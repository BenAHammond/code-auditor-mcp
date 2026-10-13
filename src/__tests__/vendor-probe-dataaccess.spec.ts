/**
 * Item B (reissued) — vendor-probe conformance for the data-access method names.
 *
 * The analyzer no longer hand-copies vendor method lists, and it no longer reads a
 * committed snapshot. The three derived sets (`eagerMethods`, `ormTableVerbs`,
 * `ormJoinVerbs`) are the union of the analyzer's irreducible cross-vendor grammar
 * (the baseline) and a per-run *probe* resolved from the tree's own `node_modules`.
 * This test pins the two halves of that contract:
 *
 *   1. the baseline survives an empty surface (no vendor resolved) — the generic
 *      SQL-driver/builder grammar is a judgment, not a vendor replica, so it never
 *      silently collapses;
 *   2. the probe supplies exactly the vendor-only methods the baseline lacks —
 *      `iterate` (better-sqlite3), `mergeInto`/`replaceInto` and
 *      `fullJoin`/`*JoinLateral` (Kysely) — and only when that vendor resolves;
 *   3. `resolveVendorSurfaces` reads a real `.d.ts` from a tree's `node_modules`,
 *      reporting the resolved path and installed version, and an `unproven`
 *      resolution (`path: null`, a reason naming what could not be resolved) on a
 *      tree where the vendor is absent;
 *   4. `COLLECTION_TRANSFORM_METHODS` remains a runtime probe over `Array.prototype`.
 *
 * This is a guard/derivation test. The end-to-end liveness (a finding that appears
 * only with the probe) is demonstrated against a real installed vendor in
 * `bench/corpus/vendor-probe/` and recorded in `specs/vendor-replica-probes.md`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import {
  deriveVendorSets,
  resolveVendorSurfaces,
  EMPTY_VENDOR_SURFACES,
  type VendorSurfaces,
} from '../analyzers/vendorSurfaces.js';
import { COLLECTION_TRANSFORM_METHODS } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** A synthetic resolved surface: the probe members the vendor publishes. */
function surfaceWith(overrides: Partial<VendorSurfaces>): VendorSurfaces {
  return {
    ...EMPTY_VENDOR_SURFACES,
    resolutions: [],
    ...overrides,
  };
}

