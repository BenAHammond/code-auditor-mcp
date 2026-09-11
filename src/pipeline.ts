/**
 * Pipeline execution engine (Spec 24).
 *
 * Four sequential stages:
 *   1. Traverse + Parse — one walk, one parse per file
 *   2. Per-file visitors — each AST → all visitors in parallel
 *   3. Corpus reducers — accumulated facts → cross-file analysis
 *   4. Derived reducers — stage 2+3 facts → cross-domain analysis
 *
 * Stage position IS the dependency declaration — no topological sort needed.
 */

import { readFile, stat } from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import {
  AuditAbortedError,
  MAX_ORPHAN_SOURCE_BYTES,
  type AuditResultScope,
  type AnalyzerNotRunStatus,
  type AnalyzerResult,
  type AnalyzerStatus,
  type FileASTTuple,
  type IndexFactsEntry,
  type IndexHandle,
  type InputPresence,
  type PipelineConfig,
  type PipelineResult,
  type RuleCoverage,
  type Stage2Visitor,
  type Stage3Reducer,
  type Stage4Reducer,
  type Severity,
  type Violation,
} from './types.js';
import { RULE_REGISTRY } from './analyzers/ruleRegistry.js';
import { evaluateRuleApplicability, scopedWholeProgramApplicability, type RuleApplicability, type UnreadStyleSourceInfo } from './analyzers/applicability.js';
import { resetRuleTiming, getRuleTimingSortedDesc } from './analyzers/ruleTiming.js';
import { LanguageRegistry } from './languages/LanguageRegistry.js';
import { discoverFiles, DEFAULT_EXCLUDED_DIRS } from './utils/fileDiscovery.js';
import { resolvePathProfile, type PathProfile } from './config/pathProfiles.js';
import { validateFactsDependencies, buildFactsMap } from './pipelineTypes.js';

// ── Stage 1: Traverse + Parse ──────────────────────────────────────────────

/**
 * Stream files one-at-a-time into stage 2 so per-file memory can be freed
 * before the next file is parsed.
 *
 * File discovery is eager (separate from parsing) so the total count is
 * available for progress reporting throughout the parse + visit loop.
 *
 * @returns generator (yields tuples), total file count, and a closure to
 *          retrieve aggregate parse/read timing after the generator completes.
 */
export function runStage1(config: PipelineConfig): {
  generator: AsyncGenerator<FileASTTuple, void, undefined>;
  fileCount: number;
  getTiming: () => { parseDurationMs: number; readDurationMs: number };
  getUnparsedFiles: () => Array<{ filePath: string; reason: string }>;
  getSkippedExtensions: () => Array<{ ext: string; count: number }>;
} {
  // ── Eager discovery (same as before) ─────────────────────────────────
  const projectRoot = config.projectRoot;
  let files: string[];
  if (config.explicitFiles !== undefined) {
    files = config.explicitFiles;
  } else {
    // discovery runs lazily inside the generator below
  }

  // Group by language adapter
  const registry = LanguageRegistry.getInstance();
  let total: number;
  let parsed = 0;
  let readMs = 0;
  let parseMs = 0;
  // Spec 32 — files that failed to parse (or be read) during stage 1, with the
  // reason. A non-empty list means the audit was incomplete; surfaced in coverage
  // and forces a non-zero exit so a plausible-but-wrong report is never silent.
  const unparsedFiles: Array<{ filePath: string; reason: string }> = [];
  // Spec 43 R5 follow-up — extensions discovery skipped (only populated on the
  // lazy-discovery path, i.e. when `explicitFiles` is absent). Surfaced so "what
  // isn't being analyzed here" is answerable from the report.
  const skippedExtensionCounts = new Map<string, number>();

  async function* generate(): AsyncGenerator<FileASTTuple, void, undefined> {
    // Lazy file discovery (only if not explicit)
    const fileList: string[] = files ?? await discoverFiles(projectRoot, {
      excludeDirs: DEFAULT_EXCLUDED_DIRS,
      onSkippedExtension: (ext) => {
        skippedExtensionCounts.set(ext, (skippedExtensionCounts.get(ext) ?? 0) + 1);
      },
      ...(config.fileAccounting ? { fileAccounting: config.fileAccounting } : {}),
    });
    total = fileList.length;

    const groups = new Map<any, string[]>();
    const orphans: string[] = [];

    for (const file of fileList) {
      config.fileAccounting?.recordTouched(file);
      const adapter = registry.getAdapterForFile(file);
      if (adapter) {
        const list = groups.get(adapter) ?? [];
        list.push(file);
        groups.set(adapter, list);
      } else {
        orphans.push(file);
      }
    }

    // Parse each file and yield immediately
    for (const [adapter, adapterFiles] of groups) {
      for (const file of adapterFiles) {
        if (config.abortSignal?.aborted) {
          throw new AuditAbortedError('Audit aborted during stage 1');
        }

        try {
          const r0 = performance.now();
          const content = await readFile(file, 'utf-8');
          readMs += performance.now() - r0;

          const p0 = performance.now();
          const ast = await adapter.parse(file, content);
          parseMs += performance.now() - p0;

          parsed++;
          yield {
            kind: 'parsed',
            file,
            ast,
            adapter,
            sourceCode: content,
          };
        } catch (err: any) {
          // Spec 32 — a parse failure (including a WASM abort that survived
          // parseWithRecovery) must never be silent: record it so it lands in
          // coverage and forces a non-zero exit.
          unparsedFiles.push({ filePath: file, reason: err?.message ?? String(err) });
          config.fileAccounting?.recordDropped('parse failed', file, { reason: err?.message ?? String(err) });
          if (config.progressCallback) {
            config.progressCallback({
              current: parsed,
              total,
              analyzer: 'pipeline',
              phase: 'stage1',
              file,
              message: `Skipped: ${err.message}`,
            });
          }
        }
      }
    }

    // Orphan files (no LanguageAdapter).
    //
    // ORDERING INVARIANT — source files are yielded *before* orphans, so a
    // caller tracking the monotonic file index sees source files first and can
    // split its ETA into a source population and an orphan population at the
    // `sourceCount` boundary. Do not interleave the two loops: the daemon's
    // two-population `retryAfterMs` estimate depends on this order and asserts
    // against it (source-before-orphan) at runtime.
    for (const file of orphans) {
      try {
        // Orphans are materialized into a source string only when a visitor will
        // parse the content:
        //  • .json — the schema-json visitor emits a path-only marker
        //    (`{ isJson: true }`) and the stage-3 schema reducer re-reads the
        //    file on demand via readSource, so materializing the bytes here is a
        //    dead read (every JSON byte would be read twice). Yield empty source.
        //  • .sql (oversized only, Spec 31) — dumps beyond
        //    MAX_ORPHAN_SOURCE_BYTES are streamed on demand by the schema-sql
        //    visitor, which skips them entirely when they contain no DDL.
        //  • everything else (CSS, etc.) — materialized because its visitor
        //    parses the content.
        if (file.endsWith('.json')) {
          parsed++;
          yield {
            kind: 'raw',
            file,
            ast: null,
            adapter: null,
            sourceCode: '',
          };
          continue;
        }

        const st = await stat(file);
        if (file.endsWith('.sql') && st.size > MAX_ORPHAN_SOURCE_BYTES) {
          parsed++;
          yield {
            kind: 'raw',
            file,
            ast: null,
            adapter: null,
            sourceCode: '',
          };
          continue;
        }

        const r0 = performance.now();
        const content = await readFile(file, 'utf-8');
        readMs += performance.now() - r0;

        parsed++;
        yield {
          kind: 'raw',
          file,
          ast: null,
          adapter: null,
          sourceCode: content,
        };
      } catch (err: any) {
        unparsedFiles.push({ filePath: file, reason: `read error: ${err?.message ?? String(err)}` });
        config.fileAccounting?.recordDropped('parse failed', file, { reason: `read error: ${err?.message ?? String(err)}` });
        if (config.progressCallback) {
          config.progressCallback({
            current: orphans.indexOf(file),
            total: orphans.length,
            analyzer: 'pipeline',
            phase: 'stage1',
            file,
            message: `Raw file skipped (read error): ${err.message}`,
          });
        }
      }
    }

    const orphanIncluded = fileList.filter(f => !registry.getAdapterForFile(f)).length;
    if (orphanIncluded > 0 && config.progressCallback) {
      config.progressCallback({
        current: orphanIncluded,
        total: orphanIncluded,
        analyzer: 'pipeline',
        phase: 'stage1',
        message: `${orphanIncluded} file(s) included as raw (no language adapter)`,
      });
    }
  }

  return {
    generator: generate(),
    get fileCount() { return total; },
    getUnparsedFiles: () => unparsedFiles,
    getSkippedExtensions: () =>
      [...skippedExtensionCounts.entries()]
        .map(([ext, count]) => ({ ext, count }))
        .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext)),
    getTiming: () => ({ parseDurationMs: parseMs, readDurationMs: readMs }),
  };
}

