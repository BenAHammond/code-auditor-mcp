/**
 * Spec 63 — loop-query anchor precision.
 *
 * `await db.prepare(…).bind(…).all<T>(…)` and `await db.all<T>(…)` parse (via
 * tree-sitter-typescript) into an OUTER `call_expression` at the `await` keyword
 * whose function is an `await_expression` wrapping the real member chain. Once the
 * builder-chain fix (Spec 63) proved that outer node, and `findNodes` walks
 * parent-before-child, the outer node won the loop-query anchor — so the caret
 * landed on `await` instead of the query's `db` receiver.
 *
 * The fix anchors the loop-query finding to the resolved callee
 * (`getCallExpressionCallee`, which recurses through `await_expression`), landing
 * the caret on `db`. These tests pin that at the analyzer level: the finding must
 * point at the `db` receiver, not the `await` keyword. (For the single-call shape
 * this was a pre-existing imprecision; for the fluent chain it was introduced by
 * the builder-chain fix and reverted here.)
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
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-loop-anchor-'));
}, 30_000);

async function loopQuery(code: string, name: string): Promise<any[]> {
  const filePath = join(tmpDir, `${name}.ts`);
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  const vs = (await (analyzer as any).analyzeAST(ast, tsAdapter, DEFAULT_DATA_ACCESS_CONFIG, sourceCode)) as any[];
  return vs.filter((v) => v.rule === 'loop-query');
}

/** 1-indexed column of the first occurrence of `token` on the finding's line. */
function colOf(line: string, token: string): number {
  return line.indexOf(token) + 1;
}

describe('loop-query anchor — points at the query receiver, not await', () => {
  it('fluent chain: await db.prepare(…).bind(…).all<T>(…) anchors on db', async () => {
    const code = `import { db } from './db';
export async function load(ids: string[]) {
  for (const id of ids) {
    const row = await db.prepare("SELECT * FROM t WHERE id = ?").bind(id).all<{ id: string }>();
    void row;
  }
}
`;
    const vs = await loopQuery(code, 'fluent-chain');
    expect(vs.length).toBeGreaterThanOrEqual(1);
    const v = vs[0];
    const line = code.split('\n')[v.line - 1];
    expect(v.column).toBe(colOf(line, 'db'));
    expect(v.column).toBeGreaterThan(colOf(line, 'await'));
  });

  it('single call: await db.all<T>(…) anchors on db', async () => {
    const code = `import { db } from './db';
export async function load(ids: string[]) {
  for (const id of ids) {
    const rows = await db.all<{ id: string }>("SELECT * FROM t WHERE id = ?", [id]);
    void rows;
  }
}
`;
    const vs = await loopQuery(code, 'single-call');
    expect(vs.length).toBeGreaterThanOrEqual(1);
    const v = vs[0];
    const line = code.split('\n')[v.line - 1];
    expect(v.column).toBe(colOf(line, 'db'));
    expect(v.column).toBeGreaterThan(colOf(line, 'await'));
  });
});
