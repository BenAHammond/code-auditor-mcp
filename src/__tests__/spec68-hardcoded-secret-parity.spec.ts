/**
 * Spec 68 §3.2 — parity: the migrated `hardcoded-secret` rule reproduces the
 * old `UniversalSecretsAnalyzer` findings exactly.
 *
 * The rule re-homes the classification half of `inspectNode` /
 * `checkCredentialCall` (secret-name / placeholder / credential-selector
 * heuristics) over the `secret-candidates` fact, whose producer pre-computed the
 * positional context (name/key/sibling args + enclosing-node start position) the
 * legacy analyzer walked the AST to obtain. The producer never decides "is this
 * a secret" — it projects; the rule classifies.
 *
 * This test runs BOTH paths (the old analyzer still live) and asserts the
 * identity multisets — (file, line, column, severity) — are equal and non-empty.
 * It is the pin that lets §15 delete the old analyzer without losing the golden
 * reference.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import {
  UniversalSecretsAnalyzer,
  DEFAULT_SECRETS_CONFIG,
} from '../analyzers/universal/UniversalSecretsAnalyzer.js';
import { runSecretsSlice } from '../phase/runner.js';

let adapter: LanguageAdapter;
let analyzer: UniversalSecretsAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalSecretsAnalyzer();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, severity. */
function key(f: { file: string; line?: number; column?: number; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.severity}`;
}

/** Run the old analyzer and the new slice, return the per-rule identity multisets. */
async function parity(source: string) {
  const ast = parseFile('parity.ts', source);
  expect(ast, `fixture failed to parse`).not.toBeNull();
  const oldViolations = await (analyzer as any).analyzeAST(ast!, adapter, DEFAULT_SECRETS_CONFIG, source);
  const old = oldViolations
    .filter((v: { rule: string }) => v.rule === 'hardcoded-secret')
    .map((v: { file: string; line?: number; column?: number; severity: string }) => key(v))
    .sort();

  const fresh = await runSecretsSlice([{ path: 'parity.ts', content: source }]);
  const nu = fresh
    .filter((f) => f.ruleId === 'hardcoded-secret')
    .map((f) => key(f))
    .sort();

  return { old, nu };
}

describe('Spec 68 hardcoded-secret parity (new analyze(ctx) === old UniversalSecretsAnalyzer)', () => {
  it('fires on a secret-named variable with a real-looking value', async () => {
    const { old, nu } = await parity("const password = 'hunter2Secret9';\n");
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on the page.type selector + secret reference case', async () => {
    const { old, nu } = await parity(
      "await page.type('#password', 'vyy8AUVvish34Fq');\n",
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on an object pair with a secret key', async () => {
    const { old, nu } = await parity(
      "const config = { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' };\n",
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on an assignment to a secret field', async () => {
    const { old, nu } = await parity("obj.password = 'hunter2Secret9';\n");
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('does NOT fire on a placeholder value (near-miss)', async () => {
    const { old, nu } = await parity("const apiKey = 'your-api-key';\n");
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('does NOT fire on an env-var reference (not a string literal)', async () => {
    const { old, nu } = await parity("const apiKey = process.env.API_KEY;\n");
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('does NOT fire on a call with no credential selector sibling', async () => {
    const { old, nu } = await parity("console.log('hunter2Secret9');\n");
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });
});
