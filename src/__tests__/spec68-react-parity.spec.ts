/**
 * Spec 68 §3.2 — parity: the migrated react rules reproduce the legacy react
 * visitor's findings exactly.
 *
 * The legacy visitor did two things: per-file, `scanFile` (read + re-parse)
 * then `analyzeComponent` over every component; cross-file, `checkCircularDependencies`
 * + `checkErrorBoundaryUsage` + `checkRawElements` over the accumulated scans.
 * The phase model re-homes the classification half over the `react-component`
 * fact (whose producer runs `scanParsedFile` over the already-parsed tree), and
 * the cross-component checks run inside the `complexity` / `no-error-boundary` /
 * `raw-element` rules — identical detectors, identical config gates.
 *
 * This test runs BOTH paths (the legacy `createReactVisitor` logic is reproduced
 * inline — it still lives in pipelineAdapters.ts) and asserts the identity
 * multisets — (file, line, column, rule, severity) — are equal and non-empty.
 * It is the pin that lets §15 delete the legacy visitor without losing the
 * golden reference.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import { scanParsedFile, buildComponentTree } from '../componentScanner.js';
import {
  analyzeComponent,
  checkCircularDependencies,
  checkErrorBoundaryUsage,
  checkRawElements,
  DEFAULT_REACT_CONFIG,
} from '../analyzers/reactAnalyzer.js';
import type { ReactAnalyzerConfig, ComponentScanResult, ReactViolation } from '../types.js';
import { runReactComponentsSlice } from '../phase/runner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** A file to scan, with its source already read. */
type Fixture = { readonly path: string; readonly content: string };

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/**
 * The legacy react visitor, reproduced inline (it still lives in
 * pipelineAdapters.ts `createReactVisitor`). `config` is the user override
 * merged over `DEFAULT_REACT_CONFIG`, exactly as the visitor did.
 */
function legacy(files: readonly Fixture[], config?: Partial<ReactAnalyzerConfig>): string[] {
  const cfg = { ...DEFAULT_REACT_CONFIG, ...(config ?? {}) };
  const scanResults: ComponentScanResult[] = [];
  const violations: ReactViolation[] = [];

  for (const { path, content } of files) {
    const ast = parseFile(path, content);
    expect(ast, `fixture ${path} failed to parse`).not.toBeNull();
    const sr = scanParsedFile(ast!, content, path, {
      includeTests: false,
      includeStories: false,
      extractProps: true,
      extractHooks: cfg.checkHooksRules, // the legacy visitor tied extraction to the flag
      extractImports: true,
      detectComplexity: true,
    });
    scanResults.push(sr);
    if (sr.parseErrors && sr.parseErrors.length > 0) continue;
    for (const comp of sr.components ?? []) {
      violations.push(...analyzeComponent(comp, cfg, sr));
    }
  }

  // Cross-component checks — the legacy finalizer, gated identically.
  if (scanResults.length > 0) {
    violations.push(...checkCircularDependencies(buildComponentTree(scanResults)));
    if (cfg.requireErrorBoundaries !== false) {
      violations.push(...checkErrorBoundaryUsage(scanResults));
    }
    if (cfg.rawElementCheck !== false) {
      violations.push(...checkRawElements(scanResults, cfg));
    }
  }

  return violations
    .map((v) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();
}

/** Run the new react slice, return the identity multiset. */
async function phase(files: readonly Fixture[], config?: Partial<ReactAnalyzerConfig>): Promise<string[]> {
  const findings = await runReactComponentsSlice(files, config);
  return findings
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();
}

async function parity(files: readonly Fixture[], config?: Partial<ReactAnalyzerConfig>) {
  const old = legacy(files, config);
  const nu = await phase(files, config);
  return { old, nu };
}

describe('Spec 68 react parity (new analyze(ctx) === legacy createReactVisitor)', () => {
  it('accessibility: <img> without alt fires on both paths', async () => {
    const { old, nu } = await parity([{
      path: 'photo.tsx',
      content: `export function Photo() {\n  return <img src="x.png" />;\n}\n`,
    }]);
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
    expect(nu.some((k) => k.includes(':accessibility:'))).toBe(true);
  });

  it('performance: inline onClick prop fires on both paths', async () => {
    const { old, nu } = await parity([{
      path: 'card.tsx',
      content: `export function Card() {\n  return <Button onClick={() => go()} />;\n}\n`,
    }]);
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
    expect(nu.some((k) => k.includes(':performance:'))).toBe(true);
  });

  it('complexity: per-component ceiling fires on both paths (threshold lowered)', async () => {
    const content = `export function Complex(props) {\n  if (props.a) return <A />;\n  if (props.b) return <B />;\n  return <C />;\n}\n`;
    const { old, nu } = await parity([{ path: 'complex.tsx', content }], { maxComponentComplexity: 2 });
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
    expect(nu.some((k) => k.includes(':complexity:'))).toBe(true);
  });

  it('missing-props: fires when requirePropTypes is enabled', async () => {
    const { old, nu } = await parity([{
      path: 'widget.tsx',
      content: `export function Widget() {\n  return <div>hello</div>;\n}\n`,
    }], { requirePropTypes: true });
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
    expect(nu.some((k) => k.includes(':missing-props:'))).toBe(true);
  });

  it('hooks-naming: a non-use-prefixed hook-using function called in a component fires', async () => {
    const content = `function fetchData() {\n  return useState(null);\n}\n\nexport function Dashboard() {\n  fetchData();\n  return <div>ok</div>;\n}\n`;
    const { old, nu } = await parity([{ path: 'dashboard.tsx', content }]);
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
    expect(nu.some((k) => k.includes(':hooks-naming:'))).toBe(true);
  });

  it('raw-element: a raw <button> is flagged when a wrapper exists', async () => {
    const files: Fixture[] = [
      {
        path: 'wrapper.tsx',
        content: `export function Button({ children }: any) {\n  return <button className="btn">{children}</button>;\n}\n`,
      },
      {
        path: 'consumer.tsx',
        content: `import { Button } from './wrapper';\n\nexport function LegacySave() {\n  return <button className="btn">Save</button>;\n}\n`,
      },
    ];
    const { old, nu } = await parity(files, { wrapperMinUsages: 1 });
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
    expect(nu.some((k) => k.includes(':raw-element:'))).toBe(true);
  });

  it('no-error-boundary: a boundary-less app of 11 components fires once at app-level', async () => {
    const components = Array.from({ length: 11 }, (_, i) =>
      `export function Screen${i}() {\n  return <div>screen ${i}</div>;\n}\n`
    ).join('\n');
    const { old, nu } = await parity([{ path: 'app.tsx', content: components }]);
    expect(nu).toEqual(old);
    expect(nu.some((k) => k.includes(':no-error-boundary:'))).toBe(true);
  });

  it('a clean fixture yields no findings on either path', async () => {
    const { old, nu } = await parity([{
      path: 'clean.tsx',
      content: `export function Good() {\n  return <img src="x.png" alt="a description" />;\n}\n`,
    }]);
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });
});
