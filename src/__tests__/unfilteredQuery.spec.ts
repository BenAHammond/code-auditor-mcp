/**
 * Spec-55 R5 — `unfiltered-query` is about unfiltered *writes*, not reads.
 *
 * The external audit (code-audit-false-positives.md §1.5) flagged two findings
 * on full-set reads (`SELECT … FROM totals`, `SELECT DISTINCT … FROM leaderboard`)
 * as false positives: a query with no WHERE is not inherently a defect — loading
 * a full working set is often the intended design. The genuine foot-gun is an
 * unfiltered *write*: `DELETE FROM t` or `UPDATE t SET …` with no row-limiting
 * clause mutates or deletes every row.
 *
 * The honest contract: `unfiltered-query` fires on a DELETE/UPDATE with no
 * WHERE (carrying a real predicate), HAVING, or LIMIT. Unfiltered reads are out
 * of scope. This supersedes the Spec-49 "unfiltered read" contract.
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
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-unfiltered-'));
}, 30_000);

async function unfilteredViolations(code: string, name: string): Promise<any[]> {
  const filePath = join(tmpDir, `${name}.ts`);
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  const vs = (await (analyzer as any).analyzeAST(ast, tsAdapter, DEFAULT_DATA_ACCESS_CONFIG, sourceCode)) as any[];
  return vs.filter((v) => v.rule === 'unfiltered-query');
}

/** An unfiltered DELETE — deletes every row, the foot-gun. */
const DELETE_ALL = `import { db } from './db';
export function nuke() {
  return db.exec("DELETE FROM users");
}
`;

/** An unfiltered UPDATE — sets a flag on every row. */
const UPDATE_ALL = `import { db } from './db';
export function reset() {
  return db.exec("UPDATE users SET active = 0");
}
`;

/** A filtered DELETE — scoped to a predicate, must NOT fire. */
const DELETE_FILTERED = `import { db } from './db';
export function one(id: string) {
  return db.exec("DELETE FROM users WHERE id = ?");
}
`;

/** A bare SELECT — an unfiltered *read*, which is out of scope (intentional full-set load). */
const BARE_SELECT = `import { db } from './db';
export function all() {
  return db.query("SELECT * FROM users");
}
`;

describe('unfiltered-query — an unfiltered write (DELETE/UPDATE with no WHERE/HAVING/LIMIT)', () => {
  it('flags an unfiltered DELETE (positive)', async () => {
    const vs = await unfilteredViolations(DELETE_ALL, 'delete-all');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('flags an unfiltered UPDATE (positive)', async () => {
    const vs = await unfilteredViolations(UPDATE_ALL, 'update-all');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a filtered DELETE (near-miss)', async () => {
    const vs = await unfilteredViolations(DELETE_FILTERED, 'delete-filtered');
    expect(vs).toHaveLength(0);
  });

  it('does NOT flag an unfiltered read (bare SELECT — full-set load is intentional)', async () => {
    const vs = await unfilteredViolations(BARE_SELECT, 'bare-select');
    expect(vs).toHaveLength(0);
  });
});
