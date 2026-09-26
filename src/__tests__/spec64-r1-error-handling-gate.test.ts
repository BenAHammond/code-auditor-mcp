/**
 * Spec 64 R1 — gate `conventions/error-handling` on the language its detector
 * can classify.
 *
 * `detectErrorHandlingShape` wraps each function body as `async function
 * __ca() {…}` and parses it with the TypeScript grammar. A body in any other
 * language — Go's `if err != nil { … }`, for example — is unclassifiable: the
 * rule is TypeScript-shaped by construction. Spec 64 R2 populates Go bodies in
 * the function index, so without this gate a Go corpus would turn a *false
 * clean* (the query excluded Go rows) into *false findings* (the detector
 * misfires on Go bodies).
 *
 * R1 lands the gate first, three ways:
 *  1. The rule declares `handledLanguages` in the registry; a corpus holding
 *     *only* unhandled-language rows reports `cannot-fire` (never `clean`) at the
 *     coverage boundary — the "clean must mean could have fired" invariant. A
 *     mixed corpus (handled + unhandled) stays applicable: the handled rows are
 *     evaluated normally, the unhandled rows are per-file diagnostics.
 *  2. `body IS NOT NULL` stops being the row filter. A row in an unhandled
 *     language is reported unhandled (a `cannot-fire` coverage diagnostic, per
 *     file); a handled-language row with a missing body is an `engine-error`
 *     defect, not a silent skip.
 *  3. A Go-only corpus produces `cannot-fire` for `conventions/error-handling`,
 *     never `clean`; a mixed corpus does not lose its TypeScript findings.
 *
 * These tests pin the pure applicability predicate, the coverage boundary, and
 * the analyzer's per-file diagnostics.
 */

import { describe, it, expect } from 'vitest';
import { buildCoverageReport, makeReducerStatus } from '../pipeline.js';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';
import { evaluateHandledLanguagesApplicability } from '../analyzers/applicability.js';
import { UniversalConventionsAnalyzer } from '../analyzers/universal/UniversalConventionsAnalyzer.js';
import type { AnalyzerResult, IndexHandle } from '../types.js';

// ── 1. The pure predicate ──────────────────────────────────────────────────

describe('Spec 64 R1 — evaluateHandledLanguagesApplicability', () => {
  it('returns null when the rule declares no handledLanguages', () => {
    expect(evaluateHandledLanguagesApplicability(undefined, new Set(['go']))).toBeNull();
    expect(evaluateHandledLanguagesApplicability([], new Set(['go']))).toBeNull();
  });

  it('returns null when there are no corpus languages to gate on', () => {
    expect(evaluateHandledLanguagesApplicability(['typescript'], undefined)).toBeNull();
    expect(evaluateHandledLanguagesApplicability(['typescript'], new Set())).toBeNull();
  });

  it('returns null when every corpus language is handled', () => {
    expect(
      evaluateHandledLanguagesApplicability(['typescript', 'javascript'], new Set(['typescript'])),
    ).toBeNull();
    expect(
      evaluateHandledLanguagesApplicability(['typescript', 'javascript'], new Set(['typescript', 'javascript'])),
    ).toBeNull();
  });

  it('leaves a mixed corpus applicable (handled + unhandled is not cannot-fire)', () => {
    // A project that is 95% TypeScript with one .go file must NOT gate the whole
    // rule: the detector evaluates the TypeScript rows normally, and the .go rows
    // are the per-file diagnostics' job. Gating on a single stray unhandled row
    // would trade a false clean for a false cannot-fire.
    expect(
      evaluateHandledLanguagesApplicability(['typescript', 'javascript'], new Set(['typescript', 'go'])),
    ).toBeNull();
  });

  it('reports cannot-fire only when NO corpus language is handled', () => {
    const verdict = evaluateHandledLanguagesApplicability(
      ['typescript', 'javascript'],
      new Set(['go', 'rust']),
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.applicable).toBe(false);
    expect(verdict!.kind).toBe('cannot-fire');
    expect(verdict!.reason).toContain('typescript/javascript');
    expect(verdict!.reason).toContain('go');
    expect(verdict!.reason).toContain('rust');
  });
});

