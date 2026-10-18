/**
 * Spec 68 §3.2 — parity: the migrated `duplicate-import` rule reproduces the
 * old `UniversalDRYAnalyzer.checkDuplicateImports` findings exactly.
 *
 * `checkDuplicateImports` is the one import-servable DRY detector (the other
 * five read code blocks / string literals the `imports` fact cannot serve), so
 * this test runs both paths for that single rule and asserts the identity
 * multisets are equal and non-empty. The legacy side is `analyzeAST` with the
 * other DRY checks disabled (`checkImports: true`, everything else off) so the
 * only dry finding emitted is `duplicate-import`.
 *
 * The per-file grouping is the load-bearing property: the legacy detector ran
 * once per AST, so two files importing the same module once each are NOT
 * duplicates. The multi-file case pins that the corpus-wide `imports` fact does
 * not collapse the two single imports into a false positive.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDRYAnalyzer } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import { runDrySlice } from '../phase/runner.js';
import { dryRules } from '../phase/rules/dry.js';
import type { Violation } from '../types.js';

let adapter: LanguageAdapter;
let analyzer: UniversalDRYAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDRYAnalyzer();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** Run the old `checkDuplicateImports` and the new slice, return the identity multisets. */
async function parity(source: string) {
  const ast = parseFile('parity.ts', source);
  expect(ast, 'fixture failed to parse').not.toBeNull();
  const oldRaw = await (analyzer as unknown as {
    analyzeAST(ast: unknown, a: LanguageAdapter, c: unknown, s: string): Promise<Violation[]>;
  }).analyzeAST(ast, adapter, {
    checkImports: true,
    checkStrings: false,
    checkExpressionSimilarity: false,
  }, source);
  const old = oldRaw
    .filter((v) => v.rule === 'duplicate-import')
    .map((v) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();

  // Thread the same config the legacy side runs under: `checkImports: true` gates
  // the migrated `duplicate-import` rule on (default off), matching `analyzeAST`.
  const fresh = await runDrySlice([{ path: 'parity.ts', content: source }], { checkImports: true });
  const nu = fresh
    .filter((f) => f.ruleId === 'duplicate-import')
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();

  return { old, nu, fresh };
}

describe('Spec 68 dry parity (new analyze(ctx) === old checkDuplicateImports)', () => {
  it('covers exactly the six import/string/code-block/history-servable DRY rules', () => {
    expect(dryRules.map((r) => r.id)).toEqual([
      'duplicate-import',
      'duplicate-string-literal',
      'dry/duplicate',
      'dry/structural-similarity',
      'dry/similar-expression',
      'dry/diverging-clone',
    ]);
  });

  it('two imports of the same module fire once, anchored at the first import', async () => {
    const source = [
      "import { a } from './mod';",
      "import { b } from './mod';",
      '',
    ].join('\n');
    const { old, nu, fresh } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
    // The first import is line 1, column 1 (1-based); the module source is the symbol.
    expect(fresh[0]).toMatchObject({
      line: 1,
      column: 1,
      symbol: './mod',
      message: 'Module "./mod" is imported 2 times',
    });
  });

  it('three imports of the same module report the count and the first location', async () => {
    const source = [
      "import { a } from './mod';",
      "import { b } from './mod';",
      "import { c } from './mod';",
      '',
    ].join('\n');
    const { old, nu, fresh } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
    expect(fresh[0]).toMatchObject({ line: 1, column: 1, message: 'Module "./mod" is imported 3 times' });
  });

  it('distinct modules do not fire', async () => {
    const source = [
      "import { a } from './mod';",
      "import { b } from './other';",
      '',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(0);
  });

  it('side-effect and named imports of the same source are still duplicates', async () => {
    const source = [
      "import './side';",
      "import { x } from './side';",
      '',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
  });

  it('does not collapse single imports across different files (per-file grouping)', async () => {
    // Each file imports `./mod` once — no duplicate within either file.
    const fresh = await runDrySlice([
      { path: 'a.ts', content: "import { a } from './mod';\n" },
      { path: 'b.ts', content: "import { b } from './mod';\n" },
    ], { checkImports: true });
    expect(fresh.filter((f) => f.ruleId === 'duplicate-import')).toEqual([]);
  });
});

describe('duplicate-import — type-only discriminant (Directive K item 2)', () => {
  // A TypeScript `import type { X } from 'm'` beside `import { Y } from 'm'` is
  // NOT a duplicate: the type-only import erases at compile time and emits no
  // runtime binding, so it is a separate declaration kind from the value import.
  // This diverges from the legacy `checkDuplicateImports` (which keyed only on
  // the module source), so these pin the new rule directly rather than via the
  // parity helper above.

  it('does NOT fire on a type-only import beside a value import of the same module', async () => {
    const fresh = await runDrySlice([
      {
        path: 'mixed.tsx',
        content: [
          "import type { ReactNode } from 'react';",
          "import { Component } from 'react';",
          '',
        ].join('\n'),
      },
    ], { checkImports: true });
    expect(fresh.filter((f) => f.ruleId === 'duplicate-import')).toEqual([]);
  });

  it('still fires on two value imports of the same module', async () => {
    const fresh = await runDrySlice([
      {
        path: 'v.ts',
        content: [
          "import { Component } from 'react';",
          "import { useState } from 'react';",
          '',
        ].join('\n'),
      },
    ], { checkImports: true });
    const dups = fresh.filter((f) => f.ruleId === 'duplicate-import');
    expect(dups.length).toBe(1);
    expect(dups[0]).toMatchObject({ symbol: 'react', message: 'Module "react" is imported 2 times' });
  });

  it('still fires on two type-only imports of the same module (same kind)', async () => {
    const fresh = await runDrySlice([
      {
        path: 't.ts',
        content: [
          "import type { ReactNode } from 'react';",
          "import type { FC } from 'react';",
          '',
        ].join('\n'),
      },
    ], { checkImports: true });
    const dups = fresh.filter((f) => f.ruleId === 'duplicate-import');
    expect(dups.length).toBe(1);
    expect(dups[0]).toMatchObject({ symbol: 'react' });
  });
});

describe('duplicate-string-literal — markup attribute discriminant (Directive K item 4)', () => {
  // A `string` node whose parent is a `jsx_attribute` is a markup attribute value
  // (`fill="var(--fleece)"`), not a factorable code literal: `duplicate-string-literal`
  // must skip it. A string inside a JSX *expression* container (`fill={"var(--fleece)"}`)
  // is a code literal and must still fire — the discriminant is "direct attribute
  // value", not "any string under a JSX element".

  async function dups(path: string, content: string): Promise<unknown[]> {
    const fresh = await runDrySlice([{ path, content }]);
    return fresh.filter((f) => f.ruleId === 'duplicate-string-literal');
  }

  it('does NOT fire on a bare SVG attribute value repeated across markup', async () => {
    const content = [
      'export function Icon() {',
      '  return (',
      '    <svg>',
      '      <path fill="var(--fleece)" />',
      '      <rect fill="var(--fleece)" />',
      '      <circle fill="var(--fleece)" />',
      '    </svg>',
      '  );',
      '}',
      '',
    ].join('\n');
    expect(await dups('icon.tsx', content)).toEqual([]);
  });

  it('still fires on a duplicated code string literal', async () => {
    const content = [
      "export function a() { return 'var(--fleece)'; }",
      "export function b() { return 'var(--fleece)'; }",
      "export function c() { return 'var(--fleece)'; }",
      '',
    ].join('\n');
    const found = await dups('code.ts', content);
    expect(found.length).toBe(1);
  });

  it('still fires on a string inside a JSX expression container (a code literal)', async () => {
    const content = [
      'export function Icon() {',
      '  return (',
      '    <svg>',
      '      <path fill={"var(--fleece)"} />',
      '      <rect fill={"var(--fleece)"} />',
      '      <circle fill={"var(--fleece)"} />',
      '    </svg>',
      '  );',
      '}',
      '',
    ].join('\n');
    const found = await dups('icon.tsx', content);
    expect(found.length).toBe(1);
  });
});