// ── Stage 2: Per-file visitors ─────────────────────────────────────────────

export async function runStage2(
  tuples: AsyncIterable<FileASTTuple>,
  visitors: Stage2Visitor[],
  config: PipelineConfig,
  totalFiles: number,
): Promise<{
  visitorResults: Map<string, AnalyzerResult>;
  allFacts: Map<string, Record<string, unknown>>;
  indexFacts: IndexFactsEntry[];
  visitorDurationMs: Map<string, number>;
  fileCount: number;
}> {
  const t0 = performance.now();
  const visitorResults = new Map<string, AnalyzerResult>();
  const allFacts = new Map<string, Record<string, unknown>>();
  const indexFacts: IndexFactsEntry[] = [];
  const timingMap = new Map<string, number>();
  const errors = new Map<string, Array<{ file: string; error: string }>>();

  // Initialize per-visitor state
  for (const visitor of visitors) {
    visitorResults.set(visitor.name, {
      violations: [],
      status: { status: 'visitor-ran', filesProcessed: 0 },
      executionTime: 0,
      analyzerName: visitor.name,
    });
    allFacts.set(visitor.name, {});
    timingMap.set(visitor.name, 0);
    errors.set(visitor.name, []);
  }

  const projectRoot = config.projectRoot;
  const rawConfig = config.config ?? {};
  const infra = (rawConfig['_infra'] as Record<string, unknown>) ?? {};
  const pathProfiles: PathProfile[] | undefined = infra['pathProfiles'] as PathProfile[] | undefined;
  const severityOverrides: Record<string, string> = (infra['severityOverrides'] as Record<string, string>) ?? {};

  // Stream tuples from stage 1
  let i = 0;
  for await (const tuple of tuples) {
    // Check abort
    if (config.abortSignal?.aborted) {
      throw new AuditAbortedError('Audit aborted during stage 2');
    }

    let matchedAny = false;
    let fileAnalysisExcluded = false;
    let fileAnalysisExcludedProfile: string | undefined;

    try {
      // Progress
      if (config.progressCallback && i % 10 === 0) {
        config.progressCallback({
          current: i,
          total: totalFiles,
          analyzer: 'pipeline',
          phase: 'stage2',
          file: tuple.file,
        });
      }

      // Resolve path profiles for this file (non-analyzer-specific)
      let fileInfra = infra;
      let fileProfileNames: string[] = [];
      let fileGateExcluded: boolean | undefined;
      if (pathProfiles && pathProfiles.length > 0) {
        const resolved = resolvePathProfile(tuple.file, projectRoot, pathProfiles);
        if (Object.keys(resolved.overrides).length > 0) {
          fileInfra = { ...infra, ...resolved.overrides };
        }
        fileProfileNames = resolved.matchedProfileNames;
        fileGateExcluded = resolved.excludeFromGate;
        fileAnalysisExcluded = resolved.excludeFromAnalysis;
        if (fileAnalysisExcluded) {
          fileAnalysisExcludedProfile = fileProfileNames[fileProfileNames.length - 1];
        }
      }

      // Fan out to all visitors for this file — filter by declared extensions
      const fileExt = path.extname(tuple.file);
      for (const visitor of visitors) {
        // Spec 44 reason 7 — a path-profile `excludeFromAnalysis` opt-out skips
        // every visitor for this file (no stage-2 work runs).
        if (fileAnalysisExcluded) continue;
        // Dispatch check: backward-compat visitors see only parsed tuples.
        // Visitors that declare extensions see only tuples whose extension they consume.
        if (visitor.extensions) {
          if (!visitor.extensions.includes(fileExt)) continue;
        } else {
          // No extensions declared → parsed tuples only (backward compat)
          if (tuple.kind !== 'parsed') continue;
        }
        matchedAny = true;

        const visitorConfig = { ...(rawConfig[visitor.name] ?? {}), ...fileInfra };
        const visitorContext = {
          projectRoot,
          filePath: tuple.file,
          config: visitorConfig,
          abortSignal: config.abortSignal,
        };

        try {
          const v0 = performance.now();
          const result = await visitor.visit(tuple.ast, tuple.adapter, visitorContext, tuple.sourceCode);
          const vMs = performance.now() - v0;

          // Accumulate timing
          timingMap.set(visitor.name, (timingMap.get(visitor.name) ?? 0) + vMs);

          // Attach profile, severity overrides, analyzer name, and gate exclusion
          // (Spec 36 R4). Severity is left untouched — a path profile excludes a
          // file from the blocking gate, it never softens a finding within it.
          const processedViolations = result.violations
            .map((v) => ({
              ...v,
              profile: fileProfileNames.length > 0
                ? fileProfileNames[fileProfileNames.length - 1]
                : v.profile,
              severity: (severityOverrides[v.rule] ?? v.severity) as Severity,
              ...(fileGateExcluded ? { gateExcluded: true } : {}),
            }))
            // Filter out violations whose severity was overridden to 'off' (Spec-11 R5)
            .filter((v) => v.severity !== 'off');

          // Accumulate violations
          const ar = visitorResults.get(visitor.name)!;
          ar.violations.push(...processedViolations);
          const prevFiles = ar.status.status === 'visitor-ran' ? ar.status.filesProcessed : 0;
          ar.status = {
            status: 'visitor-ran',
            filesProcessed: prevFiles + 1,
          };

          // Accumulate facts
          if (result.facts && Object.keys(result.facts).length > 0) {
            const existing = allFacts.get(visitor.name) ?? {};
            allFacts.set(visitor.name, { ...existing, ...result.facts });
          }

          // Collect index facts
          if (result.indexFacts && result.indexFacts.length > 0) {
            indexFacts.push(...result.indexFacts);
          }
        } catch (err: any) {
          // Visitor error on this file — collect but don't abort
          const errs = errors.get(visitor.name)!;
          errs.push({ file: tuple.file, error: err.message });
        }
      }
    } finally {
      // Free per-file memory on every exit path (Spec 32 Fix 3): reclaim the WASM
      // tree + drop the source string, even if a visitor or path-profile resolve
      // throws. A leaked tree keeps the Emscripten arena pinned at its high-water
      // mark and is the trigger for the Aborted() ceiling.
      const ast = tuple.ast as { dispose?: () => void } | null;
      ast?.dispose?.();
      tuple.sourceCode = '';
    }

    // Spec 44 — every file lands in exactly one terminal state. A raw tuple that
    // matched no visitor is `no adapter`; a parsed tuple that matched none is
    // `no visitor matched`; a path-profile opt-out is `path profile excluded`.
    if (config.fileAccounting) {
      if (fileAnalysisExcluded) {
        config.fileAccounting.recordDropped('path profile excluded', tuple.file, {
          profile: fileAnalysisExcludedProfile,
        });
      } else if (matchedAny) {
        config.fileAccounting.recordAnalyzed(tuple.file);
      } else if (tuple.kind === 'raw') {
        config.fileAccounting.recordDropped('no adapter', tuple.file);
      } else {
        config.fileAccounting.recordDropped('no visitor matched', tuple.file);
      }
    }

    i++;
  }

  // Finalize results
  const totalDuration = performance.now() - t0;
  for (const [name, result] of visitorResults) {
    const visitorTime = timingMap.get(name) ?? 0;
    result.executionTime = visitorTime;
    const errList = errors.get(name);
    if (errList && errList.length > 0) {
      result.errors = errList;
    }
    // Convert visitors with declared extensions that matched zero files to notRun.
    // These are infrastructure visitors (e.g. schema-prisma for a project with no
    // .prisma files) — not an error, just nothing to do.
    // Only convert when there are no errors — a visitor that matched files but
    // errored on all of them is a dark-analyzer failure, not benign absence.
    if (
      result.status.status === 'visitor-ran' &&
      result.status.filesProcessed === 0 &&
      (!(result as any).errors || (result as any).errors.length === 0)
    ) {
      const visitor = visitors.find(v => v.name === name);
      if (visitor?.extensions && visitor.extensions.length > 0) {
        result.status = {
          status: 'notRun',
          reason: `No files matched declared extensions: ${visitor.extensions.join(', ')}`,
        };
      }
    }
  }

  return {
    visitorResults,
    allFacts,
    indexFacts,
    visitorDurationMs: timingMap,
    fileCount: i,
  };
}

