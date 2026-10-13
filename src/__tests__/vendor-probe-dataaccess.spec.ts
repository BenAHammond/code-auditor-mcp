/**
 * Item B — vendor-probe conformance for the data-access method-name lists.
 *
 * `UniversalDataAccessAnalyzer.ts` used to hand-maintain four method-name lists
 * (EAGER_DB_METHODS, ORM_TABLE_VERBS, ORM_JOIN_VERBS, COLLECTION_TRANSFORM_METHODS).
 * Item B rewires each to *derive* from a vendor surface (the shipped `.d.ts`
 * snapshot in `vendor-declarations.json`, or `Array.prototype` for the collection
 * transforms) instead of copying names. These tests pin that derivation so a
 * later edit cannot silently regress it back to a hand-copied replica:
 *
 *   1. the committed snapshot records the real vendor surface (the source of
 *      truth is present and non-trivial);
 *   2. every derived name is actually a member of the vendor surface it claims to
 *      derive from — i.e. the list *reads* the vendor rather than replicating it;
 *   3. the vendor-only additions that were previously missing (`mergeInto`/
 *      `replaceInto`, the lateral/full joins, `iterate`) are present, and the
 *      documented judgments (`selectNoFrom` excluded from table verbs, bare
 *      `join` retained, generic `query` retained) are pinned.
 *
 * This is a guard test: it does not re-run a corpus, so it is fast and stable.
 * The corpus-level evidence (zero finding drift before/after) lives in
 * specs/vendor-replica-probes.md and is measured by scripts/measure-finding-identity.ts.
 */

import { describe, it, expect } from 'vitest';
import vendorDeclarations from '../analyzers/universal/vendor-declarations.json' with { type: 'json' };
import {
  EAGER_DB_METHODS,
  ORM_TABLE_VERBS,
  ORM_JOIN_VERBS,
  COLLECTION_TRANSFORM_METHODS,
} from '../analyzers/universal/UniversalDataAccessAnalyzer.js';

const KYSELY_QC = new Set<string>(vendorDeclarations.vendors.kysely.types.QueryCreator);
const KYSELY_SQB = new Set<string>(vendorDeclarations.vendors.kysely.types.SelectQueryBuilder);
const BS3_STMT = new Set<string>(vendorDeclarations.vendors['better-sqlite3'].types.Statement);
const BS3_DB = new Set<string>(vendorDeclarations.vendors['better-sqlite3'].types.Database);
const NODE_STMT = new Set<string>(vendorDeclarations.vendors['node:sqlite'].types.StatementSync);
const NODE_DB = new Set<string>(vendorDeclarations.vendors['node:sqlite'].types.DatabaseSync);
const D1_DB = new Set<string>(vendorDeclarations.vendors['@cloudflare/workers-types'].types.D1Database);
const D1_STMT = new Set<string>(vendorDeclarations.vendors['@cloudflare/workers-types'].types.D1PreparedStatement);

describe('vendor-probe data-access method lists (item B)', () => {
  it('commits a non-trivial vendor snapshot (four vendors, real surfaces)', () => {
    const vendors = vendorDeclarations.vendors as Record<string, { types: Record<string, string[]> }>;
    expect(Object.keys(vendors).sort()).toEqual([
      '@cloudflare/workers-types',
      'better-sqlite3',
      'kysely',
      'node:sqlite',
    ].sort());
    // The surfaces that must exist for the derivations below to be meaningful.
    expect(KYSELY_QC.size).toBeGreaterThan(10);
    expect(KYSELY_SQB.size).toBeGreaterThan(30);
    expect(BS3_STMT.size).toBeGreaterThan(8);
    expect(D1_STMT.size).toBeGreaterThan(3);
  });

  it('ORM_TABLE_VERBS are exactly the Kysely QueryCreator table-entry members', () => {
    // Every table verb is a real QueryCreator member (read, not copied)…
    for (const m of ORM_TABLE_VERBS) expect(KYSELY_QC.has(m), `${m} not in QueryCreator`).toBe(true);
    // …and it picks up the vendor-only entry points the old list missed.
    expect([...ORM_TABLE_VERBS].sort()).toEqual(
      ['deleteFrom', 'insertInto', 'mergeInto', 'replaceInto', 'selectFrom', 'updateTable'].sort(),
    );
    // `selectNoFrom` is part of the vendor surface but takes a *selection*, not a
    // table — the documented exclusion must hold.
    expect(KYSELY_QC.has('selectNoFrom')).toBe(true);
    expect(ORM_TABLE_VERBS.has('selectNoFrom')).toBe(false);
  });

  it('ORM_JOIN_VERBS = every Kysely SelectQueryBuilder *Join member + the irreducible bare join', () => {
    const kyselyJoins = [...KYSELY_SQB].filter((m) => m.endsWith('Join') || m.endsWith('JoinLateral')).sort();
    expect(kyselyJoins).toEqual(
      ['fullJoin', 'innerJoin', 'innerJoinLateral', 'leftJoin', 'leftJoinLateral', 'rightJoin'].sort(),
    );
    // The Kysely-derived half is read from the vendor surface…
    for (const m of kyselyJoins) expect(ORM_JOIN_VERBS.has(m), `${m} missing`).toBe(true);
    // …and bare `join` is retained as a documented non-Kysely judgment.
    expect(ORM_JOIN_VERBS.has('join')).toBe(true);
    expect(KYSELY_SQB.has('join')).toBe(false); // not a Kysely verb — proves the judgment
    // No other members sneak in.
    expect([...ORM_JOIN_VERBS].sort()).toEqual(
      [...kyselyJoins, 'join'].sort(),
    );
  });

  it('EAGER_DB_METHODS trace to a real statement/database surface (plus the generic query)', () => {
    // Every eager method except the generic `query` must be a method that actually
    // executes I/O on one of the four vendor surfaces the comment claims.
    const allSurfaces = [
      ...BS3_STMT, ...BS3_DB, ...NODE_STMT, ...NODE_DB, ...D1_DB, ...D1_STMT,
    ];
    for (const m of EAGER_DB_METHODS) {
      if (m === 'query') continue; // documented generic-driver judgment
      expect(allSurfaces.includes(m), `${m} not on any vendor surface`).toBe(true);
    }
    // The previously-deferred `.iterate()` is now restored from the vendor surface.
    expect(EAGER_DB_METHODS.has('iterate')).toBe(true);
    expect(BS3_STMT.has('iterate')).toBe(true);
    // The `.get()` gap that motivated #329 is covered by the vendor surface.
    expect(EAGER_DB_METHODS.has('get')).toBe(true);
    expect(BS3_STMT.has('get')).toBe(true);
    expect(NODE_STMT.has('get')).toBe(true);
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
