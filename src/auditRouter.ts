/**
 * Audit router — the single entry point that decides, by which languages are
 * present, which analyzer runs on which files.
 *
 * The decision is "which languages are in this repo", not "is there a `.go`
 * file". The old shape checked for `.go` and, on a hit, routed the *whole* repo
 * through the polyglot orchestrator — which trimmed the TypeScript half to four
 * analyzers and dropped `metadata.coverage` entirely, so a mixed-language repo
 * silently audited a fraction of its rules and no coverage entry said so
 * (Spec 66). The corrected shape is a per-language dispatch:
 *
 *   - typescript / javascript → `createAuditRunner(...).run()` with the file
 *     list, the full analyzer set, and no analyzer override.
 *   - go → the Go subprocess.
 *   - any language with no analyzer → no run (surfaced as a notApplicable
 *     coverage entry).
 *
 * Results merge into one real `AuditResult` (with coverage) rather than a
 * hand-built partial. The CLI and MCP `audit.run` both call `runAuditDispatch`,
 * so the decision lives in exactly one place.
 */

import * as path from 'path';
import {
  AuditResult,
  AuditRunnerOptions,
  AnalyzerResult,
  AuditSummary,
  RuleCoverage,
  Violation,
} from './types.js';
import { createAuditRunner } from './auditRunner.js';
import { RuntimeManager, type AnalysisResult } from './languages/RuntimeManager.js';
import { detectLanguageFromPath } from './languages/LanguageOrchestrator.js';
import { CodeIndexDB } from './codeIndexDB.js';
import { makeVisitorStatus } from './pipeline.js';
import { applyDismissals } from './dismissals.js';
import { discoverFiles } from './utils/fileDiscovery.js';
import { computeGoTenantInputs, type GoTenantInputs } from './languages/go/tenantInputs.js';
import { RULE_REGISTRY } from './analyzers/ruleRegistry.js';
import { writeAuditToLedger, detectRunInput } from './ledger.js';
import { PACKAGE_VERSION } from './constants.js';

const TOOL_VERSION = PACKAGE_VERSION;

/** Group a concrete file list by language (extension → language name). */
function groupFilesByLanguage(files: string[]): Record<string, string[]> {
  const byLanguage: Record<string, string[]> = {};
  for (const file of files) {
    const language = detectLanguageFromPath(file);
    if (!language) continue;
    (byLanguage[language] ??= []).push(file);
  }
  return byLanguage;
}

/**
 * Discover files once and group them by language (extension → language name).
 * Files with no known extension are dropped here — they are not a language group
 * and are not routed to any analyzer.
 */
export async function discoverAndGroupFiles(
  projectRoot: string,
): Promise<Record<string, string[]>> {
  const allFiles = await discoverFiles(projectRoot);
  return groupFilesByLanguage(allFiles);
}

/**
 * Run an audit, dispatching each language group to its analyzer.
 *
 * The single place both the CLI and MCP surfaces decide how a repo is audited.
 * Dispatch keys on the languages present, never on the presence of one
 * extension.
 */