// ── Stage 3: Corpus reducers ───────────────────────────────────────────────

async function runStage3(
  allFacts: Map<string, Record<string, unknown>>,
  reducers: Stage3Reducer[],
  config: PipelineConfig,
  indexHandle: IndexHandle | undefined,
): Promise<{
  reducerResults: Map<string, AnalyzerResult>;
  reducerFacts: Map<string, Record<string, unknown>>;
  durationMs: number;
  consumedFiles: Set<string>;
}> {
  const t0 = performance.now();
  const reducerResults = new Map<string, AnalyzerResult>();
  const reducerFacts = new Map<string, Record<string, unknown>>();
  const factsObj = Object.fromEntries(allFacts);
  // Spec 44 — file paths any stage-3 reducer actually read (via the on-demand
  // `readSource` closure below, or self-reported `result.consumedFiles`). Unioned
  // with pre-pipeline consumption to drive the "partially analyzed" reclassification.
  const consumedFiles = new Set<string>();
  // Count visitors that produced non-empty facts (not visitor keys in the map)
  const factsConsumed = [...allFacts.values()].filter(f => Object.keys(f).length > 0).length;

  const rawConfig = config.config ?? {};
  const infra = (rawConfig['_infra'] as Record<string, unknown>) ?? {};

  for (let i = 0; i < reducers.length; i++) {
    const reducer = reducers[i];
    if (config.abortSignal?.aborted) {
      throw new AuditAbortedError(`Audit aborted during stage 3 (${reducer.name})`);
    }

    // Per-reducer namespaced config: analyzer namespace + infrastructure
    const reducerConfig = { ...(rawConfig[reducer.name] ?? {}), ...infra };
    // On-demand source reader: reducers pull file text lazily via readFileSync
    // instead of retaining every file's source as a fact through stage 4.
    const readSource = (filePath: string): string | undefined => {
      try {
        const content = readFileSync(filePath, 'utf-8');
        consumedFiles.add(filePath);
        return content;
      } catch {
        return undefined;
      }
    };
    const reducerContext = {
      projectRoot: config.projectRoot,
      config: reducerConfig,
      indexHandle,
      abortSignal: config.abortSignal,
      readSource,
      isScoped: config.isScoped,
      styleContributingFiles: config.styleContributingFiles,
    };

    try {
      const r0 = performance.now();
      const result = await reducer.reduce(factsObj, reducerContext);
      const rMs = performance.now() - r0;

      // Reducers that read files directly (not via readSource) report them here.
      for (const p of result.consumedFiles ?? []) consumedFiles.add(p);

      // Allow reducers to signal notRun (e.g. invariants auto-disabled when no
      // rules are configured). The reducer sets notRunReason in its result.
      if (result.notRunReason) {
        reducerResults.set(reducer.name, {
          violations: [],
          status: { status: 'notRun', reason: result.notRunReason },
          executionTime: rMs,
          analyzerName: reducer.name,
        });
      } else {
        reducerResults.set(reducer.name, {
          violations: result.violations,
          status: { status: 'reducer-ran', factsConsumed: result.factsConsumed ?? factsConsumed },
          executionTime: rMs,
          analyzerName: reducer.name,
        });

        if (result.facts && Object.keys(result.facts).length > 0) {
          reducerFacts.set(reducer.name, result.facts);
        }
      }
    } catch (err: any) {
      reducerResults.set(reducer.name, {
        violations: [],
        status: {
          status: 'notRun',
          reason: `Reducer error: ${err.message}`,
        },
        executionTime: 0,
        analyzerName: reducer.name,
        errors: [{ file: '(reducer)', error: err.message }],
      });
    }

    // Report each completed reducer so a caller can price the post-file
    // reducer tail — `retryAfterMs` covers time-to-ready, not just file count.
    if (config.progressCallback) {
      config.progressCallback({
        current: i + 1,
        total: reducers.length,
        analyzer: reducer.name,
        phase: 'stage3',
      });
    }
  }

  return {
    reducerResults,
    reducerFacts,
    durationMs: performance.now() - t0,
    consumedFiles,
  };
}

