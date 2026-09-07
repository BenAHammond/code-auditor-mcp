/**
 * Spec-49 — `complex-query` (order #7 remainder, ledger row 31).
 *
 * The authenticity ledger marked `complex-query` crude with one gap: "Complex
 * query" is computed as a *count of regex-extracted table names* (> joinedTableCount,
 * default 4), while `hasSubquery` / `hasJoins` are already computed in
 * `analyzeQuery` but **not wired into the `high` gate** that drives the violation.
 * So a genuinely complex query — one built around a subquery — is missed whenever it
 * happens to touch few tables.
 *
 * Two defects stack:
 *   1. `hasSubquery` is computed from `sourceCode` (the *whole file*), so a file with
 *      two unrelated simple queries reads as "has a subquery". Wiring it in as-is
 *      would flag both simple queries (a file-scoped false positive).
 *   2. Even the (broken) `hasSubquery` is dead: only `performanceRisk === 'high'`,
 *      which is `tables.length > joinedTableCount`, drives `complex-query`.
 *
 * The honest signal: a query is *complex* when it contains a nested SELECT
 * (subquery) or references many tables. Subquery detection must be scoped to the
 * query's own text, not the file.
 *
 * These tests run the real `UniversalDataAccessAnalyzer` via `analyzeAST`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tsAdapter: LanguageAdapter;
let analyzer: UniversalDataAccessAnalyzer;
let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDataAccessAnalyzer();
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-complex-'));
}, 30_000);

async function complexQueryViolations(code: string, name: string): Promise<any[]> {
  const filePath = join(tmpDir, `${name}.ts`);
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  const vs = (await (analyzer as any).analyzeAST(ast, tsAdapter, DEFAULT_DATA_ACCESS_CONFIG, sourceCode)) as any[];
  return vs.filter((v) => v.rule === 'complex-query');
}

/** A 6-way join — complex by table count, fires under both old and new predicate. */
const MANY_TABLES = `import { db } from './db';
export function report() {
  return db.query("SELECT * FROM users JOIN orders JOIN products JOIN categories JOIN inventory JOIN shipments");
}
`;

/** A subquery with only two tables — genuinely complex, but the old table-count
 *  proxy misses it (2 ≤ 4). The honest predicate must fire. */
const SUBQUERY_FEW_TABLES = `import { db } from './db';
export function subquery() {
  return db.query("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)");
}
`;

/** A simple single-table query — not complex under either predicate. */
const SIMPLE = `import { db } from './db';
export function count() {
  return db.query("SELECT COUNT(*) FROM users WHERE active = ?");
}
`;

/** Two unrelated simple queries in one file — the *file* has two SELECTs, but
 *  neither query has a subquery. A file-scoped subquery detector would flag both;
 *  the honest query-scoped detector must flag neither. */
const TWO_SIMPLE_ONE_FILE = `import { db } from './db';
export function a() {
  return db.query("SELECT * FROM users");
}
export function b() {
  return db.query("SELECT * FROM orders");
}
`;

describe('complex-query — a subquery or many tables, not a raw table count', () => {
  it('flags a 6-table join (positive)', async () => {
    const vs = await complexQueryViolations(MANY_TABLES, 'many-tables');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('flags a subquery with only two tables — the case the old table-count proxy missed (inverse near-miss)', async () => {
    const vs = await complexQueryViolations(SUBQUERY_FEW_TABLES, 'subquery-few');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a simple single-table query (near-miss)', async () => {
    const vs = await complexQueryViolations(SIMPLE, 'simple');
    expect(vs).toHaveLength(0);
  });

  it('does NOT flag two unrelated simple queries in one file — subquery detection is query-scoped, not file-scoped', async () => {
    const vs = await complexQueryViolations(TWO_SIMPLE_ONE_FILE, 'two-simple');
    expect(vs).toHaveLength(0);
  });
});