// ── 2. The coverage boundary ───────────────────────────────────────────────

/** Build the pipeline's rule-applicability fold over `handledLanguages` the way
 *  pipeline.ts does it, given the distinct `functions.language` values. */
function applicabilityForCorpus(corpusLanguages: string[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [ruleId, entry] of Object.entries(RULE_REGISTRY)) {
    const app = evaluateHandledLanguagesApplicability(
      entry.needs.formats,
      new Set(corpusLanguages),
    );
    if (app) map.set(ruleId, app);
  }
  return map;
}

/** Coverage over the conventions reducer with `reducer-ran` status (it consumed
 *  function-index facts), plus the handledLanguages applicability fold. */
function errorHandlingCoverage(corpusLanguages: string[]): ReturnType<typeof buildCoverageReport> {
  const results: Record<string, AnalyzerResult> = {
    conventions: {
      violations: [],
      executionTime: 0,
      analyzerName: 'conventions',
      status: makeReducerStatus(5),
    },
  };
  return buildCoverageReport(
    results,
    { projectRoot: '/test', config: { conventions: {} } },
    { factKeys: ['function-index'], indexTables: [] },
    applicabilityForCorpus(corpusLanguages) as any,
  );
}

describe('Spec 64 R1 — coverage boundary (mixed corpus stays applicable)', () => {
  it('does NOT gate a mixed corpus: TypeScript findings survive a stray Go row', () => {
    // The whole point of the corrected predicate: a repo with handled + unhandled
    // rows reports the rule via its normal path (here, zero findings → `clean`),
    // not `cannot-fire`. The Go rows are the per-file diagnostics' concern.
    const row = errorHandlingCoverage(['typescript', 'go']).find(
      (c) => c.ruleId === 'conventions/error-handling',
    );
    expect(row).toBeDefined();
    expect(row!.state).not.toBe('cannot-fire');
  });

  it('does not force cannot-fire on a TypeScript-only corpus', () => {
    const row = errorHandlingCoverage(['typescript']).find(
      (c) => c.ruleId === 'conventions/error-handling',
    );
    expect(row).toBeDefined();
    expect(row!.state).not.toBe('cannot-fire');
  });

  it('reports cannot-fire only when the corpus is exclusively unhandled', () => {
    // The rule could not have fired anywhere — no handled row exists — so `clean`
    // would claim "evaluated every function" when it evaluated none. The only
    // corpus that legitimately gates is one with zero handled rows.
    const coverage = errorHandlingCoverage(['go', 'rust']);
    const row = coverage.find((c) => c.ruleId === 'conventions/error-handling');
    expect(row).toBeDefined();
    expect(row!.state).toBe('cannot-fire');
    expect(row!.reason).toContain('go');
  });
});

// ── 3. The analyzer's per-file diagnostics ─────────────────────────────────

/** Minimal IndexHandle over in-memory conventions/function rows. */
function mockIndexHandle(
  conventions: unknown[],
  functionRows: Array<Record<string, unknown>>,
): IndexHandle {
  return {
    query(sql: string): unknown[] {
      if (sql.includes('FROM conventions')) return conventions;
      if (sql.includes('SELECT id, name, file_path, line_number, body, language')) return functionRows;
      if (sql.includes('SELECT DISTINCT file_path FROM functions')) {
        return [...new Set(functionRows.map((r) => r.file_path))].map((file_path) => ({ file_path }));
      }
      return [];
    },
    count() {
      return functionRows.length;
    },
    tableHasRows() {
      return false;
    },
    run() {
      return { changes: 0, lastInsertRowid: 0 };
    },
    exec() {},
    getMeta() {
      return undefined;
    },
    getUntestedTopDecile() {
      return [];
    },
  };
}