export async function runAuditDispatch(options: AuditRunnerOptions): Promise<AuditResult> {
  // Resolve to an absolute path up front. The Go subprocess is spawned with a
  // cwd of its own, so relative paths would not resolve from its cwd and the
  // whole audit would collapse to zero findings.
  const projectRoot = path.resolve(options.projectRoot || process.cwd());

  // A shard worker or diff-scoped caller supplies `explicitFiles`; the repo is
  // rediscovered only when no explicit list is given. Grouping the explicit list
  // (rather than rediscovering) preserves shard boundaries and still routes any
  // `.go` files in the list to the subprocess — the worker's audit is per-language
  // too (Spec 66 follow-up, third entry point).
  const filesByLanguage = options.explicitFiles
    ? groupFilesByLanguage(options.explicitFiles)
    : await discoverAndGroupFiles(projectRoot);
  const tsJsFiles = [
    ...(filesByLanguage['typescript'] ?? []),
    ...(filesByLanguage['javascript'] ?? []),
  ];
  const goFiles = filesByLanguage['go'] ?? [];

  // No Go files: the full TypeScript pipeline, exactly as before. The runner
  // owns discovery, dismissals, and the ledger write.
  if (goFiles.length === 0) {
    return createAuditRunner(options).run();
  }

  // Go present → per-language dispatch.
  //   typescript/javascript → the full pipeline with the file list, ALL_ANALYZERS,
  //     no analyzer override (the old polyglot path trimmed this to four).
  //   go → the Go subprocess.
  const tsResult = tsJsFiles.length > 0
    ? await createAuditRunner({ ...options, explicitFiles: tsJsFiles, writeToLedger: false }).run()
    : undefined;

  const runtimeManager = new RuntimeManager();
  await runtimeManager.initialize();
  const goTenantInputs = await computeGoTenantInputs(projectRoot);
  const goResult = await runtimeManager.spawnAnalyzer('go', goFiles, {
    minSeverity: options.minSeverity,
    language: 'go',
    projectRoot,
    goTenantInputs,
  });

  const result = mergeAuditResults(tsResult, goResult, filesByLanguage, goTenantInputs);

  // Spec 57 — dismissals apply on every path, including the mixed one.
  applyDismissals(result, projectRoot);

  if (options.writeToLedger !== false) {
    writeMergedLedger(result, options, projectRoot);
  }

  return result;
}

/**
 * Merge the TypeScript pipeline result and the Go subprocess result into one
 * `AuditResult`. Every case returns a real result whose `metadata.coverage`
 * accounts for every registry rule.
 */
function mergeAuditResults(
  tsResult: AuditResult | undefined,
  goResult: AnalysisResult | null | undefined,
  filesByLanguage: Record<string, string[]>,
  goTenantInputs?: GoTenantInputs,
): AuditResult {
  if (tsResult && goResult) {
    return buildMergedResult(tsResult, goResult, filesByLanguage, goTenantInputs);
  }
  if (tsResult) {
    return tsResult;
  }
  if (goResult) {
    return buildGoOnlyResult(goResult, filesByLanguage, goTenantInputs);
  }
  return buildEmptyResult();
}

/** TS + Go: patch the TS result with the Go half. */
function buildMergedResult(
  tsResult: AuditResult,
  goResult: AnalysisResult,
  filesByLanguage: Record<string, string[]>,
  goTenantInputs?: GoTenantInputs,
): AuditResult {
  const goViolations = (goResult.violations ?? []) as Violation[];
  const goFiles = filesByLanguage['go'] ?? [];
  const goFilesAnalyzed = goResult.metrics?.filesAnalyzed ?? goFiles.length;

  const goRanRules = new Set(goResult.ranRules ?? []);
  const analyzerResults = mergeAnalyzerResults(tsResult.analyzerResults, goViolations, goFilesAnalyzed);
  const coverage = buildMergedCoverage(tsResult.metadata?.coverage, goRanRules, goViolations, goTenantInputs);

  const allViolations = Object.values(analyzerResults).flatMap((ar) => ar.violations);
  const totalFiles = (tsResult.summary?.totalFiles ?? 0) + goFilesAnalyzed;

  const goDiagnostics = buildGoDiagnostics(goResult);
  const goFileToFunctions = createFileToFunctionsMap(goResult.indexEntries ?? []);

  return {
    timestamp: new Date(),
    summary: buildSummary(allViolations, totalFiles),
    analyzerResults,
    recommendations: tsResult.recommendations ?? [],
    metadata: {
      ...tsResult.metadata,
      auditDuration: (tsResult.metadata?.auditDuration ?? 0) + (goResult.metrics?.executionTime ?? 0),
      filesAnalyzed: totalFiles,
      analyzersRun: [...new Set([...(tsResult.metadata?.analyzersRun ?? []), ...Object.keys(analyzerResults)])],
      coverage,
      fileToFunctionsMap: {
        ...(tsResult.metadata?.fileToFunctionsMap ?? {}),
        ...goFileToFunctions,
      },
      diagnostics: [...(tsResult.metadata?.diagnostics ?? []), ...goDiagnostics],
    },
  };
}

