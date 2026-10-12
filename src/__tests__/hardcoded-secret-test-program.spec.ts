/**
 * Directive items 2 + 3 — the two discriminants that resolve the 49 shipped
 * `hardcoded-secret` false positives.
 *
 * The §3.2 rework removed the legacy `UniversalSecretsAnalyzer` suppression
 * filters (minimum length, placeholder list, email/URL/camelCase shape, and a
 * test/fixture path skip) and kept only positive evidence. That shipped 49 wrong
 * answers: 48 hardcoded credentials *inside test files* (expected, must not block
 * the edit loop) and one UI display label (`apiKey: "API Key"`). Item 3 adds a
 * 49th shape — `token: "styleToken"`, an internal identifier — via the
 * `verify:self` scoped exemption that must be removed.
 *
 * Two discriminants fix all three shapes without restoring a suppression:
 *
 *   1. Value entropy — `looksLikeRealSecret` is `hasKnownTokenPrefix || hasDigit
 *      || hasHardSymbol`. An uppercase letter alone is not entropy, so `"API Key"`
 *      and `"styleToken"` (letters/space only) are rejected while a real
 *      credential (`'S0meVeryHardPassword'`, digit) still fires.
 *
 *   2. Test-program role — a candidate whose file belongs to the tree's
 *      *declared* test runner (read from `package.json` scripts → the runner's
 *      own discovery convention) is skipped, instead of the legacy path-substring
 *      heuristic.
 *
 * Each test is the "one check that fails if the claim is false": it asserts the
 * detector's behaviour on a byte-exact fixture, so a future change that re-admits
 * a label as a secret, or skips a non-test credential, fails here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runSecretsSlice } from '../phase/runner.js';
import { resolveTestProgram } from '../phase/testProgram.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** Write a file tree (path → content) under a fresh temp dir; return its root. */
async function tempTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ca-secret-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const trees: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await tempTree(files);
  trees.push(root);
  return root;
}

afterAll(async () => {
  for (const t of trees) await rm(t, { recursive: true, force: true });
});

/** Run the slice over `root`-relative paths, threading the root as projectRoot. */
async function audit(root: string, relPaths: string[]): Promise<{ ruleId: string; file: string }[]> {
  const inputs = relPaths.map((p) => ({ path: join(root, p), content: "const password = 'S0meVeryHardPassword';\n" }));
  const findings = await runSecretsSlice(inputs, undefined, root);
  return findings.filter((f) => f.ruleId === 'hardcoded-secret').map((f) => ({ ruleId: f.ruleId, file: f.file.replace(root + '/', '') }));
}

describe('value entropy — labels are not credentials, real credentials still fire', () => {
  it('rejects the UI label apiKey: "API Key" (no digit, no hard symbol)', async () => {
    const root = await tree({});
    const findings = await runSecretsSlice([
      { path: join(root, 'src/data-table.tsx'), content: "const LABELS = { apiKey: 'API Key' };\n" },
    ], undefined, root);
    expect(findings.filter((f) => f.ruleId === 'hardcoded-secret')).toEqual([]);
  });

  it('rejects the identifier token: "styleToken" (item 3 — no digit, no hard symbol)', async () => {
    const root = await tree({});
    const findings = await runSecretsSlice([
      { path: join(root, 'src/QueryParser.ts'), content: "const OPERATORS = { token: 'styleToken' };\n" },
    ], undefined, root);
    expect(findings.filter((f) => f.ruleId === 'hardcoded-secret')).toEqual([]);
  });

  it('still fires on a real credential (digit present)', async () => {
    const root = await tree({});
    const findings = await runSecretsSlice([
      { path: join(root, 'src/app.ts'), content: "const password = 'S0meVeryHardPassword';\n" },
    ], undefined, root);
    expect(findings.filter((f) => f.ruleId === 'hardcoded-secret').length).toBe(1);
  });
});

describe('test-program role — derived from the declared runner, not a path pattern', () => {
  it('mocha: a secret under test/ is skipped; a non-test secret stays', async () => {
    const root = await tree({
      'package.json': JSON.stringify({ scripts: { test: 'mocha --config test/mocha-all-config-test.js' } }),
    });
    const findings = await audit(root, ['test/unit/query/string.js', 'scripts/stress-test/knex-stress-test.js']);
    expect(resolveTestProgram(root).source).toBe('mocha');
    expect(findings.map((f) => f.file)).toEqual(['scripts/stress-test/knex-stress-test.js']);
  });

  it('deno via a turbo orchestrator: a secret in *.test.ts is skipped; a source secret stays', async () => {
    const root = await tree({
      'package.json': JSON.stringify({ scripts: { test: 'turbo run test' }, workspaces: ['apps/*'] }),
      'apps/server/package.json': JSON.stringify({ scripts: { test: 'deno test --parallel' } }),
    });
    const findings = await audit(root, ['apps/server/src/monitor.test.ts', 'apps/server/src/monitor.ts']);
    expect(resolveTestProgram(root).source).toBe('deno');
    expect(findings.map((f) => f.file)).toEqual(['apps/server/src/monitor.ts']);
  });

  it('falls back to the path heuristic and reports it when no runner is declared', async () => {
    const root = await tree({ 'package.json': JSON.stringify({ scripts: {} }) });
    const findings = await audit(root, ['src/helper.test.ts', 'src/helper.ts']);
    expect(resolveTestProgram(root).source).toContain('path-heuristic');
    expect(findings.map((f) => f.file)).toEqual(['src/helper.ts']);
  });
});