// ── Stage 4: Derived reducers ──────────────────────────────────────────────

async function runStage4(
  allFacts: Record<string, unknown>,
  derivedReducers: Stage4Reducer[],
  config: PipelineConfig,
  indexHandle: IndexHandle | undefined,
): Promise<{
  derivedResults: Map<string, AnalyzerResult>;
  durationMs: number;
}> {
  const t0 = performance.now();
  const derivedResults = new Map<string, AnalyzerResult>();
  // Count visitors/reducers that produced non-empty facts (not property keys in the object)
  const factsConsumed = Object.values(allFacts).filter(f => typeof f === 'object' && f !== null && Object.keys(f).length > 0).length;

  const rawConfig = config.config ?? {};
  const infra = (rawConfig['_infra'] as Record<string, unknown>) ?? {};

  for (let i = 0; i < derivedReducers.length; i++) {
    const dr = derivedReducers[i];
    if (config.abortSignal?.aborted) {
      throw new AuditAbortedError(`Audit aborted during stage 4 (${dr.name})`);
    }

    // Per-reducer namespaced config: analyzer namespace + infrastructure
    const reducerConfig = { ...(rawConfig[dr.name] ?? {}), ...infra };
    const reducerContext = {
      projectRoot: config.projectRoot,
      config: reducerConfig,
      indexHandle,
      abortSignal: config.abortSignal,
      isScoped: config.isScoped,
      styleContributingFiles: config.styleContributingFiles,
    };

    try {
      const r0 = performance.now();
      const result = await dr.reduce(allFacts, reducerContext);
      const rMs = performance.now() - r0;

      // Allow derived reducers to signal notRun (same mechanism as Stage 3)
      if (result.notRunReason) {
        derivedResults.set(dr.name, {
          violations: [],
          status: { status: 'notRun', reason: result.notRunReason },
          executionTime: rMs,
          analyzerName: dr.name,
        });
      } else {
        derivedResults.set(dr.name, {
          violations: result.violations,
          status: { status: 'reducer-ran', factsConsumed: result.factsConsumed ?? factsConsumed },
          executionTime: rMs,
          analyzerName: dr.name,
        });
      }
    } catch (err: any) {
      derivedResults.set(dr.name, {
        violations: [],
        status: {
          status: 'notRun',
          reason: `Derived reducer error: ${err.message}`,
        },
        executionTime: 0,
        analyzerName: dr.name,
        errors: [{ file: '(derived-reducer)', error: err.message }],
      });
    }

    if (config.progressCallback) {
      config.progressCallback({
        current: i + 1,
        total: derivedReducers.length,
        analyzer: dr.name,
        phase: 'stage4',
      });
    }
  }

  return {
    derivedResults,
    durationMs: performance.now() - t0,
  };
}

// ── Main pipeline entry ────────────────────────────────────────────────────

/**
 * Run the full 4-stage pipeline.
 *
 * @param config Pipeline configuration with visitors, reducers, and derived reducers.
 * @param indexHandle Optional DB handle for reducers (in-memory overlay for scoped runs).
 * @returns PipelineResult with analyzerResults and metadata.
 */

