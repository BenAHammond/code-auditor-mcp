/**
 * Spec 68 §3.2 — parity: the three migrated security-defect rules reproduce the
 * old `UniversalSecurityAnalyzer` findings exactly.
 *
 * The rules re-home the *classification* half (`isConfigPath`, the
 * test/fixture skip, and the finding/message/resolution construction) over the
 * `security-candidates` fact, whose producer already resolved the structural
 * half the legacy analyzer walked the AST to obtain — the unsafe-shell
 * determination, the computed-require arg/callee text, and the three-phase
 * sink-flow analysis that finds the sink-reaching unescaped member-access
 * interpolation. The producer never decides "is this a finding"; it projects.
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
  UniversalSecurityAnalyzer,
  DEFAULT_SECURITY_CONFIG,
} from '../analyzers/universal/UniversalSecurityAnalyzer.js';
import { runSecurityDefectsSlice } from '../phase/runner.js';

let adapter: LanguageAdapter;
let analyzer: UniversalSecurityAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalSecurityAnalyzer();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, severity. */
function key(f: { file: string; line?: number; column?: number; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.severity}`;
}

/** Run the old analyzer and the new slice, return the per-rule identity multisets. */
async function parity(source: string, ruleId: string) {
  const ast = parseFile('parity.ts', source);
  expect(ast, `fixture failed to parse`).not.toBeNull();
  const oldViolations = await (analyzer as any).analyzeAST(ast!, adapter, DEFAULT_SECURITY_CONFIG, source);
  const old = oldViolations
    .filter((v: { rule: string }) => v.rule === ruleId)
    .map((v: { file: string; line?: number; column?: number; severity: string }) => key(v))
    .sort();

  const fresh = await runSecurityDefectsSlice([{ path: 'parity.ts', content: source }]);
  const nu = fresh
    .filter((f) => f.ruleId === ruleId)
    .map((f) => key(f))
    .sort();

  return { old, nu };
}

describe('Spec 68 security-defect parity (new analyze(ctx) === old UniversalSecurityAnalyzer)', () => {
  describe('command-injection-risk', () => {
    it('fires on a template-substitution command', async () => {
      const { old, nu } = await parity("execSync(`git diff --name-only ${ref}`)\n", 'command-injection-risk');
      expect(nu).toEqual(old);
      expect(nu.length).toBeGreaterThan(0);
    });

    it('fires on a concatenated command', async () => {
      const { old, nu } = await parity("exec('ls ' + dir)\n", 'command-injection-risk');
      expect(nu).toEqual(old);
      expect(nu.length).toBeGreaterThan(0);
    });

    it('does NOT fire on an argv-array form (near-miss)', async () => {
      const { old, nu } = await parity("execFileSync('git', ['diff', '--name-only', ref])\n", 'command-injection-risk');
      expect(nu).toEqual(old);
      expect(nu).toEqual([]);
    });

    it('does NOT fire on a member-access call (this.db.exec is SQLite)', async () => {
      const { old, nu } = await parity("this.db.exec(`SELECT * FROM t`)\n", 'command-injection-risk');
      expect(nu).toEqual(old);
      expect(nu).toEqual([]);
    });
  });

  describe('dynamic-require-of-project-path', () => {
    it('fires on a computed config path require', async () => {
      const { old, nu } = await parity("require(configPath)\n", 'dynamic-require-of-project-path');
      expect(nu).toEqual(old);
      expect(nu.length).toBeGreaterThan(0);
    });

    it('fires on a computed config-path import()', async () => {
      const { old, nu } = await parity("await import(path.join(root, 'config.js'))\n", 'dynamic-require-of-project-path');
      expect(nu).toEqual(old);
      expect(nu.length).toBeGreaterThan(0);
    });

    it('does NOT fire on a literal require (near-miss)', async () => {
      const { old, nu } = await parity("require('tailwindcss')\n", 'dynamic-require-of-project-path');
      expect(nu).toEqual(old);
      expect(nu).toEqual([]);
    });

    it('does NOT fire on a computed but non-config specifier', async () => {
      const { old, nu } = await parity("require(someModule)\n", 'dynamic-require-of-project-path');
      expect(nu).toEqual(old);
      expect(nu).toEqual([]);
    });
  });

  describe('unescaped-html-interpolation', () => {
    it('fires on an innerHTML sink with a member-access interpolation', async () => {
      const { old, nu } = await parity("el.innerHTML = `<p>${user.name}</p>`;\n", 'unescaped-html-interpolation');
      expect(nu).toEqual(old);
      expect(nu.length).toBeGreaterThan(0);
    });

    it('does NOT fire on an escape-wrapped interpolation (near-miss)', async () => {
      const { old, nu } = await parity("el.innerHTML = `<p>${escapeHtml(user.name)}</p>`;\n", 'unescaped-html-interpolation');
      expect(nu).toEqual(old);
      expect(nu).toEqual([]);
    });

    it('does NOT fire without a sink', async () => {
      const { old, nu } = await parity("const html = `<p>${user.name}</p>`;\n", 'unescaped-html-interpolation');
      expect(nu).toEqual(old);
      expect(nu).toEqual([]);
    });
  });
});
