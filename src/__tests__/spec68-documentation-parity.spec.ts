/**
 * Spec 68 §3.2 — parity: the migrated documentation rules reproduce the old
 * analyzer's findings exactly.
 *
 * A rule is "migrated" only when the new `analyze(ctx)` over the `file-symbols`
 * fact produces the *same* findings the pre-migration
 * `UniversalDocumentationAnalyzer` produced on a fixture — same file, line,
 * column, rule, severity. Not a "similar count": the full multiset of identity
 * tuples. This test runs BOTH paths per rule (the old analyzer still live at
 * the time it is written) and asserts the multisets are equal and non-empty.
 *
 * The docsMinLines gate (default 5) would swallow every short fixture, so the
 * test passes `docsMinLines: 1`. The `exemptPatterns` list is emptied so the
 * `parity.ts` fixture path never trips a file-level skip. The two opt-in tag
 * rules (`parameter-documentation` / `return-documentation`) are exercised with
 * `requireParamDocs` / `requireReturnDocs` turned on; `file-documentation` is
 * deliberately absent — it is RENEW and stays on the legacy path.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDocumentationAnalyzer } from '../analyzers/universal/UniversalDocumentationAnalyzer.js';
import { runDocumentationSlice } from '../phase/runner.js';
import { documentationRules } from '../phase/rules/documentation.js';
import type { Violation } from '../types.js';
import type { ThresholdValues } from '../phase/types.js';

let adapter: LanguageAdapter;
let analyzer: UniversalDocumentationAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDocumentationAnalyzer();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** Run the old analyzer and the new slice, return the per-rule identity multisets. */
async function parity(ruleId: string, source: string, config: ThresholdValues) {
  const ast = parseFile('parity.ts', source);
  expect(ast, `fixture failed to parse`).not.toBeNull();
  const oldRaw = await (analyzer as unknown as {
    analyzeAST(ast: unknown, a: LanguageAdapter, c: unknown, s: string): Promise<Violation[]>;
  }).analyzeAST(ast, adapter, config, source);
  const old = oldRaw.filter((v) => v.rule === ruleId).map((v) => key({
    file: v.file,
    line: v.line,
    column: v.column,
    rule: v.rule,
    severity: v.severity,
  })).sort();

  const fresh = await runDocumentationSlice([{ path: 'parity.ts', content: source }], config);
  const nu = fresh.filter((f) => f.ruleId === ruleId).map((f) => key({
    file: f.file,
    line: f.line,
    column: f.column,
    rule: f.ruleId,
    severity: f.severity,
  })).sort();

  return { old, nu };
}

/** The five TypeScript documentation rules, in registry order — the slice under test. */
const RULE_IDS = documentationRules.map((r) => r.id);

describe('Spec 68 documentation parity (new analyze(ctx) === old UniversalDocumentationAnalyzer)', () => {
  it('covers exactly the five migrated documentation rules', () => {
    expect(RULE_IDS).toEqual([
      'function-documentation',
      'parameter-documentation',
      'return-documentation',
      'class-documentation',
      'method-documentation',
    ]);
  });

  it('function-documentation (exported function, no doc)', async () => {
    const { old, nu } = await parity(
      'function-documentation',
      'export function foo() {\n  return 1;\n}\n',
      { exemptPatterns: [], docsMinLines: 1 },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('parameter-documentation (substantive doc, missing @param)', async () => {
    const { old, nu } = await parity(
      'parameter-documentation',
      '/**\n * Does the thing.\n */\nexport function greet(name: string): string {\n  return name;\n}\n',
      { exemptPatterns: [], docsMinLines: 1, requireParamDocs: true },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('return-documentation (substantive doc, typed non-void, missing @returns)', async () => {
    const { old, nu } = await parity(
      'return-documentation',
      '/**\n * Computes the result.\n */\nexport function compute(): number {\n  return 1;\n}\n',
      { exemptPatterns: [], docsMinLines: 1, requireReturnDocs: true },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('class-documentation (exported class, no doc)', async () => {
    const { old, nu } = await parity(
      'class-documentation',
      'export class Widget {\n  x() {}\n}\n',
      { exemptPatterns: [], docsMinLines: 1 },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('method-documentation (public method of exported class, no doc)', async () => {
    const { old, nu } = await parity(
      'method-documentation',
      'export class Widget {\n  render() {\n    return 1;\n  }\n}\n',
      { exemptPatterns: [], docsMinLines: 1 },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('skips anonymous/inline callables and non-exported symbols at public scope', async () => {
    // The anonymous callback and the non-exported function are both skipped at
    // scope 'public'; only the exported `top` (undocumented) fires.
    const { old, nu } = await parity(
      'function-documentation',
      [
        'export function top() {',
        '  const cb = () => 1;',
        '  return cb();',
        '}',
        'function helper() { return 1; }',
      ].join('\n'),
      { exemptPatterns: [], docsMinLines: 1 },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });
});