export async function runPipeline(
  config: PipelineConfig,
  indexHandle?: IndexHandle,
): Promise<PipelineResult> {
  const totalT0 = performance.now();
  const stageTiming: Record<string, number> = {};
  const visitors = config.visitors ?? [];
  const reducers = config.reducers ?? [];
  const derivedReducers = config.derivedReducers ?? [];

  // Spec 38 R2 — per-rule timing accumulator is module-global (spans stages 2+3),
  // so reset it at pipeline entry to avoid cross-run contamination.
  resetRuleTiming();

  // ── Validate facts dependencies ──────────────────────────────────────────
  const depErrors = validateFactsDependencies(visitors, reducers, derivedReducers);
  if (depErrors.length > 0) {
    throw new Error(
      `Pipeline facts dependency errors:\n${depErrors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  // ── Stage 1 setup: eager file discovery, lazy parse stream ──────────────
  const s1 = runStage1(config);
  if (config.progressCallback) {
    config.progressCallback({
      current: 0,
      total: s1.fileCount,
      analyzer: 'pipeline',
      phase: 'stage1-complete',
      message: `${s1.fileCount} files discovered`,
    });
  }

  // ── Stage 2: Stream parse + per-file visitors ────────────────────────────
  // The generator lazily reads/parses files as stage 2 consumes them.
  // Stage 1 parse time is accumulated inside the generator closure and
  // retrieved via getTiming() after the stream exhausts.
  const streamT0 = performance.now();
  const stage2 = await runStage2(s1.generator, visitors, config, s1.fileCount);
  const { parseDurationMs, readDurationMs } = s1.getTiming();
  // Streaming interleaves parse + visit per file, so there is no clean
  // "stage 1 then stage 2" wall-clock split. Report honest figures instead:
  // two CPU accumulators (measured inside the generator) plus one combined
  // wall-clock for the whole parse+visit stream.
  stageTiming['parse-cpu'] = parseDurationMs;
  stageTiming['read-cpu'] = readDurationMs;
  stageTiming['stream-parse-visit'] = performance.now() - streamT0;

  if (config.progressCallback) {
    config.progressCallback({
      current: stage2.fileCount,
      total: stage2.fileCount,
      analyzer: 'pipeline',
      phase: 'stage2-complete',
      message: `${visitors.length} visitors ran on ${stage2.fileCount} files`,
    });
  }

  // Emit the reducer-phase start marker *before* the index-fact flush and
  // onStage2Complete hook so a caller pricing time-to-ready covers that tail,
  // not just the file stream. `current: 0` means "reducers pending" (rate
  // unknown yet); the daemon reports a conservative clamp rather than "done".
  if (config.progressCallback) {
    config.progressCallback({
      current: 0,
      total: reducers.length,
      analyzer: 'pipeline',
      phase: 'stage3',
    });
  }

  // ── Flush index facts to DB ──────────────────────────────────────────────────
  // Stage 2 visitors collect IndexFactsEntry records (function-index,
  // schema-code etc.). Flush them now so downstream reducers and
  // the onStage2Complete hook (which mines conventions from the functions
  // table) can read the freshly-populated DB. Without this flush, cold runs
  // drop conventions and cross-domain results because the post-pipeline
  // writeIndexFactsToDb call at auditRunner.ts:545 happens too late.
  if (indexHandle && stage2.indexFacts.length > 0) {
    writeIndexFactsToDb(indexHandle, stage2.indexFacts);
    // Clear flushed facts so the post-pipeline flush (auditRunner.ts:545)
    // doesn't double-insert them.
    stage2.indexFacts = [];
  }

  // ── Post-stage-2 setup hook ────────────────────────────────────────────────
  // DB operations that depend on Stage 2 output (e.g. rebuilding function_calls
  // from the functions table, mining conventions) run here before Stage 3.
  if (config.onStage2Complete) {
    await config.onStage2Complete({ allFacts: stage2.allFacts });
  }

  // ── Stage 3: Corpus reducers ─────────────────────────────────────────────
  const stage3T0 = performance.now();
  const stage3 = await runStage3(stage2.allFacts, reducers, config, indexHandle);
  stageTiming['stage3-reducers'] = performance.now() - stage3T0;

  // Derived-reducer start marker (stage 4) — emitted before the fact merge so a
  // caller's estimate never collapses to "done" between the two reducer phases.
  if (config.progressCallback) {
    config.progressCallback({
      current: 0,
      total: derivedReducers.length,
      analyzer: 'pipeline',
      phase: 'stage4',
    });
  }

  // Merge stage 2 + stage 3 facts for stage 4
  const combinedFacts: Record<string, unknown> = {};
  for (const [name, facts] of stage2.allFacts) {
    combinedFacts[name] = facts;
  }
  for (const [name, facts] of stage3.reducerFacts) {
    combinedFacts[name] = facts;
  }

  // ── Stage 4: Derived reducers ────────────────────────────────────────────
  const stage4T0 = performance.now();
  const stage4 = await runStage4(combinedFacts, derivedReducers, config, indexHandle);
  stageTiming['stage4-derived'] = performance.now() - stage4T0;

  // Pipeline is done — a caller pricing time-to-ready must not report "done"
  // here: the daemon's finalize (hash + persist) and any runner post-pipeline
  // awaits remain.
  if (config.progressCallback) {
    config.progressCallback({
      current: derivedReducers.length,
      total: derivedReducers.length,
      analyzer: 'pipeline',
      phase: 'stage4-complete',
    });
  }

  // ── Build result ─────────────────────────────────────────────────────────
  const analyzerResults: Record<string, AnalyzerResult> = {};

  // Stage 2 results
  for (const [name, result] of stage2.visitorResults) {
    analyzerResults[name] = result;
  }

  // Stage 3 results
  for (const [name, result] of stage3.reducerResults) {
    analyzerResults[name] = result;
  }

  // Stage 4 results
  for (const [name, result] of stage4.derivedResults) {
    analyzerResults[name] = result;
  }

  // Collect diagnostics
  const diagnostics: Array<{ analyzerName: string; kind: string; message: string }> = [];
  for (const [name, result] of Object.entries(analyzerResults)) {
    if (result.status && result.status.status === 'notRun') {
      diagnostics.push({
        analyzerName: name,
        kind: 'not-run',
        message: result.status.reason,
      });
    }
  }

  // Spec 39 — derived rule applicability. Each rule's predicate is evaluated
  // over its declared inputs BEFORE findings are surfaced; an inapplicable rule
  // has its findings removed from the raw analyzer results so they never reach
  // the report total, and is reported `notApplicable` (with a reason) in
  // coverage rather than `fired`/`clean`. Runs after Stage 4 so the schema
  // reducer's `ddlColumns` fact is available.
  const dataAccessConfig = (config.config ?? {})['data-access'] as Record<string, unknown> | undefined;
  const schemaReducerFacts = combinedFacts['schema'] as Record<string, unknown> | undefined;
  const ddlColumns = schemaReducerFacts?.ddlColumns as string[] | undefined;
  // Spec 45 R5 — stylesheet sources the indexer could not read. These do NOT
  // silence styles/undefined-class; they become reportable context attached to
  // each undefined-class finding below.
  let unreadStyleSources: UnreadStyleSourceInfo[] = [];
  if (indexHandle) {
    try {
      unreadStyleSources = indexHandle.query(
        'SELECT file_path AS filePath, reason FROM style_unread_sources',
      ) as UnreadStyleSourceInfo[];
    } catch {
      // Table absent (pre-migration DB) — treated as "nothing unread".
      unreadStyleSources = [];
    }
  }
  const ruleApplicability = new Map<string, RuleApplicability>();
  for (const ruleId of Object.keys(RULE_REGISTRY)) {
    const app = evaluateRuleApplicability(ruleId, dataAccessConfig, ddlColumns);
    if (app) ruleApplicability.set(ruleId, app);
  }

  // Spec 52 R3 — whole-program rules are unsound on a scoped run. A partial
  // file set cannot support a global claim like "table X is never read" or
  // "table Y is unknown", so on a scoped/diff run each whole-program rule is
  // suppressed with a `notApplicable` reason naming the scope. The finding is
  // removed below (same pass as Spec 39) and reported `notApplicable` in
  // coverage — not a fired global claim, and not silence. (Whole-program rules
  // that already carry a Spec-39 applicability verdict are left intact.)
  for (const [ruleId, app] of scopedWholeProgramApplicability(!!config.isScoped, s1.fileCount)) {
    if (!ruleApplicability.has(ruleId)) ruleApplicability.set(ruleId, app);
  }

  for (const [ruleId, app] of ruleApplicability) {
    if (app.applicable) continue;
    const entry = RULE_REGISTRY[ruleId];
    const result = analyzerResults[entry.analyzer];
    if (result?.violations) {
      result.violations = result.violations.filter((v) => !violationMatchesRule(v, ruleId, entry.field));
    }
  }

  // Spec 45 R5 — undefined-class reports, does not go silent, when stylesheets
  // were unread. Each finding carries the unread-source list as
  // `details.incompleteDefinitions` so "undefined" reads as "not defined in any
  // *read* stylesheet", while the finding itself still fires and blocks.
  if (unreadStyleSources.length > 0) {
    const entry = RULE_REGISTRY['styles/undefined-class'];
    const result = entry ? analyzerResults[entry.analyzer] : undefined;
    const context = unreadStyleSources.map((s) =>
      s.reason ? `${s.filePath} (${s.reason})` : s.filePath
    );
    if (result?.violations) {
      for (const v of result.violations) {
        if (!violationMatchesRule(v, 'styles/undefined-class', entry!.field)) continue;
        const existing =
          typeof v.details === 'object' && v.details !== null ? v.details : {};
        v.details = { ...existing, incompleteDefinitions: context };
      }
    }
  }

  // Spec 33 Item 14 — per-rule input presence, computed once from the merged
  // facts + index tables, then used to promote zero-violation rules.
  const inputPresence = computeInputPresence(combinedFacts, indexHandle);

  // Spec 27 — build per-rule coverage from completed pipeline results
  const coverage = buildCoverageReport(analyzerResults, config, inputPresence, ruleApplicability);

  // Spec 29: Extract table catalog from schema reducer facts for metadata
  const schemaFacts = combinedFacts['schema'] as Record<string, unknown> | undefined;
  const tableCatalog = schemaFacts?.tableCatalog as Array<{ table: string; sources: any[] }> | undefined;

  // Spec 31: surface oversized orphan files skipped by stage-1 streaming.
  // The schema-sql visitor marks them with `skipped: true`; here they are lifted
  // into metadata so a skipped file is visible in coverage without adding a
  // violation (which would break the exact baseline counts).
  const schemaSqlFacts = stage2.allFacts.get('schema-sql') as Record<string, unknown> | undefined;
  const skippedFiles: Array<{ filePath: string; bytes: number; reason: string }> = [];
  if (schemaSqlFacts) {
    for (const [filePath, fact] of Object.entries(schemaSqlFacts)) {
      const f = fact as { skipped?: boolean; bytes?: number };
      if (f.skipped) {
        skippedFiles.push({ filePath, bytes: f.bytes ?? 0, reason: 'oversized-orphan-no-ddl' });
        // Spec 44 reason 6 — the oversized .sql orphan reached the schema-sql
        // visitor (recorded analyzed) before being skipped; reclassify it so the
        // balance reflects the size-threshold drop, not a phantom "analyzed".
        config.fileAccounting?.reclassifyAnalyzedToDropped('size threshold', filePath, { bytes: f.bytes ?? 0 });
      }
    }
  }

  // Spec 44 R1 follow-up — "partially analyzed" is keyed on *consumption*, not
  // findings. A file dropped at stage 2 (`no adapter` / `no visitor matched`)
  // that any later layer READ (the style indexer readFileSyncs every discovered
  // file; stage-3 reducers pull source via `readSource`) was still reached by
  // that layer — regardless of whether it happened to emit findings. Keying on
  // findings would collapse "clean" and "never looked at" into the same drop
  // label. The consumed set is the union of pre-pipeline consumption
  // (`config.consumedFilePaths`, the style indexer) and stage-3 reads
  // (`stage3.consumedFiles`). Reclassify before the balance assertion; the method
  // no-ops for non-reclassifiable states/reasons.
  if (config.fileAccounting) {
    const consumedFiles = new Set<string>([
      ...(config.consumedFilePaths ?? []),
      ...stage3.consumedFiles,
    ]);
    for (const filePath of consumedFiles) {
      config.fileAccounting.reclassifyDroppedToPartiallyAnalyzed(filePath);
    }
  }

  // Spec 44 R2 — the accounting must balance before we report. A touched file
  // that was never classified (a silent-drop leak) or classified more than once
  // throws AccountingBalanceError here and fails the run.
  config.fileAccounting?.assertBalanced();
  const fileAccounting = config.fileAccounting?.summary();

  const totalDuration = performance.now() - totalT0;

  // Spec 32: files that failed to parse (or be read) in stage 1. Surfaced in
  // coverage and used by the CLI to force a non-zero exit — a run that silently
  // skipped files must never report as clean.
  const unparsedFiles = s1.getUnparsedFiles();
  const skippedExtensions = s1.getSkippedExtensions();

  // Spec 38 R2 — surface per-rule timing, slowest first, only when opt-in.
  const ruleTiming = getRuleTimingSortedDesc();

  return {
    analyzerResults,
    metadata: {
      auditDuration: totalDuration,
      filesAnalyzed: s1.fileCount,
      stageTiming,
      scoped: config.isScoped,
      diagnostics,
      coverage,
      inputPresence,
      ruleApplicability: [...ruleApplicability.entries()].map(([ruleId, app]) => ({
        ruleId,
        applicable: app.applicable,
        reason: app.reason,
        kind: app.kind,
      })),
      tableCatalog,
      ...(skippedFiles.length > 0 && { skippedFiles }),
      ...(unparsedFiles.length > 0 && { unparsedFiles }),
      ...(skippedExtensions.length > 0 && { skippedExtensions }),
      ...(ruleTiming.length > 0 && { ruleTiming }),
      ...(fileAccounting ? { fileAccounting } : {}),
    },
    indexFacts: stage2.indexFacts,
  };
}

/**
 * Run pipeline with index fact handling.
 *
 * For scoped runs (changed, path-filtered), index facts are kept in-memory.
 * For full runs (plain audit), index facts are written to persistent storage
 * via the provided writeFn.
 */
// ── Index facts persistence ────────────────────────────────────────────────

/**
 * Write IndexFactsEntry records to the DB via an IndexHandle.
 *
 * Handles special actions:
 *   - `_action: 'clear-by-file'` → DELETE FROM table WHERE file_path = ?
 *   - Normal entries → INSERT ... ON CONFLICT DO UPDATE (upsert)
 *
 * Spec 25 B4 — moved from analyzer-side CodeIndexDB calls to a post-pipeline
 * write step so visitors never open the database directly.
 */
export function writeIndexFactsToDb(handle: IndexHandle, facts: IndexFactsEntry[]): void {
  for (const fact of facts) {
    const data = fact.data as Record<string, unknown>;

    // Special action: clear rows by file path
    if (data._action === 'clear-by-file') {
      handle.run(`DELETE FROM ${fact.table} WHERE file_path = ?`, [data.file_path as string]);
      continue;
    }

    // Normal upsert
    const columns = Object.keys(data).filter(k => !k.startsWith('_'));
    const values = columns.map(k => data[k]);
    const placeholders = columns.map(() => '?').join(', ');

    if (fact.conflictKey) {
      const keyCols = fact.conflictKey.split(',').map(s => s.trim());
      const updateCols = columns.filter(c => !keyCols.includes(c));
      const updates = updateCols.map(c => `"${c}" = excluded."${c}"`).join(', ');
      handle.run(
        `INSERT INTO ${fact.table} ("${columns.join('", "')}") VALUES (${placeholders}) ON CONFLICT (${keyCols.join(', ')}) DO UPDATE SET ${updates}`,
        values,
      );
    } else {
      // Normal insert — no conflictKey (caller handles dedup via clear-by-file or similar)
      handle.run(
        `INSERT INTO ${fact.table} ("${columns.join('", "')}") VALUES (${placeholders})`,
        values,
      );
    }
  }
}

export async function runPipelineWithIndex(
  config: PipelineConfig,
  indexHandle?: IndexHandle,
  writeIndexFacts?: (facts: IndexFactsEntry[]) => Promise<void>,
): Promise<{
  result: PipelineResult;
  indexFacts: IndexFactsEntry[];
}> {
  const result = await runPipeline(config, indexHandle);

  // Spec 25 B4 — Write index facts when a persister is supplied.
  // The pipeline's stage 2 collects IndexFactsEntry records from visitors;
  // the caller provides the write mechanism (DB, overlay, etc.).
  if (writeIndexFacts && result.indexFacts && result.indexFacts.length > 0) {
    await writeIndexFacts(result.indexFacts);
  }

  return {
    result,
    indexFacts: result.indexFacts ?? [],
  };
}

// ── Status factory functions ──────────────────────────────────────────────

/**
 * Canonical factory for visitor status objects.
 * All code outside types.ts and pipeline.ts MUST use these factories
 * instead of hand-constructing status discriminants.
 */
export function makeVisitorStatus(filesProcessed: number) {
  return { status: 'visitor-ran' as const, filesProcessed };
}

export function makeReducerStatus(factsConsumed: number) {
  return { status: 'reducer-ran' as const, factsConsumed };
}

/**
 * Accessor: extract filesProcessed from any AnalyzerStatus.
 * Returns 0 for non-visitor statuses (reducer-ran, notRun, etc.).
 */
export function getFilesProcessed(status: AnalyzerStatus): number {
  if (status.status === 'visitor-ran') {
    return status.filesProcessed;
  }
  return 0;
}

/**
 * Accessor: extract factsConsumed from any AnalyzerStatus.
 * Returns 0 for non-reducer statuses.
 */
export function getFactsConsumed(status: AnalyzerStatus): number {
  if (status.status === 'reducer-ran') {
    return status.factsConsumed;
  }
  return 0;
}

/**
 * Accessor: type-narrowed check whether this status is visitor-ran.
 */
export function isVisitorStatus(status: AnalyzerStatus): boolean {
  return status.status === 'visitor-ran';
}

/**
 * Accessor: type-narrowed check whether this status is reducer-ran.
 */
export function isReducerStatus(status: AnalyzerStatus): boolean {
  return status.status === 'reducer-ran';
}

// ── Coverage reporting (Spec 27) ────────────────────────────────────────────

/**
 * Spec 33 Item 14 — snapshot which rule-input sources are present this run.
 *
 *   - `factKeys`: visitor/reducer names whose merged facts (stage 2 + stage 3)
 *     are non-empty. A reducer reading e.g. `function-index` facts has input
 *     only when that key is present.
 *   - `indexTables`: index tables (referenced by a rule's `input`) that held
 *     ≥1 row when coverage was built. Non-existent tables are skipped.
 */
function computeInputPresence(
  combinedFacts: Record<string, unknown>,
  indexHandle?: IndexHandle,
): InputPresence {
  const factKeys: string[] = [];
  for (const [name, facts] of Object.entries(combinedFacts)) {
    if (facts && typeof facts === 'object' && Object.keys(facts as object).length > 0) {
      factKeys.push(name);
    }
  }

  const indexTables: string[] = [];
  if (indexHandle) {
    const candidates = new Set<string>();
    for (const entry of Object.values(RULE_REGISTRY)) {
      for (const source of entry.input ?? []) {
        if (source !== 'files') candidates.add(source);
      }
    }
    for (const table of candidates) {
      try {
        if (indexHandle.tableHasRows(table)) indexTables.push(table);
      } catch {
        // Table doesn't exist (e.g. a fact-key name) — not an index table.
      }
    }
  }

  return { factKeys, indexTables };
}

/**
 * Match a violation to a rule id using the rule's declared `field` discriminator.
 * Shared by coverage counting and Spec 39 applicability suppression so the two
 * can never disagree about which violations belong to a rule.
 */
export function violationMatchesRule(v: Violation, ruleId: string, field: string | undefined): boolean {
  if (field === 'type') return (v as any).type === ruleId;
  if (field === 'contractType') return (v as any).contractType === ruleId;
  if (field === 'principle') return (v as any).principle === ruleId;
  if (field === 'violationType') return (v as any).violationType === ruleId;
  if (field === 'ruleId') return (v as any).ruleId === ruleId;
  return v.rule === ruleId;
}

/**
 * Build a per-rule coverage report from completed pipeline results.
 *
 * Iterates every rule in the canonical {@link RULE_REGISTRY}, cross-references
 * with the analyzer-results map to derive a {@link RuleCoverageState} per rule:
 *
 * | Analyzer status                        | Rule state      | Reason                          |
 * |----------------------------------------|-----------------|---------------------------------|
 * | notRun                                 | `notApplicable` | `notRun.reason`                 |
 * | visitor-ran, filesProcessed === 0      | `notApplicable` | "no matching source files"      |
 * | reducer-ran, factsConsumed === 0       | `notApplicable` | "no facts consumed from upstream visitors" |
 * | analyzer ran with input, count > 0     | `fired`         | (none)                          |
 * | analyzer ran with input, count === 0   | `clean`/`notApplicable` | per-rule input mapping    |
 *
 * Spec 33 Item 14: zero-violation rules are promoted from `unassessed` to
 * `clean` (mapped input present) or `notApplicable` (mapped input absent). Only
 * rules with no `input` mapping (non-pipeline analyzers) remain `unassessed`.
 *
 * Rules whose analyzer was not enabled in `config` are omitted entirely
 * (they were not part of this run — distinct from `notRun`).
 */
export function buildCoverageReport(
  analyzerResults: Record<string, AnalyzerResult>,
  config: PipelineConfig,
  inputPresence?: InputPresence,
  ruleApplicability?: ReadonlyMap<string, RuleApplicability>,
): RuleCoverage[] {
  const coverage: RuleCoverage[] = [];

  for (const [ruleId, entry] of Object.entries(RULE_REGISTRY)) {
    const { analyzer: analyzerName, field } = entry;

    // Skip rules whose analyzer wasn't configured for this run
    if (!(analyzerName in (config.config ?? {}))) {
      continue;
    }

    // Spec 44 bucket 2 — a `cannot-fire` rule is broken in the tool (its
    // predicate reads a field no extractor populates). That verdict holds on
    // every run regardless of whether the analyzer found input, so it precedes
    // the run-status checks below.
    const cannotFire = ruleApplicability?.get(ruleId);
    if (cannotFire && !cannotFire.applicable && cannotFire.kind === 'cannot-fire') {
      coverage.push({
        ruleId,
        analyzer: analyzerName,
        state: 'cannot-fire',
        count: 0,
        reason: cannotFire.reason,
      });
      continue;
    }

    const result = analyzerResults[analyzerName];

    // Analyzer not in results → notRun-equivalent
    if (!result) {
      coverage.push({
        ruleId,
        analyzer: analyzerName,
        state: 'notApplicable',
        count: 0,
        reason: `analyzer "${analyzerName}" not in results`,
      });
      continue;
    }

    const status = result.status;

    // notRun: all rules notApplicable
    if (status.status !== 'visitor-ran' && status.status !== 'reducer-ran') {
      const reason = (status as AnalyzerNotRunStatus).reason;
      coverage.push({
        ruleId,
        analyzer: analyzerName,
        state: 'notApplicable',
        count: 0,
        reason,
      });
      continue;
    }

    // Visitor with zero input files
    if (isVisitorStatus(status) && getFilesProcessed(status) === 0) {
      coverage.push({
        ruleId,
        analyzer: analyzerName,
        state: 'notApplicable',
        count: 0,
        reason: 'no matching source files',
      });
      continue;
    }

    // Reducer with zero facts consumed
    if (isReducerStatus(status) && getFactsConsumed(status) === 0) {
      coverage.push({
        ruleId,
        analyzer: analyzerName,
        state: 'notApplicable',
        count: 0,
        reason: 'no facts consumed from upstream visitors',
      });
      continue;
    }

    // Check per-rule config gate (explicitly disabled by config)
    if (entry.configGate) {
      const analyzerNs = (config.config ?? {})[analyzerName];
      const gateValue = (analyzerNs as Record<string, unknown> | undefined)?.[entry.configGate];
      if (gateValue === false) {
        coverage.push({
          ruleId,
          analyzer: analyzerName,
          state: 'notApplicable',
          count: 0,
          reason: `disabled by config (${analyzerName}.${entry.configGate}: false)`,
        });
        continue;
      }
    }

    // Spec 39 — derived applicability. A rule whose predicate evaluated false is
    // `notApplicable` with the predicate's reason, before any finding is counted.
    // (`cannot-fire` was already reported above; only per-corpus `notApplicable`
    // reaches this branch.)
    const applicability = ruleApplicability?.get(ruleId);
    if (applicability && !applicability.applicable) {
      coverage.push({
        ruleId,
        analyzer: analyzerName,
        state: 'notApplicable',
        count: 0,
        reason: applicability.reason,
      });
      continue;
    }

    // Analyzer ran with input — count violations for this rule
    const violations = (result.violations ?? []).filter((v: Violation) =>
      violationMatchesRule(v, ruleId, field),
    );

    const count = violations.length;
    if (count > 0) {
      coverage.push({
        ruleId,
        analyzer: analyzerName,
        state: 'fired',
        count,
      });
      continue;
    }

    // Spec 33 Item 14 — zero-violation rules are now promoted from `unassessed`
    // to `clean`/`notApplicable` based on whether the rule's mapped input was
    // present this run. Rules with no mapping (non-pipeline analyzers) stay
    // `unassessed`.
    coverage.push(resolveZeroViolationState(ruleId, analyzerName, entry.input, inputPresence));
  }

  return coverage;
}

/**
 * Spec 33 Item 14 — classify a zero-violation rule by its declared input.
 *
 *   - No `input` mapping → `unassessed` (input provenance unknown; non-pipeline
 *     analyzers only).
 *   - Any input source present → `clean` (the analyzer ran over the rule's real
 *     input and found nothing to flag).
 *   - All input sources absent → `notApplicable` (the input this rule reads was
 *     never produced this run).
 *
 * An input source is "present" when it is the literal `'files'` (always present
 * at this branch — earlier checks already excluded empty-input analyzers), a
 * fact-key in {@link InputPresence.factKeys}, or an index table in
 * {@link InputPresence.indexTables}.
 */
function resolveZeroViolationState(
  ruleId: string,
  analyzerName: string,
  input: readonly string[] | undefined,
  inputPresence: InputPresence | undefined,
): RuleCoverage {
  if (!input || input.length === 0) {
    return {
      ruleId,
      analyzer: analyzerName,
      state: 'unassessed',
      count: 0,
      reason: 'applicability not assessed (no per-rule input mapping)',
    };
  }

  const factKeys = new Set(inputPresence?.factKeys ?? []);
  const indexTables = new Set(inputPresence?.indexTables ?? []);

  const anyPresent = input.some(
    (source) => source === 'files' || factKeys.has(source) || indexTables.has(source),
  );

  if (anyPresent) {
    return { ruleId, analyzer: analyzerName, state: 'clean', count: 0 };
  }

  return {
    ruleId,
    analyzer: analyzerName,
    state: 'notApplicable',
    count: 0,
    reason: `rule input absent (none of: ${input.join(', ')})`,
  };
}