/** Go only: build a full result from the subprocess output. */
function buildGoOnlyResult(
  goResult: AnalysisResult,
  filesByLanguage: Record<string, string[]>,
  goTenantInputs?: GoTenantInputs,
): AuditResult {
  const goViolations = (goResult.violations ?? []) as Violation[];
  const goRanRules = new Set(goResult.ranRules ?? []);
  const goFiles = filesByLanguage['go'] ?? [];
  const goFilesAnalyzed = goResult.metrics?.filesAnalyzed ?? goFiles.length;

  const analyzerResults: Record<string, AnalyzerResult> = {};
  for (const [key, vs] of bucketByAnalyzer(goViolations)) {
    analyzerResults[key] = {
      violations: vs,
      status: makeVisitorStatus(goFilesAnalyzed),
      executionTime: goResult.metrics?.executionTime ?? 0,
      analyzerName: key,
    };
  }

  const goDiagnostics = buildGoDiagnostics(goResult);

  return {
    timestamp: new Date(),
    summary: buildSummary(goViolations, goFilesAnalyzed),
    analyzerResults,
    recommendations: [],
    metadata: {
      auditDuration: goResult.metrics?.executionTime ?? 0,
      filesAnalyzed: goFilesAnalyzed,
      analyzersRun: Object.keys(analyzerResults),
      coverage: buildGoOnlyCoverage(goRanRules, goViolations, goTenantInputs),
      fileToFunctionsMap: createFileToFunctionsMap(goResult.indexEntries ?? []),
      ...(goDiagnostics.length > 0 ? { diagnostics: goDiagnostics } : {}),
    },
  };
}

/** Neither TS nor Go produced a result — full coverage, every rule notApplicable. */
function buildEmptyResult(): AuditResult {
  return {
    timestamp: new Date(),
    summary: buildSummary([], 0),
    analyzerResults: {},
    recommendations: [],
    metadata: {
      auditDuration: 0,
      filesAnalyzed: 0,
      analyzersRun: [],
      coverage: Object.entries(RULE_REGISTRY).map(([ruleId, entry]) => ({
        ruleId,
        analyzer: entry.analyzer,
        state: 'notApplicable' as const,
        count: 0,
        reason: 'no analyzer produced results',
      })),
    },
  };
}

/** Bucket violations by their `analyzer` label (defaulting to `go`). */
function bucketByAnalyzer(violations: Violation[]): Map<string, Violation[]> {
  const buckets = new Map<string, Violation[]>();
  for (const v of violations) {
    const key = (v as any).analyzer || 'go';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(v);
  }
  return buckets;
}

/** Merge TS analyzerResults with Go buckets (append on key collision). */
function mergeAnalyzerResults(
  tsResults: Record<string, AnalyzerResult>,
  goViolations: Violation[],
  goFilesAnalyzed: number,
): Record<string, AnalyzerResult> {
  const merged: Record<string, AnalyzerResult> = {};
  for (const [key, ar] of Object.entries(tsResults ?? {})) {
    merged[key] = { ...ar, violations: [...(ar.violations ?? [])] };
  }
  for (const [key, vs] of bucketByAnalyzer(goViolations)) {
    if (merged[key]) {
      merged[key].violations.push(...vs);
    } else {
      merged[key] = {
        violations: vs,
        status: makeVisitorStatus(goFilesAnalyzed),
        executionTime: 0,
        analyzerName: key,
      };
    }
  }
  return merged;
}

