/**
 * Audit Runner (Functional)
 * Main orchestrator for running code audits
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  AuditResult,
  AuditRunnerOptions,
  AnalyzerResult,
  Violation,
  AuditProgress,
  FunctionMetadata,
  AuditResultScope,
  AuditAbortedError,
  type RuleCoverage,
  type InputPresence,
  type FileAccountingSummary,
  type PipelineConfig,
  type PipelineResult,
  type IndexHandle,
  type Stage2Visitor,
  type Stage3Reducer,
  type Stage4Reducer,
  type TestCoverageReport,
  type DeadCluster,
  type SizeDistribution,
  type CoverageDiagnostic,
} from './types.js';
import { discoverFiles, discoverFilesDetailed, getSourceExtensions } from './utils/fileDiscovery.js';
import { FileAccounting } from './services/fileAccounting.js';
import { loadConfig, findConfigFileUp, type RejectedConfigEntry } from './config/configLoader.js';
import { mergePathProfiles } from './config/defaults.js';
import { resolvePathProfile } from './config/pathProfiles.js';
import { checkThresholdRationales } from './config/thresholdRationales.js';
import { readProjectLintThresholds, thresholdsToAnalyzerConfig } from './config/lintConfigReader.js';
import { computeThresholdSources } from './config/effectiveConfig.js';
import { applyPresets, getPreset, type Preset } from './presets/presets.js';
import { generateReport } from './reporting/reportGenerator.js';
import { extractFunctionsFromFile } from './functionScanner.js';
import { isMcpDebugEnabled, logMcpDebug, logMcpInfo } from './mcpDiagnostics.js';
import { loadBaseline, matchFindings, hashBaseline } from './baseline.js';
import { applyDismissals } from './dismissals.js';
import { computeImpact, LATENCY_BUDGET_MS } from './graph/blastRadius.js';
import { readTsconfigAliases, readPackageEntryPoints, readDeclaredTypePackages, DEFAULT_VIRTUAL_MODULES } from './graph/importClassification.js';
import { normalizeDialect, type Dialect } from './mcp-tools/discoveryQueries.js';
import { detectDialect } from './languages/sql/dialectDetection.js';

// Import universal analyzers
import { initializeLanguages } from './languages/index.js';
import { initializeOrmAdapters } from './analyzers/orm/index.js';
import { syncStyleIndex } from './styles/styleIndexer.js';


import { CodeIndexDB } from './codeIndexDB.js';
import { notifyLegacyIndexLocation } from './legacyIndexNotice.js';
import { writeAuditToLedger, detectRunInput } from './ledger.js';

// Pipeline imports (Spec 25 — pipeline replaces hand-rolled analyzer loop)
import { runPipeline, makeVisitorStatus, getFilesProcessed, isVisitorStatus } from './pipeline.js';
import { getRuleTimingSortedDesc } from './analyzers/ruleTiming.js';
import {
  createFunctionIndexVisitor,
  createStylesCssVisitor,
  createStylesSourceVisitor,
  createStylesReducer,
  createInvariantsReducer,
  createSchemaCodeVisitor,
  type ReactVisitorBundle,
  type SolidVisitorBundle,
} from './pipelineAdapters.js';
import { computeSizeDistributions } from './reporting/sizeDistribution.js';
import { splitRoutes, attributeRoutes, enabledMigratedRules } from './phase/routing.js';
import { runPhaseModel, type PhaseInfra } from './phase/phaseModel.js';
import { resolvePhaseThresholds } from './phase/config.js';
import { deriveCoverage, presentFormatsOf } from './phase/coverage.js';
import { MIGRATED_RULES, RULE_ANALYZER } from './phase/rules/registry.js';
import type { Finding, FactKind, CodeBlockFact } from './phase/types.js';
import { seedDryPairs, resolveBlockConfig, type DryPairSeed } from './phase/rules/dry.js';
import { checkUnresolvedReceiverImports, checkUnprovenQueryReceivers, checkUnresolvedQueries, checkUnparseableSql, dedupeCannotFireByReceiver, type UnparseableSql } from './analyzers/universal/schema/codeAnalysis.js';
import { readProjectManifest, computeManifestStaleness } from './analyzers/manifestStaleness.js';

// Package version — stamped into the build (see constants.ts), not read from
// package.json at runtime, so a stale binary reports the version it was built as.
import { PACKAGE_VERSION } from './constants.js';
const TOOL_VERSION = PACKAGE_VERSION;

// Initialize the canonical language system once
initializeLanguages();

// Initialize ORM adapters for cross-domain schema extraction (Spec 15 R2)
initializeOrmAdapters();

/** Schema sub-visitor names — shown as separate rows in the CLI table. */
const SCHEMA_SUB_VISITORS = ['schema-sql', 'schema-code', 'schema-prisma', 'schema-json'];


/**
 * CPU time consumed since `start` (a prior `process.cpuUsage()` snapshot), in
 * milliseconds. Load-independent: wall clock measures how long the run took on
 * the wall (inflated by co-tenant load), CPU time measures how much processor
 * the run's rules actually burned. The gate-budget check asserts on this.
 */
function cpuDurationMs(start: NodeJS.CpuUsage): number {
  const cpu = process.cpuUsage(start);
  return (cpu.user + cpu.system) / 1000;
}

/** An empty visitor result for an analyzer that emitted nothing this run. The
 *  call sites below shared the same four-field object literal (violations,
 *  status, executionTime, analyzerName); this factory keeps the shape in one
 *  place so a new field can't drift between them. */
function makeEmptyAnalyzerResult(analyzerName: string, filesProcessed: number): AnalyzerResult {
  return {
    violations: [],
    status: makeVisitorStatus(filesProcessed),
    executionTime: 0,
    analyzerName,
  };
}

/**
 * Spec 68 §15 — the full pipeline stage set, always run. Derived from the
 * migrated rules' own `analyzer` labels (each `RuleDefinition` carries the
 * namespace it re-emits into) plus the pipeline-only `invariants` reducer
 * (user-defined rules from `.codeauditor.json`; it auto-disables when none are
 * configured). No selection remains: `indexOnly` skips analysis wholesale, but
 * config cannot pick a subset of analyzers.
 */
const RUN_ANALYZERS: string[] = [
  ...new Set(MIGRATED_RULES.map((r) => r.analyzer)),
  'invariants',
].sort();

/**
 * §6.6 — the phase-model pool size. Defaults to `max(1, cpus - 1)` and is a
 * config threshold (env `CODE_AUDITOR_WORKERS`), never a selection gate: the
 * fact merge is file-sorted, so the value never reorders findings (§6.4).
 * `CODE_AUDITOR_WORKERS=1` is the determinism-test escape hatch that forces the
 * serial path for byte-identical-report comparisons.
 */
function resolveWorkerCount(): number {
  const env = Number(process.env.CODE_AUDITOR_WORKERS);
  if (Number.isInteger(env) && env > 0) return env;
  return Math.max(1, os.cpus().length - 1);
}

/**
 * Resolve the effective run configuration: load `.codeauditor.json` (walking up
 * from the audit path so a scoped `--path src` still finds project-root config),
 * enforce the Spec 36 R5 threshold-rationale guard, merge the project's own lint
 * thresholds as a base layer, apply shareable presets, and merge built-in path
 * profiles. Returns everything `run` needs to proceed plus the diagnostics that
 * surface in result metadata (`rejected`, `lintConfigDiagnostics`).
 */
async function resolveRunConfig(
  baseOptions: AuditRunnerOptions,
  runOptions?: AuditRunnerOptions,
) {
  const rootForConfig = runOptions?.projectRoot || baseOptions.projectRoot || process.cwd();
  const configPath = await findConfigFileUp(rootForConfig);
  let fileConfig: Partial<AuditRunnerOptions> = {};
  let rejected: RejectedConfigEntry[] = [];
  if (configPath) {
    const loaded = await loadConfig({ configPath, projectRoot: rootForConfig });
    fileConfig = loaded.config;
    rejected = loaded.rejected;
  }
  const mergedOptions: AuditRunnerOptions = { ...fileConfig, ...baseOptions, ...runOptions };

  // Spec 36 R5 — a threshold change needs a written rationale. Check the
  // user-facing analyzerConfigs layer (project config + inline options)
  // BEFORE presets merge in, so curated presets never trip the guard. Any
  // changed threshold without a rationale is a config error, not a warning.
  const thresholdCheck = checkThresholdRationales(
    mergedOptions.analyzerConfigs as Record<string, unknown> | undefined,
    mergedOptions.rationales,
  );
  if (thresholdCheck.errors.length > 0) {
    const message = [
      'Configuration error — threshold changes require a rationale (Spec 36 R5):',
      ...thresholdCheck.errors.map((e) => `  - ${e}`),
    ].join('\n');
    throw new Error(message);
  }
  const thresholdChanges = thresholdCheck.changes.map((c) => ({
    key: c.key,
    defaultValue: c.defaultValue,
    effectiveValue: c.effectiveValue,
  }));

  // ── Spec 50 R2 — project lint config as threshold authority ──────────
  // Read the project's own ESLint config (flat or legacy) and merge its size
  // thresholds (max-lines-per-function, max-params, complexity) as a base layer
  // UNDER the user's analyzerConfigs. Because we only fill keys the project did
  // not set, `.codeauditor.json` always wins. Runs AFTER checkThresholdRationales
  // so lint-sourced values never trip the Spec 36 R5 guard. Fail-open: no config,
  // or an unloadable config, is absent — defaults, not an error.
  const projectAnalyzerConfigs = (mergedOptions.analyzerConfigs ?? {}) as Record<string, unknown>;
  const lintRoot = path.resolve(mergedOptions.projectRoot || process.cwd());
  const lintResult = await readProjectLintThresholds(lintRoot);
  const lintThresholds: Record<string, number> = lintResult?.thresholds ?? {};
  // Spec 61 R3.2 — an ESLint config that exists but could not be read
  // statically is a `cannot-fire` coverage diagnostic, surfaced (never
  // silently treated as "no config").
  const lintConfigDiagnostics = lintResult?.diagnostic ? [lintResult.diagnostic] : [];
  if (Object.keys(lintThresholds).length > 0) {
    mergedOptions.analyzerConfigs = mergeLintUnderProject(
      thresholdsToAnalyzerConfig(lintThresholds),
      projectAnalyzerConfigs,
    );
  }

  // Resolve shareable presets (Spec 38 R4). Unknown ids are dropped (matching
  // mergePresets semantics); the merged preset layer becomes the base under
  // the project config / run options already present in mergedOptions.
  const presetIds = Array.isArray(mergedOptions.presets) ? mergedOptions.presets : [];
  if (presetIds.length > 0) {
    mergedOptions.analyzerConfigs = applyPresets(presetIds, mergedOptions.analyzerConfigs);
  }

  // Spec 50 R2 — which config layer supplied each size threshold (coverage output).
  const resolvedPresets: Preset[] = presetIds
    .map((id) => getPreset(id))
    .filter((p): p is Preset => p !== undefined);
  const thresholdSources = computeThresholdSources({
    projectConfig: projectAnalyzerConfigs,
    lintThresholds,
    presets: resolvedPresets,
  });

  // Always merge built-in path profiles — corpus audits and projects without
  // .codeauditor.json must still get the built-in scripts-and-tests profile.
  mergedOptions.pathProfiles = mergePathProfiles(
    mergedOptions.pathProfiles,
    (mergedOptions as any).builtin
  );

  return {
    mergedOptions,
    configPath,
    rejected,
    lintConfigDiagnostics,
    thresholdChanges,
    thresholdSources,
  };
}

/**
 * Resolve the audit's file set from the configured scope (`all`, `git:<ref>`,
 * `changed`, or an explicit files array), detect changed functions for scoped
 * runs, compute blast-radius impact for those functions, and re-walk discovery
 * for the unfiltered corpus file list (the import classifier's input — see the
 * Spec 60.1 Correction 1 comment below). Returns everything `run` needs to
 * build the pipeline, plus `scope`/`isScoped`/`scopeResultType` for downstream
 * metadata and the ledger.
 */
