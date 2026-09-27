/**
 * Spec 68 §3.2 — parity: the migrated `too-many-queries` rule reproduces the old
 * schema-code visitor's `checkQueryPatterns` findings exactly.
 *
 * The rule re-homes the *classification* half (the `validateQueryPatterns` gate,
 * the test-file skip, the `maxQueriesPerFunction` ceiling, and the finding
 * construction) over the `function-bodies` fact, whose producer already resolved
 * the *projection* half the legacy walk did inline — `adapter.extractFunctions`
 * → `findNodeByLocation` → full `getNodeText`. The producer never decides "is
 * this a finding"; it projects the function universe.
 *
 * The producer's node set is deliberately `extractFunctions`' full set
 * (declaration, generator, expression, arrow, method) — wider than
 * `function-index` — so the rule sees the same universe the legacy walk saw,
 * including expression-bodied arrows whose query calls live in the expression
 * body, not a `statement_block`.
 *
 * This test runs BOTH paths (the old `checkQueryPatterns` still live) and
 * asserts the identity multisets — (file, line, column, severity) — are equal
 * and non-empty. It is the pin that lets §15 delete the old function without
 * losing the golden reference.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { checkQueryPatterns } from '../analyzers/universal/schema/codeAnalysis.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';
import { runFunctionBodiesSlice } from '../phase/runner.js';

let adapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, severity. */
function key(f: { file: string; line?: number; column?: number; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.severity}`;
}

/** Run the old `checkQueryPatterns` and the new slice, return the identity multisets. */
async function parity(source: string, path = 'parity.ts') {
  const ast = parseFile(path, source);
  expect(ast, `fixture failed to parse`).not.toBeNull();
  const oldViolations = checkQueryPatterns(ast!, adapter, source, DEFAULT_SCHEMA_CONFIG);
  const old = oldViolations
    .map((v) => key({ file: v.file, line: v.line, column: v.column, severity: v.severity }))
    .sort();

  const fresh = await runFunctionBodiesSlice([{ path, content: source }]);
  const nu = fresh
    .map((f) => key(f))
    .sort();

  return { old, nu };
}

const SIX_QUERIES = `function loadDashboard() {
  db.query("SELECT * FROM users");
  db.query("SELECT * FROM orders");
  db.query("SELECT * FROM products");
  db.query("SELECT * FROM reviews");
  db.query("SELECT * FROM events");
  db.query("SELECT * FROM alerts");
}`;

describe('Spec 68 too-many-queries parity (new analyze(ctx) === old checkQueryPatterns)', () => {
  it('fires on a function declaration with more than maxQueriesPerFunction queries', async () => {
    const { old, nu } = await parity(SIX_QUERIES);
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('does NOT fire at the ceiling (near-miss)', async () => {
    const { old, nu } = await parity(`function getUser() {
  db.query("SELECT * FROM users");
  db.query("SELECT * FROM orders");
  db.query("SELECT * FROM products");
  db.query("SELECT * FROM reviews");
  db.query("SELECT * FROM events");
}`);
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('fires on a method_definition body', async () => {
    const { old, nu } = await parity(`class Repo {
  loadAll() {
    db.query("SELECT * FROM a");
    db.query("SELECT * FROM b");
    db.query("SELECT * FROM c");
    db.query("SELECT * FROM d");
    db.query("SELECT * FROM e");
    db.query("SELECT * FROM f");
  }
}`);
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on a generator function declaration', async () => {
    const { old, nu } = await parity(`function* loadMany() {
  db.query("SELECT * FROM a");
  db.query("SELECT * FROM b");
  db.query("SELECT * FROM c");
  db.query("SELECT * FROM d");
  db.query("SELECT * FROM e");
  db.query("SELECT * FROM f");
}`);
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on a function expression', async () => {
    const { old, nu } = await parity(`const load = function () {
  db.query("SELECT * FROM a");
  db.query("SELECT * FROM b");
  db.query("SELECT * FROM c");
  db.query("SELECT * FROM d");
  db.query("SELECT * FROM e");
  db.query("SELECT * FROM f");
};`);
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on an expression-bodied arrow (query calls in the expression, not a block)', async () => {
    const { old, nu } = await parity(`const load = () =>
  db.query("SELECT * FROM a") +
  db.query("SELECT * FROM b") +
  db.query("SELECT * FROM c") +
  db.query("SELECT * FROM d") +
  db.query("SELECT * FROM e") +
  db.query("SELECT * FROM f");`);
    expect(nu).toEqual(old);
  });

  it('skips test files by default (Spec 55 R3)', async () => {
    const { old, nu } = await parity(SIX_QUERIES, 'parity.test.ts');
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('honours the maxQueriesPerFunction threshold from config', async () => {
    const ast = parseFile('parity.ts', SIX_QUERIES);
    const oldViolations = checkQueryPatterns(ast!, adapter, SIX_QUERIES, {
      ...DEFAULT_SCHEMA_CONFIG,
      maxQueriesPerFunction: 10,
    });
    const old = oldViolations
      .map((v) => key({ file: v.file, line: v.line, column: v.column, severity: v.severity }))
      .sort();
    const fresh = await runFunctionBodiesSlice(
      [{ path: 'parity.ts', content: SIX_QUERIES }],
      { maxQueriesPerFunction: 10 },
    );
    const nu = fresh.map((f) => key(f)).sort();
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });
});