describe('vendor-probe data-access method sets (item B, reissued)', () => {
  it('baseline survives an empty surface — no vendor, no collapse', () => {
    const d = deriveVendorSets(EMPTY_VENDOR_SURFACES);
    // The generic grammar is present even when nothing resolves…
    expect([...d.eagerMethods].sort()).toEqual(
      ['all', 'batch', 'exec', 'first', 'get', 'query', 'raw', 'run'].sort(),
    );
    expect([...d.ormTableVerbs].sort()).toEqual(
      ['deleteFrom', 'insertInto', 'selectFrom', 'updateTable'].sort(),
    );
    expect([...d.ormJoinVerbs].sort()).toEqual(
      ['innerJoin', 'join', 'leftJoin', 'rightJoin'].sort(),
    );
    // …and the probe-only methods are absent (unproven, not a fallback list).
    expect(d.eagerMethods.has('iterate')).toBe(false);
    expect(d.ormTableVerbs.has('mergeInto')).toBe(false);
    expect(d.ormTableVerbs.has('replaceInto')).toBe(false);
    expect(d.ormJoinVerbs.has('fullJoin')).toBe(false);
    expect(d.ormJoinVerbs.has('innerJoinLateral')).toBe(false);
  });

  it('probe adds iterate only when better-sqlite3 Statement resolves', () => {
    const none = deriveVendorSets(surfaceWith({ betterSqlite3Statement: null }));
    expect(none.eagerMethods.has('iterate')).toBe(false);

    const withIt = deriveVendorSets(
      surfaceWith({ betterSqlite3Statement: new Set(['run', 'get', 'all', 'iterate', 'raw']) }),
    );
    expect(withIt.eagerMethods.has('iterate')).toBe(true);
    // The baseline is unchanged by the probe.
    expect(withIt.eagerMethods.has('run')).toBe(true);
  });

  it('probe adds mergeInto/replaceInto only when Kysely QueryCreator resolves', () => {
    const none = deriveVendorSets(surfaceWith({ kyselyQueryCreator: null }));
    expect(none.ormTableVerbs.has('mergeInto')).toBe(false);
    expect(none.ormTableVerbs.has('replaceInto')).toBe(false);

    const withIt = deriveVendorSets(
      surfaceWith({ kyselyQueryCreator: new Set(['selectFrom', 'selectNoFrom', 'mergeInto', 'replaceInto', 'deleteFrom']) }),
    );
    expect(withIt.ormTableVerbs.has('mergeInto')).toBe(true);
    expect(withIt.ormTableVerbs.has('replaceInto')).toBe(true);
    // `selectNoFrom` is a selection, not a table-entry verb — the documented exclusion.
    expect(withIt.ormTableVerbs.has('selectNoFrom')).toBe(false);
  });

  it('probe adds fullJoin / *JoinLateral only when Kysely SelectQueryBuilder resolves', () => {
    const none = deriveVendorSets(surfaceWith({ kyselySelectQueryBuilder: null }));
    expect(none.ormJoinVerbs.has('fullJoin')).toBe(false);
    expect(none.ormJoinVerbs.has('leftJoinLateral')).toBe(false);

    const withIt = deriveVendorSets(
      surfaceWith({
        kyselySelectQueryBuilder: new Set(['innerJoin', 'fullJoin', 'innerJoinLateral', 'leftJoinLateral', 'where']),
      }),
    );
    expect(withIt.ormJoinVerbs.has('fullJoin')).toBe(true);
    expect(withIt.ormJoinVerbs.has('innerJoinLateral')).toBe(true);
    expect(withIt.ormJoinVerbs.has('leftJoinLateral')).toBe(true);
    // Non-join members do not leak in.
    expect(withIt.ormJoinVerbs.has('where')).toBe(false);
  });

  it('resolveVendorSurfaces reads a real .d.ts with path + version, and is unproven otherwise', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vendor-probe-'));
    try {
      // A tree with a vendored @types/better-sqlite3 declaration.
      const pkg = path.join(root, 'node_modules', '@types', 'better-sqlite3');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@types/better-sqlite3', version: '7.6.11' }));
      writeFileSync(
        path.join(pkg, 'index.d.ts'),
        `declare namespace BetterSqlite3 {
  interface Statement { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown; iterate(...params: unknown[]): unknown; raw(): unknown; }
  interface Database { exec(sql: string): unknown; }
}`,
      );

      const s = resolveVendorSurfaces(root);
      expect(s.betterSqlite3Statement).not.toBeNull();
      expect(s.betterSqlite3Statement!.has('iterate')).toBe(true);

      const rec = s.resolutions.find((r) => r.pkg === '@types/better-sqlite3' && r.type === 'Statement')!;
      expect(rec.path).toContain('better-sqlite3');
      expect(rec.version).toBe('7.6.11');
      expect(rec.reason).toBeNull();

      // A tree without any vendor installed: every surface null, reason names the miss.
      const bare = mkdtempSync(path.join(tmpdir(), 'vendor-probe-bare-'));
      const bareSurfaces = resolveVendorSurfaces(bare);
      expect(bareSurfaces.betterSqlite3Statement).toBeNull();
      expect(bareSurfaces.kyselyQueryCreator).toBeNull();
      expect(bareSurfaces.resolutions.length).toBe(8);
      const miss = bareSurfaces.resolutions.find((r) => r.pkg === 'kysely')!;
      expect(miss.path).toBeNull();
      expect(miss.reason).toContain('not installed');
      rmSync(bare, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('COLLECTION_TRANSFORM_METHODS are real Array.prototype functions', () => {
    expect([...COLLECTION_TRANSFORM_METHODS].sort()).toEqual(
      ['concat', 'filter', 'flatMap', 'map', 'slice', 'splice'].sort(),
    );
    for (const m of COLLECTION_TRANSFORM_METHODS) {
      expect(
        typeof (Array.prototype as unknown as Record<string, unknown>)[m],
        `${m} not on Array.prototype`,
      ).toBe('function');
    }
  });
});
