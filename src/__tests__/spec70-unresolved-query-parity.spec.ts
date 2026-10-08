/**
 * Spec 70 1b — the corpus `unresolved-query` reduction, parity-pinned.
 *
 * The legacy `schema-code` visitor emitted `checkUnresolvedQueries` for every
 * DB-call `findTableReferences` admitted via `dbCallVerdict` (i.e.
 * `identifyHandle` said "DB handle" — `handle` or `unproven`, never `not-handle`)
 * but whose SQL argument was held in an identifier `resolveQuerySql` could not
 * statically resolve (imported constant, computed expression, call result). The
 * collapse re-derives that surface with no AST: `extractSchemaUsageCandidates`
 * carries the raw `unresolved` record on each `DbCallCandidate`, and the corpus
 * producer re-admits it through `identifyHandle` — dropping any call whose
 * receiver is not a DB handle — so a non-DB receiver (`page.$`, `$('.foo')`)
 * never emits `unresolved-query`. The guarantee is:
 *
 *   classifyUnresolvedQuerySites(schema-usage-candidates, within-file-provenance,
 *     receiver-provenance, receiver-activity, dialect)
 *   ≡ findTableReferences(ast, …, { provenanceContext }).unresolved
 *
 * — byte-identical (identifier + call-site location), for every fixture. When the
 * second parse is deleted, this is the proof the corpus producer re-derives the
 * old `unresolved-query` diagnostic set. It is the `unresolved` sibling of
 * `spec68-schema-parity` (which pins the resolved table references) and leans on
 * `spec70-classify-build-provenance-parity` + `spec70-receiver-provenance-parity`
 * for the provenance halves both sides share.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { buildProvenanceContext } from '../analyzers/provenance.js';
import { findTableReferences } from '../analyzers/universal/schema/codeAnalysis.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';
import type { Dialect } from '../mcp-tools/discoveryQueries.js';
import { extractSchemaUsageCandidates } from '../phase/schemaUsageCandidates.js';
import { extractWithinFileProvenance, evidenceToFact } from '../phase/withinFileProvenance.js';
import { extractImportSpecifiers } from '../phase/importSpecifiers.js';
import { extractExportSymbols } from '../phase/exportSymbols.js';
import { extractGoPackageBindings } from '../phase/goPackageBindings.js';
import { extractReceiverActivity } from '../phase/receiverActivity.js';
import { computeReceiverProvenance } from '../phase/receiverProvenance.js';
import { classifyUnresolvedQuerySites } from '../phase/receiverConsumers.js';
import type { AstFile, ReceiverProvenanceFact } from '../phase/types.js';

let adapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

/** Canonical `unresolved` multiset — sorted (identifier, line, column). */
function canonUnresolved(
  records: readonly { identifier: string; location: { line: number; column: number } }[],
): string {
  return JSON.stringify(
    records
      .map((r) => [r.identifier, r.location.line, r.location.column] as const)
      .sort((a, b) => {
        const ka = JSON.stringify(a);
        const kb = JSON.stringify(b);
        return ka < kb ? -1 : 1;
      }),
  );
}