const ERROR_HANDLING_CONVENTION = {
  id: 1,
  domain: 'error-handling',
  rule_id: 'conventions/error-handling',
  antecedent: null,
  consequent: null,
  pattern: 'try-catch',
  directory: '/corpus',
  file_path: null,
  line: null,
  support: 10,
  total_cases: 12,
  confidence: 0.83,
  exemplar_file: null,
  exemplar_line: null,
};

function analyzeWith(conventions: unknown[], functionRows: Array<Record<string, unknown>>) {
  const analyzer = new UniversalConventionsAnalyzer();
  return analyzer.analyze([], { indexHandle: mockIndexHandle(conventions, functionRows) });
}

describe('Spec 64 R1 — analyzer per-file diagnostics', () => {
  it('a Go function row emits a cannot-fire diagnostic, never a clean skip', async () => {
    const goRow = {
      id: 1,
      name: 'ReadFile',
      file_path: '/corpus/main.go',
      line_number: 10,
      is_exported: 0,
      body: 'if err != nil { return err }',
      language: 'go',
    };
    const result = await analyzeWith([ERROR_HANDLING_CONVENTION], [goRow]);

    const cannotFire = result.diagnostics?.filter((d) => d.kind === 'cannot-fire');
    expect(cannotFire?.length).toBe(1);
    expect(cannotFire![0].file).toBe('/corpus/main.go');
    expect(cannotFire![0].line).toBe(10);
    expect(cannotFire![0].message).toContain('go');
    // No false finding from classifying the Go body.
    expect(result.violations).toEqual([]);
  });

  it('a handled-language row with no body is an engine-error defect, not a skip', async () => {
    const overloadRow = {
      id: 2,
      name: 'overload',
      file_path: '/corpus/overload.ts',
      line_number: 3,
      is_exported: 0,
      body: null,
      language: 'typescript',
    };
    const result = await analyzeWith([ERROR_HANDLING_CONVENTION], [overloadRow]);

    const engineErrors = result.diagnostics?.filter((d) => d.kind === 'engine-error');
    expect(engineErrors?.length).toBe(1);
    expect(engineErrors![0].file).toBe('/corpus/overload.ts');
    expect(engineErrors![0].line).toBe(3);
  });

  it('a handled-language row with a body is evaluated, not diagnosed', async () => {
    const tsRow = {
      id: 3,
      name: 'readFile',
      file_path: '/corpus/util.ts',
      line_number: 5,
      is_exported: 0,
      body: 'try { await read() } catch (e) { throw e }',
      language: 'typescript',
    };
    const result = await analyzeWith([ERROR_HANDLING_CONVENTION], [tsRow]);

    expect(result.diagnostics ?? []).toEqual([]);
    // Matches the dominant `try-catch` shape → no deviation violation either.
    expect(result.violations).toEqual([]);
  });

  it('a mixed table diagnoses the Go row and still evaluates the TypeScript row', async () => {
    const goRow = {
      id: 1,
      name: 'ReadFile',
      file_path: '/corpus/main.go',
      line_number: 10,
      is_exported: 0,
      body: 'if err != nil { return err }',
      language: 'go',
    };
    const tsRow = {
      id: 2,
      name: 'readFile',
      file_path: '/corpus/util.ts',
      line_number: 5,
      is_exported: 0,
      body: 'try { await read() } catch (e) { throw e }',
      language: 'typescript',
    };
    const result = await analyzeWith([ERROR_HANDLING_CONVENTION], [goRow, tsRow]);

    // Only the Go row is diagnosed — a stray `.go` file must not cascade a
    // cannot-fire onto the TypeScript row it sits beside (the over-reach fix).
    const cannotFire = result.diagnostics?.filter((d) => d.kind === 'cannot-fire');
    expect(cannotFire?.length).toBe(1);
    expect(cannotFire![0].file).toBe('/corpus/main.go');
    expect(result.diagnostics?.filter((d) => d.kind === 'engine-error')).toEqual([]);
    // The TypeScript row is still evaluated (dominant shape → no deviation).
    expect(result.violations).toEqual([]);
  });
});