async function discoverAuditFiles(
  mergedOptions: AuditRunnerOptions,
  root: string,
  fileAccounting: FileAccounting,
) {
  const scope = mergedOptions.scope ?? 'all';
  const isScoped = scope !== 'all';
  const scopeResultType: AuditResultScope = isScoped ? 'scoped' : 'full';

  reportProgress(mergedOptions, {
    phase: 'discovery',
    message: `Discovering files... (scope: ${scopeResultType})`
  });

  // Discover files based on scope
  let files: string[];
  let changedFunctions: FunctionMetadata[] | undefined;
  // Extensions present on disk that discovery skipped (Spec 43 R5 follow-up).
  // Populated only for the `all` scope — scoped runs are explicitly scoped by
  // the user, so "what wasn't analyzed" there is the scope itself, not the
  // extension filter.
  let skippedExtensions: Array<{ ext: string; count: number }> | undefined;

  if (typeof scope === 'string' && scope.startsWith('git:')) {
    // git:<ref> scope
    const gitRef = scope.slice(4);
    files = resolveGitScopeFiles(mergedOptions, gitRef);
    logMcpInfo('discovery', 'git scope resolved', {
      ref: gitRef,
      fileCount: files.length
    });
  } else if (scope === 'changed') {
    // Changed scope: detect modified files. Fail open on an unavailable index
    // (a future schema version is the sharpest case): when the caller pinned
    // explicit files we audit those without touching the index; otherwise there
    // is nothing to diff against, so the run degrades to zero files and the
    // analyze phase reports the index skip as a coverage diagnostic (never a
    // fatal — the hook must complete with the exit code it would otherwise have).
    let db: CodeIndexDB | undefined;
    try {
      db = CodeIndexDB.getInstance(undefined, mergedOptions.projectRoot || process.cwd());
      await db.initialize();
    } catch (err) {
      logMcpInfo('discovery', 'changed scope index unavailable (continuing)', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
    const modifiedFiles = mergedOptions.explicitFiles !== undefined
      ? mergedOptions.explicitFiles
      : (db ? await db.detectModifiedFiles(
          path.resolve(mergedOptions.projectRoot || process.cwd())
        ) : []);
    files = [...new Set(modifiedFiles.map((f) => path.resolve(f)))].sort();
    logMcpInfo('discovery', 'changed scope resolved', {
      fileCount: files.length
    });
  } else if (Array.isArray(scope)) {
    // files scope: explicit file paths/globs
    files = await resolveFilesScope(mergedOptions, scope);
    logMcpInfo('discovery', 'files scope resolved', {
      fileCount: files.length
    });
  } else {
    // all scope: current behavior
    const discovered = await discoverProjectFiles(mergedOptions, fileAccounting);
    files = discovered.files;
    skippedExtensions = discovered.skippedExtensions;
  }

  throwIfAborted(mergedOptions.abortSignal);

  // Detect changed functions for non-all scopes
  if (isScoped && files.length > 0) {
    try {
      const db = CodeIndexDB.getInstance(undefined, mergedOptions.projectRoot || process.cwd());
      await db.initialize();
      const detection = await db.detectChangedFunctions(files);
      changedFunctions = detection.changedFunctions;
      logMcpInfo('discovery', 'changed function detection', {
        changedFunctionCount: changedFunctions.length,
        deletedCount: detection.deletedFunctions.length,
        errors: detection.errors.length
      });
    } catch (err) {
      logMcpInfo('discovery', 'changed function detection failed (continuing)', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // ── Blast-radius impact (Spec 14 R6) ──────────────────────────────
  // Compute transitive-caller impact for changed functions.
  // If latency exceeds the 100ms budget, skip and emit a warning;
  // the feature is disabled-by-default when over budget.
  let blastRadius: import('./types.js').BlastRadiusImpact | undefined;
  if (isScoped && changedFunctions && changedFunctions.length > 0) {
    try {
      const db = CodeIndexDB.getInstance(undefined, mergedOptions.projectRoot || process.cwd());
      const rawDb = db.rawDb;
      const functionIds: number[] = [];
      // One batched query per chunk of changed functions, not one query per
      // function (loop-query). `changedFunctions` can be large, so chunk to the
      // SQLite bind-parameter cap; `ORDER BY id` + first-wins by (name, file_path)
      // reproduces the old `.get` (first matching row) semantics exactly.
      const idByKey = new Map<string, number>();
      const BATCH = 900;
      for (let i = 0; i < changedFunctions.length; i += BATCH) {
        const chunk = changedFunctions.slice(i, i + BATCH);
        const orClause = chunk.map(() => '(name = ? AND file_path = ?)').join(' OR ');
        const params = chunk.flatMap((fn) => [fn.name, fn.filePath]);
        const rows = rawDb.prepare(
          `SELECT id, name, file_path FROM functions WHERE ${orClause} ORDER BY id`
        ).all(...params) as Array<{ id: number; name: string; file_path: string }>;
        for (const r of rows) {
          const key = `${r.name}\0${r.file_path}`;
          if (!idByKey.has(key)) idByKey.set(key, r.id);
        }
      }
      for (const fn of changedFunctions) {
        const id = idByKey.get(`${fn.name}\0${fn.filePath}`);
        if (id != null) functionIds.push(id);
      }

      if (functionIds.length > 0) {
        const impact = computeImpact(rawDb, functionIds);
        if (impact.latencyMs > LATENCY_BUDGET_MS) {
          logMcpInfo('blast-radius',
            `latency ${impact.latencyMs}ms exceeds ${LATENCY_BUDGET_MS}ms budget — blast radius disabled for this run`,
            {}
          );
        } else {
          blastRadius = impact;
          logMcpInfo('blast-radius', 'computed', {
            editedFunctionCount: impact.editedFunctionCount,
            transitiveCallers: impact.transitiveCallers,
            reachableExports: impact.reachableExports,
            latencyMs: impact.latencyMs,
          });
        }
      }
    } catch (err) {
      // Blast radius is advisory — non-fatal
      logMcpInfo('blast-radius', 'computation failed (continuing)', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Spec 60.1 Correction 1 — the import classifier's corpus file set must be
  // the UNFILTERED stage-1 discovery list, not the audit's `files` list.
  // `files` is narrowed at two points before `_infra` is built:
  //   1. The polyglot dispatch narrows `files` to the per-language list it
  //      actually hands to the TypeScript analyzer — files with no detectable
  //      language (`.json`, `.sql`) drop out here.
  //   2. `filterFiles` (fileDiscovery.ts, called from `findFiles`) applies
  //      `includePaths` as a positive-selection glob filter — a `.json` file
  //      that survives step 1 is dropped here (or by the default `includePaths`
  //      from config/defaults.ts, which omits `.json`).
  // Either way `_infra.files` no longer contains `.json`, so a real
  // `./invariant-rules.schema.json` import classifies `internal-broken`.
  // Classification answers "does this import resolve to a real file",
  // independent of what the audit chooses to analyze, so it re-walks
  // discovery with ALL_EXTENSIONS and no include/exclude narrowing.
  const corpusFiles = await discoverFiles(root);

  logMcpInfo('discovery', 'file discovery finished', {
    projectRoot: path.resolve(root),
    totalFiles: files.length,
    corpusFiles: corpusFiles.length,
    scope: scopeResultType,
    indexFunctions: !!mergedOptions.indexFunctions
  });

  return {
    files,
    changedFunctions,
    skippedExtensions,
    blastRadius,
    corpusFiles,
    scope,
    isScoped,
    scopeResultType,
  };
}

/**
 * Collect per-file function metadata for the index (Spec 44 / Spec 60.1). Only
 * script files are extracted here; Go files are indexed by the SOLID analyzer
 * directly. Threads the abort signal and a progress callback so a long extraction
 * stays cancellable and observable.
 */
async function collectIndexedFunctions(
  mergedOptions: AuditRunnerOptions,
  files: string[],
): Promise<{
  collectedFunctions: FunctionMetadata[];
  fileToFunctionsMap: Map<string, FunctionMetadata[]>;
}> {
  let collectedFunctions: FunctionMetadata[] = [];
  const fileToFunctionsMap = new Map<string, FunctionMetadata[]>(); // Track functions per file for sync

  if (mergedOptions.indexFunctions) {
    reportProgress(mergedOptions, {
      phase: 'function-indexing',
      message: 'Collecting functions from files...'
    });

    // Collect functions from TypeScript/JavaScript files
    // Note: Go files will be indexed by the Universal SOLID analyzer directly
    const scriptFiles = files.filter(f =>
      f.endsWith('.ts') || f.endsWith('.tsx') ||
      f.endsWith('.js') || f.endsWith('.jsx') ||
      f.endsWith('.mts') || f.endsWith('.cts') ||
      f.endsWith('.mjs') || f.endsWith('.cjs')
    );

    logMcpInfo('function-indexing', 'extracting functions from script files', {
      scriptFileCount: scriptFiles.length
    });

    for (let i = 0; i < scriptFiles.length; i++) {
      try {
        if (i % 10 === 0) {
          throwIfAborted(mergedOptions.abortSignal);
        }
        if (i > 0 && i % 50 === 0) {
          logMcpInfo('function-indexing', 'progress', {
            current: i,
            total: scriptFiles.length
          });
        }
        const fileFunctions = await extractFunctionsFromFile(scriptFiles[i], {
          unusedImportsConfig: mergedOptions.unusedImportsConfig
        });
        collectedFunctions.push(...fileFunctions);
        fileToFunctionsMap.set(scriptFiles[i], fileFunctions); // Store for sync

        reportProgress(mergedOptions, {
          phase: 'function-indexing',
          current: i + 1,
          total: scriptFiles.length,
          message: `Collected ${fileFunctions.length} items from ${scriptFiles[i]}`
        });
        if (isMcpDebugEnabled()) {
          logMcpDebug('function-indexing', scriptFiles[i], {
            symbols: fileFunctions.length
          });
        }
      } catch (error) {
        logMcpInfo('function-indexing', 'extract failed (continuing)', {
          file: scriptFiles[i],
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return { collectedFunctions, fileToFunctionsMap };
}

/** Everything the pipeline stage produces that `run` folds into the result. */
interface PipelineRunResult {
  analyzerResults: Record<string, AnalyzerResult>;
  phaseFindings: Finding[];
  phaseIncompleteFacts: ReadonlyMap<FactKind, ReadonlySet<string>>;
  pipelineCoverage: RuleCoverage[] | undefined;
  pipelineTableCatalog: Array<{ table: string; sources: any[] }> | undefined;
  pipelineStageTiming: Record<string, number> | undefined;
  pipelineSkippedFiles: Array<{ filePath: string; bytes: number; reason: string }> | undefined;
  pipelineUnparsedFiles: Array<{ filePath: string; reason: string }> | undefined;
  pipelineInputPresence: InputPresence | undefined;
  pipelineRuleTiming: Array<{ ruleId: string; totalMs: number; calls: number }> | undefined;
  pipelineFileAccounting: FileAccountingSummary | undefined;
  pipelineDiagnostics: Array<{ analyzerName: string; kind: string; message: string; file?: string; line?: number; details?: Record<string, unknown> }> | undefined;
  pipelineTestCoverage: TestCoverageReport | undefined;
  pipelineDeadClusters: DeadCluster[] | undefined;
  pipelineSizeDistributions: SizeDistribution[] | undefined;
  routeAttribution: Record<string, 'phase' | 'legacy'> | undefined;
  indexFactsWritten: number;
  writeIndexFactsMs: number;
}

/**
 * Sync style declarations, tokens, and class usage before the styles analyzer
 * runs (Spec 10), mirroring the function index sync. Non-fatal: on failure the
 * styles analyzer runs with whatever is already in the index.
 */
async function syncStyles(
  analyzers: string[],
  root: string,
  files: string[],
  isScoped: boolean,
): Promise<{ styleConsumedFiles: string[]; styleContributingFiles: string[] | undefined }> {
  let styleConsumedFiles: string[] = [];
  let styleContributingFiles: string[] | undefined;
  if (analyzers.includes('styles')) {
    try {
      const styleDb = CodeIndexDB.getInstance(undefined, root);
      await styleDb.initialize();
      const styleSyncResult = await syncStyleIndex(
        styleDb.rawDb,
        files,
        root,
        { scoped: isScoped }
      );
      styleConsumedFiles = styleSyncResult.consumedFiles;
      styleContributingFiles = styleSyncResult.contributingFiles;
      logMcpInfo('style-index', 'style index sync complete', {
        changed: styleSyncResult.changed,
        skipped: styleSyncResult.skipped,
        removed: styleSyncResult.removed,
        errors: styleSyncResult.errors,
        consumed: styleSyncResult.consumedFiles.length,
      });
    } catch (err) {
      // Non-fatal: styles analyzer will run with whatever is in the index
      logMcpInfo('style-index', 'style index sync failed (continuing)', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return { styleConsumedFiles, styleContributingFiles };
}

/** The visitor/reducer/bundle set produced by the pipeline-adapter assembly. */
interface PipelineAdapterBundle {
  pipelineVisitors: Stage2Visitor[];
  pipelineReducers: Stage3Reducer[];
  pipelineDerivedReducers: Stage4Reducer[];
  reactBundle: ReactVisitorBundle | undefined;
  solidBundle: SolidVisitorBundle | undefined;
}

/**
 * Assemble the Stage-2 visitors / Stage-3 reducers / Stage-4 derived reducers
 * for this run. Spec 68 §15 — once every registry rule is migrated, the legacy
 * pipeline's rule-emitting visitors/reducers are skipped (their findings are
 * stripped to zero at the both-paths split); only the infrastructure with a
 * side-effect the phase model reads from the index keeps running.
 */
function buildPipelineAdapters(analyzers: string[]): PipelineAdapterBundle {
  const pipelineVisitors: Stage2Visitor[] = [];
  const pipelineReducers: Stage3Reducer[] = [];
  const pipelineDerivedReducers: Stage4Reducer[] = [];

  let reactBundle: ReactVisitorBundle | undefined;
  let solidBundle: SolidVisitorBundle | undefined;

  // Always-on infrastructure: function-index visitor populates the
  // `functions` table so conventions + cross-domain reducers have data
  // even on a cold run with no prior index sync.
  pipelineVisitors.push(createFunctionIndexVisitor());

  // styles-css visitor — AST-extracts .css files into style_* tables (Spec 26 Phase 2)
  if (analyzers.includes('styles')) pipelineVisitors.push(createStylesCssVisitor());
  // styles-source visitor — AST-extracts TS/JS CSS-in-JS into style_* tables,
  // reusing the stage-1 parse (eliminates the style-index re-parse).
  if (analyzers.includes('styles')) pipelineVisitors.push(createStylesSourceVisitor());

  // The DRY visitor's findings are all migrated and stripped, and its pair-seed
  // side-effect now comes from the phase `code-block` fact (`seedDryPairs`, Spec
  // 70 2b), so there is no legacy DRY visitor to register.
  // The invariant reducer is pipeline-only (its rules come from
  // `.codeauditor.json`, not the registry), so it always runs — it is the one
  // legacy path that still emits non-migrated findings.
  if (analyzers.includes('invariants')) pipelineReducers.push(createInvariantsReducer());
  // The styles reducer persists the styles-css visitor's facts into the
  // `style_*` tables (the styles-source visitor writes its own). The phase
  // `defined-classes` / `unread-style-sources` corpus producers read those
  // tables, so this reducer must keep running even though its *findings* are
  // migrated and stripped.
  if (analyzers.includes('styles')) pipelineReducers.push(createStylesReducer());
  // The schema-code visitor's findings are migrated and stripped, but it must
  // keep running for its one remaining live emit: the `reserved-word` finding
  // off `checkNamingConventions` (unregistered emission, §13 disposition) and the
  // ORM/DDL table catalog. Its `unresolved-query` diagnostic (Spec 58 R1) and its
  // `unparseable` cannot-fire diagnostic (Spec 70 R2) are both re-derived
  // corpus-side (Spec 70 1b / R2), so this visitor no longer emits either.
  if (analyzers.includes('schema')) pipelineVisitors.push(createSchemaCodeVisitor());

  return {
    pipelineVisitors,
    pipelineReducers,
    pipelineDerivedReducers,
    reactBundle,
    solidBundle,
  };
}

/**
 * Build the per-analyzer namespaced config passed to every pipeline stage. Each
 * analyzer gets its own namespace; `_infra` holds shared infrastructure keys.
 */
function buildPipelineAnalyzerConfig(
  analyzers: string[],
  mergedOptions: AuditRunnerOptions,
  root: string,
  files: string[],
  corpusFiles: string[],
  provenanceTiming: { totalMs: number },
): Record<string, Record<string, unknown>> {
  const pipelineAnalyzerConfig: Record<string, Record<string, unknown>> = {};
  for (const name of analyzers) {
    pipelineAnalyzerConfig[name] = { ...(mergedOptions.analyzerConfigs?.[name] ?? {}) };
  }
  // Spec 70 R1 — the corpus's dialect is threaded to the data-access analyzer
  // (whose SQL-content facts parse rather than regex) and to DB-receiver
  // resolution. Explicit config (`databaseType`) overrides detection; otherwise
  // the dialect is *detected* from the dependency manifest (pg/neon → postgres,
  // better-sqlite3/D1 → sqlite, mysql2 → mysql). A null dialect means the SQL
  // facts `cannot-fire` — and `sqlDialectReason` names *why* (undetermined or
  // ambiguous) so the abstention is visible rather than silent.
  const detection = mergedOptions.databaseType
    ? (() => {
        const explicit = normalizeDialect(mergedOptions.databaseType as string);
        return explicit
          ? { dialect: explicit, reason: null as string | null }
          : { dialect: null as Dialect | null, reason: `dialect undetermined (unsupported databaseType '${mergedOptions.databaseType}')` };
      })()
    : detectDialect(root);
  const sqlDialect: Dialect | null = detection.dialect;
  const sqlDialectReason: string | null = detection.reason;
  // Spec 62 Amendment B — the missing-org-filter Stage-4 reducer reads the
  // data-access config namespace, so it inherits the data-access analyzer's
  // config rather than a fresh empty namespace.
  if (analyzers.includes('data-access')) {
    pipelineAnalyzerConfig['data-access'] = {
      ...(pipelineAnalyzerConfig['data-access'] ?? {}),
      dialect: sqlDialect,
    };
    pipelineAnalyzerConfig['data-access-org-filter'] = { ...(pipelineAnalyzerConfig['data-access'] ?? {}) };
  }
  // Pass invariant rules from .codeauditor.json into the invariants pipeline config.
  if (analyzers.includes('invariants') && (mergedOptions as any).rules) {
    pipelineAnalyzerConfig['invariants'] = {
      ...(pipelineAnalyzerConfig['invariants'] ?? {}),
      rules: (mergedOptions as any).rules,
    };
  }
  // Cross-domain config lives at the top level (not analyzerConfigs)
  if (analyzers.includes('cross-domain') && (mergedOptions as any).crossDomain) {
    pipelineAnalyzerConfig['cross-domain'] = {
      ...(pipelineAnalyzerConfig['cross-domain'] ?? {}),
      ...(mergedOptions as any).crossDomain,
    };
  }
  // Schema config: all table discovery flows through visitors and facts.
  if (analyzers.includes('schema')) {
    const scConfig = mergedOptions.analyzerConfigs?.schema ?? {};
    const schemaConfig = {
      ...(pipelineAnalyzerConfig['schema'] ?? {}),
      sqlTagNames: scConfig.sqlTagNames ?? ['sql', 'db'],
      dbBindingNames: scConfig.dbBindingNames ?? ['env.DB'],
      fileGateGlobs: scConfig.fileGateGlobs,
      maxQueriesPerFunction: scConfig.maxQueriesPerFunction,
      validateQueryPatterns: scConfig.validateQueryPatterns,
      checkNamingConventions: scConfig.checkNamingConventions,
      tableSources: scConfig.tableSources,
      dbWrapperNames: scConfig.dbWrapperNames,
      detection: scConfig.detection,
      schemas: scConfig.schemas,
      knownTables: scConfig.knownTables,
      // Spec 70 R2 — thread the corpus's named dialect so a provenanced static
      // SQL argument that the dialect cannot parse (PRAGMA/VACUUM/ANALYZE) is
      // reported as unreadable (cannot-fire), not silently "no tables".
      sqlDialect,
      // Spec 70 (detection) — the named reason when the dialect is null, so an
      // undetermined/ambiguous corpus emits a "dialect undetermined" cannot-fire
      // rather than reading the empty reference set as clean.
      sqlDialectReason,
    };
    pipelineAnalyzerConfig['schema'] = schemaConfig;
    // Pipeline resolves config by visitor name; the schema-* sub-visitors need
    // the same namespace as the schema reducer.
    for (const sub of ['schema-code', 'schema-sql', 'schema-prisma', 'schema-json']) {
      pipelineAnalyzerConfig[sub] = schemaConfig;
    }
  }
  // Global/infrastructure settings passed to all pipeline stages
  pipelineAnalyzerConfig['_infra'] = {
    pathProfiles: mergedOptions.pathProfiles,
    projectRoot: root,
    _provenanceTiming: provenanceTiming,
    files,
    corpusFiles,
    importVirtualModules: mergedOptions.importVirtualModules ?? DEFAULT_VIRTUAL_MODULES,
    tsconfigAliases: readTsconfigAliases(root),
    packageEntryPoints: readPackageEntryPoints(root).entryPaths,
    declaredTypePackages: readDeclaredTypePackages(root),
    // Spec 70 R1 — surfaced under `_infra` so `runPipeline` can hand the named
    // dialect to the phase model's data-access producer without reading the
    // data-access namespace.
    sqlDialect,
    // Spec 70 (detection) — the named reason when `sqlDialect` is null.
    sqlDialectReason,
  };

  return pipelineAnalyzerConfig;
}

/**
 * Assemble the `PipelineConfig` handed to `runPipeline`.
 */
function buildPipelineConfig(inputs: {
  mergedOptions: AuditRunnerOptions;
  root: string;
  files: string[];
  isScoped: boolean;
  fileAccounting: FileAccounting;
  styleConsumedFiles: string[];
  styleContributingFiles: string[] | undefined;
  analyzers: string[];
  auditIndex: CodeIndexDB | undefined;
  pipelineAnalyzerConfig: Record<string, Record<string, unknown>>;
  pipelineVisitors: Stage2Visitor[];
  pipelineReducers: Stage3Reducer[];
  pipelineDerivedReducers: Stage4Reducer[];
}): PipelineConfig {
  const {
    mergedOptions, root, files, isScoped, fileAccounting,
    styleConsumedFiles, styleContributingFiles, analyzers,
    auditIndex, pipelineAnalyzerConfig, pipelineVisitors, pipelineReducers,
    pipelineDerivedReducers,
  } = inputs;

  return {
    projectRoot: root,
    explicitFiles: files,
    visitors: pipelineVisitors,
    reducers: pipelineReducers,
    derivedReducers: pipelineDerivedReducers,
    config: pipelineAnalyzerConfig,
    abortSignal: mergedOptions.abortSignal,
    progressCallback: (progress) => {
      throwIfAborted(mergedOptions.abortSignal);
      reportProgress(mergedOptions, progress);
    },
    isScoped,
    fileAccounting,
    consumedFilePaths: styleConsumedFiles,
    styleContributingFiles,
    onStage2Complete: async () => {
      // Post-stage-2 setup: rebuild the call-graph from the functions table
      // (populated by the function-index visitor).
      if (auditIndex && analyzers.includes('conventions')) {
        try {
          await auditIndex.graph.updateDependencyGraph();
        } catch (err) {
          logMcpInfo('analysis', 'updateDependencyGraph failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    },
  };
}

/**
 * Run the both-paths split (Spec 68 §11.1): strip migrated rules' legacy
 * emission and re-emit phase findings into the correct analyzer buckets.
 * Mutates `analyzerResults` and `pipelineAnalyzerConfig` (dry divergence).
 */
async function applyPhaseModelSplit(inputs: {
  mergedOptions: AuditRunnerOptions;
  root: string;
  files: string[];
  isScoped: boolean;
  pipelineAnalyzerConfig: Record<string, Record<string, unknown>>;
  analyzerResults: Record<string, AnalyzerResult>;
  pipelineIndexHandle: IndexHandle | undefined;
}): Promise<{
  phaseFindings: Finding[];
  phaseIncompleteFacts: ReadonlyMap<FactKind, ReadonlySet<string>>;
  routeAttribution: Record<string, 'phase' | 'legacy'> | undefined;
  /** Spec 69 §10 + Part 2b — the `cannot-fire` (unproven receivers + unresolved
   *  imports) and `manifest-stale` diagnostics, re-homed here from the deleted
   *  pre-pass, to be merged into the pipeline's metadata diagnostics. */
  receiverDiagnostics: CoverageDiagnostic[];
}> {
  const { mergedOptions, root, files, isScoped, pipelineAnalyzerConfig, analyzerResults, pipelineIndexHandle } = inputs;
  let phaseFindings: Finding[] = [];
  let phaseIncompleteFacts: ReadonlyMap<FactKind, ReadonlySet<string>> = new Map();
  let routeAttribution: Record<string, 'phase' | 'legacy'> | undefined;
  let receiverDiagnostics: CoverageDiagnostic[] = [];

  const { migrated } = splitRoutes();
  routeAttribution = Object.fromEntries(attributeRoutes());

  if (migrated.size > 0) {
    // The `dry/diverging-clone` rule reads its knobs from `dry.divergence`.
    const topLevelDivergence = (mergedOptions as { divergence?: Record<string, unknown> }).divergence;
    if (topLevelDivergence && !pipelineAnalyzerConfig['dry']?.divergence) {
      pipelineAnalyzerConfig['dry'] = { ...(pipelineAnalyzerConfig['dry'] ?? {}), divergence: topLevelDivergence };
    }
    const thresholds = resolvePhaseThresholds(pipelineAnalyzerConfig);
    const profiles = mergedOptions.pathProfiles;
    const profileByFile = new Map<string, ReturnType<typeof resolvePathProfile>>();
    const resolveFileProfile = (file: string) => {
      let resolved = profileByFile.get(file);
      if (!resolved) {
        resolved = profiles?.length
          ? resolvePathProfile(file, root, profiles)
          : { overrides: {}, excludeFromGate: false, excludeFromAnalysis: false, matchedProfileNames: [] };
        profileByFile.set(file, resolved);
      }
      return resolved;
    };
    const phaseFiles = files.filter((f) => !resolveFileProfile(f).excludeFromAnalysis);
    const infraConfig = (pipelineAnalyzerConfig['_infra'] ?? {}) as Record<string, unknown>;
    const schemaPhaseConfig = (pipelineAnalyzerConfig['schema'] ?? {}) as {
      knownTables?: readonly string[];
      schemas?: ReadonlyArray<{
        name: string;
        tables: ReadonlyArray<{ name: string; columns: ReadonlyArray<{ name: string; type: string }> }>;
      }>;
    };
    const externalTables: Array<{ name: string; source: string; columns: readonly string[] }> = [];
    for (const t of schemaPhaseConfig.knownTables ?? []) {
      externalTables.push({ name: t, source: 'external-config', columns: [] });
    }
    for (const s of schemaPhaseConfig.schemas ?? []) {
      for (const t of s.tables) {
        externalTables.push({ name: t.name, source: `Schema: ${s.name}`, columns: t.columns.map((c) => c.name) });
      }
    }
    const phaseResult = await runPhaseModel(phaseFiles, thresholds, {
      projectRoot: root,
      scoped: isScoped,
      corpusFiles: infraConfig.corpusFiles as string[] | undefined,
      importVirtualModules: infraConfig.importVirtualModules as string[] | undefined,
      tsconfigAliases: infraConfig.tsconfigAliases as PhaseInfra['tsconfigAliases'],
      packageEntryPoints: infraConfig.packageEntryPoints as string[] | undefined,
      indexHandle: pipelineIndexHandle,
      enabledRules: enabledMigratedRules(),
      externalTables,
      workerCount: resolveWorkerCount(),
      sqlDialect: infraConfig.sqlDialect as Dialect | null | undefined,
      sqlDialectReason: infraConfig.sqlDialectReason as string | null | undefined,
      declaredTypePackages: infraConfig.declaredTypePackages as ReadonlySet<string> | undefined,
      // Spec 70 2b — the diverging-clone write: seed `dry_pair_history` from the
      // phase `code-block` fact (replacing `createDryVisitor`/`persistDryPairs`).
      persistDryPairHistory: (facts) => {
        const dryCfg = resolveBlockConfig(thresholds.get('dry/duplicate') ?? {});
        const codeBlocks = (facts.get('code-block') as CodeBlockFact[] | undefined) ?? [];
        return persistDryPairs(seedDryPairs(codeBlocks, dryCfg), root);
      },
    });
    phaseFindings = phaseResult.findings;
    phaseIncompleteFacts = phaseResult.incompleteFacts;

    // Spec 69 §10 + Part 2b — re-home the pre-pass's diagnostics (deleted from
    // `pipeline.ts`) on the phase result. Cannot-fire: re-derive per file from
    // `phaseResult.unprovenQueryReceivers` + `phaseResult.unresolvedImports`, keyed
    // to the TS-family surface the legacy `schema-code` visitor covered (Go
    // receivers/imports never reached it). Manifest-stale: the ecosystem-list
    // self-check, unchanged from the deleted `buildPipelineResult` loop.
    receiverDiagnostics = await buildReceiverDiagnostics(phaseResult.unprovenQueryReceivers, phaseResult.unresolvedImports, phaseResult.unresolvedQuerySites, phaseResult.unparseableSql, root);

    // Strip the migrated rules' legacy emission from every analyzer result.
    let strippedCount = 0;
    for (const result of Object.values(analyzerResults)) {
      const before = result.violations.length;
      result.violations = result.violations.filter((v) => !migrated.has(v.rule));
      strippedCount += before - result.violations.length;
    }

    // Re-emit phase findings as violations, bucketed by the rule's analyzer.
    const byAnalyzer = new Map<string, Violation[]>();
    const ruleAnalyzerOverride: Record<string, string> = {
      'table-naming-convention': 'schema-code',
      'too-many-queries': 'schema-code',
    };
    for (const f of phaseFindings) {
      const analyzer = ruleAnalyzerOverride[f.ruleId] ?? RULE_ANALYZER.get(f.ruleId) ?? 'phase';
      const resolved = resolveFileProfile(f.file);
      const profile = resolved.matchedProfileNames.length > 0
        ? resolved.matchedProfileNames[resolved.matchedProfileNames.length - 1]
        : undefined;
      const bucket = byAnalyzer.get(analyzer) ?? [];
      bucket.push({
        file: f.file,
        rule: f.ruleId,
        severity: f.severity,
        message: f.message,
        line: f.line,
        column: f.column,
        symbol: f.symbol,
        resolution: f.resolution,
        analyzer,
        ...(f.fix ? { fix: f.fix } : {}),
        ...(f.details !== undefined ? { details: f.details } : {}),
        ...(profile ? { profile } : {}),
        ...(resolved.excludeFromGate ? { gateExcluded: true } : {}),
      });
      byAnalyzer.set(analyzer, bucket);
    }
    for (const [analyzer, violations] of byAnalyzer) {
      if (analyzerResults[analyzer]) {
        analyzerResults[analyzer].violations.push(...violations);
      } else {
        analyzerResults[analyzer] = {
          ...makeEmptyAnalyzerResult(analyzer, phaseFiles.length),
          violations,
        };
      }
    }

    // Every migrated analyzer must appear in the results map even when it
    // emitted nothing this run.
    for (const analyzer of new Set(RULE_ANALYZER.values())) {
      if (!analyzerResults[analyzer]) {
        analyzerResults[analyzer] = makeEmptyAnalyzerResult(analyzer, phaseFiles.length);
      }
    }

    logMcpInfo('analysis', 'phase model (both paths)', {
      migrated: migrated.size,
      stripped: strippedCount,
      reemitted: phaseFindings.length,
    });
  }

  return { phaseFindings, phaseIncompleteFacts, routeAttribution, receiverDiagnostics };
}

/**
 * Spec 69 §10 + Part 2b — re-derive the pre-pass's coverage diagnostics from the
 * phase result: the `cannot-fire` surface (unproven query receivers + unresolved
 * DB-looking imports, keyed to the TS-family files the legacy `schema-code`
 * visitor covered) and the `manifest-stale` ecosystem-list self-check. Replaces
 * `collectCannotFireDiagnostics` (deleted from `pipelineAdapters.ts`) and the
 * `manifest-staleness` loop (deleted from `buildPipelineResult`).
 */
async function buildReceiverDiagnostics(
  unprovenQueryReceivers: readonly { file: string; line: number; receiver: string; method: string; reason: string }[],
  unresolvedImports: readonly { importer: string; source: string; names: readonly string[] }[],
  unresolvedQuerySites: readonly { file: string; identifier: string; location: { line: number; column: number } }[],
  unparseableSql: readonly (UnparseableSql & { file: string })[],
  projectRoot: string,
): Promise<CoverageDiagnostic[]> {
  const diagnostics: CoverageDiagnostic[] = [];

  // Group the two signals by file, then per-file dedup so the call-site signal
  // wins over the import-level signal — mirroring the deleted
  // `collectCannotFireDiagnostics` (which ran per TS-family file inside the
  // schema-code visitor, so Go files never reached it).
  const files = new Set<string>();
  for (const u of unprovenQueryReceivers) if (!u.file.endsWith('.go')) files.add(u.file);
  for (const u of unresolvedImports) if (!u.importer.endsWith('.go')) files.add(u.importer);
  for (const file of files) {
    const perFile: CoverageDiagnostic[] = [];
    const unresolvedHere = unresolvedImports.filter((u) => path.resolve(u.importer) === path.resolve(file));
    if (unresolvedHere.length > 0) {
      perFile.push(...checkUnresolvedReceiverImports(unresolvedHere.map((u) => ({ source: u.source, names: [...u.names] })), file));
    }
    const unprovenHere = unprovenQueryReceivers.filter((u) => path.resolve(u.file) === path.resolve(file));
    if (unprovenHere.length > 0) {
      perFile.push(...checkUnprovenQueryReceivers(unprovenHere.map((u) => ({ receiver: u.receiver, method: u.method, line: u.line, reason: u.reason })), file));
    }
    diagnostics.push(...dedupeCannotFireByReceiver(perFile));
  }

  // Spec 70 1b — the `unresolved-query` diagnostics (re-admitted DB-calls whose
  // SQL is held in an unresolvable identifier). Emitted separately from
  // `cannot-fire`: a distinct kind, never receiver-deduped (the legacy
  // `schema-code` visitor emitted them verbatim, per file, in visitor order).
  const unresolvedByFile = new Map<string, { file: string; identifier: string; location: { line: number; column: number } }[]>();
  for (const site of unresolvedQuerySites) {
    if (site.file.endsWith('.go')) continue;
    let list = unresolvedByFile.get(site.file);
    if (!list) {
      list = [];
      unresolvedByFile.set(site.file, list);
    }
    list.push(site);
  }
  for (const [file, sites] of unresolvedByFile) {
    diagnostics.push(...checkUnresolvedQueries(sites.map((s) => ({ identifier: s.identifier, location: s.location })), file));
  }

  // Spec 70 R2 — the `unparseable` cannot-fire diagnostics. Emitted per file in
  // fact order, mirroring the deleted legacy `schema-code` visitor, which ran
  // `checkUnparseableSql` over every admitted tag/DB-call parse within the file.
  const unparseableByFile = new Map<string, UnparseableSql[]>();
  for (const u of unparseableSql) {
    if (u.file.endsWith('.go')) continue;
    let list = unparseableByFile.get(u.file);
    if (!list) {
      list = [];
      unparseableByFile.set(u.file, list);
    }
    list.push(u);
  }
  for (const [file, records] of unparseableByFile) {
    diagnostics.push(...checkUnparseableSql(records, file));
  }

  // Part 2b — the manifest staleness self-check, unchanged from the deleted
  // `buildPipelineResult` loop: our hardcoded ecosystem lists vs. the project's
  // manifest, emitted as a diagnostic (never a verdict input).
  const manifest = await readProjectManifest(projectRoot);
  for (const stale of computeManifestStaleness(manifest)) {
    diagnostics.push({
      analyzerName: 'data-access',
      kind: 'manifest-stale',
      message: `our list names '${stale.package}', this project doesn't depend on it`,
      file: stale.manifestPath,
      line: 0,
      details: { ecosystem: stale.ecosystem, package: stale.package },
    });
  }

  return diagnostics;
}

/**
 * Persist seeded DRY pairs into `dry_pair_history` (Spec 13 R5 Phase 1) so the
 * migrated `dry/diverging-clone` rule can read them through the index handle.
 * The pairs come from `seedDryPairs` over the phase `code-block` fact (Spec 70
 * 2b — the writer moved off the legacy DRY visitor). Runs BEFORE the phase
 * model's `clone-pair-history` read. Advisory — non-fatal on failure.
 * @param dryPairs The seeded DRY pairs to persist into `dry_pair_history`.
 * @param root The project root used to open the code-index database handle.
 * @returns Resolves when the advisory write completes (never rejects).
 */
export async function persistDryPairs(dryPairs: DryPairSeed[], root: string): Promise<void> {
  try {
    if (dryPairs.length > 0) {
      const indexDb = CodeIndexDB.getInstance(undefined, root);
      await indexDb.initialize();
      const dryPersistRunId = randomUUID();
      const insertStmt = indexDb.rawDb.prepare(`
        INSERT OR IGNORE INTO dry_pair_history
          (pair_fingerprint, file1, symbol1, line1, content_hash1,
           file2, symbol2, line2, content_hash2, similarity, timestamp, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `);
      const tx = indexDb.rawDb.transaction(() => {
        for (const pair of dryPairs) {
          insertStmt.run(
            pair.pairFingerprint,
            pair.file1, pair.symbol1, pair.line1, pair.contentHash1,
            pair.file2, pair.symbol2, pair.line2, pair.contentHash2,
            pair.similarity,
            dryPersistRunId,
          );
        }
      });
      tx();
    }
  } catch {
    // dry_pair_history persistence is advisory — non-fatal
  }
}

/**
 * Run the React analyzer's cross-component finalization (require-error-boundary
 * / raw-element checks), appending extra violations into the `react` result.
 */
async function finalizeReact(
  reactBundle: ReactVisitorBundle | undefined,
  analyzerResults: Record<string, AnalyzerResult>,
  pipelineAnalyzerConfig: Record<string, Record<string, unknown>>,
): Promise<void> {
  if (reactBundle) {
    try {
      const reactResult = analyzerResults['react'];
      if (reactResult) {
        // Pass the react namespace (not the whole namespaced config) so
        // finalize reads `requireErrorBoundaries`/`rawElementCheck` at the
        // same level the visitor's `context.config` does.
        const extraViolations = await reactBundle.finalizeCrossComponent(
          pipelineAnalyzerConfig['react'] ?? {},
        );
        reactResult.violations.push(...extraViolations);
      }
    } catch (err) {
      logMcpInfo('analysis', 'react finalization failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

/**
 * Build the pipeline, run it, and fold its outputs — plus the both-paths phase
 * split and derived coverage — into a single result bundle for `run`.
 */
async function runPipelineStage(inputs: {
  mergedOptions: AuditRunnerOptions;
  root: string;
  files: string[];
  corpusFiles: string[];
  isScoped: boolean;
  fileAccounting: FileAccounting;
  styleConsumedFiles: string[];
  styleContributingFiles: string[] | undefined;
  analyzers: string[];
  provenanceTiming: { totalMs: number };
}): Promise<PipelineRunResult> {
  const {
    mergedOptions, root, files, corpusFiles, isScoped, fileAccounting,
    styleConsumedFiles, styleContributingFiles, analyzers, provenanceTiming,
  } = inputs;

  const analyzerResults: Record<string, AnalyzerResult> = {};
  let indexFactsWritten = 0;
  let writeIndexFactsMs = 0;

  const { auditIndex, pipelineIndexHandle, indexSkipDiagnostic } = await initializeAuditIndex(root);

  const {
    pipelineVisitors, pipelineReducers, pipelineDerivedReducers,
    reactBundle, solidBundle,
  } = buildPipelineAdapters(analyzers);

  // ── Safeguard warnings ────────────────────────────────────────────────
  if (auditIndex && analyzers.includes('cross-domain')) {
    const suCount = auditIndex.rawSql.count('schema_usage');
    if (suCount === 0) {
      console.warn('[code-audit] ⚠ cross-domain analyzer requires schema_usage data. '
        + 'This is populated during a full audit run by the schema analyzer. '
        + 'If this warning persists, run a full "code-audit audit --path ." first.');
    }
  }

  const hasPipelineAnalyzers = pipelineVisitors.length > 0
    || pipelineReducers.length > 0
    || pipelineDerivedReducers.length > 0;

  // Outputs hoisted so derived coverage (after the split) can read them.
  let phaseFindings: Finding[] = [];
  let phaseIncompleteFacts: ReadonlyMap<FactKind, ReadonlySet<string>> = new Map();
  let pipelineCoverage: RuleCoverage[] | undefined;
  let pipelineTableCatalog: Array<{ table: string; sources: any[] }> | undefined;
  let pipelineStageTiming: Record<string, number> | undefined;
  let pipelineSkippedFiles: Array<{ filePath: string; bytes: number; reason: string }> | undefined;
  let pipelineUnparsedFiles: Array<{ filePath: string; reason: string }> | undefined;
  let pipelineInputPresence: InputPresence | undefined;
  let pipelineRuleTiming: Array<{ ruleId: string; totalMs: number; calls: number }> | undefined;
  let pipelineFileAccounting: FileAccountingSummary | undefined;
  let pipelineDiagnostics: Array<{ analyzerName: string; kind: string; message: string; file?: string; line?: number; details?: Record<string, unknown> }> | undefined;
  let pipelineTestCoverage: TestCoverageReport | undefined;
  let pipelineDeadClusters: DeadCluster[] | undefined;
  let pipelineSizeDistributions: SizeDistribution[] | undefined;
  let routeAttribution: Record<string, 'phase' | 'legacy'> | undefined;
  let receiverDiagnostics: CoverageDiagnostic[] = [];

  if (hasPipelineAnalyzers) {
    const pipelineAnalyzerConfig = buildPipelineAnalyzerConfig(analyzers, mergedOptions, root, files, corpusFiles, provenanceTiming);
    const pipelineConfig = buildPipelineConfig({
      mergedOptions, root, files, isScoped, fileAccounting,
      styleConsumedFiles, styleContributingFiles, analyzers,
      auditIndex, pipelineAnalyzerConfig, pipelineVisitors, pipelineReducers,
      pipelineDerivedReducers,
    });

    try {
      logMcpInfo('analysis', 'running pipeline', { visitorCount: pipelineVisitors.length, reducerCount: pipelineReducers.length, derivedReducerCount: pipelineDerivedReducers.length, fileCount: files.length });
      const pipelineResult = await runPipeline(pipelineConfig, pipelineIndexHandle);

      // §6.3 — the parent is the only index writer; surface its count and
      // wall-clock via stageTiming.
      const stageWriteCount = pipelineResult.metadata.stageTiming?.['index-fact-write-count'];
      const stageWriteMs = pipelineResult.metadata.stageTiming?.['index-fact-write'];
      if (typeof stageWriteCount === 'number') indexFactsWritten = stageWriteCount;
      if (typeof stageWriteMs === 'number') writeIndexFactsMs = stageWriteMs;

      // Pull in pipeline results
      for (const [name, ar] of Object.entries(pipelineResult.analyzerResults)) {
        analyzerResults[name] = ar;
        logMcpDebug('analysis', `pipeline: ${name} completed`, {
          violations: ar.violations?.length ?? 0,
          status: ar.status?.status,
        });
      }

      await finalizeReact(reactBundle, analyzerResults, pipelineAnalyzerConfig);

      const split = await applyPhaseModelSplit({
        mergedOptions, root, files, isScoped, pipelineAnalyzerConfig, analyzerResults, pipelineIndexHandle,
      });
      phaseFindings = split.phaseFindings;
      phaseIncompleteFacts = split.phaseIncompleteFacts;
      routeAttribution = split.routeAttribution;
      receiverDiagnostics = split.receiverDiagnostics;

      // Spec 68 §8 — derived coverage, computed AFTER the split so phaseFindings
      // holds the migrated rules' re-emitted findings.
      pipelineCoverage = deriveCoverage({
        rules: MIGRATED_RULES,
        findings: phaseFindings,
        presentFormats: presentFormatsOf(files),
        enabledRules: enabledMigratedRules(),
        incompleteFacts: phaseIncompleteFacts,
        groupOf: (ruleId) => RULE_ANALYZER.get(ruleId) ?? ruleId,
      });

      // Spec 29: extract table catalog from pipeline metadata for audit report
      pipelineTableCatalog = pipelineResult.metadata?.tableCatalog as Array<{ table: string; sources: any[] }> | undefined;
      pipelineStageTiming = pipelineResult.metadata?.stageTiming;
      pipelineSkippedFiles = pipelineResult.metadata?.skippedFiles;
      pipelineUnparsedFiles = pipelineResult.metadata?.unparsedFiles;
      pipelineInputPresence = pipelineResult.metadata?.inputPresence;
      // Spec 38 R2 — read the live accumulator rather than the `runPipeline`
      // snapshot: the phase model's `analyzeAll` records its per-rule timing
      // after `runPipeline` already snapshotted (empty) `ruleTiming`. The
      // accumulator was reset at `runPipeline` entry, so this is legacy + phase.
      pipelineRuleTiming = getRuleTimingSortedDesc();
      pipelineFileAccounting = pipelineResult.metadata?.fileAccounting;
      pipelineDiagnostics = [
        ...(pipelineResult.metadata?.diagnostics ?? []),
        ...receiverDiagnostics,
      ];
      pipelineTestCoverage = pipelineResult.metadata?.testCoverage;
      pipelineDeadClusters = pipelineResult.metadata?.deadClusters;

      // Spec 60 R2 — aggregate the SOLID analyzer's raw size readings.
      if (solidBundle) {
        const samples = await solidBundle.getSizeSamples();
        pipelineSizeDistributions = computeSizeDistributions(samples);
      }
    } catch (error) {
      if (error instanceof AuditAbortedError) {
        throw error;
      }
      // Pipeline failure — one error, reported once below. Populate a `notRun`
      // placeholder (NOT `visitor-ran` with zero files) for each pipeline analyzer
      // so the zero-files diagnostic does not fan this single failure out into N
      // "matched zero source files" warnings. Exclude infrastructure visitors
      // (function-index) that don't produce violations. The single `pipeline-error`
      // diagnostic below is the one signal the CLI gates on for a non-zero exit.
      const pipelineAnalyzerNames = new Set([
        ...pipelineVisitors.map(v => v.name),
        ...pipelineReducers.map(r => r.name),
        ...pipelineDerivedReducers.map(r => r.name),
      ]);
      pipelineAnalyzerNames.delete('function-index');
      for (const name of pipelineAnalyzerNames) {
        if (!analyzerResults[name]) {
          analyzerResults[name] = {
            violations: [],
            executionTime: 0,
            analyzerName: name,
            status: { status: 'notRun', reason: `pipeline error: ${(error as Error).message}` },
          };
        }
      }
      pipelineDiagnostics = [{
        analyzerName: 'pipeline',
        kind: 'pipeline-error',
        message: (error as Error).message,
      }];
      reportError(mergedOptions, error as Error, 'pipeline');
    }
  }

  // An unavailable index (e.g. a future schema version) is reported as a
  // coverage diagnostic — never raised as a fatal — so the run still completes
  // with the exit code it would otherwise have had.
  if (indexSkipDiagnostic) {
    pipelineDiagnostics = [...(pipelineDiagnostics ?? []), indexSkipDiagnostic];
  }

  return {
    analyzerResults,
    phaseFindings,
    phaseIncompleteFacts,
    pipelineCoverage,
    pipelineTableCatalog,
    pipelineStageTiming,
    pipelineSkippedFiles,
    pipelineUnparsedFiles,
    pipelineInputPresence,
    pipelineRuleTiming,
    pipelineFileAccounting,
    pipelineDiagnostics,
    pipelineTestCoverage,
    pipelineDeadClusters,
    pipelineSizeDistributions,
    routeAttribution,
    indexFactsWritten,
    writeIndexFactsMs,
  };
}

/**
 * Initialize the analyzer-facing CodeIndexDB and build the `IndexHandle` the
 * pipeline reducers read through. Both are optional: a failed init degrades to
 * `undefined` and the pipeline continues without index-backed facts. Hoisted out
 * of `runPipelineStage` so its body stays under the `function-length` ceiling.
 */
async function initializeAuditIndex(root: string): Promise<{
  auditIndex: CodeIndexDB | undefined;
  pipelineIndexHandle: IndexHandle | undefined;
  indexSkipDiagnostic: AuditDiagnostic | undefined;
}> {
  let auditIndex: CodeIndexDB | undefined;
  let indexSkipDiagnostic: AuditDiagnostic | undefined;
  try {
    auditIndex = CodeIndexDB.getInstance(undefined, root);
    await auditIndex.initialize();
    logMcpInfo('analysis', 'code index initialized for analyzers', { isInitialized: (auditIndex as any).isInitialized, dbPath: (auditIndex as any).dbPath });
  } catch (err) {
    // Fail-open (Spec 71 R7 shape): a failed init — including a *future* index
    // schema version — must not crash the audit. Drop the half-built singleton
    // (its concern modules are undefined after a failed createSchema) so every
    // downstream `if (auditIndex)` guard reads "no index", and record the skip
    // as a coverage diagnostic naming the cause so "indexed analysis skipped"
    // is visible in the report, not raised as a fatal.
    auditIndex = undefined;
    const message = err instanceof Error ? err.message : String(err);
    const context = (err as { context?: Record<string, unknown> } | undefined)?.context;
    indexSkipDiagnostic = {
      analyzerName: 'code-index',
      kind: 'engine-error',
      message: `Indexed analysis skipped: ${message}`,
      ...(context && typeof context.storedSchemaVersion === 'number' && typeof context.supportedSchemaVersion === 'number'
        ? { details: { storedSchemaVersion: context.storedSchemaVersion, supportedSchemaVersion: context.supportedSchemaVersion } }
        : {}),
    };
    logMcpInfo('analysis', 'failed to initialize code index for analyzers (continuing)', { error: message });
  }

  // Build IndexHandle for pipeline reducers
  let pipelineIndexHandle: IndexHandle | undefined;
  if (auditIndex) {
    pipelineIndexHandle = {
      query: (sql, params) => auditIndex!.rawSql.query(sql, params),
      count: (table) => auditIndex!.rawSql.count(table),
      tableHasRows: (table) => auditIndex!.rawSql.tableHasRows(table),
      run: (sql, params) => auditIndex!.rawDb.prepare(sql).run(...(params ?? [])),
      exec: (sql) => auditIndex!.rawDb.exec(sql),
      getMeta: (key) => auditIndex!.meta.getMeta(key),
      getUntestedTopDecile: (td) => auditIndex!.coverage.getUntestedTopDecile(td),
      rawDb: auditIndex!.rawDb,
    };
  }
  return { auditIndex, pipelineIndexHandle, indexSkipDiagnostic };
}

/** Shape of a metadata diagnostic (zero-files, lint config, pipeline). */
type AuditDiagnostic = {
  analyzerName: string;
  kind: string;
  message: string;
  file?: string;
  line?: number;
  details?: Record<string, unknown>;
};

/**
 * Build the ordered analyzer-results map from the raw pipeline output: filter
 * to truthy entries (so downstream consumers never see undefineds), and insert
 * the schema sub-visitors and the auto-registered `data-access-org-filter`
 * reducer in their display positions.
 */
function buildOrderedAnalyzerResults(
  analyzers: string[],
  analyzerResults: Record<string, AnalyzerResult>,
): Record<string, AnalyzerResult> {
  const ordered: Record<string, AnalyzerResult> = {};
  for (const analyzerName of analyzers) {
    if (analyzerResults[analyzerName]) {
      ordered[analyzerName] = analyzerResults[analyzerName];
    }
    // When schema is enabled, insert sub-visitor rows after the schema entry
    // so the CLI table shows per-visitor file/fact counts.
    if (analyzerName === 'schema') {
      for (const subName of SCHEMA_SUB_VISITORS) {
        if (analyzerResults[subName]) {
          ordered[subName] = analyzerResults[subName];
        }
      }
    }
    // Spec 62 Amendment B — `data-access-org-filter` is auto-registered (never
    // in analyzers), so surface its Stage-4 row right after data-access.
    if (analyzerName === 'data-access' && analyzerResults['data-access-org-filter']) {
      ordered['data-access-org-filter'] = analyzerResults['data-access-org-filter'];
    }
  }
  return ordered;
}

/**
 * Stamp the `analyzer` field on every violation to its result key. Violations
 * are emitted by analyzers that don't always stamp `analyzer` correctly: the
 * react analyzer omits it entirely, schema sub-visitor helpers hardcode
 * `'schema'`, and the `data-access-org-filter` reducer deliberately labels
 * itself `data-access` to keep the ledger group stable. The result key is the
 * single source of truth.
 */
function stampAnalyzerFields(ordered: Record<string, AnalyzerResult>): void {
  const overrides: Record<string, string> = {
    'data-access-org-filter': 'data-access',
  };
  for (const [resultName, result] of Object.entries(ordered)) {
    const stamped = overrides[resultName] ?? resultName;
    for (const v of result.violations) {
      v.analyzer = stamped;
    }
  }
}

/**
 * Spec 13 R2 — attach hotspot + reachability scores to every violation and
 * reorder within severity tiers (live code first, then higher hotspot, original
 * order as tiebreaker). Advisory — failure is non-fatal (no churn/hotspot data
 * is common on a first run).
 */
async function applyHotspotScoring(
  ordered: Record<string, AnalyzerResult>,
  root: string,
): Promise<void> {
  try {
    const indexDb = CodeIndexDB.getInstance(undefined, root);
    await indexDb.initialize();

    const hotspotRows = indexDb.rawDb
      .prepare('SELECT target, type, score FROM hotspot_scores')
      .all() as Array<{ target: string; type: string; score: number }>;

    const hotspotByTarget = new Map<string, number>();
    const hotspotByFile = new Map<string, number>();
    for (const row of hotspotRows) {
      hotspotByTarget.set(row.target, row.score);
      if (row.type === 'file') {
        hotspotByFile.set(row.target, row.score);
      }
    }

    const reachabilityByFile = new Map<string, number>();
    const reachRows = indexDb.rawDb
      .prepare("SELECT node_key, weight FROM graph_cache WHERE graph_type = 'reachability'")
      .all() as Array<{ node_key: string; weight: number }>;
    for (const row of reachRows) {
      reachabilityByFile.set(row.node_key, row.weight);
    }

    for (const analyzerName of Object.keys(ordered)) {
      const result = ordered[analyzerName];
      const violations = result.violations;

      for (const v of violations) {
        const funcName = v.symbol as string | undefined;
        const file = v.file as string;
        // Try function-level hotspot first: "filePath::symbol"
        const funcTarget = funcName ? `${file}::${funcName}` : undefined;
        v.hotspot = (funcTarget ? hotspotByTarget.get(funcTarget) : undefined)
          ?? hotspotByFile.get(file)
          ?? 0;
        // Files with no cross-language entities (no reachability data) get a
        // neutral 0.5 so we never demote a finding we know nothing about.
        v.reachability = reachabilityByFile.get(file) ?? 0.5;
      }

      const severityOrder: Record<string, number> = {
        critical: 0,
        severe: 1,
        high: 2,
        info: 3,
      };

      const indexed = violations.map((v, i) => ({ v, i }));
      indexed.sort((a, b) => {
        const sevA = severityOrder[a.v.severity] ?? 99;
        const sevB = severityOrder[b.v.severity] ?? 99;
        if (sevA !== sevB) return sevA - sevB;
        const reachA = a.v.reachability ?? 0.5;
        const reachB = b.v.reachability ?? 0.5;
        if (reachA !== reachB) return reachB - reachA;
        const hsA = a.v.hotspot ?? 0;
        const hsB = b.v.hotspot ?? 0;
        if (hsA !== hsB) return hsB - hsA;
        return a.i - b.i;
      });

      result.violations = indexed.map((x) => x.v);
    }
  } catch {
    // Hotspot/reachability reordering is advisory — failure is non-fatal
  }
}

/**
 * Spec 18 R1 — classify the ordered findings against the committed baseline,
 * tagging each violation new/known and computing the baseline metadata. Runs
 * after the hook-contract guard so it classifies exactly the set that reaches
 * the report.
 */
function classifyBaselineFindings(
  ordered: Record<string, AnalyzerResult>,
  mergedOptions: AuditRunnerOptions,
  files: string[],
  isScoped: boolean,
): { projectRoot: string; baselineMetadata: AuditResult['metadata']['baseline'] } {
  const projectRoot = path.resolve(mergedOptions.projectRoot || process.cwd());
  const baseline = loadBaseline(projectRoot);
  let baselineMetadata: AuditResult['metadata']['baseline'];

  if (baseline) {
    const allViolations = Object.values(ordered).flatMap((r) => r.violations);
    // For scoped runs, limit "fixed" to in-scope files
    const scopedFiles = isScoped ? files : undefined;
    const classified = matchFindings(allViolations, baseline, scopedFiles);

    // Tag violations with their baseline status
    for (const v of classified.new) {
      (v as any).new = true;
    }
    for (const v of classified.known) {
      (v as any).new = false;
    }

    baselineMetadata = {
      present: true,
      hash: hashBaseline(baseline),
      newCount: classified.new.length,
      fixedCount: classified.fixed.length,
      knownCount: classified.known.length,
      previousKnownCount: baseline.metadata.totalFindings,
    };

    logMcpInfo('baseline', 'baseline classification complete', {
      new: classified.new.length,
      fixed: classified.fixed.length,
      known: classified.known.length,
    });
  }

  return { projectRoot, baselineMetadata };
}

/** Inputs for the final result construction (post-processing → `AuditResult`). */
interface FinalizeInputs {
  ordered: Record<string, AnalyzerResult>;
  files: string[];
  analyzers: string[];
  mergedOptions: AuditRunnerOptions;
  isScoped: boolean;
  scopeResultType: AuditResultScope;
  indexFactsWritten: number;
  writeIndexFactsMs: number;
  startTime: number;
  startCpu: NodeJS.CpuUsage;
  provenanceTiming: { totalMs: number };
  blastRadius: import('./types.js').BlastRadiusImpact | undefined;
  zeroFilesDiagnostics: DiagnosticWarning[];
  pipelineDiagnostics: AuditDiagnostic[] | undefined;
  rejected: RejectedConfigEntry[];
  lintConfigDiagnostics: AuditDiagnostic[];
  configPath: string | null;
  baselineMetadata: AuditResult['metadata']['baseline'];
  pipelineCoverage: RuleCoverage[] | undefined;
  routeAttribution: Record<string, 'phase' | 'legacy'> | undefined;
  pipelineTableCatalog: Array<{ table: string; sources: any[] }> | undefined;
  pipelineStageTiming: Record<string, number> | undefined;
  thresholdChanges: Array<{ key: string; defaultValue: unknown; effectiveValue: unknown }>;
  thresholdSources: import('./types.js').ThresholdSource[];
  pipelineSkippedFiles: Array<{ filePath: string; bytes: number; reason: string }> | undefined;
  pipelineUnparsedFiles: Array<{ filePath: string; reason: string }> | undefined;
  skippedExtensions: Array<{ ext: string; count: number }> | undefined;
  pipelineInputPresence: InputPresence | undefined;
  pipelineRuleTiming: Array<{ ruleId: string; totalMs: number; calls: number }> | undefined;
  pipelineFileAccounting: FileAccountingSummary | undefined;
  pipelineTestCoverage: TestCoverageReport | undefined;
  pipelineDeadClusters: DeadCluster[] | undefined;
  pipelineSizeDistributions: SizeDistribution[] | undefined;
  collectedFunctions: FunctionMetadata[];
  fileToFunctionsMap: Map<string, FunctionMetadata[]>;
}

/**
 * Build the final `AuditResult` from the ordered findings and the pipeline
 * bundle — summary, metadata assembly (coverage, baseline, diagnostics, the
 * Spec 60 size/test/distribution reports), and hook-contract-clean violations.
 */
function buildAuditResult(inputs: FinalizeInputs): AuditResult {
  const {
    ordered, files, analyzers, mergedOptions, isScoped, scopeResultType,
    indexFactsWritten, writeIndexFactsMs, startTime, startCpu, provenanceTiming,
    blastRadius, zeroFilesDiagnostics, pipelineDiagnostics, rejected,
    lintConfigDiagnostics, configPath, baselineMetadata, pipelineCoverage,
    routeAttribution, pipelineTableCatalog, pipelineStageTiming, thresholdChanges,
    thresholdSources, pipelineSkippedFiles, pipelineUnparsedFiles, skippedExtensions,
    pipelineInputPresence, pipelineRuleTiming, pipelineFileAccounting,
    pipelineTestCoverage, pipelineDeadClusters, pipelineSizeDistributions,
    collectedFunctions, fileToFunctionsMap,
  } = inputs;

  // Spec 69 §10 R4 — count query-shaped call sites whose DB receiver is
  // unproven, keyed by the analyzer that owns the receiver-resolution
  // instrument (`schema`). This is the site-level `cannot-fire` surface that
  // `summary.byAnalyzer[].unprovenSites` carries per analyzer.
  const unprovenSitesByAnalyzer = new Map<string, number>();
  for (const d of pipelineDiagnostics ?? []) {
    if (d.kind !== 'cannot-fire' || d.analyzerName !== 'schema') continue;
    unprovenSitesByAnalyzer.set(d.analyzerName, (unprovenSitesByAnalyzer.get(d.analyzerName) ?? 0) + 1);
  }

  const summary = generateSummary(ordered, files.length, unprovenSitesByAnalyzer);

  return {
    timestamp: new Date(),
    summary,
    analyzerResults: ordered,
    recommendations: [],
    metadata: {
      auditDuration: Date.now() - startTime,
      auditCpuMs: cpuDurationMs(startCpu),
      filesAnalyzed: files.length,
      ...(indexFactsWritten > 0 && { indexFactsWritten, writeIndexFactsMs }),
      analyzersRun: analyzers,
      ...(isScoped && { analyzedFiles: files }),
      configUsed: mergedOptions,
      scope: scopeResultType,
      provenanceResolutionMs: provenanceTiming.totalMs,
      ...(blastRadius && { blastRadius }),
      ...((zeroFilesDiagnostics.length > 0 || (pipelineDiagnostics?.length ?? 0) > 0 || rejected.length > 0 || lintConfigDiagnostics.length > 0) && {
        diagnostics: [
          ...zeroFilesDiagnostics,
          ...(pipelineDiagnostics ?? []),
          ...lintConfigDiagnostics,
          ...rejected.map((entry) => ({
            analyzerName: 'config',
            kind: 'config-key-rejected',
            message: `${entry.key}: ${entry.value} (${entry.reason})`,
            ...(configPath ? { file: configPath } : {}),
            details: { key: entry.key, value: entry.value, reason: entry.reason },
          })),
        ],
      }),
      ...(baselineMetadata && { baseline: baselineMetadata }),
      ...(pipelineCoverage && { coverage: pipelineCoverage }),
      ...(routeAttribution && { routeAttribution }),
      ...(pipelineTableCatalog && { tableCatalog: pipelineTableCatalog }),
      ...(pipelineStageTiming && { stageTiming: pipelineStageTiming }),
      ...(thresholdChanges.length > 0 && { thresholdChanges }),
      ...(thresholdSources.length > 0 && { thresholdSources }),
      ...(pipelineSkippedFiles && pipelineSkippedFiles.length > 0 && { skippedFiles: pipelineSkippedFiles }),
      ...(pipelineUnparsedFiles && pipelineUnparsedFiles.length > 0 && { unparsedFiles: pipelineUnparsedFiles }),
      ...(skippedExtensions && skippedExtensions.length > 0 && { skippedExtensions }),
      ...(pipelineInputPresence && { inputPresence: pipelineInputPresence }),
      ...(pipelineRuleTiming && { ruleTiming: pipelineRuleTiming }),
      ...(pipelineFileAccounting && { fileAccounting: pipelineFileAccounting }),
      ...(pipelineTestCoverage && { testCoverage: pipelineTestCoverage }),
      ...(pipelineDeadClusters && pipelineDeadClusters.length > 0 && { deadClusters: pipelineDeadClusters }),
      ...(pipelineSizeDistributions && pipelineSizeDistributions.length > 0 && { sizeDistributions: pipelineSizeDistributions }),
      ...(collectedFunctions.length > 0 && {
        collectedFunctions,
        fileToFunctionsMap: Object.fromEntries(fileToFunctionsMap)
      })
    }
  };
}

/**
 * Spec 11 R1 — fire-and-forget write to the findings ledger. Non-fatal: the
 * ledger is advisory, so a failed write never invalidates the audit result.
 * Forked shard workers set `writeToLedger:false` (handled by the caller's
 * guard here) so the parent run is the single writer.
 */
function fireLedgerWrite(inputs: {
  mergedOptions: AuditRunnerOptions;
  root: string;
  options: AuditRunnerOptions;
  scope: import('./types.js').AuditScope;
  ordered: Record<string, AnalyzerResult>;
  result: AuditResult;
  startTime: number;
}): void {
  if (inputs.mergedOptions.writeToLedger === false) {
    return;
  }
  void (async () => {
    try {
      const indexDb = CodeIndexDB.getInstance(undefined, inputs.root);
      await indexDb.initialize();
      const violations = Object.values(inputs.ordered).flatMap((ar) => ar.violations);
      const scopeStr = Array.isArray(inputs.scope) ? `files:${inputs.scope.length}` : (inputs.scope ?? 'all');
      return writeAuditToLedger(
        indexDb.rawDb,
        detectRunInput(
          process.argv.slice(2).join(' '),
          (inputs.options as any).surface ?? 'cli',
          scopeStr,
          inputs.root,
          TOOL_VERSION,
        ),
        violations,
        Date.now() - inputs.startTime,
        0, // exit status TBD — updateLedgerRunStatus by CLI after return
        { coverage: inputs.result.metadata.coverage },
      );
    } catch (_err) {
      // ledger write is non-fatal — audit result is still valid
      return null;
    }
  })();
}


/**
 * Create an audit runner with the given options
 *
 * @param options - Audit runner options (project root, analyzer config, thresholds).
 */
export function createAuditRunner(options: AuditRunnerOptions = {}) {
  /**
   * Load configuration from file
   */
  async function loadConfiguration(configPath: string): Promise<AuditRunnerOptions> {
    const { config } = await loadConfig({ configPath, projectRoot: path.dirname(configPath) });
    return { ...options, ...config };
  }
  
  /**
   * Run the audit
   */
  async function run(runOptions?: AuditRunnerOptions): Promise<AuditResult> {
    const {
      mergedOptions,
      configPath,
      rejected,
      lintConfigDiagnostics,
      thresholdChanges,
      thresholdSources,
    } = await resolveRunConfig(options, runOptions);

    const startTime = Date.now();
    // CPU-time clock for the load-independent gate metric (Spec 38 R3 / Spec 43
    // R2-R3): wall clock conflates a slow rule with a slow machine; CPU time
    // isolates the rule cost. Captured alongside the wall clock so both stay in
    // the same scope (everything from scope resolution through result creation).
    const startCpu = process.cpuUsage();
    const root = path.resolve(mergedOptions.projectRoot || process.cwd());
    // One-time notice for a legacy in-repo index location (`.code-index` /
    // `node_modules/.cache/code-auditor`) left by a pre-move build — reported once,
    // never deleted (see legacyIndexNotice.ts).
    notifyLegacyIndexLocation(root);
    // Spec 44 — file accounting accumulator, owned by the run. Threaded through
    // discovery (full `all` scope) and the pipeline (stage 1/2) so every touched
    // file lands in exactly one terminal state and the balance can be asserted.
    const fileAccounting = new FileAccounting();

    const {
      files,
      changedFunctions,
      skippedExtensions,
      blastRadius,
      corpusFiles,
      scope,
      isScoped,
      scopeResultType,
    } = await discoverAuditFiles(mergedOptions, root, fileAccounting);

    const { collectedFunctions, fileToFunctionsMap } = await collectIndexedFunctions(mergedOptions, files);

    // Run analyzers
    // Spec 68 §15 — no selection model: the full pipeline always runs. `indexOnly`
    // skips analysis wholesale (the index-only harness); config cannot pick a subset.
    const analyzers: string[] = mergedOptions.indexOnly ? [] : [...RUN_ANALYZERS];

    logMcpInfo('analysis', 'enabled analyzers', {
      names: analyzers,
      fileCount: files.length,
      scope: scopeResultType
    });

    // Spec 21: Shared timing accumulator for provenance resolution.
    const provenanceTiming = { totalMs: 0 };

    const { styleConsumedFiles, styleContributingFiles } = await syncStyles(analyzers, root, files, isScoped);

    const pipeline = await runPipelineStage({
      mergedOptions, root, files, corpusFiles, isScoped, fileAccounting,
      styleConsumedFiles, styleContributingFiles, analyzers, provenanceTiming,
    });
    const {
      analyzerResults, phaseFindings, phaseIncompleteFacts, pipelineCoverage,
      pipelineTableCatalog, pipelineStageTiming, pipelineSkippedFiles,
      pipelineUnparsedFiles, pipelineInputPresence, pipelineRuleTiming,
      pipelineFileAccounting, pipelineDiagnostics, pipelineTestCoverage,
      pipelineDeadClusters, pipelineSizeDistributions, routeAttribution,
      indexFactsWritten, writeIndexFactsMs,
    } = pipeline;

    // ── Zero-files diagnostic ─────────────────────────────────────────────
    // Extracted to runZeroFilesDiagnostics() for testability. Runs against the
    // raw analyzerResults before truthiness filtering so the "no result" pass
    // catches analyzers skipped by the registry, abort, or handoff exceptions.
    const hasGoFiles = files.some((f) => f.endsWith('.go'));
    const zeroFilesDiagnostics = runZeroFilesDiagnostics(analyzers, analyzerResults, files.length, hasGoFiles);
    for (const w of zeroFilesDiagnostics) {
      console.warn(w.message);
    }
    // Build ordered results — filter to truthy entries so downstream consumers
    // (DRY pair persistence, baseline, report generation) don't see undefineds.
    const orderedAnalyzerResults = buildOrderedAnalyzerResults(analyzers, analyzerResults);

    // Normalize the analyzer field on every violation to its result key (the
    // single source of truth — see stampAnalyzerFields).
    stampAnalyzerFields(orderedAnalyzerResults);

    // Spec 13 R2 — hotspot scoring & finding reordering (advisory).
    await applyHotspotScoring(orderedAnalyzerResults, root);

    // Hook-contract guard: no violation may carry an empty file path, line 0, or
    // missing line. A sentinel violation with file:'' broke the Claude Code hook's
    // JSON consumer (Spec 15 regression); line:0 from CrossDomainAnalyzer broke it
    // again (Spec 22 alarm #1). Permanent — every analyzer code path must produce
    // properly anchored violations. Operates on the originals (via splice).
    for (const ar of Object.values(orderedAnalyzerResults)) {
      validateHookContract(ar.violations);
    }

    // Baseline classification (Spec 18 R1) — after the hook-contract guard so it
    // classifies exactly the violation set that reaches the report.
    const { projectRoot, baselineMetadata } = classifyBaselineFindings(
      orderedAnalyzerResults, mergedOptions, files, isScoped
    );

    const result = buildAuditResult({
      ordered: orderedAnalyzerResults,
      files,
      analyzers,
      mergedOptions,
      isScoped,
      scopeResultType,
      indexFactsWritten,
      writeIndexFactsMs,
      startTime,
      startCpu,
      provenanceTiming,
      blastRadius,
      zeroFilesDiagnostics,
      pipelineDiagnostics,
      rejected,
      lintConfigDiagnostics,
      configPath,
      baselineMetadata,
      pipelineCoverage,
      routeAttribution,
      pipelineTableCatalog,
      pipelineStageTiming,
      thresholdChanges,
      thresholdSources,
      pipelineSkippedFiles,
      pipelineUnparsedFiles,
      skippedExtensions,
      pipelineInputPresence,
      pipelineRuleTiming,
      pipelineFileAccounting,
      pipelineTestCoverage,
      pipelineDeadClusters,
      pipelineSizeDistributions,
      collectedFunctions,
      fileToFunctionsMap,
    });

    // Report completion
    reportProgress(mergedOptions, {
      phase: 'reporting',
      message: 'Generating reports...'
    });

    // Spec 57 — apply committed dismissals: mark matching findings dismissed
    // (they never gate) and record the dismissed count in the summary (never
    // subtracted from totalViolations).
    applyDismissals(result, projectRoot);

    // Spec 11 R1 — write to findings ledger (non-fatal: ledger is advisory).
    fireLedgerWrite({ mergedOptions, root, options, scope, ordered: orderedAnalyzerResults, result, startTime });

    return result;
  }
  
  /**
   * Generate report in specified format
   */
  async function generateReportForResult(result: AuditResult, format: string): Promise<string> {
    return generateReport(result, format as any);
  }
  
  return {
    loadConfiguration,
    run,
    generateReport: generateReportForResult
  };
}

/**
 * Discover files to analyze
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const r = signal.reason;
  if (r instanceof Error) {
    throw r;
  }
  throw new AuditAbortedError(String(r ?? 'Audit aborted'));
}

async function discoverProjectFiles(
  options: AuditRunnerOptions,
  fileAccounting?: FileAccounting
): Promise<{ files: string[]; skippedExtensions: Array<{ ext: string; count: number }> }> {
  const rootDir = path.resolve(options.projectRoot || process.cwd());
  if (options.explicitFiles !== undefined) {
    // Explicitly scoped files — the user named them, so extension skipping is
    // not a silent drop (and discovery-by-extension never runs).
    return {
      files: [...new Set(options.explicitFiles.map((f) => path.resolve(f)))].sort(),
      skippedExtensions: []
    };
  }
  return discoverFilesDetailed(rootDir, {
    includePaths: options.includePaths,
    excludePaths: options.excludePaths,
    extensions: options.fileExtensions, // Use override if provided
    excludeDirs: undefined, // This will use DEFAULT_EXCLUDED_DIRS which includes node_modules
    ...(fileAccounting ? { fileAccounting } : {})
  });
}

/**
 * Resolve git:<ref> scope: get files from `git diff --name-only <ref>`
 * plus untracked files. Requires a git worktree.
 */
function resolveGitScopeFiles(options: AuditRunnerOptions, ref: string): string[] {
  const rootDir = path.resolve(options.projectRoot || process.cwd());

  // Validate the ref before it reaches git. An argv array alone is not enough —
  // git accepts `--output=<file>`, so `git:--output=/etc/cron.d/x` is still a
  // write primitive through execFileSync. The leading character class rejects
  // anything beginning with `-`. `--end-of-options` below is the second guard;
  // neither suffices alone.
  const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:-]*(\.\.\.?[A-Za-z0-9][A-Za-z0-9._/@{}^~:-]*)?$/;
  if (!GIT_REF_PATTERN.test(ref)) {
    throw new Error(`Invalid git ref in scope: ${JSON.stringify(ref)}`);
  }

  // Verify git worktree
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: rootDir, stdio: 'pipe' });
  } catch {
    throw new Error(
      `git:<ref> scope requires a git worktree. "${rootDir}" is not a git repository.`
    );
  }

  const files = new Set<string>();

  // git diff --name-only <ref>
  try {
    const diffOutput = execFileSync('git', ['diff', '--name-only', '--end-of-options', ref], {
      cwd: rootDir,
      stdio: 'pipe',
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });
    for (const line of diffOutput.trim().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(path.resolve(rootDir, trimmed));
    }
  } catch (err) {
    throw new Error(
      `Failed to run git diff --name-only ${ref}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Untracked files
  try {
    const untrackedOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: rootDir,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    for (const line of untrackedOutput.trim().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(path.resolve(rootDir, trimmed));
    }
  } catch {
    // No untracked files or git error — non-fatal
  }

  return [...files].sort();
}

/**
 * Resolve files scope: paths can be file paths or globs.
 * Absolute paths are used directly; relative paths are resolved
 * against the project root; globs use discoverFiles. A direct path whose
 * extension no analyzer claims (nor a raw/markup extension the pipeline reads
 * directly) is dropped — see `getSourceExtensions` — so a prose edit never
 * reaches the pipeline as a "dark analyzer" and trips the zero-files gate.
 *
 * @param options - The merged audit-runner options (`projectRoot`, `excludePaths`,
 *   `fileExtensions`).
 * @param scopeFiles - Candidate paths or globs to resolve into an absolute file
 *   set.
 * @returns The sorted set of absolute paths that are in audit scope.
 */
export async function resolveFilesScope(
  options: AuditRunnerOptions,
  scopeFiles: string[]
): Promise<string[]> {
  const rootDir = path.resolve(options.projectRoot || process.cwd());
  const result = new Set<string>();

  for (const item of scopeFiles) {
    if (item.includes('*') || item.includes('?') || item.includes('[')) {
      // Glob pattern
      const matches = await discoverFiles(rootDir, {
        includePaths: [item],
        excludePaths: options.excludePaths,
        extensions: options.fileExtensions,
        excludeDirs: undefined
      });
      for (const m of matches) result.add(m);
    } else {
      // Direct file path — skip files that don't exist, and files no analyzer
      // understands. A file whose extension is not claimed by the language
      // registry (nor a raw/markup extension the pipeline reads directly) was
      // never in scope: it must not enter `files` and trip the zero-files gate
      // as a "dark analyzer", which would turn a prose edit into an exit-2 hook
      // failure. The Spec 32 parse-failure gate is untouched — a claimed-but-
      // unparseable file (a `.ts` that fails to parse) still reaches the
      // pipeline and stays loud. The gate is the registry union (via
      // `getSourceExtensions`), not a hand-maintained extension list, so a parser
      // added to the registry is in scope here without a second edit.
      const resolved = path.isAbsolute(item) ? item : path.resolve(rootDir, item);
      const ext = path.extname(resolved).toLowerCase();
      if (!getSourceExtensions().has(ext)) continue;
      try {
        await fs.stat(resolved);
        result.add(resolved);
      } catch {
        // File doesn't exist — skip silently
      }
    }
  }

  return [...result].sort();
}





/**
 * Generate audit summary.
 *
 * Exported for the Spec 69 §10 R4 pin: `summary.byAnalyzer[].unprovenSites`
 * must carry the site-level cannot-fire count per analyzer.
 *
 * @param analyzerResults per-analyzer results, keyed by analyzer name
 * @param filesAnalyzed total number of files processed this run
 * @param unprovenSitesByAnalyzer per-analyzer count of unproven (cannot-fire) sites
 */
export function generateSummary(
  analyzerResults: Record<string, AnalyzerResult>,
  filesAnalyzed: number,
  unprovenSitesByAnalyzer: ReadonlyMap<string, number> = new Map(),
) {
  let totalViolations = 0;
  let criticalIssues = 0;
  let severe = 0;
  let high = 0;
  const violationsByCategory: Record<string, number> = {};
  const byAnalyzer: Record<string, { violations: number; filesProcessed: number; fatalErrors: number; unprovenSites: number }> = {};

  for (const [analyzer, result] of Object.entries(analyzerResults)) {
    let analyzerViolations = 0;
    for (const violation of result.violations) {
      totalViolations++;
      analyzerViolations++;

      switch (violation.severity) {
        case 'critical':
          criticalIssues++;
          break;
        case 'severe':
          severe++;
          break;
        case 'high':
          high++;
          break;
      }

      const category = violation.rule;
      violationsByCategory[category] = (violationsByCategory[category] || 0) + 1;
    }

    byAnalyzer[analyzer] = {
      violations: analyzerViolations,
      filesProcessed: getFilesProcessed(result.status),
      fatalErrors: result.errors ? result.errors.length : 0,
      unprovenSites: unprovenSitesByAnalyzer.get(analyzer) ?? 0,
    };
  }

  // Compute top issues from violationsByCategory
  const topIssues = Object.entries(violationsByCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  return {
    totalFiles: filesAnalyzed,
    totalViolations,
    criticalIssues,
    severe,
    high,
    violationsByCategory,
    byAnalyzer,
    topIssues
  };
}

/**
 * Hook-contract regression guard.
 *
 * Every violation must carry a non-empty `file` path. A sentinel violation with
 * `file: ''` (Spec 15 regression, commit 3419ed0) broke the Claude Code hook's
 * JSON consumer, which expects every violation to anchor to a real file.
 *
 * When `line` is present, it must be > 0 — a zero line means the analyzer
 * failed to locate the finding and shipped an unactionable anchor.
 *
 * Contract violations are logged as warnings and dropped from the pipeline
 * (they are never written to the ledger or surfaced to the hook).
 *
 * This guard is permanent — no analyzer code path may produce violations with
 * empty file paths or line 0.
 */
function validateHookContract(violations: Violation[]): void {
  for (let i = violations.length - 1; i >= 0; i--) {
    const v = violations[i];
    let drop = false;
    if (!v.file || v.file.trim() === '') {
      drop = true;
    }
    if (v.line === undefined || v.line === null) {
      drop = true;
    }
    if (v.line !== undefined && v.line !== null && v.line < 1) {
      drop = true;
    }
    if (drop) {
      // Silent filter — no console output. The hook-audit.sh script does NOT
      // merge stderr into stdout, but any console.warn/console.error output
      // would still corrupt the JSON stream if it reached stdout.
      // The structured logger writes to stderr only, so it's safe.
      violations.splice(i, 1);
    }
  }
}

/**
 * Report progress
 */
function reportProgress(options: AuditRunnerOptions, progress: Partial<AuditProgress>): void {
  if (options.progressCallback) {
    options.progressCallback({
      current: 0,
      total: 0,
      analyzer: '',
      ...progress
    } as AuditProgress);
  }
}

/**
 * Report error
 */
function reportError(options: AuditRunnerOptions, error: Error, context: string): void {
  if (options.errorCallback) {
    options.errorCallback(error, context);
  } else {
    console.error(`Error in ${context}:`, error);
  }
}

/**
 * Merge lint-sourced thresholds (namespace-scoped fragments) as a base layer
 * under the project config, filling only keys the project did not set. The
 * lint fragment holds flat scalar keys (e.g. `solid.maxLinesPerMethod`), so a
 * shallow per-namespace merge is sufficient — project values win on collision,
 * and any other keys in the project's namespace survive untouched.
 */
function mergeLintUnderProject(
  lintFragment: Record<string, Record<string, number>>,
  projectConfig: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...projectConfig };
  for (const [namespace, fragment] of Object.entries(lintFragment)) {
    const existing = out[namespace];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      out[namespace] = { ...fragment, ...(existing as Record<string, unknown>) };
    } else {
      out[namespace] = { ...fragment };
    }
  }
  return out;
}

// ── Zero-files diagnostic (extracted for testability) ───────────────────────

export interface DiagnosticWarning {
  analyzerName: string;
  kind: 'no-result' | 'zero-files';
  message: string;
}

/**
 * Runs post-audit diagnostics on enabled analyzers vs. results.
 *
 * Pass 1: Every enabled analyzer must appear in the results map. An absent entry
 * means the analyzer was skipped (unregistered, aborted, handoff-exception).
 *
 * Pass 2: Every analyzer with a result entry but filesProcessed === 0 and no
 * errors fires a warning — the analyzer ran but matched zero source files.
 *
 * @param analyzers - Names of the enabled analyzers to check against the results.
 * @param analyzerResults - Map of analyzer name to its audit result.
 * @param totalFiles - Total files processed; a zero total suppresses the warning as expected.
 * @param hasGoFiles - Whether the corpus contained `.go` files (false excuses a skipped `go` analyzer).
 * @returns Diagnostic warnings for analyzers that produced no result or matched zero files.
 */
export function runZeroFilesDiagnostics(
  analyzers: string[],
  analyzerResults: Record<string, AnalyzerResult>,
  totalFiles?: number,
  hasGoFiles?: boolean,
): DiagnosticWarning[] {
  // When there were zero files to process, zero-files is expected, not a bug.
  if (totalFiles === 0) return [];

  const warnings: DiagnosticWarning[] = [];

  // Pass 1: enabled but absent from results
  for (const analyzerName of analyzers) {
    if (!analyzerResults[analyzerName]) {
      // The `go` analyzer is a polyglot subprocess that runs only when `.go`
      // files exist. On a TypeScript-only corpus
      // it is legitimately notApplicable, not a dropped analyzer (defect #50) —
      // zero `.go` files means there was nothing for it to run on.
      if (analyzerName === 'go' && hasGoFiles === false) continue;
      warnings.push({
        analyzerName,
        kind: 'no-result',
        message:
          `⚠️  ${analyzerName} analyzer: enabled but produced no result. ` +
          `The analyzer may not be registered or may have been silently dropped.`,
      });
    }
  }

  // Pass 2: filesProcessed = 0 — a dark-analyzer failure. Visitors with declared
  // extensions that matched zero files in the corpus are benign (converted to
  // notRun by the pipeline), but a visitor that was dispatched files and still
  // shows visitor-ran + 0 files is broken. When it errored, name the file(s) and
  // error(s) — "check file extensions" is the wrong cause for a parse/visit error
  // and would send the reader to look at configuration when a file failed.
  for (const [analyzerName, result] of Object.entries(analyzerResults)) {
    if (analyzerName === 'go' && hasGoFiles === false) continue;
    if (
      isVisitorStatus(result.status) && getFilesProcessed(result.status) === 0
    ) {
      const errs = (result as any).errors as Array<{ file: string; error: string }> | undefined;
      const errDetail = errs && errs.length > 0
        ? ` — ${errs.length} file error(s): ${errs.slice(0, 3).map((e) => `${e.file}: ${e.error}`).join('; ')}${errs.length > 3 ? ' …' : ''}`
        : '';
      warnings.push({
        analyzerName,
        kind: 'zero-files',
        message: errDetail
          ? `⚠️  ${analyzerName} analyzer: filesProcessed = 0${errDetail}.`
          : `⚠️  ${analyzerName} analyzer: filesProcessed = 0. ` +
            `The analyzer ran but matched zero source files. Check file extensions, ` +
            `scanner configuration, and project structure.`,
      });
    }
  }

  return warnings;
}

/**
 * Run audit with default runner (convenience function)
 */
export async function runAudit(options?: AuditRunnerOptions): Promise<AuditResult> {
  const runner = createAuditRunner(options);
  return runner.run();
}

export type { AuditProgress, AuditRunnerOptions } from './types.js';