/**
 * Spec-19 R2 — Shared DB-call detection gate
 *
 * Verifies that isDbCallNode uses AST-level method name extraction
 * instead of substring matching, fixing false positives where:
 * - .findIndex() substring-matches 'find' (item 5)
 * - Non-DB methods inside loops are flagged as loop-query (item 6)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../../../languages/index.js';
import { parseFile } from '../../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../../languages/types.js';
import { UniversalDataAccessAnalyzer } from '../../../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const fixtureDir = join(tmpdir(), 'spec19-r2-' + Date.now());

// ── Fixture sources ──────────────────────────────────────────────────

/** Item 5: findIndex in forEach — NOT a DB call, should NOT trigger loop-query */
const FIND_INDEX_IN_FOREACH = `
export function searchIndex(items: Array<{ id: number; name: string }>, targetId: number): number {
  let found = -1;
  items.forEach((item) => {
    const idx = items.findIndex(x => x.id === targetId);
    if (idx !== -1) {
      found = idx;
    }
  });
  return found;
}
`;

/** .find() in a loop — IS a DB pattern (find is a known DB method), should trigger */
const FIND_IN_LOOP = `
export async function findInLoop(ids: number[]): Promise<any[]> {
  const results = [];
  for (const id of ids) {
    const row = await db.users.find({ id });
    results.push(row);
  }
  return results;
}
`;

/** .select() in forEach — IS a DB call inside loop, should trigger */
const SELECT_IN_FOREACH = `
export async function selectInLoop(ids: number[]): Promise<any[]> {
  const results = [];
  for (const id of ids) {
    const row = await db.select().from('users').where('id = ?', id);
    results.push(row);
  }
  return results;
}
`;

/** Item 6: pure data transformation in a loop — no DB call inside loop body */
const DATA_TRANSFORM_IN_LOOP = `
export function transformData(records: Array<{ id: string; name: string }>): Array<{ key: string; label: string }> {
  const result: Array<{ key: string; label: string }> = [];
  for (const rec of records) {
    result.push({ key: rec.id, label: rec.name.toUpperCase() });
  }
  return result;
}
`;

/** query() inside a loop — bare function call, should trigger (execute/query are in BARE_DB_FUNCTIONS) */
const QUERY_IN_LOOP = `
export async function queryLoop(ids: number[]): Promise<any[]> {
  const results = [];
  for (const id of ids) {
    const row = await query('SELECT * FROM users WHERE id = ?', id);
    results.push(row);
  }
  return results;
}
`;

type TestCase = {
  name: string;
  code: string;
  /** Expected number of loop-query violations */
  expectedLoopQueryCount: number;
};

const TEST_CASES: TestCase[] = [
  {
    name: 'findIndex in forEach — should NOT trigger loop-query (item 5)',
    code: FIND_INDEX_IN_FOREACH,
    expectedLoopQueryCount: 0,
  },
  {
    name: '.find() in for loop — should trigger loop-query',
    code: FIND_IN_LOOP,
    expectedLoopQueryCount: 1,
  },
  {
    name: '.select() in forEach — should trigger loop-query',
    code: SELECT_IN_FOREACH,
    expectedLoopQueryCount: 1,
  },
  {
    name: 'pure data transform in loop — should NOT trigger loop-query (item 6)',
    code: DATA_TRANSFORM_IN_LOOP,
    expectedLoopQueryCount: 0,
  },
  {
    name: 'query() in loop — should trigger loop-query',
    code: QUERY_IN_LOOP,
    expectedLoopQueryCount: 1,
  },
];

describe('Spec-19 R2: Shared DB-call detection gate', () => {
  let analyzer: UniversalDataAccessAnalyzer;
  let tsAdapter: LanguageAdapter;

  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
    await mkdir(fixtureDir, { recursive: true });
    tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
    if (!tsAdapter) throw new Error('TypeScript adapter not found');
    analyzer = new UniversalDataAccessAnalyzer();
  });

  for (const { name, code, expectedLoopQueryCount } of TEST_CASES) {
    it(name, async () => {
      const safeName = name.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
      const filePath = join(fixtureDir, `${safeName}.ts`);
      await writeFile(filePath, code, 'utf-8');

      const sourceCode = await readFile(filePath, 'utf-8');
      const ast = parseFile(filePath, sourceCode)!;
      if (!ast) throw new Error(`Failed to parse ${filePath}`);

      const violations = await (analyzer as any).analyzeAST(ast, tsAdapter, {}, sourceCode);

      const loopQueryViolations = violations.filter((v: { rule: string }) => v.rule === 'loop-query');
      expect(
        loopQueryViolations.length,
        `Expected ${expectedLoopQueryCount} loop-query violations for "${name}", got ${loopQueryViolations.length}`
      ).toBe(expectedLoopQueryCount);
    });
  }
});
