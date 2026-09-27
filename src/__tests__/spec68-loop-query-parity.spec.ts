/**
 * Spec 68 §3.2 — parity: the migrated `loop-query` rule reproduces the old
 * `UniversalDataAccessAnalyzer.checkLoopQueries` findings exactly.
 *
 * `loop-query` is the one data-access rule that reads loop *structure* (N+1), not
 * a resolved-call fact — so it is served by the new `loop-queries` fact, not
 * `data-access-calls`. This test runs BOTH paths — the still-live
 * `analyzeWithFacts` (which still calls `checkLoopQueries`) and the new
 * `runLoopQueriesSlice` — and asserts the identity multiset (file, line, column,
 * rule, severity) is equal and non-empty.
 *
 * The load-bearing properties are the pre-computations the producer performs
 * where the AST lived, and which `analyze` must reproduce without a tree:
 *   - the anchor is the *resolved* query-call callee (the `db` receiver), not the
 *     raw node — so the caret lands on `db`, not `await` (Spec 63);
 *   - one finding per *loop*, not per query (defect #51) — a loop issuing two
 *     queries is still one finding, keyed on the loop's start offset;
 *   - nested-loop depth is attributed into the message (`(nested N levels deep)`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import {
  UniversalDataAccessAnalyzer,
  DEFAULT_DATA_ACCESS_CONFIG,
} from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { runLoopQueriesSlice } from '../phase/runner.js';
import { loopQueryRules } from '../phase/rules/dataAccess.js';
import type { Violation } from '../types.js';

let adapter: LanguageAdapter;
let analyzer: UniversalDataAccessAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDataAccessAnalyzer();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** Run the old `checkLoopQueries` (via `analyzeWithFacts`) and the new slice. */
async function parity(source: string) {
  const ast = parseFile('parity.ts', source);
  expect(ast, 'fixture failed to parse').not.toBeNull();
  const { violations } = await analyzer.analyzeWithFacts(ast!, adapter, DEFAULT_DATA_ACCESS_CONFIG, source);
  const old = violations
    .filter((v) => v.rule === 'loop-query')
    .map((v) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();

  const fresh = await runLoopQueriesSlice([{ path: 'parity.ts', content: source }]);
  const nu = fresh
    .filter((f) => f.ruleId === 'loop-query')
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();

  return { old, nu, fresh, violations };
}

describe('Spec 68 loop-query parity (new analyze(ctx) === old checkLoopQueries)', () => {
  it('covers exactly the one loop-query rule', () => {
    expect(loopQueryRules.map((r) => r.id)).toEqual(['loop-query']);
  });

  it('a plain N+1 fires once, anchored at the query receiver, with the loop line', async () => {
    const source = [
      "import { db } from './db';",
      '',
      'export function load(ids) {',
      '  for (const id of ids) {',
      '    db.query("SELECT * FROM users WHERE id = ?", [id]);',
      '  }',
      '}',
    ].join('\n');
    const { old, nu, fresh } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
    const f = fresh.filter((x) => x.ruleId === 'loop-query')[0];
    expect(f).toMatchObject({
      line: 5,
      column: 5, // `db` receiver, 1-based
      severity: 'severe',
      message: 'Database query inside loop (loop at line 4). ' +
        'This may cause N+1 performance issues. Consider batching queries or using a join.',
    });
    expect(f.symbol).toBeTruthy();
  });

  it('a loop issuing two queries still fires once (one finding per loop)', async () => {
    const source = [
      "import { db } from './db';",
      '',
      'export function load(ids) {',
      '  for (const id of ids) {',
      '    db.query("SELECT * FROM users WHERE id = ?", [id]);',
      '    db.query("SELECT * FROM orders WHERE user_id = ?", [id]);',
      '  }',
      '}',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
  });

  it('two separate loops fire twice', async () => {
    const source = [
      "import { db } from './db';",
      '',
      'export function load(ids) {',
      '  for (const id of ids) {',
      '    db.query("SELECT * FROM users WHERE id = ?", [id]);',
      '  }',
      '  for (const id of ids) {',
      '    db.query("SELECT * FROM orders WHERE user_id = ?", [id]);',
      '  }',
      '}',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(2);
  });

  it('a nested loop attributes depth into the message', async () => {
    const source = [
      "import { db } from './db';",
      '',
      'export function load(groups) {',
      '  for (const g of groups) {',
      '    for (const id of g.ids) {',
      '      db.query("SELECT * FROM users WHERE id = ?", [id]);',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const { old, nu, fresh } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
    const f = fresh.filter((x) => x.ruleId === 'loop-query')[0];
    expect(f.message).toContain('(nested 2 levels deep)');
  });

  it('a loop with no DB call does not fire (and neither path emits)', async () => {
    const source = [
      "import { db } from './db';",
      '',
      'export function sum(ids) {',
      '  let total = 0;',
      '  for (const id of ids) {',
      '    total += id;',
      '  }',
      '  return total;',
      '}',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });
});