/**
 * Go rules that ran but had nothing to assess, because their declared input was
 * absent. `missing-org-filter` needs declared org-filter tables (config tiers or
 * DDL); `unknown-table` needs a known-table catalog. When a project declares
 * neither, the Go subprocess cannot accuse anything — it runs the rule and finds
 * zero. Without this, that silence reads `clean` (the strongest claim the tool
 * makes: "input present, nothing wrong"), when the truth is `notApplicable`
 * ("no input to check"). This mirrors the TS pipeline's `hasDeclaredTenancy`
 * gate, so the Go half does not quietly claim a corpus is tenancy-clean when it
 * simply has no declared tenancy to check against.
 */
function goUndeclaredTenancyRules(goTenantInputs?: GoTenantInputs): ReadonlyMap<string, string> {
  const rules = new Map<string, string>();
  if ((goTenantInputs?.orgFilterTables ?? []).length === 0) {
    rules.set('missing-org-filter', 'no org-filter tables declared (no .codeauditor.json or DDL tenancy)');
  }
  if ((goTenantInputs?.knownTables ?? []).length === 0) {
    rules.set('unknown-table', 'no known-table catalog declared (no .codeauditor.json schemas or DDL)');
  }
  return rules;
}

/**
 * Classify one analyzer's rules generically: `fired` (in violations), `clean`
 * (ran, no finding), or `notApplicable` (ran, but declared input absent). The
 * `notApplicable` case is threaded through `undeclaredTenancy` — a rule id the
 * caller flags as "ran with nothing to assess" reads `notApplicable`, never
 * `clean`. Language-agnostic — it cross-references the global registry by rule
 * id and reads `ranRules` (canonical rule ids), so it works unchanged the day
 * Python registers. `ranRules` is the analyzer's own report of which rules it
 * ran, and each rule's analyzer label is normalized to the registry's canonical
 * analyzer (the Go subprocess stamps everything `go` or `solid`, but the
 * registry maps e.g. `unknown-table` → `schema`).
 */
function coverageForRanRules(
  ranRules: ReadonlySet<string>,
  violations: Violation[],
  undeclaredTenancy?: ReadonlyMap<string, string>,
): Map<string, RuleCoverage> {
  const fired = new Map<string, number>();
  for (const v of violations) {
    fired.set(v.rule, (fired.get(v.rule) ?? 0) + 1);
  }
  const states = new Map<string, RuleCoverage>();
  for (const ruleId of ranRules) {
    const analyzer = RULE_REGISTRY[ruleId]?.analyzer ?? 'go';
    const count = fired.get(ruleId);
    if (count) {
      states.set(ruleId, { ruleId, analyzer, state: 'fired' as const, count });
    } else if (undeclaredTenancy?.has(ruleId)) {
      states.set(ruleId, {
        ruleId,
        analyzer,
        state: 'notApplicable' as const,
        count: 0,
        reason: undeclaredTenancy.get(ruleId),
      });
    } else {
      states.set(ruleId, { ruleId, analyzer, state: 'clean' as const, count: 0 });
    }
  }
  return states;
}

/**
 * Merge the TS pipeline's coverage with the Go half's. The TS coverage already
 * carries a row for every registry rule; the Go half's rules (whatever is in its
 * `ranRules`) overwrite their row with `fired` or `clean` — closing the gap where
 * a ran-but-clean Go rule would otherwise read `notApplicable`.
 */
function buildMergedCoverage(
  tsCoverage: RuleCoverage[] | undefined,
  goRanRules: ReadonlySet<string>,
  goViolations: Violation[],
  goTenantInputs?: GoTenantInputs,
): RuleCoverage[] {
  const coverage: RuleCoverage[] = (tsCoverage ?? []).map((row) => ({ ...row }));
  const undeclaredTenancy = goUndeclaredTenancyRules(goTenantInputs);
  for (const [ruleId, state] of coverageForRanRules(goRanRules, goViolations, undeclaredTenancy)) {
    const row = coverage.find((c) => c.ruleId === ruleId);
    if (row) {
      row.state = state.state;
      row.count = state.count;
      row.analyzer = state.analyzer;
      if (state.reason) row.reason = state.reason;
      else delete row.reason;
    } else {
      coverage.push(state);
    }
  }
  return coverage;
}

