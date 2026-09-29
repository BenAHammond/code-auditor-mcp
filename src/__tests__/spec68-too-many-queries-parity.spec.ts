/**
 * Spec 68 §3.2 / Spec 69 R2 — parity + the located-fact fix for `too-many-queries`.
 *
 * The rule re-homes the *classification* half (the `maxQueriesPerFunction`
 * ceiling, the test-file skip, and the finding construction) over the
 * `query-sites` fact, whose producer already resolved the *projection* half the
 * legacy walk did inline: locate every DB-query site from the raw source and
 * attribute each to its innermost enclosing function. The producer never decides
 * "is this a finding"; it locates sites.
 *
 * For a fixture with no nesting, the migrated rule reproduces the old
 * `checkQueryPatterns` findings exactly — the first block below pins that
 * (file, line, column, severity) identity. For a fixture with a closure inside a
 * counted function, the two intentionally diverge: the legacy walk counts the
 * closure's sites in the parent too (the parent's text encloses them), while the
 * located-fact rule counts each site once against its innermost function — the
 * Spec 69 R2 fix — demonstrated in the second block.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { checkQueryPatterns } from '../analyzers/universal/schema/codeAnalysis.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';
import { runQuerySitesSlice, buildQuerySites } from '../phase/runner.js';

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

  const fresh = await runQuerySitesSlice([{ path, content: source }]);
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
    const fresh = await runQuerySitesSlice(
      [{ path: 'parity.ts', content: SIX_QUERIES }],
      { maxQueriesPerFunction: 10 },
    );
    const nu = fresh.map((f) => key(f)).sort();
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });
});

describe('Spec 69 R2 — nested-closure double-count is gone', () => {
  // `outer` issues 2 of its own queries; `inner` issues 6. The legacy walk counts
  // all 8 in `outer` (its text encloses `inner`'s) and 6 in `inner`. The located
  // fact attributes each site once to its innermost function.
  const NESTED = `function outer() {
  db.query("SELECT 1");
  db.query("SELECT 2");
  const inner = () => {
    db.query("SELECT a");
    db.query("SELECT b");
    db.query("SELECT c");
    db.query("SELECT d");
    db.query("SELECT e");
    db.query("SELECT f");
  };
}`;

  it('attributes each site to its innermost enclosing function', async () => {
    const facts = await buildQuerySites([{ path: 'parity.ts', content: NESTED }]);
    const outer = facts.filter((f) => f.functionName === 'outer');
    const inner = facts.filter((f) => f.functionName === 'inner');
    expect(outer).toHaveLength(2);
    expect(inner).toHaveLength(6);
  });

  it('reports the outer function true count (2), not the shared 8', async () => {
    const fresh = await runQuerySitesSlice([{ path: 'parity.ts', content: NESTED }]);
    // Only `inner` (6 > 5) fires; `outer` (2 ≤ 5) does not — it no longer inherits
    // the closure's six sites.
    expect(fresh.map((f) => f.symbol).sort()).toEqual(['inner']);
    expect(fresh[0].line).toBe(4); // the arrow's start line
  });

  it('the legacy walk double-counts the same fixture (the defect this removes)', async () => {
    const ast = parseFile('parity.ts', NESTED);
    const old = checkQueryPatterns(ast!, adapter, NESTED, DEFAULT_SCHEMA_CONFIG);
    // `outer` (8 > 5) and `inner` (6 > 5) both fire under the legacy walk.
    expect(old.map((v) => v.symbol).sort()).toEqual(['inner', 'outer']);
  });
});
