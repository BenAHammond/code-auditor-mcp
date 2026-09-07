/**
 * Audit Runner (Functional)
 * Main orchestrator for running code audits
 */

import { promises as fs } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import {
  AuditResult,
  AuditRunnerOptions,
  AnalyzerResult,
  Violation,
  AuditProgress,
  FunctionMetadata,
  DryFunctionIndexEntry,
  AuditResultScope,
  AuditAbortedError,
  AuditHandoffError,
  type RuleCoverage,
  type InputPresence,
  type FileAccountingSummary,
} from './types.js';
import { discoverFiles, discoverFilesDetailed } from './utils/fileDiscovery.js';
import { FileAccounting } from './services/fileAccounting.js';
import { loadConfig, findConfigFileUp } from './config/configLoader.js';
import { mergePathProfiles } from './config/defaults.js';
import { checkThresholdRationales } from './config/thresholdRationales.js';
import { ALL_ANALYZERS } from './analyzers/ruleRegistry.js';
import { applyPresets, getPreset } from './presets/presets.js';
import { generateReport } from './reporting/reportGenerator.js';
import { extractFunctionsFromFile } from './functionScanner.js';
import { isMcpDebugEnabled, logMcpDebug, logMcpInfo } from './mcpDiagnostics.js';
import { loadBaseline, matchFindings, hashBaseline } from './baseline.js';
import { computeImpact, LATENCY_BUDGET_MS } from './graph/blastRadius.js';

// Import universal analyzers
import { initializeLanguages } from './languages/index.js';
import { initializeOrmAdapters } from './analyzers/orm/index.js';
import { syncStyleIndex } from './styles/styleIndexer.js';


import { CodeIndexDB } from './codeIndexDB.js';
import { writeAuditToLedger, detectRunInput } from './ledger.js';

