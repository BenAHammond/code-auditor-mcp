/**
 * Spec 60 R2 — the size-distribution population is pinned: named functions and
 * methods are sampled; anonymous functions (inline callbacks, IIFEs) are not.
 *
 * A distribution whose denominator is undefined is not a measurement, so this
 * pins the exact set that enters `sizeSamples`. The line is drawn at the
 * adapter's naming: a `function_declaration`, a `method_definition`, and a
 * variable-assigned arrow (`const f = () => …`) all carry a name and are
 * counted; an arrow/function expression used inline (a `.map(…)` callback, an
 * IIFE) carries `name === '<anonymous>'` and is excluded.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../../languages/index.js';
import { parseFile } from '../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../languages/types.js';
import { UniversalSOLIDAnalyzer, DEFAULT_SOLID_CONFIG } from './UniversalSOLIDAnalyzer.js';

let adapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
}, 30_000);

async function samplesFor(code: string, name: string) {
  const analyzer = new UniversalSOLIDAnalyzer();
  const ast = parseFile(`${name}.ts`, code)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  await (analyzer as any).analyzeAST(ast, adapter, DEFAULT_SOLID_CONFIG, code);
  return analyzer.sizeSamples;
}

describe('Spec 60 R2 — size-sample population', () => {
  it('samples named functions and methods, excludes anonymous functions', async () => {
    const code = `
export function namedFn(a: number): number { return a + 1; }

const assignedArrow = (x: number): number => x * 2;

export class Widget {
  render(n: number): number { return n + 1; }
}

export function usesCallbacks(items: number[]): number[] {
  return items.map((x) => x * 2); // inline callback — anonymous
}
`;
    const samples = await samplesFor(code, 'population');
    const complexityNames = samples
      .filter((s) => s.measure === 'complexity')
      .map((s) => s.name)
      .sort();

    // Function declaration, variable-assigned arrow, and the class method are named.
    expect(complexityNames).toContain('namedFn');
    expect(complexityNames).toContain('assignedArrow');
    expect(complexityNames).toContain('Widget.render');
    expect(complexityNames).toContain('usesCallbacks');

    // The inline `.map(…)` callback is anonymous and must not enter the sample.
    expect(complexityNames.some((n) => n.startsWith('anonymous@'))).toBe(false);
  });
});