/** Run both sides and return the canonical unresolved multisets. */
function both(src: string, dialect: Dialect | null): { expected: string; actual: string } {
  const ast = parseFile('/fixture/parity.ts', src)!;
  const file: AstFile = {
    file: '/fixture/parity.ts',
    format: 'typescript',
    source: src,
    ast,
    adapter,
  };
  try {
    // The four additive file facts + receiver activity, once.
    const candidates = extractSchemaUsageCandidates(file);
    const withinFacts = extractWithinFileProvenance(file);
    const importFacts = extractImportSpecifiers(file);
    const exportFacts = extractExportSymbols(file);
    const goPackageFacts = extractGoPackageBindings(file);
    const activityFacts = extractReceiverActivity(file);

    // The cross-file fixed point — the seed both sides read (empty for a
    // self-contained fixture, so it is exactly the within-file provenance).
    const { fileProvenance, unresolvedImports } = computeReceiverProvenance(
      withinFacts,
      importFacts,
      exportFacts,
      goPackageFacts,
      undefined,
    );
    const seed = fileProvenance.get('/fixture/parity.ts') ?? new Map();

    // Legacy side: the same seed threaded into `buildProvenanceContext`, then the
    // DB-call strategy of `findTableReferences` (admission via `dbCallVerdict`
    // → `identifyHandle`, SQL resolution via `resolveQuerySql`).
    const provenanceContext = buildProvenanceContext(ast, adapter, src, {
      mode: 'hybrid',
      dbBindingNames: DEFAULT_SCHEMA_CONFIG.dbBindingNames,
      dbWrapperNames: DEFAULT_SCHEMA_CONFIG.dbWrapperNames,
      seedProvenance: seed,
      sqlDialect: dialect,
    });
    const legacyUnresolved = findTableReferences(ast, adapter, src, {
      config: { ...DEFAULT_SCHEMA_CONFIG, sqlDialect: dialect },
      provenanceContext,
    }).unresolved;

    // Phase side: the serialized fixed point fact, then the corpus reduction.
    const provenanceFact: ReceiverProvenanceFact = {
      files: [...fileProvenance.entries()].map(([f, prov]) => ({
        file: f,
        provenance: [...prov.values()].map(evidenceToFact),
      })),
      unresolvedImports: unresolvedImports.map((u) => ({ importer: u.importer, source: u.source, names: u.names })),
    };
    const phaseUnresolved = classifyUnresolvedQuerySites(candidates, {
      withinFacts,
      provenance: provenanceFact,
      activityFacts,
      sqlDialect: dialect,
    });

    return {
      expected: canonUnresolved(legacyUnresolved),
      actual: canonUnresolved(phaseUnresolved),
    };
  } finally {
    ast.dispose?.();
  }
}

function expectParity(src: string, dialect: Dialect | null = 'sqlite'): void {
  const { expected, actual } = both(src, dialect);
  expect(actual).toBe(expected);
}

describe('Spec 70 1b — classifyUnresolvedQuerySites ≡ findTableReferences().unresolved', () => {
  it('a provenanced handle with an imported SQL constant emits one unresolved record', () => {
    const { expected, actual } = both(
      `import Database from 'better-sqlite3';
import { UPSERT_SQL } from './queries';
const db = new Database(':memory:');
db.prepare(UPSERT_SQL);
`,
      'sqlite',
    );
    expect(actual).toBe(expected);
    expect(JSON.parse(actual)).toEqual([['UPSERT_SQL', 4, 1]]);
  });

  it('a provenanced handle with a direct string argument emits no unresolved record', () => {
    const { expected, actual } = both(
      `import Database from 'better-sqlite3';
const db = new Database(':memory:');
db.prepare('SELECT * FROM users');
`,
      'sqlite',
    );
    expect(actual).toBe(expected);
    expect(JSON.parse(actual)).toEqual([]);
  });

  it('a type-annotated D1Database param with an unresolvable SQL emits one unresolved record (unproven, admitted)', () => {
    const { expected, actual } = both(
      `import { UPSERT_SQL } from './queries';
export function getUser(db: D1Database) {
  return db.prepare(UPSERT_SQL);
}
`,
      'sqlite',
    );
    expect(actual).toBe(expected);
    expect(JSON.parse(actual)).toEqual([['UPSERT_SQL', 3, 10]]);
  });

  it('an unbound global receiver (no declaration) is `not-handle` and never emits unresolved-query, even with an unresolvable SQL', () => {
    const { expected, actual } = both(
      `import { IMPORTED_SQL } from './queries';
export function run() {
  return db.query(IMPORTED_SQL);
}
`,
      'sqlite',
    );
    expect(actual).toBe(expected);
    expect(JSON.parse(actual)).toEqual([]);
  });

  it('a structured literal argument is neither SQL nor unresolved on either side', () => {
    const { expected, actual } = both(
      `import Database from 'better-sqlite3';
const db = new Database(':memory:');
db.exec(['CREATE TABLE a (id INT)', 'CREATE TABLE b (id INT)']);
`,
      'sqlite',
    );
    expect(actual).toBe(expected);
    expect(JSON.parse(actual)).toEqual([]);
  });
});