/**
 * Full coverage for a Go-only run: the Go half's ran rules read `fired` or
 * `clean`; every rule it did not run reads `notApplicable` (unclaimed).
 */
function buildGoOnlyCoverage(
  goRanRules: ReadonlySet<string>,
  goViolations: Violation[],
  goTenantInputs?: GoTenantInputs,
): RuleCoverage[] {
  const coverage: RuleCoverage[] = [];
  const claimed = new Set<string>();
  for (const [, state] of coverageForRanRules(goRanRules, goViolations, goUndeclaredTenancyRules(goTenantInputs))) {
    coverage.push(state);
    claimed.add(state.ruleId);
  }
  for (const [ruleId, entry] of Object.entries(RULE_REGISTRY)) {
    if (claimed.has(ruleId)) continue;
    coverage.push({
      ruleId,
      analyzer: entry.analyzer,
      state: 'notApplicable' as const,
      count: 0,
      reason: `no analyzer ran this rule`,
    });
  }
  return coverage;
}

/** Relay Go subprocess errors as report diagnostics. */
function buildGoDiagnostics(
  goResult: AnalysisResult,
): Array<{ analyzerName: string; kind: string; message: string }> {
  return (goResult.errors ?? []).map((err: any) => ({
    analyzerName: err?.language ?? 'go',
    kind: err?.type ?? 'error',
    message: err?.message ?? String(err),
  }));
}

function buildSummary(violations: Violation[], totalFiles: number): AuditSummary {
  let criticalIssues = 0;
  let severe = 0;
  let high = 0;
  const violationsByCategory: Record<string, number> = {};
  for (const v of violations) {
    if (v.severity === 'critical') criticalIssues++;
    else if (v.severity === 'severe') severe++;
    else if (v.severity === 'high') high++;
    violationsByCategory[v.rule] = (violationsByCategory[v.rule] ?? 0) + 1;
  }
  const topIssues = Object.entries(violationsByCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));
  return {
    totalViolations: violations.length,
    criticalIssues,
    severe,
    high,
    totalFiles,
    violationsByCategory,
    topIssues,
  };
}

function createFileToFunctionsMap(indexEntries: any[]): Record<string, any[]> {
  const fileMap: Record<string, any[]> = {};
  for (const entry of indexEntries) {
    if (!fileMap[entry.file]) fileMap[entry.file] = [];
    fileMap[entry.file].push(entry);
  }
  return fileMap;
}

/**
 * Write the merged result to the findings ledger (advisory, non-fatal). Mirrors
 * the runner's own ledger write — the TS half runs with `writeToLedger: false`,
 * so this is the single ledger writer for a mixed run.
 */
function writeMergedLedger(result: AuditResult, options: AuditRunnerOptions, projectRoot: string): void {
  void (async () => {
    try {
      const indexDb = CodeIndexDB.getInstance(undefined, projectRoot);
      await indexDb.initialize();
      const violations = Object.values(result.analyzerResults).flatMap((ar) => ar.violations);
      const scopeStr = typeof (options as any).scope === 'string' ? (options as any).scope : 'all';
      return writeAuditToLedger(
        indexDb.rawDb,
        detectRunInput(
          process.argv.slice(2).join(' '),
          (options as any).surface ?? 'cli',
          scopeStr,
          projectRoot,
          TOOL_VERSION,
        ),
        violations,
        result.metadata.auditDuration ?? 0,
        0, // exit status TBD — updateLedgerRunStatus by CLI after return
        { coverage: result.metadata.coverage },
      );
    } catch {
      return null;
    }
  })();
}