// Pipeline imports (Spec 25 — pipeline replaces hand-rolled analyzer loop)
import { runPipeline, writeIndexFactsToDb, makeVisitorStatus, getFilesProcessed, isVisitorStatus, buildCoverageReport } from './pipeline.js';
import {
  createSolidVisitor,
  createDryVisitor,
  createDataAccessVisitor,
  createDocumentationVisitor,
  createSecretsVisitor,
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
import type { DryVisitorBundle, ReactVisitorBundle } from './pipelineAdapters.js';
import type { PipelineConfig, PipelineResult, IndexHandle, Stage2Visitor, Stage3Reducer, Stage4Reducer } from './types.js';

// Package version — read once at module load
const __auditRunnerDirname = path.dirname(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(readFileSync(path.join(__auditRunnerDirname, '..', 'package.json'), 'utf-8'));
const TOOL_VERSION = String(_pkg.version || '0.0.0');

// Initialize the canonical language system once
initializeLanguages();

// Initialize ORM adapters for cross-domain schema extraction (Spec 15 R2)
initializeOrmAdapters();

/** Schema sub-visitor names — shown as separate rows in the CLI table. */
const SCHEMA_SUB_VISITORS = ['schema-sql', 'schema-code', 'schema-prisma', 'schema-json'];


/**
 * Create an audit runner with the given options
 */
export function createAuditRunner(options: AuditRunnerOptions = {}) {
  const analyzerRegistry: Record<string, { name: string }> = Object.fromEntries(
    ALL_ANALYZERS.map((name) => [name, { name }])
  );
  
  /**
   * Load configuration from file
   */
  async function loadConfiguration(configPath: string): Promise<AuditRunnerOptions> {
    const config = await loadConfig({ configPath });
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
    const fileConfig: Partial<AuditRunnerOptions> = configPath
      ? await loadConfig({ configPath })
      : {};
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

    // Always merge built-in path profiles — corpus audits and projects without
    // .codeauditor.json must still get the built-in scripts-and-tests profile.
    mergedOptions.pathProfiles = mergePathProfiles(
      mergedOptions.pathProfiles,
      (mergedOptions as any).builtin
    );

    const startTime = Date.now();

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

    const handoffRemaining: string[] = [];
    const maxPerRun = mergedOptions.maxFilesPerRun;
    if (typeof maxPerRun === 'number' && maxPerRun > 0 && files.length > maxPerRun) {
      handoffRemaining.push(...files.slice(maxPerRun));
      files = files.slice(0, maxPerRun);
    }

    const root = path.resolve(mergedOptions.projectRoot || process.cwd());
    logMcpInfo('discovery', 'file discovery finished', {
      projectRoot: path.resolve(root),
      totalFiles: files.length,
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

    // ── Build full function index for scoped DRY ─────────────────────
    // When scope is not 'all', DRY must compare scoped functions against
    // the full index so new duplicates are caught (R2.2).
    let fullFunctionIndex: DryFunctionIndexEntry[] | undefined;
    if (isScoped) {
      try {
        const db = CodeIndexDB.getInstance(undefined, mergedOptions.projectRoot || process.cwd());
        fullFunctionIndex = await db.getAllFunctionsForDry();
        logMcpInfo('analysis', 'loaded full function index for scoped DRY', {
          functionCount: fullFunctionIndex.length
        });
      } catch (err) {
        // Non-fatal: DRY will just run within scope
        logMcpInfo('analysis', 'failed to load full index for DRY (continuing)', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // Run analyzers
    const analyzerResults: Record<string, AnalyzerResult> = {};
    const enabledAnalyzers = getEnabledAnalyzers(mergedOptions, analyzerRegistry);

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
    if (enabledAnalyzers.includes('styles')) {
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
    let pipelineTableCatalog: Array<{ table: string; sources: any[] }> | undefined;
    let pipelineStageTiming: Record<string, number> | undefined;
    let pipelineSkippedFiles: Array<{ filePath: string; bytes: number; reason: string }> | undefined;
    let pipelineUnparsedFiles: Array<{ filePath: string; reason: string }> | undefined;
    let pipelineInputPresence: InputPresence | undefined;
    let pipelineRuleTiming: Array<{ ruleId: string; totalMs: number; calls: number }> | undefined;
    let pipelineFileAccounting: FileAccountingSummary | undefined;
    logMcpInfo('analysis', 'enabled analyzers', {
      names: enabledAnalyzers,
      fileCount: files.length,
      scope: scopeResultType
    });
    logMcpDebug('analysis', 'registry keys', { keys: Object.keys(analyzerRegistry) });

    const requestedConcurrency = Number(mergedOptions.analyzerConcurrency);
    const analyzerConcurrency =
      Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.min(Math.floor(requestedConcurrency), enabledAnalyzers.length || 1)
        : 1;
    logMcpInfo('analysis', 'analyzer concurrency', { analyzerConcurrency });

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

    // Always-on infrastructure: function-index visitor populates the
    // `functions` table so conventions + cross-domain reducers have data
    // even on a cold run with no prior index sync.
    pipelineVisitors.push(createFunctionIndexVisitor());

    // styles-css visitor — AST-extracts .css files into style_* tables (Spec 26 Phase 2)
    if (enabledAnalyzers.includes('styles')) pipelineVisitors.push(createStylesCssVisitor());
    // styles-source visitor — AST-extracts TS/JS CSS-in-JS into style_* tables,
    // reusing the stage-1 parse (eliminates the style-index re-parse).
    if (enabledAnalyzers.includes('styles')) pipelineVisitors.push(createStylesSourceVisitor());

    if (enabledAnalyzers.includes('solid')) pipelineVisitors.push(createSolidVisitor());
    if (enabledAnalyzers.includes('dry')) {
      dryBundle = createDryVisitor(fullFunctionIndex);
      pipelineVisitors.push(dryBundle.visitor);
    }
    if (enabledAnalyzers.includes('data-access')) pipelineVisitors.push(createDataAccessVisitor());
    if (enabledAnalyzers.includes('secrets')) pipelineVisitors.push(createSecretsVisitor());
    if (enabledAnalyzers.includes('react')) {
      reactBundle = createReactVisitor();
      pipelineVisitors.push(reactBundle.visitor);
    }
    if (enabledAnalyzers.includes('documentation')) pipelineVisitors.push(createDocumentationVisitor());
    if (enabledAnalyzers.includes('styles')) pipelineReducers.push(createStylesReducer());
    if (enabledAnalyzers.includes('conventions')) pipelineReducers.push(createConventionsReducer());
    if (enabledAnalyzers.includes('invariants')) pipelineReducers.push(createInvariantsReducer());
    if (enabledAnalyzers.includes('cross-domain')) pipelineDerivedReducers.push(createCrossDomainReducer());
    if (enabledAnalyzers.includes('schema')) {
      pipelineVisitors.push(createSchemaSqlVisitor());
      pipelineVisitors.push(createSchemaCodeVisitor());
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
      .some((a) => enabledAnalyzers.includes(a));
    if (crossLanguageEnabled) {
      pipelineVisitors.push(createCrossLanguageEntityVisitor());
    }
    if (enabledAnalyzers.includes('schema-validator')) pipelineDerivedReducers.push(createSchemaValidatorReducer());
    if (enabledAnalyzers.includes('api-contract')) pipelineDerivedReducers.push(createAPIContractReducer());
    if (enabledAnalyzers.includes('dependency-graph')) pipelineDerivedReducers.push(createDependencyGraphReducer());

    // ── 2. Safeguard warnings ────────────────────────────────────────────
    if (auditIndex) {
      if (enabledAnalyzers.includes('cross-domain')) {
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
      for (const name of enabledAnalyzers) {
        pipelineAnalyzerConfig[name] = { ...(mergedOptions.analyzerConfigs?.[name] ?? {}) };
      }
      // Pass invariant rules from .codeauditor.json into the invariants pipeline config.
      // The rules field lives at the top level of the loaded config (not under analyzerConfigs).
      if (enabledAnalyzers.includes('invariants') && (mergedOptions as any).rules) {
        pipelineAnalyzerConfig['invariants'] = {
          ...(pipelineAnalyzerConfig['invariants'] ?? {}),
          rules: (mergedOptions as any).rules,
        };
      }
      // Cross-domain config lives at the top level (not analyzerConfigs)
      if (enabledAnalyzers.includes('cross-domain') && (mergedOptions as any).crossDomain) {
        pipelineAnalyzerConfig['cross-domain'] = {
          ...(pipelineAnalyzerConfig['cross-domain'] ?? {}),
          ...(mergedOptions as any).crossDomain,
        };
      }
      // Schema config: all table discovery flows through visitors and facts;
      // the reducer builds the known-tables catalog solely from fact data.
      if (enabledAnalyzers.includes('schema')) {
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
        severityOverrides: mergedOptions.severityOverrides,
        projectRoot: root,
        _provenanceTiming: provenanceTiming,
        files,
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
          // Post-stage-2 setup: rebuild function_calls from the functions table
          // (populated by the function-index visitor), then mine conventions.
          if (auditIndex && enabledAnalyzers.includes('conventions')) {
            try {
              await auditIndex.updateDependencyGraph();
            } catch (err) {
              logMcpInfo('analysis', 'updateDependencyGraph failed (non-fatal)', {
                error: err instanceof Error ? err.message : String(err)
              });
            }
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

        // Spec 27 — build per-rule coverage from final analyzer results
        // (computed AFTER react finalization so cross-component checks are included).
        // Spec 33 Item 14 — thread the pipeline's input-presence snapshot so
        // zero-violation rules promote from `unassessed` to `clean`/`notApplicable`.
        pipelineCoverage = buildCoverageReport(
          analyzerResults,
          pipelineConfig,
          pipelineResult.metadata?.inputPresence,
          new Map(
            (pipelineResult.metadata?.ruleApplicability ?? []).map((a) => [
              a.ruleId,
              { applicable: a.applicable, reason: a.reason, kind: a.kind },
            ]),
          ),
        );

        // Spec 29: extract table catalog from pipeline metadata for audit report
        pipelineTableCatalog = pipelineResult.metadata?.tableCatalog as Array<{ table: string; sources: any[] }> | undefined;
        pipelineStageTiming = pipelineResult.metadata?.stageTiming;
        pipelineSkippedFiles = pipelineResult.metadata?.skippedFiles;
        pipelineUnparsedFiles = pipelineResult.metadata?.unparsedFiles;
        pipelineInputPresence = pipelineResult.metadata?.inputPresence;
        pipelineRuleTiming = pipelineResult.metadata?.ruleTiming;
        pipelineFileAccounting = pipelineResult.metadata?.fileAccounting;
      } catch (error) {
        if (error instanceof AuditAbortedError || error instanceof AuditHandoffError) {
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
    const zeroFilesDiagnostics = runZeroFilesDiagnostics(enabledAnalyzers, analyzerResults, files.length);
    for (const w of zeroFilesDiagnostics) {
      console.warn(w.message);
    }
    // Build ordered results — filter to truthy entries so downstream consumers
    // (DRY pair persistence, baseline, report generation) don't see undefineds.
    const orderedAnalyzerResults: Record<string, AnalyzerResult> = {};
    for (const analyzerName of enabledAnalyzers) {
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
    for (const [resultName, result] of Object.entries(orderedAnalyzerResults)) {
      for (const v of result.violations) {
        v.analyzer = resultName;
      }
    }

    // ── Spec 13 R5 Phase 1: Persist seeded DRY pairs ──────────────────
    // Store pairs from DRY analysis in dry_pair_history for divergence tracking.
    // Pair identity is fingerprint-based (file + nodeType + line),
    // NOT content-hash-based — so a diverging clone stays the same pair.
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
          const funcName = v.functionName as string | undefined;
          const file = v.file as string;

          // Try function-level hotspot first: "filePath::functionName"
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
          warning: 1,
          suggestion: 2,
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

    // ── Spec 13 R5 Phase 2: Divergence tracking pass ──────────────────
    // For every pair in dry_pair_history, compare the last 2 similarity
    // measurements. If similarity has declined by ≥ divergenceThreshold
    // for divergenceRuns consecutive runs, emit dry/diverging-clone.
    //
    // New rows are inserted by Phase 1 for pairs the DRY analyzer re-detects
    // this run. Pairs that weren't re-detected don't get a new measurement
    // this pass — full source re-read is deferred to the 20% case.
    try {
      const divergenceCfg: {
        divergenceThreshold?: number;
        divergenceRuns?: number;
        minPairSimilarity?: number;
      } = (mergedOptions.analyzerConfigs as any)?.dry?.divergence
        ?? (mergedOptions as any).divergence
        ?? { divergenceThreshold: 0.05, divergenceRuns: 2, minPairSimilarity: 0.5 };

      const threshold = divergenceCfg.divergenceThreshold ?? 0.05;
      const requiredDeclines = divergenceCfg.divergenceRuns ?? 2;

      if (threshold > 0) {
        const indexDb = CodeIndexDB.getInstance(undefined, root);
        await indexDb.initialize();

        // Get all distinct pair fingerprints
        const fingerprints = indexDb.rawDb
          .prepare('SELECT DISTINCT pair_fingerprint FROM dry_pair_history')
          .all() as Array<{ pair_fingerprint: string }>;

        if (fingerprints.length > 0) {
          const getRows = indexDb.rawDb.prepare(`
            SELECT similarity, timestamp
            FROM dry_pair_history
            WHERE pair_fingerprint = ?
            ORDER BY timestamp ASC
          `);

          const divergingViolations: Violation[] = [];

          for (const { pair_fingerprint: fp } of fingerprints) {
            const rows = getRows.all(fp) as Array<{ similarity: number; timestamp: string }>;
            if (rows.length < requiredDeclines + 1) continue;

            // Check last `requiredDeclines` consecutive pairs for decline
            let consecutiveDeclines = 0;
            for (let i = rows.length - requiredDeclines; i < rows.length; i++) {
              if (rows[i].similarity < rows[i - 1].similarity - threshold) {
                consecutiveDeclines++;
              }
            }

            if (consecutiveDeclines >= requiredDeclines) {
              // Get file/line info from the last row
              const lastRow = indexDb.rawDb.prepare(`
                SELECT file1, file2, line1, line2 FROM dry_pair_history
                WHERE pair_fingerprint = ?
                ORDER BY timestamp DESC LIMIT 1
              `).get(fp) as { file1: string; file2: string; line1: number; line2: number } | undefined;

              if (lastRow) {
                const currentSim = rows[rows.length - 1].similarity;
                const prevSim = rows[rows.length - 2].similarity;
                const drop = Math.round((prevSim - currentSim) * 1000) / 1000;

                divergingViolations.push({
                  file: lastRow.file1,
                  line: lastRow.line1,
                  severity: 'suggestion',
                  message: `Clone pair has diverged: similarity dropped ${drop} (from ${prevSim.toFixed(3)} to ${currentSim.toFixed(3)}) across ${requiredDeclines} consecutive runs (pair: ${fp.slice(0, 12)}…). Review ${lastRow.file1}:${lastRow.line1} and ${lastRow.file2}:${lastRow.line2} for diverged logic.`,
                  analyzer: 'dry',
                  rule: 'dry/diverging-clone',
                });
              }
            }
          }

          if (divergingViolations.length > 0) {
            // Append to the dry analyzer result, or create one if none exists
            if (orderedAnalyzerResults['dry']) {
              orderedAnalyzerResults['dry'].violations.push(...divergingViolations);
            } else {
              orderedAnalyzerResults['dry'] = {
                violations: divergingViolations,
                status: makeVisitorStatus(0),
                executionTime: 0,
                analyzerName: 'dry',
              };
            }
          }
        }
      }
    } catch {
      // Divergence tracking is advisory — non-fatal
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
        filesAnalyzed: files.length,
        analyzersRun: enabledAnalyzers,
        ...(isScoped && { analyzedFiles: files }),
        configUsed: mergedOptions,
        scope: scopeResultType,
        provenanceResolutionMs: provenanceTiming.totalMs,
        ...(blastRadius && { blastRadius }),
        ...(zeroFilesDiagnostics.length > 0 && { diagnostics: zeroFilesDiagnostics }),
        ...(baselineMetadata && { baseline: baselineMetadata }),
        ...(pipelineCoverage && { coverage: pipelineCoverage }),
        ...(pipelineTableCatalog && { tableCatalog: pipelineTableCatalog }),
        ...(pipelineStageTiming && { stageTiming: pipelineStageTiming }),
        ...(thresholdChanges.length > 0 && { thresholdChanges }),
        ...(pipelineSkippedFiles && pipelineSkippedFiles.length > 0 && { skippedFiles: pipelineSkippedFiles }),
        ...(pipelineUnparsedFiles && pipelineUnparsedFiles.length > 0 && { unparsedFiles: pipelineUnparsedFiles }),
        ...(skippedExtensions && skippedExtensions.length > 0 && { skippedExtensions }),
        ...(pipelineInputPresence && { inputPresence: pipelineInputPresence }),
        ...(pipelineRuleTiming && { ruleTiming: pipelineRuleTiming }),
        ...(pipelineFileAccounting && { fileAccounting: pipelineFileAccounting }),
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

    if (handoffRemaining.length > 0) {
      throw new AuditHandoffError(
        `${handoffRemaining.length} file(s) deferred to the next worker chunk`,
        result,
        handoffRemaining
      );
    }

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

  // Verify git worktree
  try {
    execSync('git rev-parse --git-dir', { cwd: rootDir, stdio: 'pipe' });
  } catch {
    throw new Error(
      `git:<ref> scope requires a git worktree. "${rootDir}" is not a git repository.`
    );
  }

  const files = new Set<string>();

  // git diff --name-only <ref>
  try {
    const diffOutput = execSync(`git diff --name-only ${ref}`, {
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
    const untrackedOutput = execSync('git ls-files --others --exclude-standard', {
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
 * Get list of enabled analyzers
 */
function getEnabledAnalyzers(
  options: AuditRunnerOptions,
  registry: Record<string, { name: string }>
): string[] {
  // Explicit array (including empty = run no analyzers, e.g. index-only harness)
  if (options.enabledAnalyzers !== undefined) {
    // invariants auto-disables at runtime inside the pipeline reducer when no
    // rules are configured — it stays in the list so coverage can report its
    // rules as notApplicable (Spec 27 criterion 5).
    return options.enabledAnalyzers;
  }

  const allAnalyzers = Object.keys(registry);

  return allAnalyzers;
}

/**
 * Generate audit summary
 */
function generateSummary(analyzerResults: Record<string, AnalyzerResult>, filesAnalyzed: number) {
  let totalViolations = 0;
  let criticalIssues = 0;
  let warnings = 0;
  let suggestions = 0;
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
        case 'warning':
          warnings++;
          break;
        case 'suggestion':
          suggestions++;
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
    warnings,
    suggestions,
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
  enabledAnalyzers: string[],
  analyzerResults: Record<string, AnalyzerResult>,
  totalFiles?: number,
): DiagnosticWarning[] {
  // When there were zero files to process, zero-files is expected, not a bug.
  if (totalFiles === 0) return [];

  const warnings: DiagnosticWarning[] = [];

  // Pass 1: enabled but absent from results
  for (const analyzerName of enabledAnalyzers) {
    if (!analyzerResults[analyzerName]) {
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