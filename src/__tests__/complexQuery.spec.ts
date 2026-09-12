/**
 * Spec-55 R5 — `complex-query` is about a join-heavy query, not a subquery.
 *
 * The external audit (code-audit-false-positives.md §1.6) flagged four findings
 * — a window function (`PERCENT_RANK() OVER (…)`), a `NOT IN` subquery, an
 * `EXISTS` subquery, and a correlated `COUNT(*)` subquery — as false positives:
 * these are "SQL-in-SQLite-complexity, not real complexity". A subquery (indexed
 * `EXISTS`, `NOT IN`, correlated `COUNT(*)`) or a window function is an ordinary,
 * well-optimized D1 idiom; it is not a defect.
 *
 * The honest contract: `complex-query` fires only on a genuinely join-heavy query
 * (more than `joinedTableCount` tables, default 4). A subquery alone no longer
 * counts. This supersedes the Spec-49 "subquery OR many tables" contract.
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

/** A 6-way join — complex by table count. */
const MANY_TABLES = `import { db } from './db';
export function report() {
  return db.query("SELECT * FROM users JOIN orders JOIN products JOIN categories JOIN inventory JOIN shipments");
}
`;

/** A subquery with only two tables — an ordinary SQLite idiom, NOT complex. */
const SUBQUERY_FEW_TABLES = `import { db } from './db';
export function subquery() {
  return db.query("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)");
}
`;

/** An EXISTS subquery — the report's §1.6 example, NOT complex. */
const EXISTS_SUBQUERY = `import { db } from './db';
export function stale() {
  return db.query("SELECT q.id FROM questions q WHERE EXISTS (SELECT 1 FROM answers a WHERE a.q = q.id)");
}
`;

/** A simple single-table query — not complex under any contract. */
const SIMPLE = `import { db } from './db';
export function count() {
  return db.query("SELECT COUNT(*) FROM users WHERE active = ?");
}
`;

describe('complex-query — a join-heavy query, not a subquery', () => {
  it('flags a 6-table join (positive)', async () => {
    const vs = await complexQueryViolations(MANY_TABLES, 'many-tables');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a subquery with only two tables (was a false positive)', async () => {
    const vs = await complexQueryViolations(SUBQUERY_FEW_TABLES, 'subquery-few');
    expect(vs).toHaveLength(0);
  });

  it('does NOT flag an EXISTS subquery (report §1.6 example)', async () => {
    const vs = await complexQueryViolations(EXISTS_SUBQUERY, 'exists-subquery');
    expect(vs).toHaveLength(0);
  });

  it('does NOT flag a simple single-table query (near-miss)', async () => {
    const vs = await complexQueryViolations(SIMPLE, 'simple');
    expect(vs).toHaveLength(0);
  });
});
