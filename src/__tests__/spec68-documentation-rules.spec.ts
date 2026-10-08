/**
 * Spec 68 §3.2 — the five migrated documentation rules, asserted directly.
 *
 * The parity spec this replaces (`spec68-documentation-parity.spec.ts`) ran the
 * legacy `UniversalDocumentationAnalyzer` as the "expected" side and the phase
 * slice as the "actual" side, asserting the identity multiset was equal. When
 * the legacy analyzer was deleted (§15), the parity spec's expected side
 * vanished with it and the spec was removed. The behavior it pinned did not go
 * away — it moved into `phase/rules/documentation.ts`. This spec re-pins that
 * behavior against the live slice (`runDocumentationSlice`), asserting each of
 * the five rules fires (or stays silent) on a fixture designed to isolate its
 * gate, checking `ruleId`, `severity`, and the target symbol rather than the
 * dead analyzer's output.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { runDocumentationSlice } from '../phase/runner.js';
import { documentationRules } from '../phase/rules/documentation.js';
import type { Finding } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts');
  if (!adapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

const of = (findings: Finding[], ruleId: string): Finding[] =>
  findings.filter((f) => f.ruleId === ruleId);

async function run(source: string): Promise<Finding[]> {
  return runDocumentationSlice([{ path: 'parity.ts', content: source }], {
    exemptPatterns: [],
    docsMinLines: 1,
  });
}

describe('Spec 68 documentation rules (live phase slice)', () => {
  it('registers exactly the five migrated documentation rules', () => {
    expect(documentationRules.map((r) => r.id)).toEqual([
      'function-documentation',
      'parameter-documentation',
      'return-documentation',
      'class-documentation',
      'method-documentation',
    ]);
  });

  it('function-documentation fires on an exported function with no doc', async () => {
    const fs = await run('export function foo() {\n  return 1;\n}\n');
    const rule = of(fs, 'function-documentation');
    expect(rule.length).toBeGreaterThan(0);
    for (const f of rule) {
      expect(f.severity).toBe('high');
      expect(f.file).toBe('parity.ts');
      expect(f.symbol).toBe('foo');
    }
  });

  it('parameter-documentation fires on a substantive doc missing @param', async () => {
    const fs = await run('/**\n * Does the thing.\n */\nexport function greet(name: string): string {\n  return name;\n}\n');
    const rule = of(fs, 'parameter-documentation');
    expect(rule.length).toBeGreaterThan(0);
    for (const f of rule) {
      expect(f.severity).toBe('high');
      expect(f.symbol).toBe('greet');
    }
  });

  it('return-documentation fires on a substantive doc missing @returns', async () => {
    const fs = await run('/**\n * Computes the result.\n */\nexport function compute(): number {\n  return 1;\n}\n');
    const rule = of(fs, 'return-documentation');
    expect(rule.length).toBeGreaterThan(0);
    for (const f of rule) {
      expect(f.severity).toBe('high');
      expect(f.symbol).toBe('compute');
    }
  });

  it('class-documentation fires on an exported class with no doc', async () => {
    const fs = await run('export class Widget {\n  x() {}\n}\n');
    const rule = of(fs, 'class-documentation');
    expect(rule.length).toBeGreaterThan(0);
    for (const f of rule) {
      expect(f.severity).toBe('high');
      expect(f.symbol).toBe('Widget');
    }
  });

  it('method-documentation fires on a public method of an exported class', async () => {
    const fs = await run('export class Widget {\n  render() {\n    return 1;\n  }\n}\n');
    const rule = of(fs, 'method-documentation');
    expect(rule.length).toBeGreaterThan(0);
    for (const f of rule) {
      expect(f.severity).toBe('high');
      expect(f.symbol).toBe('Widget.render');
    }
  });

  it('skips anonymous callbacks and non-exported symbols at public scope', async () => {
    // The anonymous callback (`cb`) and the non-exported `helper` are both
    // skipped at scope 'public'; only the exported `top` (undocumented) fires.
    const fs = await run(
      [
        'export function top() {',
        '  const cb = () => 1;',
        '  return cb();',
        '}',
        'function helper() { return 1; }',
      ].join('\n'),
    );
    const rule = of(fs, 'function-documentation');
    expect(rule).toHaveLength(1);
    expect(rule[0].symbol).toBe('top');
  });
});
