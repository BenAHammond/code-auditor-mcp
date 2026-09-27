/**
 * Spec 68 §3.2 — parity: the migrated `dynamic-sql-construction` rule reproduces
 * the old `checkSQLInjection` findings exactly.
 *
 * `dynamic-sql-construction` is the one schema rule that walks dynamic SQL
 * *construction* (string interpolation / concatenation at `query(`/`execute(`
 * call sites), not resolved table references — so it is served by the new
 * `dynamic-sql` fact, not `schema-usage`. This test runs BOTH paths — the
 * still-live `checkSQLInjection` (the Spec-34 helper `UniversalSchemaAnalyzer`
 * calls) and the new `runDynamicSqlSlice` — and asserts the identity multiset
 * (file, line, column, rule, severity) is equal and non-empty.
 *
 * The load-bearing properties are the pre-computations the producer performs
 * where the AST lived, and which `analyze` must reproduce without a tree:
 *   - the parameterized-query skip (`query(sql, params)`) never fires;
 *   - the taint-safety hatch (`isAllDynamicPartsSafe`) clears provably-safe
 *     interpolation but leaves raw-input interpolation/concatenation standing;
 *   - the symbol ordinal is per-function, so two sites in one function are two
 *     distinct `functionName` keys (the parity key omits symbol by contract).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { checkSQLInjection } from '../analyzers/universal/schema/codeAnalysis.js';
import { runDynamicSqlSlice } from '../phase/runner.js';
import { dynamicSqlRules } from '../phase/rules/schema.js';

let adapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** Run the old `checkSQLInjection` and the new slice. */
async function parity(source: string) {
  const ast = parseFile('parity.ts', source);
  expect(ast, 'fixture failed to parse').not.toBeNull();
  const legacy = checkSQLInjection(ast!, adapter, source);
  const old = legacy
    .filter((v) => v.rule === 'dynamic-sql-construction')
    .map((v) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();

  const fresh = await runDynamicSqlSlice([{ path: 'parity.ts', content: source }]);
  const nu = fresh
    .filter((f) => f.ruleId === 'dynamic-sql-construction')
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();

  return { old, nu, fresh };
}

describe('Spec 68 dynamic-sql-construction parity (new analyze(ctx) === old checkSQLInjection)', () => {
  it('covers exactly the one dynamic-sql-construction rule', () => {
    expect(dynamicSqlRules.map((r) => r.id)).toEqual(['dynamic-sql-construction']);
  });

  it('string concatenation fires once, anchored at the query() call, critical', async () => {
    const source = [
      "import { db } from './db';",
      '',
      'export function search(id) {',
      '  return db.query("SELECT * FROM t WHERE id = " + id);',
      '}',
    ].join('\n');
    const { old, nu, fresh } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
    const f = fresh.filter((x) => x.ruleId === 'dynamic-sql-construction')[0];
    expect(f).toMatchObject({
      line: 4,
      column: 13, // `query` in `db.query(`, 1-based
      severity: 'critical',
      message: 'SQL query built via string interpolation or concatenation in search; use parameterized queries.',
    });
    expect(f.symbol).toBe('search:dynamic-sql-construction');
  });

  it('a parameterized query does not fire (and neither path emits)', async () => {
    const source = [
      "import { db } from './db';",
      '',
      'export function search(id) {',
      '  return db.query("SELECT * FROM t WHERE id = ?", [id]);',
      '}',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('template interpolation fires once', async () => {
    const source = [
      "import { db } from './db';",
      '',
      'export function search(id) {',
      '  return db.query(`SELECT * FROM t WHERE id = ${id}`);',
      '}',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
  });

  it('two sites in one function fire twice with distinct symbol ordinals', async () => {
    const source = [
      "import { db } from './db';",
      '',
      'export function search(id, name) {',
      '  const a = db.query("SELECT * FROM t WHERE id = " + id);',
      '  return db.query("SELECT * FROM t WHERE name = " + name);',
      '}',
    ].join('\n');
    const { old, nu, fresh } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(2);
    const symbols = fresh.filter((x) => x.ruleId === 'dynamic-sql-construction').map((x) => x.symbol).sort();
    expect(symbols).toEqual(['search:dynamic-sql-construction', 'search:dynamic-sql-construction:2']);
  });

  it('a function with no query/execute call does not fire (and neither path emits)', async () => {
    const source = [
      "import { db } from './db';",
      '',
      'export function sum(ids) {',
      '  let total = 0;',
      '  for (const id of ids) total += id;',
      '  return total;',
      '}',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });
});
