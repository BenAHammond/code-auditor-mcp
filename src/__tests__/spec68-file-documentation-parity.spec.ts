/**
 * Spec 68 §3.2 — parity: the migrated `file-documentation` rule reproduces the
 * old analyzer's findings exactly.
 *
 * `file-documentation` is the one documentation rule that is file-level, not
 * symbol-level: it checks for a leading *file header* comment (`@fileoverview` /
 * `@file` / `@module` / `@overview` / `@purpose`). It reads the new
 * `file-header` fact (one element per file) instead of `file-symbols`. This test
 * runs BOTH paths — the still-live `UniversalDocumentationAnalyzer` and the new
 * `runFileHeadersSlice` — and asserts the identity multiset (file, line, column,
 * rule, severity) is equal and non-empty.
 *
 * The gate defaults OFF (`fileHeaders` → `requireFileDocs` → false), so every
 * case passes `fileHeaders: true`. The `exemptPatterns` list is emptied so the
 * fixture path never trips a file-level skip, and fixtures use `.ts` (not
 * `.tsx`/`.jsx` — those are skipped by the legacy `.tsx$`/`.jsx$` exempt
 * patterns before the header check is reached). The `headerSkipGlobs` skip is
 * exercised separately on an `index.ts` path.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDocumentationAnalyzer } from '../analyzers/universal/UniversalDocumentationAnalyzer.js';
import { runFileHeadersSlice } from '../phase/runner.js';
import { fileDocumentationRules } from '../phase/rules/fileDocumentation.js';
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
async function parity(source: string, config: ThresholdValues, path = 'parity.ts') {
  const ast = parseFile(path, source);
  expect(ast, `fixture failed to parse`).not.toBeNull();
  const oldRaw = await (analyzer as unknown as {
    analyzeAST(ast: unknown, a: LanguageAdapter, c: unknown, s: string): Promise<Violation[]>;
  }).analyzeAST(ast, adapter, config, source);
  const old = oldRaw.filter((v) => v.rule === 'file-documentation').map((v) => key({
    file: v.file,
    line: v.line,
    column: v.column,
    rule: v.rule,
    severity: v.severity,
  })).sort();

  const fresh = await runFileHeadersSlice([{ path, content: source }], config);
  const nu = fresh.filter((f) => f.ruleId === 'file-documentation').map((f) => key({
    file: f.file,
    line: f.line,
    column: f.column,
    rule: f.ruleId,
    severity: f.severity,
  })).sort();

  return { old, nu };
}

describe('Spec 68 file-documentation parity (new analyze(ctx) === old UniversalDocumentationAnalyzer)', () => {
  it('registers exactly the one file-documentation rule', () => {
    expect(fileDocumentationRules.map((r) => r.id)).toEqual(['file-documentation']);
  });

  it('a valid @fileoverview header fires nothing', async () => {
    const { old, nu } = await parity(
      '/**\n * @fileoverview Parses and validates the audit configuration.\n */\nexport const x = 1;\n',
      { exemptPatterns: [], fileHeaders: true },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBe(0);
  });

  it('a file with no leading comment fires', async () => {
    const { old, nu } = await parity(
      'export const x = 1;\n',
      { exemptPatterns: [], fileHeaders: true },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('a license-only leading comment is not a header and fires', async () => {
    const { old, nu } = await parity(
      '/* Copyright 2026 Example Corp. All rights reserved. */\nexport const x = 1;\n',
      { exemptPatterns: [], fileHeaders: true },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('a @module header fires nothing', async () => {
    const { old, nu } = await parity(
      '/**\n * @module widgets\n */\nexport function widget() {\n  return 1;\n}\n',
      { exemptPatterns: [], fileHeaders: true },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBe(0);
  });

  it('headerSkipGlobs skips an index file before the header check', async () => {
    // `**/index.{ts,tsx,js}` is in the default headerSkipGlobs; a headerless
    // index file must fire nothing on both paths.
    const { old, nu } = await parity(
      'export const x = 1;\n',
      { exemptPatterns: [], fileHeaders: true },
      'src/index.ts',
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBe(0);
  });

  it('the fileHeaders gate is OFF by default', async () => {
    const { old, nu } = await parity(
      'export const x = 1;\n',
      { exemptPatterns: [] },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBe(0);
  });
});
