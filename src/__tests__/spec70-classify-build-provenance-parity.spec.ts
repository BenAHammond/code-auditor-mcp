/**
 * Spec 70 Item 4 (step 3) — the build-side provenance mirror, parity-pinned.
 *
 * The four receiver consumers (`query-sites`, `schema-usage`, `data-access-calls`,
 * `loop-queries`) move from file producers reading `file.receiverProvenance` to
 * corpus producers re-deriving each file's `buildProvenanceContext().dbProvenanced`
 * with no AST. The whole conversion hangs on one guarantee:
 *
 *   classifyBuildProvenance(extractTsWithinFileProvenance(ast, …), seed,
 *       buildBindingEnv(ast, …), extractR3Sites(ast, …), dialect)
 *   ≡ buildProvenanceContext(ast, …, { hybrid, seed, dialect }).dbProvenanced
 *
 * — byte-identical, for every fixture. When the second parse is deleted, this is
 * the proof the corpus producers re-derive the old per-file provenance. It is the
 * *build-side* sibling of `spec70-ts-within-file-parity.spec.ts` (which pins the
 * classify side, `classifyTsWithinFileProvenance ≡ computeTsWithinFileProvenance`):
 * the build side runs R3 (sql-argument) and stops at function wrappers, while the
 * classify side scans classes/returning functions and skips R3.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';
import {
  buildProvenanceContext,
  extractR3Sites,
  extractTsWithinFileProvenance,
} from '../analyzers/provenance.js';
import { buildBindingEnv } from '../analyzers/receiverRoot.js';
import { classifyBuildProvenance } from '../phase/receiverProvenance.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';
import type { Dialect } from '../mcp-tools/discoveryQueries.js';

let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

/** Canonical serialization of a provenance map — sorted keys, JSON evidence. */
function canon(map: Map<string, ProvenanceEvidence>): string {
  return JSON.stringify([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/** Run both sides and return the canonical strings (richer diff on failure). */
function both(
  src: string,
  dialect: Dialect | null,
  seed: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
): { expected: string; actual: string } {
  const ast = parseFile('/fixture/parity.ts', src)!;
  try {
    const expected = buildProvenanceContext(ast, tsAdapter, src, {
      mode: 'hybrid',
      dbBindingNames: DEFAULT_SCHEMA_CONFIG.dbBindingNames,
      dbWrapperNames: DEFAULT_SCHEMA_CONFIG.dbWrapperNames,
      seedProvenance: seed,
      sqlDialect: dialect,
    }).dbProvenanced;

    const extract = extractTsWithinFileProvenance(ast, tsAdapter, src);
    const bindings = buildBindingEnv(ast, tsAdapter, src);
    const r3Sites = extractR3Sites(ast, tsAdapter, src);
    const actual = classifyBuildProvenance(extract, seed, bindings, r3Sites, dialect);

    return { expected: canon(expected), actual: canon(actual) };
  } finally {
    ast.dispose?.();
  }
}

function expectParity(src: string, dialect: Dialect | null, seed?: ReadonlyMap<string, ProvenanceEvidence>): void {
  const { expected, actual } = both(src, dialect, seed);
  expect(actual).toBe(expected);
}

/** A cross-file seed (a name provenanced outside this file). */
function seed(name: string): ReadonlyMap<string, ProvenanceEvidence> {
  return new Map([
    [name, { identifier: name, reason: 'module', source: 'import from in-repo module', chain: [] }],
  ]);
}

describe('Spec 70 build-side provenance mirror — classifyBuildProvenance ≡ buildProvenanceContext', () => {
  it('package import + `new` variable declarator (no dialect)', () => {
    expectParity(
      `import Database from 'better-sqlite3';
const db = new Database('file.db');
const appDb = db;
`,
      null,
    );
  });

  it('propagation through a member receiver (no dialect)', () => {
    expectParity(
      `import { drizzle } from 'drizzle-orm/libsql';
const db = drizzle({ url: ':memory:' });
const users = db.select().from('users');
`,
      null,
    );
  });

  it('R3 — a SQL-argument receiver proves handle when a dialect is named', () => {
    expectParity(
      `const dataSource = getConnection();
dataSource.query("SELECT * FROM users WHERE org_id = ?");
`,
      'sqlite',
    );
  });

  it('R3 abstains (unproven) with no dialect named', () => {
    expectParity(
      `const dataSource = getConnection();
dataSource.query("SELECT * FROM users WHERE org_id = ?");
`,
      null,
    );
  });

  it('wrapper function (D1 REST fetch + delegating call) with dialect', () => {
    expectParity(
      `import Database from 'better-sqlite3';
const db = new Database(':memory:');
function d1Query(sql) { return db.prepare(sql).all(); }
async function d1Rest(sql) {
  return fetch('https://api.cloudflare.com/client/v4/accounts/x/d1/database/y/query', { body: sql });
}
`,
      'sqlite',
    );
  });

  it('cross-file seed merges and propagates', () => {
    expectParity(
      `const appDb = sharedHandle();
const q = appDb.prepare('select 1').all();
`,
      'sqlite',
      seed('sharedHandle'),
    );
  });

  it('compound receiver `this.env.DB` with dialect', () => {
    expectParity(
      `import Database from 'better-sqlite3';
const db = new Database(':memory:');
class Repo {
  constructor() { this.env = { DB: db }; }
  query(sql) { return this.env.DB.prepare(sql).all(); }
}
`,
      'sqlite',
    );
  });

  it('an empty file (no DB signal) projects to the empty map', () => {
    expectParity(
      `const x = 1;
function f() { return x; }
`,
      'sqlite',
    );
  });
});
