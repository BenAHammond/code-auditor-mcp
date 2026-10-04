/**
 * Spec 70 Item 4 / Item 3 — the within-file-provenance split, parity-pinned.
 *
 * The collapse of the double-parse replaces `resolveCorpusReceivers` (the second
 * full-corpus parse) with a `within-file-provenance` file fact + a fixed-point
 * corpus producer. The fact is the *projection* of a file's AST into a
 * serializable `TsWithinFileProvenanceExtract`, and the corpus producer re-runs
 * the fixed point over it with no AST. The whole collapse hangs on one
 * guarantee:
 *
 *   `classifyTsWithinFileProvenance(extractTsWithinFileProvenance(ast, …), seeds)`
 *   ≡ `computeTsWithinFileProvenance(ast, …, seeds)`
 *
 * — byte-identical, for every fixture. When the second parse is deleted, this is
 * the only proof the new corpus producer re-derives the old output.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';
import { extractTsWithinFileProvenance } from '../analyzers/provenance.js';
import { computeTsWithinFileProvenance } from '../analyzers/receiverResolution.js';
import { classifyTsWithinFileProvenance } from '../analyzers/tsExpressionDescriptor.js';

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

/** Run both sides and return the canonical strings (for a richer diff on failure). */
function both(
  src: string,
  extraSeeds: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
): { expected: string; actual: string } {
  const ast = parseFile('/fixture/parity.ts', src)!;
  try {
    const extract = extractTsWithinFileProvenance(ast, tsAdapter, src);
    const actual = classifyTsWithinFileProvenance(extract, extraSeeds);
    const expected = computeTsWithinFileProvenance(ast, tsAdapter, src, extraSeeds);
    return { expected: canon(expected), actual: canon(actual) };
  } finally {
    ast.dispose?.();
  }
}

function expectParity(src: string, extraSeeds?: ReadonlyMap<string, ProvenanceEvidence>): void {
  const { expected, actual } = both(src, extraSeeds);
  expect(actual).toBe(expected);
}

/** An extra cross-file seed (a name provenanced outside this file). */
function seed(name: string): ReadonlyMap<string, ProvenanceEvidence> {
  return new Map([
    [name, { identifier: name, reason: 'module', source: 'import from in-repo module', chain: [] }],
  ]);
}

describe('TS within-file-provenance split — classify(extract(ast)) ≡ compute(ast)', () => {
  it('package import seed + `new` variable declarator', () => {
    expectParity(`import Database from 'better-sqlite3';
const db = new Database('file.db');
const appDb = db;
`);
  });

  it('propagation through a member receiver', () => {
    expectParity(`import { drizzle } from 'drizzle-orm/libsql';
const db = drizzle({ url: ':memory:' });
const users = db.select().from('users');
`);
  });

  it('default parameter + destructuring + class field', () => {
    expectParity(`import Database from 'better-sqlite3';
function open(db = new Database(':memory:')) { return db; }
const { conn } = { conn: new Database(':memory:') };
class Store { private db = new Database(':memory:'); }
`);
  });

  it('member assignment (`this.db = …`) and `await`', () => {
    expectParity(`import Database from 'better-sqlite3';
class Store {
  init() {
    this.db = new Database(':memory:');
  }
}
async function load() {
  const db = await makeDb();
}
function makeDb() { return new Database(':memory:'); }
`);
  });

  it('wrapper function — D1 REST fetch and delegating call', () => {
    expectParity(`import Database from 'better-sqlite3';
const db = new Database(':memory:');
function d1Query(sql) { return db.prepare(sql).all(); }
async function d1Rest(sql) {
  return fetch('https://api.cloudflare.com/client/v4/accounts/x/d1/database/y/query', { body: sql });
}
`);
  });

  it('wrapper class — driver constructed in the constructor', () => {
    expectParity(`import { neon } from '@neondatabase/serverless';
export class Database {
  constructor() { this.sql = neon(process.env.DATABASE_URL); }
  query(t) { return this.sql(t); }
}
const appDb = Database.getInstance ? new Database() : new Database();
`);
  });

  it('DB-returning function (form 5)', () => {
    expectParity(`import Database from 'better-sqlite3';
export function getDB() { return new Database(':memory:'); }
const db = getDB();
`);
  });

  it('S5f higher-order wrapper — forwards a provenanced argument', () => {
    expectParity(`import { PrismaClient } from '@prisma/client';
function enhancePrisma(c) { return c; }
const p = new PrismaClient();
const wrapped = enhancePrisma(p);
`);
  });

  it('non-DB mutation on a provenanced value is not a wrapper', () => {
    expectParity(`import Database from 'better-sqlite3';
const db = new Database(':memory:');
const m = new Map();
function useMap() { m.set('k', db); }
`);
  });

  it('compound receiver `this.env.DB` and dotted delegation', () => {
    expectParity(`import Database from 'better-sqlite3';
const db = new Database(':memory:');
class Repo {
  constructor() { this.env = { DB: db }; }
  query(sql) { return this.env.DB.prepare(sql).all(); }
}
`);
  });

  it('cross-file extra seed is merged before the fixed point', () => {
    expectParity(
      `const appDb = sharedHandle();
const q = appDb.prepare('select 1').all();
`,
      seed('sharedHandle'),
    );
  });

  it('an empty file (no DB signal) projects to the empty map', () => {
    expectParity(`const x = 1;
function f() { return x; }
`);
  });
});
