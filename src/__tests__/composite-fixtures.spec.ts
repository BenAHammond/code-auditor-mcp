/**
 * Spec 56 R2/R4 — composite fixtures.
 *
 * Each fixture is a small tree that *mixes* constructs known to have interacted
 * historically, rather than a minimal single-construct case. The test runs the
 * FULL analyzer set over each fixture and asserts the *complete* finding set by
 * **equality** — presence AND absence — not "contains".
 *
 * A finding is normalized to `<analyzer>::<rule>@<relpath>:<line>`, sorted, and
 * compared to a declared list. Anything firing beyond the declared set is a
 * real finding (reported, reasoned about) — not silently folded into the
 * fixture. See the per-fixture comments for the rationale, including which
 * findings are the fixture's *target* rules and which are accurate
 * cross-cutting findings (e.g. cross-domain lifecycle) that the full set also
 * surfaces.
 *
 * The fixtures live under `tests/fixtures/composite/` (the standard location),
 * but each is *copied* to a temp dir before the audit runs. The temp path has no
 * `tests/` / `test/` / `__tests__/` segment, so the per-analyzer
 * `skipTestFiles` exclusion (which would otherwise treat the fixture as a test
 * file and skip it — e.g. SOLID's whole-file skip) does not fire. The full
 * 14-analyzer set therefore treats the fixture as source, exactly as R4 wants.
 *
 * Every fixture also carries an `index.ts` entry barrel that re-exports the
 * fixture modules. `index` is an entry-point basename, so it is never flagged
 * `unreferenced-module`, and its re-export makes every other module "referenced"
 * — silencing the otherwise-unavoidable `dependency-graph::unreferenced-module`
 * noise that a leaf fixture module (exported but imported by nothing) would
 * otherwise emit.
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
const FIXTURE_ROOT = join(__dirname, '..', '..', 'tests', 'fixtures', 'composite');

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** Copy a fixture to a clean temp dir and return the normalized finding set. */
async function auditFixture(fixture: string): Promise<string[]> {
  const src = join(FIXTURE_ROOT, fixture);
  const tmp = await mkdtemp(join(tmpdir(), 'ca-composite-'));
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

describe('composite fixtures — full analyzer set, complete finding set by equality', () => {
  // ─────────────────────────────────────────────────────────────────────
  // 1. Data access — six query-shape constructs in one file.
  //
  // Target rules: the genuine N+1 (`loop-query`) and the bare DELETE
  // (`unfiltered-query`). The batch-accumulated prepares, the ON CONFLICT
  // upsert, the filtered write, and the non-SQL `update()` method must NOT
  // fire anything — the upsert in particular is the R1 fix (an upsert is
  // keyed by its conflict target, not an unfiltered write).
  //
  // `users` is written (INSERT/UPDATE/DELETE) but never SELECTed, so
  // `written-never-read` fires. This is the Spec 56 R4 finding, now fixed:
  // the generic `FROM` pattern used to read `DELETE FROM users` as a `select`,
  // silently classifying the delete-only table as also-read and suppressing
  // `written-never-read`. The context-aware FROM no longer does.
  // ─────────────────────────────────────────────────────────────────────
  describe('data-access', () => {
    it('fires exactly the N+1, the bare DELETE, and the never-read write', async () => {
      await expectCompleteSet('data-access', [
        'cross-domain::cross-domain/written-never-read@src/mixed.ts:38',
        'data-access::loop-query@src/mixed.ts:31',
        'data-access::unfiltered-query@src/mixed.ts:38',
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. Class structure — five SOLID constructs stacked in one file.
  //
  // Target rules: class-size (god class), liskov-substitution (override that
  // throws where the parent does not), open-closed (instanceof a user type
  // inside a class method), dependency-inversion (concrete `new` held), and
  // parameter-count (five params). Every public member is JSDoc'd so the
  // documentation analyzer stays silent.
  // ─────────────────────────────────────────────────────────────────────
  describe('class-structure', () => {
    it('fires the five SOLID rules and nothing else', async () => {
      await expectCompleteSet('class-structure', [
        'solid::solid/liskov-substitution@src/classes.ts:27',
        'solid::solid/dependency-inversion@src/classes.ts:41',
        'solid::solid/open-closed@src/classes.ts:62',
        'solid::parameter-count@src/classes.ts:73',
        'solid::solid/class-size@src/classes.ts:84',
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Cross-file references — barrel re-export + direct import + orphan.
  //
  // Target rule: `unreferenced-module` on the one genuinely unreferenced
  // module. The barrel (`index.ts → barrel.ts → lib.ts`) and the direct
  // import (`consumer.ts → lib.ts`) must resolve the reference chain so
  // `lib`/`barrel`/`consumer` are NOT flagged. This is the R3 "barrel
  // re-export" concern: a re-export counts as a reference.
  // ─────────────────────────────────────────────────────────────────────
  describe('cross-file', () => {
    it('flags only the orphan module, resolving the barrel chain', async () => {
      await expectCompleteSet('cross-file', [
        'dependency-graph::unreferenced-module@src/orphan.ts:1',
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. Styles — one component mixing three styling concerns.
  //
  // Target rules: `undefined-class` (a className with no CSS definition),
  // `token-bypass` (a raw `#1a2b3c` used instead of the `--color-brand`
  // token), and `z-index-singleton` (a lone `z-index: 10` in a three-value
  // inventory). The defined classes and repeated z-index values stay silent.
  // ─────────────────────────────────────────────────────────────────────
  describe('styles', () => {
    it('fires undefined-class, token-bypass, and the lone z-index', async () => {
      await expectCompleteSet('styles', [
        'styles::styles/token-bypass@src/Button.tsx:3',
        'styles::styles/undefined-class@src/Button.tsx:3',
        'styles::styles/z-index-singleton@src/tokens.css:9',
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. Schema — three table references against a two-table migration.
  //
  // Target rules: `unknown-table` (audit_logs, declared in no migration) and
  // `table-naming-convention` (userProfiles, camelCase). The three SELECTs
  // also surface three accurate cross-cutting `cross-domain/read-never-written`
  // findings — the fixture has reads but no write paths, so every read table
  // is "read, never written". These are declared (not adjusted) because they
  // are correct lifecycle facts the full set surfaces.
  // ─────────────────────────────────────────────────────────────────────
  describe('schema', () => {
    it('flags the unknown and mis-named tables plus the lifecycle reads', async () => {
      await expectCompleteSet('schema', [
        'cross-domain::cross-domain/read-never-written@src/queries.ts:8',
        'cross-domain::cross-domain/read-never-written@src/queries.ts:13',
        'cross-domain::cross-domain/read-never-written@src/queries.ts:18',
        'schema::unknown-table@src/queries.ts:13',
        'schema-code::table-naming-convention@src/queries.ts:18',
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. Wrapping matrix — a matrix of concern combinations in one file.
  //
  // Target rule: `single-responsibility`, fired when a function spans two
  // irreducible ("voting") concerns. fetch+email and fetch+render fire;
  // fetch+transform (related) and email+log (one voting concern) must NOT.
  // ─────────────────────────────────────────────────────────────────────
  describe('wrapping-matrix', () => {
    it('fires single-responsibility only on the two mixed-concern functions', async () => {
      await expectCompleteSet('wrapping-matrix', [
        'solid::solid/single-responsibility@src/concerns.ts:17',
        'solid::solid/single-responsibility@src/concerns.ts:23',
      ]);
    });
  });
});
