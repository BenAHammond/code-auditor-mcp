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
} from './types.js';
import { discoverFiles, discoverFilesDetailed } from './utils/fileDiscovery.js';
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
import { readTsconfigAliases, readPackageEntryPoints, DEFAULT_VIRTUAL_MODULES } from './graph/importClassification.js';

// Import universal analyzers
import { initializeLanguages } from './languages/index.js';
import { initializeOrmAdapters } from './analyzers/orm/index.js';
import { syncStyleIndex } from './styles/styleIndexer.js';


import { CodeIndexDB } from './codeIndexDB.js';
import { writeAuditToLedger, detectRunInput } from './ledger.js';

// Pipeline imports (Spec 25 — pipeline replaces hand-rolled analyzer loop)
import { runPipeline, writeIndexFactsToDb, makeVisitorStatus, getFilesProcessed, isVisitorStatus } from './pipeline.js';
import {
  createSolidVisitor,
  createDryVisitor,
  createDataAccessVisitor,
  createOrgFilterReducer,
  createDocumentationVisitor,
  createSecretsVisitor,
  createSecurityVisitor,
  createFunctionIndexVisitor,
  createStylesCssVisitor,
  createStylesSourceVisitor,
  createReactVisitor,
  createStylesReducer,
  createConventionsReducer,
  createCrossDomainReducer,
  createInvariantsReducer,
  createSchemaSqlVisitor,
  createSchemaCodeVisitor,
  createSchemaPrismaVisitor,
  createSchemaJsonVisitor,
  createSchemaReducer,
  createCrossLanguageEntityVisitor,
  createSchemaValidatorReducer,
  createAPIContractReducer,
  createDependencyGraphReducer,
} from './pipelineAdapters.js';
import type { DryVisitorBundle, ReactVisitorBundle, SolidVisitorBundle } from './pipelineAdapters.js';
import type { PipelineConfig, PipelineResult, IndexHandle, Stage2Visitor, Stage3Reducer, Stage4Reducer, TestCoverageReport, DeadCluster, SizeDistribution } from './types.js';
import { computeSizeDistributions } from './reporting/sizeDistribution.js';
import { splitRoutes, attributeRoutes, enabledMigratedRules } from './phase/routing.js';
import { runPhaseModel, type PhaseInfra } from './phase/phaseModel.js';
import { resolvePhaseThresholds } from './phase/config.js';
import { deriveCoverage, presentFormatsOf } from './phase/coverage.js';
import { MIGRATED_RULES, RULE_ANALYZER } from './phase/rules/registry.js';
import type { Finding, FactKind } from './phase/types.js';

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
 * Create an audit runner with the given options
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
    // Auto-load .codeauditor.json so the programmatic API respects the same
    // config the CLI surface reads. Walk UP from the audit path so a scoped
    // audit (`--path src`) still finds the project-root config rather than
    // silently using defaults. RunOptions (caller) override file config, and
    // createAuditRunner options override both.
    const rootForConfig = runOptions?.projectRoot || options.projectRoot || process.cwd();
    const configPath = await findConfigFileUp(rootForConfig);
    let fileConfig: Partial<AuditRunnerOptions> = {};
    let rejected: RejectedConfigEntry[] = [];
    if (configPath) {
      const loaded = await loadConfig({ configPath, projectRoot: rootForConfig });
      fileConfig = loaded.config;
      rejected = loaded.rejected;
    }
    const mergedOptions = { ...fileConfig, ...options, ...runOptions };

    // Spec 36 R5 — a threshold change needs a written rationale. Check the
    // user-facing analyzerConfigs layer (project config + inline options)
    // BEFORE presets merge in, so curated presets never trip the guard. Any
    // changed threshold without a rationale is a config error, not a warning.
    const thresholdCheck = checkThresholdRationales(
      mergedOptions.analyzerConfigs as Record<string, unknown> | undefined,
      (mergedOptions as AuditRunnerOptions).rationales,
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
    // so lint-sourced values (the project's own declared lint rules, not a
    // code-auditor threshold decision) never trip the Spec 36 R5 guard. Fail-open:
    // no config, or an unloadable config, is absent — defaults, not an error.
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
      mergedOptions.analyzerConfigs = applyPresets(
        presetIds,
        mergedOptions.analyzerConfigs
      );
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

    const startTime = Date.now();
    // CPU-time clock for the load-independent gate metric (Spec 38 R3 / Spec 43
    // R2-R3): wall clock conflates a slow rule with a slow machine; CPU time
    // isolates the rule cost. Captured alongside the wall clock so both stay in
    // the same scope (everything from scope resolution through result creation).
    const startCpu = process.cpuUsage();

    // ── Scope resolution ─────────────────────────────────────────────
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

    // Spec 44 — file accounting accumulator, owned by the run. Threaded through
    // discovery (full `all` scope) and the pipeline (stage 1/2) so every touched
    // file lands in exactly one terminal state and the balance can be asserted.
    const fileAccounting = new FileAccounting();

    if (typeof scope === 'string' && scope.startsWith('git:')) {
      // git:<ref> scope
      const gitRef = scope.slice(4);
      files = resolveGitScopeFiles(mergedOptions, gitRef);
      logMcpInfo('discovery', 'git scope resolved', {
        ref: gitRef,
        fileCount: files.length
      });
    } else if (scope === 'changed') {
      // Changed scope: detect modified files
      const db = CodeIndexDB.getInstance(undefined, mergedOptions.projectRoot || process.cwd());
      await db.initialize();
      const modifiedFiles = mergedOptions.explicitFiles !== undefined
        ? mergedOptions.explicitFiles
        : await db.detectModifiedFiles(
            path.resolve(mergedOptions.projectRoot || process.cwd())
          );
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
        for (const fn of changedFunctions) {
          const row = rawDb.prepare(
            'SELECT id FROM functions WHERE name = ? AND file_path = ?'
          ).get(fn.name, fn.filePath) as { id: number } | undefined;
          if (row) functionIds.push(row.id);
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

    const root = path.resolve(mergedOptions.projectRoot || process.cwd());

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

    // Collect functions if enabled
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

    // Run analyzers
    const analyzerResults: Record<string, AnalyzerResult> = {};
    // Spec 68 §15 — no selection model: the full pipeline always runs. `indexOnly`
    // skips analysis wholesale (the index-only harness); config cannot pick a subset.
    const analyzers: string[] = mergedOptions.indexOnly ? [] : [...RUN_ANALYZERS];

    // ── Style index sync (Spec 10) ────────────────────────────────────
    // Sync style declarations, tokens, and class usage before the
    // styles analyzer runs, mirroring the function index sync pattern.
    // Spec 44: the indexer readFileSyncs every discovered file (except
    // `.css`/`.scss`), so `consumedFiles` is the "any layer read it" evidence
    // for files dropped at stage 2 — threaded into the pipeline below.
    let styleConsumedFiles: string[] = [];
    // In-scope files that contributed style data during the sync. Undefined when
    // the sync did not run or failed — the styles reducer must not short-circuit
    // on that (it falls back to full analysis), so we only assign on success.
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

    // Spec 21: Shared timing accumulator for provenance resolution.
    // Injected into data-access and schema analyzers so they can report
    // per-file buildProvenanceContext() wall time (hook-latency measurement).
    const provenanceTiming = { totalMs: 0 };
    let pipelineCoverage: RuleCoverage[] | undefined;
    // Spec 68 §8 — the migrated rules' findings, hoisted out of the both-paths
    // block so derived coverage (computed after the split) can read them.
    let phaseFindings: Finding[] = [];
    // §3.3/§8 — per-file fact completeness (parse dropped / producer threw),
    // fed into derived coverage so the fifth state (`incomplete`) is reachable
    // from a real run, not only the synthetic coverage unit test.
    let phaseIncompleteFacts: ReadonlyMap<FactKind, ReadonlySet<string>> = new Map();
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
    // Spec 68 §11.1 — per-rule route attribution (phase model vs legacy pipeline),
    // derived from MIGRATED_RULES and surfaced in result metadata for the
    // conformance test. Always populated (an empty MIGRATED_RULES means every
    // rule is `legacy`), so the split is observable even mid-migration.
    let routeAttribution: Record<string, 'phase' | 'legacy'> | undefined;
    logMcpInfo('analysis', 'enabled analyzers', {
      names: analyzers,
      fileCount: files.length,
      scope: scopeResultType
    });

    // ── Initialize CodeIndexDB for analyzer DB access ────────────────────
    // Styles, conventions, and cross-domain analyzers read config.indexHandle
    // for DB access. The singleton is shared — initialize once before the
    // analyzer run loop so ensureInitialized() is a no-op for each call.
    let auditIndex: CodeIndexDB | undefined;
    try {
      auditIndex = CodeIndexDB.getInstance(undefined, root);
      await auditIndex.initialize();
      logMcpInfo('analysis', 'code index initialized for analyzers', { isInitialized: (auditIndex as any).isInitialized, dbPath: (auditIndex as any).dbPath });
    } catch (err) {
      // Non-fatal: analyzers that need indexHandle will skip DB-dependent
      // checks and report "No index handle available" in their errors.
      logMcpInfo('analysis', 'failed to initialize code index for analyzers (continuing)', {
        error: err instanceof Error ? err.message : String(err)
      });
    }

    // ── Analyzer execution ──────────────────────────────────────────────
    // Spec 25 R3: The pipeline replaces the hand-rolled concurrent
    // analyzer loop. Visitors run per-file in stage 2, corpus reducers
    // run in stage 3, and derived reducers (cross-domain) run in stage 4.
    // Schema runs outside the pipeline because it needs ALL file types (SQL, JSON, TS).
    // Invariants runs inside the pipeline as a Stage 3 reducer (Spec 41 Part C).

    // Build IndexHandle for pipeline reducers
    let pipelineIndexHandle: IndexHandle | undefined;
    if (auditIndex) {
      pipelineIndexHandle = {
        query: (sql, params) => auditIndex!.query(sql, params),
        count: (table, where, params) => auditIndex!.count(table, where, params),
        tableHasRows: (table) => auditIndex!.tableHasRows(table),
        run: (sql, params) => auditIndex!.rawDb.prepare(sql).run(...(params ?? [])),
        exec: (sql) => auditIndex!.rawDb.exec(sql),
        getMeta: (key) => auditIndex!.getMeta(key),
        getUntestedTopDecile: (td) => auditIndex!.getUntestedTopDecile(td),
        rawDb: auditIndex!.rawDb,
      };
    }

    // ── 1. Build pipeline adapters ───────────────────────────────────────
    const pipelineVisitors: Stage2Visitor[] = [];
    const pipelineReducers: Stage3Reducer[] = [];
    const pipelineDerivedReducers: Stage4Reducer[] = [];

    let dryBundle: DryVisitorBundle | undefined;
    let reactBundle: ReactVisitorBundle | undefined;
    let solidBundle: SolidVisitorBundle | undefined;

    // Spec 68 §15 — once every registry rule is migrated, the legacy pipeline's
    // rule-emitting visitors/reducers produce findings the phase model already
    // emits (they are stripped to zero at the both-paths split). Only the
    // infrastructure that still has a side-effect the phase model reads from the
    // index must keep running: function-index (`functions` + `graph_cache`),
    // styles-css/source (`style_*` tables), dry (`dry_pair_history`), plus the
    // pipeline-only `invariants` reducer (user-defined rules from
    // `.codeauditor.json`, never a registry rule). Skipping the rest removes the
    // redundant AST walks + reducers the diff-scoped gate was burning CPU on.
    const { legacy: legacyRuleSet } = splitRoutes();
    const allRulesMigrated = legacyRuleSet.size === 0;

    // Always-on infrastructure: function-index visitor populates the
    // `functions` table so conventions + cross-domain reducers have data
    // even on a cold run with no prior index sync.
    pipelineVisitors.push(createFunctionIndexVisitor());

    // styles-css visitor — AST-extracts .css files into style_* tables (Spec 26 Phase 2)
    if (analyzers.includes('styles')) pipelineVisitors.push(createStylesCssVisitor());
    // styles-source visitor — AST-extracts TS/JS CSS-in-JS into style_* tables,
    // reusing the stage-1 parse (eliminates the style-index re-parse).
    if (analyzers.includes('styles')) pipelineVisitors.push(createStylesSourceVisitor());

    if (analyzers.includes('dry')) {
      dryBundle = createDryVisitor();
      pipelineVisitors.push(dryBundle.visitor);
    }
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
    // The schema-code visitor emits the Spec 58 R1 `unresolved-query` coverage
    // diagnostic (DB-call SQL held in an unresolvable identifier) — a
    // *diagnostic*, not a finding, so it is not migrated and must keep running
    // even though the visitor's own findings are stripped. Its schema_usage
    // index facts and per-file facts are now unused by the phase model (which
    // produces its own `ddl-declarations` / `data-access-calls`), so only the
    // diagnostic survives; the redundant finding work is still avoided.
    if (analyzers.includes('schema')) pipelineVisitors.push(createSchemaCodeVisitor());

    // Everything below emits findings the phase model already serves. Once the
    // migration is complete their legacy emission is stripped to zero, so they
    // are skipped outright — their only job (re-deriving the same violations)
    // is redundant. Registered only while `legacyRuleSet` is non-empty (the
    // mid-migration state where some rules still ride the legacy path).
    if (!allRulesMigrated) {
      if (analyzers.includes('solid')) {
        solidBundle = createSolidVisitor();
        pipelineVisitors.push(solidBundle.visitor);
      }
      if (analyzers.includes('data-access')) {
        pipelineVisitors.push(createDataAccessVisitor());
        // Spec 62 Amendment B — the missing-org-filter rule is a Stage-4 derived
        // reducer that joins the data-access query facts against the declared +
        // DDL-discovered tenant tiers. Registered whenever data-access is enabled,
        // mirroring the data-access visitor it consumes.
        pipelineDerivedReducers.push(createOrgFilterReducer());
      }
      if (analyzers.includes('secrets')) pipelineVisitors.push(createSecretsVisitor());
      if (analyzers.includes('security')) pipelineVisitors.push(createSecurityVisitor());
      if (analyzers.includes('react')) {
        reactBundle = createReactVisitor();
        pipelineVisitors.push(reactBundle.visitor);
      }
      if (analyzers.includes('documentation')) pipelineVisitors.push(createDocumentationVisitor());
      if (analyzers.includes('conventions')) pipelineReducers.push(createConventionsReducer());
      if (analyzers.includes('cross-domain')) pipelineDerivedReducers.push(createCrossDomainReducer());
      if (analyzers.includes('schema')) {
        pipelineVisitors.push(createSchemaSqlVisitor());
        pipelineVisitors.push(createSchemaPrismaVisitor());
        pipelineVisitors.push(createSchemaJsonVisitor());
        pipelineReducers.push(createSchemaReducer());
      }

      // Cross-language analyzers (SchemaValidator, APIContractAnalyzer,
      // DependencyGraphBuilder) — three Stage-4 reducers fed by one shared
      // entity-extraction visitor. The visitor is cheap (per-file) and runs
      // whenever ANY cross-language analyzer is enabled; the corpus-wide reducers
      // short-circuit on scoped/diff runs.
      const crossLanguageEnabled = ['schema-validator', 'api-contract', 'dependency-graph']
        .some((a) => analyzers.includes(a));
      if (crossLanguageEnabled) {
        pipelineVisitors.push(createCrossLanguageEntityVisitor());
      }
      if (analyzers.includes('schema-validator')) pipelineDerivedReducers.push(createSchemaValidatorReducer());
      if (analyzers.includes('api-contract')) pipelineDerivedReducers.push(createAPIContractReducer());
      if (analyzers.includes('dependency-graph')) pipelineDerivedReducers.push(createDependencyGraphReducer());
    }

    // ── 2. Safeguard warnings ────────────────────────────────────────────
    if (auditIndex) {
      if (analyzers.includes('cross-domain')) {
        const suCount = auditIndex.count('schema_usage');
        if (suCount === 0) {
          console.warn('[code-audit] ⚠ cross-domain analyzer requires schema_usage data. '
            + 'This is populated during a full audit run by the schema analyzer. '
            + 'If this warning persists, run a full "code-audit audit --path ." first.');
        }
      }
    }

    // ── 3. Run pipeline ──────────────────────────────────────────────────
    const hasPipelineAnalyzers = pipelineVisitors.length > 0
      || pipelineReducers.length > 0
      || pipelineDerivedReducers.length > 0;

    if (hasPipelineAnalyzers) {
      // Build per-analyzer namespaced config — no flat Object.assign merge.
      // Each analyzer gets its own namespace; _infra holds shared infrastructure keys
      // that every visitor/reducer receives alongside its own config.
      const pipelineAnalyzerConfig: Record<string, Record<string, unknown>> = {};
      for (const name of analyzers) {
        pipelineAnalyzerConfig[name] = { ...(mergedOptions.analyzerConfigs?.[name] ?? {}) };
      }
      // Spec 62 Amendment B — the missing-org-filter Stage-4 reducer reads the
      // data-access config namespace (orgFilterTables/orgFilterColumns/schemas),
      // so it inherits the data-access analyzer's config rather than a fresh
      // empty namespace. `data-access-org-filter` has no config namespace of its
      // own, so this is the only place its config is set.
      if (analyzers.includes('data-access')) {
        pipelineAnalyzerConfig['data-access-org-filter'] = { ...(pipelineAnalyzerConfig['data-access'] ?? {}) };
      }
      // Pass invariant rules from .codeauditor.json into the invariants pipeline config.
      // The rules field lives at the top level of the loaded config (not under analyzerConfigs).
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
      // Schema config: all table discovery flows through visitors and facts;
      // the reducer builds the known-tables catalog solely from fact data.
      if (analyzers.includes('schema')) {
        const scConfig = mergedOptions.analyzerConfigs?.schema ?? {};
        const schemaConfig = {
          ...(pipelineAnalyzerConfig['schema'] ?? {}),
          sqlTagNames: scConfig.sqlTagNames ?? ['sql', 'db'],
          dbReceiverNames: scConfig.dbReceiverNames,
          dbCallMethods: scConfig.dbCallMethods,
          dbBindingNames: scConfig.dbBindingNames ?? ['env.DB'],
          fileGateGlobs: scConfig.fileGateGlobs,
          // Forward the per-function query ceiling + query-pattern/naming gates
          // so the configured value reaches checkQueryPatterns instead of being
          // dropped (which made the too-many-queries message print "undefined").
          maxQueriesPerFunction: scConfig.maxQueriesPerFunction,
          validateQueryPatterns: scConfig.validateQueryPatterns,
          checkNamingConventions: scConfig.checkNamingConventions,
          // Declarative ORM table-source registry (Spec 29 R2). Defaults to the
          // Drizzle builders in the visitor when unset; presets (drizzle, typeorm,
          // knex) supply their own, and it must not be dropped before the visitor.
          tableSources: scConfig.tableSources,
          // Provenance context knobs that the visitor reads via buildProvenanceContext.
          dbWrapperNames: scConfig.dbWrapperNames,
          detection: scConfig.detection,
          // External schema references — the pipeline reducer gates unknown-table
          // detection on these being non-empty (fail-open law: no external
          // authority means the rule cannot accuse).
          schemas: scConfig.schemas,
          knownTables: scConfig.knownTables,
        };
        pipelineAnalyzerConfig['schema'] = schemaConfig;
        // Pipeline resolves config by visitor name (rawConfig[visitor.name]).
        // The schema-* sub-visitors need the same namespace as the schema reducer.
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
        // Spec 60.1 Correction 1 — unfiltered discovery list, used as the
        // classifier's corpus set (see the computation above for why `files`
        // is too narrow).
        corpusFiles,
        // Spec 60.1 — virtual-module list (config, default ['.blitz']) and the
        // project's tsconfig `paths` + `baseUrl` (alias classification *and*
        // resolution). Threaded here so the function-index visitor and the
        // reachability reducer read them once per run rather than re-reading
        // tsconfig per file.
        importVirtualModules: mergedOptions.importVirtualModules ?? DEFAULT_VIRTUAL_MODULES,
        tsconfigAliases: readTsconfigAliases(root),
        // Files reachable only through package.json (main/module/types/bin/exports
        // + their sibling facades) are entry points, not dead modules — knex's
        // `knex.mjs` / `knex.d.mts` beside `main: knex.js` were flagged
        // `unreferenced-module` because no in-tree import reaches them.
        packageEntryPoints: readPackageEntryPoints(root).entryPaths,
      };

      const pipelineConfig: PipelineConfig = {
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
        onStage2Complete: async (ctx) => {
          // Post-stage-2 setup: rebuild the call-graph from the functions table
          // (populated by the function-index visitor). `updateDependencyGraph`
          // feeds `graph_cache`, which the phase `call-graph` corpus producer
          // reads — it is still needed post-migration.
          if (auditIndex && analyzers.includes('conventions')) {
            try {
              await auditIndex.updateDependencyGraph();
            } catch (err) {
              logMcpInfo('analysis', 'updateDependencyGraph failed (non-fatal)', {
                error: err instanceof Error ? err.message : String(err)
              });
            }
            // Convention mining writes the `conventions` table, read only by the
            // legacy conventions reducer (migrated). The phase `mined-conventions`
            // producer computes conventions from the `function-index` fact itself,
            // so this index write is redundant once every rule is migrated.
            if (!allRulesMigrated) {
              try {
                // Convention mining reads source on demand via readFileSync
                // (mineImportForm/mineExportShape have an internal fallback).
                auditIndex.mineAllConventions(root);
              } catch (err) {
                logMcpInfo('analysis', 'convention mining failed (non-fatal)', {
                  error: err instanceof Error ? err.message : String(err)
                });
              }
            }
          }
        },
      };

      try {
        logMcpInfo('analysis', 'running pipeline', { visitorCount: pipelineVisitors.length, reducerCount: pipelineReducers.length, derivedReducerCount: pipelineDerivedReducers.length, fileCount: files.length });
        const pipelineResult = await runPipeline(pipelineConfig, pipelineIndexHandle);

        // Write index facts (schema_usage from schema visitor, etc.)
        if (pipelineIndexHandle && pipelineResult.indexFacts && pipelineResult.indexFacts.length > 0) {
          writeIndexFactsToDb(pipelineIndexHandle, pipelineResult.indexFacts);
        }

        // Pull in pipeline results
        for (const [name, ar] of Object.entries(pipelineResult.analyzerResults)) {
          analyzerResults[name] = ar;
          logMcpDebug('analysis', `pipeline: ${name} completed`, {
            violations: ar.violations?.length ?? 0,
            status: ar.status?.status,
          });
        }

        // ── Schema sub-visitors: keep separate rows for visibility ────
        // Schema runs as 4 Stage 2 visitors + 1 Stage 3 reducer. Each visitor
        // keeps its own violations and status row so the CLI displays per-visitor
        // file/fact counts. Violations are NOT merged — the reducer only carries
        // cross-file violations (unknown-table, JSON schema validation).
        // Sub-visitors are added to orderedAnalyzerResults below (line ~650).

        // ── React finalization (cross-component checks) ──────────────────
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

        // ── Spec 13 R5 Phase 1: Persist seeded DRY pairs ──────────────────
        // Store pairs from DRY analysis in dry_pair_history for divergence
        // tracking. Pair identity is fingerprint-based (file + nodeType + line),
        // NOT content-hash-based — so a diverging clone stays the same pair.
        //
        // Runs BEFORE the phase model below: the migrated `dry/diverging-clone`
        // rule reads `clone-pair-history` (this table) through the index handle,
        // so the freshly-seeded rows must be committed before `runPhaseModel`.
        let dryPersistRunId: string | null = null;
        try {
          const dryPairs = dryBundle?.getDryPairs() as Array<{
            pairFingerprint: string;
            file1: string; symbol1: string; line1: number; contentHash1: string;
            file2: string; symbol2: string; line2: number; contentHash2: string;
            similarity: number;
          }> | undefined;
          if (dryPairs && dryPairs.length > 0) {
            const indexDb = CodeIndexDB.getInstance(undefined, root);
            await indexDb.initialize();
            dryPersistRunId = randomUUID();
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

        // ── Spec 68 §11.1 — the both-paths split ─────────────────────────
        // Migrated rules are served by the phase model (Parse → Process →
        // Analyze); their legacy emission is stripped and re-emitted from the
        // phase findings. Unmigrated rules stay on the legacy pipeline. The
        // split derives from MIGRATED_RULES; while it is empty the phase model
        // is a no-op and the pipeline serves everything — the tool is
        // functionally unchanged mid-migration. Attribution is recorded in
        // result metadata so the conformance tests can pin disjointness and
        // per-rule routing.
        {
          const { migrated } = splitRoutes();
          routeAttribution = Object.fromEntries(attributeRoutes());

          if (migrated.size > 0) {
            // The `dry/diverging-clone` rule reads its knobs from
            // `dry.divergence`. The legacy Phase 2 read
            // `analyzerConfigs.dry.divergence ?? top-level divergence ?? fallback`;
            // thread the top-level `divergence` config into the dry namespace so
            // the phase rule sees the same effective value (lower precedence than
            // an explicit `analyzerConfigs.dry.divergence`).
            const topLevelDivergence = (mergedOptions as { divergence?: Record<string, unknown> }).divergence;
            if (topLevelDivergence && !pipelineAnalyzerConfig['dry']?.divergence) {
              pipelineAnalyzerConfig['dry'] = { ...(pipelineAnalyzerConfig['dry'] ?? {}), divergence: topLevelDivergence };
            }
            const thresholds = resolvePhaseThresholds(pipelineAnalyzerConfig);
            // The phase model must honor path-profile attribution exactly as the
            // pipeline does: `excludeFromAnalysis` (Spec 44 reason 7) removes a
            // file's facts entirely, and `profile`/`excludeFromGate` (Spec 36 R4)
            // are stamped on each finding by the last matched profile. Resolve
            // once per file — both the exclusion filter and the re-emission
            // attribution below read the same `ResolvedProfile`.
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
            // Thread the corpus-level reachability inputs the phase model's
            // §8 `reachability` processor reads — the same discovery list,
            // virtual-module list, tsconfig aliases and package entry points the
            // legacy reducer read from `_infra`.
            const infraConfig = (pipelineAnalyzerConfig['_infra'] ?? {}) as Record<string, unknown>;
            // Config-declared external tables (schema analyzer's `knownTables` +
            // `schemas`) → the phase `table-catalog` producer, mirroring the legacy
            // reducer's known-table merge (pipelineAdapters.ts) so `unknown-table`'s
            // fail-open guard fires on a config-only schema.
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
              corpusFiles: infraConfig.corpusFiles as string[] | undefined,
              importVirtualModules: infraConfig.importVirtualModules as string[] | undefined,
              tsconfigAliases: infraConfig.tsconfigAliases as PhaseInfra['tsconfigAliases'],
              packageEntryPoints: infraConfig.packageEntryPoints as string[] | undefined,
              indexHandle: pipelineIndexHandle,
              enabledRules: enabledMigratedRules(),
              externalTables,
              workerCount: resolveWorkerCount(),
            });
            phaseFindings = phaseResult.findings;
            phaseIncompleteFacts = phaseResult.incompleteFacts;

            // Strip the migrated rules' legacy emission from every analyzer
            // result — the phase model is now their single source of truth.
            let strippedCount = 0;
            for (const result of Object.values(analyzerResults)) {
              const before = result.violations.length;
              result.violations = result.violations.filter((v) => !migrated.has(v.rule));
              strippedCount += before - result.violations.length;
            }

            // Re-emit phase findings as violations, bucketed by the rule's
            // analyzer namespace (the result key stamping below owns the
            // `analyzer` field — the source of truth is the bucket). Each
            // finding carries the same `profile`/`gateExcluded` the pipeline's
            // stage-2 loop would have stamped on it.
            const byAnalyzer = new Map<string, Violation[]>();
            // Rule-level bucket override: the phase finding must land in the
            // *legacy result key*, not the registry's `analyzer` label, so the
            // composite fixture's `schema-code::table-naming-convention` (emitted
            // by the schema-code visitor) does not collapse into `schema`.
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
                  violations,
                  status: makeVisitorStatus(phaseFiles.length),
                  executionTime: 0,
                  analyzerName: analyzer,
                };
              }
            }

            // Every migrated analyzer must appear in the results map even when
            // it emitted nothing this run. Its legacy visitor is skipped (the
            // phase model serves its findings), so a zero-finding analyzer would
            // otherwise read as "no-result" (silently dropped) to the legacy
            // zero-files diagnostic. The phase model ran it over `phaseFiles`;
            // report that so the diagnostic sees a real (ran, N files, 0
            // findings) entry rather than a dropped analyzer. `go` and
            // `schema-code` are covered elsewhere (the former is special-cased by
            // the diagnostic; the latter still runs as a legacy visitor).
            for (const analyzer of new Set(RULE_ANALYZER.values())) {
              if (!analyzerResults[analyzer]) {
                analyzerResults[analyzer] = {
                  violations: [],
                  status: makeVisitorStatus(phaseFiles.length),
                  executionTime: 0,
                  analyzerName: analyzer,
                };
              }
            }

            logMcpInfo('analysis', 'phase model (both paths)', {
              migrated: migrated.size,
              stripped: strippedCount,
              reemitted: phaseFindings.length,
            });
          }
        }

        // Spec 68 §8 — derived coverage. Every migrated rule declares its
        // `needs` (formats + facts), so its coverage state is a pure function of
        // the run's findings, the corpus's present formats, and producer
        // availability — no registry cross-reference, status machine, or per-rule
        // `input` list. (Computed AFTER the both-paths split so `phaseFindings`
        // holds the migrated rules' re-emitted findings.)
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
        pipelineRuleTiming = pipelineResult.metadata?.ruleTiming;
        pipelineFileAccounting = pipelineResult.metadata?.fileAccounting;
        pipelineDiagnostics = pipelineResult.metadata?.diagnostics;
        pipelineTestCoverage = pipelineResult.metadata?.testCoverage;
        pipelineDeadClusters = pipelineResult.metadata?.deadClusters;

        // Spec 60 R2 — aggregate the SOLID analyzer's raw size readings into
        // per-measure distributions (median/p95/max + tail annotation).
        if (solidBundle) {
          const samples = await solidBundle.getSizeSamples();
          pipelineSizeDistributions = computeSizeDistributions(samples);
        }
      } catch (error) {
        if (error instanceof AuditAbortedError) {
          throw error;
        }
        // Pipeline failure — populate error results for all pipeline analyzers.
        // Exclude infrastructure visitors (function-index) that don't produce violations.
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
              status: makeVisitorStatus(0),
              executionTime: 0,
              analyzerName: name,
              errors: [{ file: 'pipeline', error: (error as Error).message }],
            };
          }
        }
        reportError(mergedOptions, error as Error, 'pipeline');
      }
    }

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
    const orderedAnalyzerResults: Record<string, AnalyzerResult> = {};
    for (const analyzerName of analyzers) {
      if (analyzerResults[analyzerName]) {
        orderedAnalyzerResults[analyzerName] = analyzerResults[analyzerName];
      }
      // When schema is enabled, insert sub-visitor rows after the schema entry
      // so the CLI table shows per-visitor file/fact counts.
      if (analyzerName === 'schema') {
        for (const subName of SCHEMA_SUB_VISITORS) {
          if (analyzerResults[subName]) {
            orderedAnalyzerResults[subName] = analyzerResults[subName];
          }
        }
      }
      // Spec 62 Amendment B — `data-access-org-filter` is auto-registered (never
      // in analyzers), so surface its Stage-4 row right after data-access.
      if (analyzerName === 'data-access' && analyzerResults['data-access-org-filter']) {
        orderedAnalyzerResults['data-access-org-filter'] = analyzerResults['data-access-org-filter'];
      }
    }

    // ── Normalize the analyzer field on every violation to its result key ──
    // Violations are emitted by analyzers that don't always stamp `analyzer`
    // correctly: the react analyzer omits it entirely, and the schema sub-visitor
    // helpers (createSchemaViolation) hardcode `analyzer: 'schema'` for every
    // sub-visitor, collapsing schema-code/schema-sql/schema-prisma/schema-json
    // into the parent 'schema'. Both surface in the baseline metadata as
    // `unknown: 338` / an over-broad `schema` bucket. The result key IS the
    // analyzer that emitted the finding, so stamp it here as the single source
    // of truth — a no-op for every analyzer that already labels itself, and it
    // also fixes any future analyzer that forgets. Runs before baseline
    // classification (Spec 18) so fingerprints and analyzerCounts are correct.
    // Spec 62 Amendment B — the `data-access-org-filter` reducer stamps its
    // findings with `analyzer: 'data-access'` so the ledger group
    // `data-access/missing-org-filter` stays stable across the Stage-2 → Stage-4
    // move. The result key is otherwise the single source of truth (see above).
    const analyzerFieldOverride: Record<string, string> = {
      'data-access-org-filter': 'data-access',
    };
    for (const [resultName, result] of Object.entries(orderedAnalyzerResults)) {
      const stampedAnalyzer = analyzerFieldOverride[resultName] ?? resultName;
      for (const v of result.violations) {
        v.analyzer = stampedAnalyzer;
      }
    }

    // ── Spec 13 R2 — Hotspot scoring & finding reordering ──────────────
    // Attach hotspot scores to violations and reorder within severity tiers.
    // Falls back gracefully when no churn/hotspot data exists.
    //
    // Reachability (live vs dead code) is a second ranking axis written by the
    // dependency-graph reducer to graph_cache. Within a severity tier, dead
    // code sinks below live code, so a finding in an unreferenced module drops
    // while a finding on a framework entry point rises.
    try {
      const indexDb = CodeIndexDB.getInstance(undefined, root);
      await indexDb.initialize();

      // Build hotspot lookup: target -> score
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

      // Build reachability lookup: file -> score (0 dead, 0.5 imported, 1 entry)
      const reachabilityByFile = new Map<string, number>();
      const reachRows = indexDb.rawDb
        .prepare("SELECT node_key, weight FROM graph_cache WHERE graph_type = 'reachability'")
        .all() as Array<{ node_key: string; weight: number }>;
      for (const row of reachRows) {
        reachabilityByFile.set(row.node_key, row.weight);
      }

      // Attach hotspot + reachability to each violation and reorder within each analyzer
      for (const analyzerName of Object.keys(orderedAnalyzerResults)) {
        const result = orderedAnalyzerResults[analyzerName];
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

        // Reorder within severity tiers: reachability descending, then hotspot
        // descending, preserving original order as tiebreaker.
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
          // Within same severity: live code first, dead code last
          const reachA = a.v.reachability ?? 0.5;
          const reachB = b.v.reachability ?? 0.5;
          if (reachA !== reachB) return reachB - reachA;
          // Then higher hotspot first
          const hsA = a.v.hotspot ?? 0;
          const hsB = b.v.hotspot ?? 0;
          if (hsA !== hsB) return hsB - hsA;
          // Tiebreaker: original order
          return a.i - b.i;
        });

        result.violations = indexed.map(x => x.v);
      }
    } catch {
      // Hotspot/reachability reordering is advisory — failure is non-fatal
    }

    // Hook-contract guard: no violation may carry an empty file path, line 0, or
    // missing line. A sentinel violation with file:'' broke the Claude Code hook's
    // JSON consumer (Spec 15 regression). line:0 from CrossDomainAnalyzer broke it
    // again (Spec 22 alarm #1). This guard is permanent — every analyzer code path
    // must produce properly anchored violations.
    //
    // Runs BEFORE result construction so the CLI/MCP surfaces never see bad
    // violations. Operates on the originals (via splice), not a copy.
    for (const ar of Object.values(orderedAnalyzerResults)) {
      validateHookContract(ar.violations);
    }

    // ── Baseline classification (Spec 18 R1) ────────────────────────────
    // Runs AFTER validateHookContract (and after divergence tracking) so it
    // classifies exactly the violation set that reaches the report. Previously
    // this ran before the hook-contract guard spliced out malformed violations
    // (empty file / line 0 / missing line), so newCount+knownCount over-counted
    // by the number of spliced findings and no longer reconciled with
    // summary.totalViolations.
    const projectRoot = path.resolve(mergedOptions.projectRoot || process.cwd());
    const baseline = loadBaseline(projectRoot);
    let baselineMetadata: {
      present: boolean;
      hash?: string;
      newCount: number;
      fixedCount: number;
      knownCount: number;
      previousKnownCount?: number;
    } | undefined;

    if (baseline) {
      const allViolations = Object.values(orderedAnalyzerResults).flatMap(
        (r) => r.violations
      );
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

    // Generate summary
    const summary = generateSummary(orderedAnalyzerResults, files.length);

    // Create result
    const result: AuditResult = {
      timestamp: new Date(),
      summary,
      analyzerResults: orderedAnalyzerResults,
      recommendations: [],
      metadata: {
        auditDuration: Date.now() - startTime,
        auditCpuMs: cpuDurationMs(startCpu),
        filesAnalyzed: files.length,
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
    // Forked shard workers set writeToLedger:false so the parent run is the
    // single ledger writer (see AuditRunnerOptions.writeToLedger).
    if (mergedOptions.writeToLedger !== false) {
      void (async () => {
        try {
          const indexDb = CodeIndexDB.getInstance(undefined, root);
          await indexDb.initialize();
          const violations = Object.values(orderedAnalyzerResults).flatMap(ar => ar.violations);
          const scopeStr = Array.isArray(scope) ? `files:${scope.length}` : (scope ?? 'all');
          return writeAuditToLedger(
            indexDb.rawDb,
            detectRunInput(
              process.argv.slice(2).join(' '),
              (options as any).surface ?? 'cli',
              scopeStr,
              root,
              TOOL_VERSION,
            ),
            violations,
            Date.now() - startTime,
            0, // exit status TBD — updateLedgerRunStatus by CLI after return
            { coverage: result.metadata.coverage },
          );
        } catch (_err) {
          // ledger write is non-fatal — audit result is still valid
          return null;
        }
      })();
    }

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
 * against the project root; globs use discoverFiles.
 */
async function resolveFilesScope(
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
      // Direct file path — skip files that don't exist
      const resolved = path.isAbsolute(item) ? item : path.resolve(rootDir, item);
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
 * Generate audit summary
 */
function generateSummary(analyzerResults: Record<string, AnalyzerResult>, filesAnalyzed: number) {
  let totalViolations = 0;
  let criticalIssues = 0;
  let severe = 0;
  let high = 0;
  const violationsByCategory: Record<string, number> = {};
  const byAnalyzer: Record<string, { violations: number; filesProcessed: number; fatalErrors: number }> = {};

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

  // Pass 2: filesProcessed = 0 — a dark-analyzer failure regardless of errors.
  // Visitors with declared extensions that matched zero files in the corpus are
  // benign (converted to notRun by the pipeline), but a visitor that was dispatched
  // files and still shows visitor-ran + 0 files is broken — whether it errored or
  // silently returned.
  for (const [analyzerName, result] of Object.entries(analyzerResults)) {
    if (analyzerName === 'go' && hasGoFiles === false) continue;
    if (
      isVisitorStatus(result.status) && getFilesProcessed(result.status) === 0
    ) {
      const errCount = (result as any).errors?.length ?? 0;
      const errDetail = errCount > 0 ? ` (${errCount} file error(s))` : '';
      warnings.push({
        analyzerName,
        kind: 'zero-files',
        message:
          `⚠️  ${analyzerName} analyzer: filesProcessed = 0${errDetail}. ` +
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