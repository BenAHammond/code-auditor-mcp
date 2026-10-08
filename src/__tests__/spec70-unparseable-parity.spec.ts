/**
 * Spec 70 R2 — the corpus `unparseable` reduction, parity-pinned.
 *
 * The legacy `schema-code` visitor emitted `checkUnparseableSql` for every
 * DB-call / tagged-template SQL argument `findTableReferences` admitted (via
 * `dbCallVerdict` → `identifyHandle`, i.e. "DB handle") but whose static text
 * the named dialect could not parse (e.g. SQLite `PRAGMA`/`VACUUM`/`ANALYZE`,
 * which node-sql-parser rejects). The collapse re-derives that surface with no
 * AST: `classifyUnparseableSql` re-admits each tagged template and DB-call
 * through the same gates `classifySchemaUsage` uses, then re-parses and keeps
 * `parseSqlTables().unparseable` (the half `classifySchemaUsage` discards). The
 * guarantee is:
 *
 *   classifyUnparseableSql(schema-usage-candidates, within-file-provenance,
 *     receiver-provenance, receiver-activity, dialect)
 *   ≡ findTableReferences(ast, …, { provenanceContext }).unparseable
 *
 * — byte-identical (`sqlText` + location + `reason` + `kind`), for every fixture.
 * When the second parse is deleted, this is the proof the corpus producer
 * re-derives the old `unparseable` cannot-fire diagnostic set. It is the
 * `unparseable` sibling of `spec70-unresolved-query-parity` (the `unresolved`
 * half) and leans on `spec70-classify-build-provenance-parity` +
 * `spec70-receiver-provenance-parity` for the provenance halves both sides share.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { buildProvenanceContext } from '../analyzers/provenance.js';
import { findTableReferences } from '../analyzers/universal/schema/codeAnalysis.js';
import type { UnparseableSql } from '../analyzers/universal/schema/codeAnalysis.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';
import type { Dialect } from '../mcp-tools/discoveryQueries.js';
import { extractSchemaUsageCandidates } from '../phase/schemaUsageCandidates.js';
import { extractWithinFileProvenance, evidenceToFact } from '../phase/withinFileProvenance.js';
import { extractImportSpecifiers } from '../phase/importSpecifiers.js';
import { extractExportSymbols } from '../phase/exportSymbols.js';
import { extractGoPackageBindings } from '../phase/goPackageBindings.js';
import { extractReceiverActivity } from '../phase/receiverActivity.js';
import { computeReceiverProvenance } from '../phase/receiverProvenance.js';
import { classifyUnparseableSql } from '../phase/receiverConsumers.js';
import type { AstFile, ReceiverProvenanceFact } from '../phase/types.js';

let adapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

/** Canonical `unparseable` multiset — sorted (sqlText, line, column, reason, kind). */
function canonUnparseable(records: readonly UnparseableSql[]): string {
  return JSON.stringify(
    records
      .map((u) => [u.sqlText, u.location.line, u.location.column, u.reason, u.kind] as const)
      .sort((a, b) => {
        const ka = JSON.stringify(a);
        const kb = JSON.stringify(b);
        return ka < kb ? -1 : 1;
      }),
  );
}

/** Run both sides and return the canonical unparseable multisets. */
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
    // DB-call + tagged-template strategies of `findTableReferences`.
    const provenanceContext = buildProvenanceContext(ast, adapter, src, {
      mode: 'hybrid',
      dbBindingNames: DEFAULT_SCHEMA_CONFIG.dbBindingNames,
      dbWrapperNames: DEFAULT_SCHEMA_CONFIG.dbWrapperNames,
      seedProvenance: seed,
      sqlDialect: dialect,
    });
    const legacyUnparseable = findTableReferences(ast, adapter, src, {
      config: { ...DEFAULT_SCHEMA_CONFIG, sqlDialect: dialect },
      provenanceContext,
    }).unparseable;

    // Phase side: the serialized fixed point fact, then the corpus reduction.
    const provenanceFact: ReceiverProvenanceFact = {
      files: [...fileProvenance.entries()].map(([f, prov]) => ({
        file: f,
        provenance: [...prov.values()].map(evidenceToFact),
      })),
      unresolvedImports: unresolvedImports.map((u) => ({ importer: u.importer, source: u.source, names: u.names })),
    };
    // `classifyUnparseableSql` stamps each record with its `file` so the caller
    // can re-group per file; strip it for the byte-comparison against the legacy
    // `UnparseableSql[]`.
    const phaseUnparseable = classifyUnparseableSql(candidates, {
      withinFacts,
      provenance: provenanceFact,
      activityFacts,
      sqlDialect: dialect,
    }).map(({ file: _file, ...rest }) => rest);

    return {
      expected: canonUnparseable(legacyUnparseable),
      actual: canonUnparseable(phaseUnparseable),
    };
  } finally {
    ast.dispose?.();
  }
}

function expectParity(src: string, dialect: Dialect | null = 'sqlite'): void {
  const { expected, actual } = both(src, dialect);
  expect(actual).toBe(expected);
}

describe('Spec 70 R2 — classifyUnparseableSql ≡ findTableReferences().unparseable', () => {
  it('a provenanced handle with a PRAGMA argument emits one parse-failure record', () => {
    const { expected, actual } = both(
      `import Database from 'better-sqlite3';
const db = new Database(':memory:');
db.prepare('PRAGMA journal_mode=WAL');
`,
      'sqlite',
    );
    expect(actual).toBe(expected);
    const parsed = JSON.parse(actual) as Array<[string, number, number, string, string]>;
    expect(parsed.length).toBe(1);
    expect(parsed[0][0]).toContain('PRAGMA');
    expect(parsed[0][4]).toBe('parse-failure');
  });

  it('a provenanced handle with a parseable SELECT emits no unparseable record', () => {
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

  it('a tagged template with unparseable VACUUM emits one parse-failure record', () => {
    const { expected, actual } = both(
      `import { sql } from 'better-sqlite3';
const q = sql\`VACUUM\`;
`,
      'sqlite',
    );
    expect(actual).toBe(expected);
    const parsed = JSON.parse(actual) as Array<[string, number, number, string, string]>;
    expect(parsed.length).toBe(1);
    expect(parsed[0][0]).toContain('VACUUM');
    expect(parsed[0][4]).toBe('parse-failure');
  });

  it('an unbound global receiver (no declaration) is not-handle and never emits unparseable', () => {
    const { expected, actual } = both(
      `export function run() {
  return db.prepare('PRAGMA journal_mode=WAL');
}
`,
      'sqlite',
    );
    expect(actual).toBe(expected);
    expect(JSON.parse(actual)).toEqual([]);
  });
});
