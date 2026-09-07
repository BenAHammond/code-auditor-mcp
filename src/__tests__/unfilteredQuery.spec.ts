/**
 * Spec-49 — `unfiltered-query` (order #7 remainder, ledger row 32).
 *
 * The authenticity ledger marked `unfiltered-query` crude with one gap:
 * "Unfiltered" is computed as the *absence of WHERE/HAVING/LIMIT/ON keyword
 * substrings*, so `WHERE 1=1` (a tautology that limits nothing) and a bare
 * `JOIN … ON` (a join predicate, not a row-limiting WHERE) both read as
 * "filtered" and suppress a genuinely unbounded read.
 *
 * The honest signal: a read is *unfiltered* when it lacks a row-limiting
 * clause — a WHERE carrying a real predicate, a HAVING, or a LIMIT.  A `JOIN
 * … ON` predicate scopes *how rows match*, not *which rows come back*; a
 * `WHERE 1=1` is the placeholder prepended so a caller can append `AND x = ?`
 * and limits nothing by itself.  Neither is a filter.
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

/** A bare single-table SELECT — genuinely unbounded, fires under both old and new. */
const BARE_SELECT = `import { db } from './db';
export function all() {
  return db.query("SELECT * FROM users");
}
`;

/** A read with a real WHERE predicate — filtered, must not fire. */
const WHERE_REAL = `import { db } from './db';
export function active() {
  return db.query("SELECT * FROM users WHERE active = ?");
}
`;

/** A join scoped only by ON — a join predicate is not a row-limiting WHERE, so
 *  the read is unbounded.  The old proxy saw `ON` and called it filtered; the
 *  honest predicate must fire. */
const JOIN_ON_ONLY = `import { db } from './db';
export function joined() {
  return db.query("SELECT * FROM users u JOIN orders o ON u.id = o.user_id");
}
`;

/** `WHERE 1=1` — a tautology that limits nothing.  The old proxy saw `WHERE` and
 *  called it filtered; the honest predicate must fire. */
const WHERE_TAUTOLOGY = `import { db } from './db';
export function tautology() {
  return db.query("SELECT * FROM users WHERE 1=1");
}
`;

/** `WHERE 1=1 AND active = ?` — the tautology is present but a real predicate
 *  carries the filter, so the read IS filtered.  Guards against over-broad
 *  tautology detection. */
const TAUTOLOGY_AND_REAL = `import { db } from './db';
export function dyn() {
  return db.query("SELECT * FROM users WHERE 1=1 AND active = ?");
}
`;

describe('unfiltered-query — a row-limiting WHERE/HAVING/LIMIT, not ON or a tautology', () => {
  it('flags a bare SELECT (positive)', async () => {
    const vs = await unfilteredViolations(BARE_SELECT, 'bare-select');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a read with a real WHERE predicate (near-miss)', async () => {
    const vs = await unfilteredViolations(WHERE_REAL, 'where-real');
    expect(vs).toHaveLength(0);
  });

  it('flags a JOIN scoped only by ON — the old proxy called it filtered (inverse near-miss)', async () => {
    const vs = await unfilteredViolations(JOIN_ON_ONLY, 'join-on-only');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('flags WHERE 1=1 — a tautology is not a filter (inverse near-miss)', async () => {
    const vs = await unfilteredViolations(WHERE_TAUTOLOGY, 'where-tautology');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag WHERE 1=1 AND active = ? — a real predicate still filters', async () => {
    const vs = await unfilteredViolations(TAUTOLOGY_AND_REAL, 'tautology-and-real');
    expect(vs).toHaveLength(0);
  });
});
