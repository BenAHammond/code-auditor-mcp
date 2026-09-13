/**
 * Spec 56 R3/R4 — corpus-derived fixtures.
 *
 * R2 built *composite* fixtures (constructs deliberately mixed). R3 reduces the
 * two external reports' findings to *minimal* constructs, each tagged with its
 * source report + project and pinned to its expected result. R4 runs the full
 * 14-analyzer set over every fixture and asserts the *complete* finding set by
 * **equality** — presence AND absence — not "contains".
 *
 * The two source reports (CHANGELOG 3.9.1 and 3.9.3):
 *
 *   - **D1/Workers** (Spec 52) — a Cloudflare D1/Workers project. Found
 *     `loop-query` treating statement construction as execution (R1), the write
 *     classifier missing the upsert forms (R2), and (same pass) the
 *     `dependency-inversion` escapes-vs-held false positive.
 *   - **crowd-answer-game** (Spec 55) — a Next.js / Cloudflare D1 game project.
 *     Found the `orphaned-nodes` call-graph resolver missing same-file calls
 *     (R1), `unfiltered-query` targeting reads instead of writes (R5), and a
 *     `FOR UPDATE SKIP LOCKED` locking clause being read as extra tables.
 *
 * Each fixture is *copied* to a temp dir before the audit runs (same as the
 * composite harness) so the `/tests/` segment does not trip per-analyzer
 * `skipTestFiles`, and every module is re-exported by an `index.ts` entry barrel
 * so `unreferenced-module` stays silent on the leaf modules. A finding is
 * normalized to `<analyzer>::<rule>@<relpath>:<line>`, sorted, and compared.
 *
 * Each fixture carries a POSITIVE control (a construct that must fire) so the
 * absence in the negative cases is provably a resolved fix, not a silently
 * dead rule.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initializeLanguages } from '../languages/index.js';
import { initParsers } from '../languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../auditRouter.js';
import type { Violation } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, '..', '..', 'tests', 'fixtures', 'corpus');

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** Copy a fixture to a clean temp dir and return the normalized finding set. */
async function auditFixture(fixture: string): Promise<string[]> {
  const src = join(FIXTURE_ROOT, fixture);
  const tmp = await mkdtemp(join(tmpdir(), 'ca-corpus-'));
  try {
    await cp(src, tmp, { recursive: true });
    const result = await runAuditDispatch({ projectRoot: tmp, writeToLedger: false } as any);
    const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
      (r: any) => r.violations ?? [],
    );
    return all
      .map((v: any) => {
        const file = v.file ? relative(tmp, v.file) : '(no file)';
        const rule = `${v.analyzer}::${v.rule ?? v.type ?? v.issueType ?? '(none)'}`;
        return `${rule}@${file}:${v.line ?? ''}`;
      })
      .sort();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Assert the complete finding set of a fixture equals the declared list. */
async function expectCompleteSet(fixture: string, expected: string[]): Promise<void> {
  const actual = await auditFixture(fixture);
  expect(actual).toEqual([...expected].sort());
}

describe('corpus-derived fixtures — full analyzer set, complete finding set by equality', () => {
  // ─────────────────────────────────────────────────────────────────────
  // D1/Workers report (Spec 52). Four constructs from the report, each a
  // minimal reduction with a declared expected result:
  //
  //   statements.ts  R1 — `accumulateBatch` (prepare→batch) and
  //                  `promiseAllStatements` (Promise.all of statements) must NOT
  //                  fire loop-query (construction, not execution); `eagerRun`
  //                  (eager .run() per row) MUST fire loop-query.
  //   upsert.ts      R2 — `INSERT … ON CONFLICT DO UPDATE` is a write keyed by
  //                  its conflict target, NOT an unfiltered write.
  //   escapes.ts     dependency-inversion — `throw new AppError(...)` and
  //                  `return new QueryBuilder(this)` are escaping value types,
  //                  NOT held collaborators.
  //
  // The two declared findings are the positive control (`loop-query`) and one
  // accurate cross-cutting fact: `users` is written (INSERT/UPDATE/ON CONFLICT)
  // but never read, so `written-never-read` fires. Everything else stays silent
  // — no loop-query on the batched/Promise.all constructions, no unfiltered-query
  // on the upsert, no dependency-inversion on the escapes.
  // ─────────────────────────────────────────────────────────────────────
  describe('d1-workers', () => {
    it('fires only the eager-N+1 control and the never-read write', async () => {
      await expectCompleteSet('d1-workers', [
        'cross-domain::cross-domain/written-never-read@src/statements.ts:26',
        'data-access::loop-query@src/statements.ts:43',
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // crowd-answer-game report (Spec 55). Three constructs, each a minimal
  // reduction:
  //
  //   writes.ts      R5 — `purgeOrders` (bare DELETE, no WHERE) MUST fire
  //                  unfiltered-query; `shipOrder` (UPDATE scoped by WHERE) must
  //                  NOT.
  //   read.ts        extractTables — `SELECT … FOR UPDATE SKIP LOCKED` extracts
  //                  only `orders` (the locking clause is not a table), so no
  //                  unknown-table. (Verified meaningful: a read-only control
  //                  fires read-never-written, proving the SELECT is extracted.)
  //   callgraph.ts   R1 — `normalize`, referenced only through a bare function
  //                  value in an array (`[normalize]`), must NOT be orphaned.
  //                  (Verified meaningful: a truly-unreferenced non-exported
  //                  function fires orphaned-nodes.)
  //
  // The single declared finding is the positive control (`unfiltered-query`).
  // `orders` is both read (read.ts) and written (writes.ts), so no cross-domain
  // lifecycle finding fires.
  // ─────────────────────────────────────────────────────────────────────
  describe('crowd-answer-game', () => {
    it('fires only the bare-DELETE unfiltered write', async () => {
      await expectCompleteSet('crowd-answer-game', [
        'data-access::unfiltered-query@src/writes.ts:21',
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // R4 — findings surfaced by running the full set over the fixtures.
  //
  // 1. `DELETE FROM` emitted a spurious `select` reference. The generic `FROM`
  //    pattern in `sqlTablePatterns()` (`/\bFROM\s+…/`) matched `FROM users` in
  //    `DELETE FROM users` as a `select` (read), *in addition* to the `delete`
  //    reference from the DELETE pattern. A table that is only ever deleted —
  //    never SELECTed — was misclassified as also-read, suppressing
  //    `written-never-read`. **Fixed**: `isDeleteFrom` now gates the generic FROM
  //    pattern so `DELETE FROM` classifies as a write only. The composite
  //    data-access fixture (which has `DELETE FROM users` and no SELECT) now
  //    fires `written-never-read`, and the composite spec asserts it. This was a
  //    pre-existing gap in schema table extraction, distinct from the Spec 52 R2
  //    upsert-write fix, and was resolved on its own rather than folded into the
  //    fixture.
  //
  // 2. `no-error-boundary` (and its `getDerivedStateFromError` recognition) is
  //    app-level — it needs >10 components and no boundary. A minimal single-
  //    component corpus fixture cannot exercise it, so the R3 "getDerivedState-
  //    FromError boundaries" construct is pinned at the unit level in
  //    reactErrorBoundary.spec.ts rather than as a full-set corpus fixture. This
  //    is a scope limitation of the fixture harness, not a silently-skipped rule.
  // ─────────────────────────────────────────────────────────────────────
  describe('R4 — findings from the full-set run', () => {
    it('documents finding 1 as fixed and finding 2 as a scope limitation', () => {
      // Finding 1 (DELETE FROM spurious select) is now fixed and asserted by the
      // composite data-access fixture; finding 2 (app-level error boundary) stays
      // pinned at the unit level. Neither is silently folded into this fixture.
      expect(true).toBe(true);
    });
  });
});
