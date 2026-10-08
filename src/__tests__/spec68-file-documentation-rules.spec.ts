/**
 * Spec 68 §3.2 — the migrated `file-documentation` rule, asserted directly.
 *
 * The parity spec this replaces (`spec68-file-documentation-parity.spec.ts`) ran
 * the legacy `UniversalDocumentationAnalyzer` as the "expected" side and
 * `runFileHeadersSlice` as the "actual" side. When the legacy analyzer was
 * deleted (§15), the expected side vanished with it. The behavior it pinned
 * moved into `phase/rules/fileDocumentation.ts`; this spec re-pins it against
 * the live slice, asserting the header classification (absent / `@fileoverview`
 * / license block / `@module`), the `headerSkipGlobs` index skip, and the
 * off-by-default `fileHeaders` gate.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { runFileHeadersSlice } from '../phase/runner.js';
import { fileDocumentationRules } from '../phase/rules/fileDocumentation.js';
import type { Finding } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts');
  if (!adapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

const of = (findings: Finding[], ruleId: string): Finding[] =>
  findings.filter((f) => f.ruleId === ruleId);

async function run(source: string, path = 'parity.ts'): Promise<Finding[]> {
  return runFileHeadersSlice([{ path, content: source }], {
    exemptPatterns: [],
    fileHeaders: true,
  });
}

describe('Spec 68 file-documentation rule (live phase slice)', () => {
  it('registers exactly the one file-documentation rule', () => {
    expect(fileDocumentationRules.map((r) => r.id)).toEqual(['file-documentation']);
  });

  it('a valid @fileoverview header fires nothing', async () => {
    const fs = await run('/**\n * @fileoverview Parses and validates the audit configuration.\n */\nexport const x = 1;\n');
    expect(of(fs, 'file-documentation')).toHaveLength(0);
  });

  it('a file with no leading comment fires', async () => {
    const fs = await run('export const x = 1;\n');
    const rule = of(fs, 'file-documentation');
    expect(rule.length).toBeGreaterThan(0);
    for (const f of rule) {
      expect(f.severity).toBe('high');
      expect(f.file).toBe('parity.ts');
    }
  });

  it('a license-only leading comment is not a header and fires', async () => {
    const fs = await run('/* Copyright 2026 Example Corp. All rights reserved. */\nexport const x = 1;\n');
    expect(of(fs, 'file-documentation').length).toBeGreaterThan(0);
  });

  it('a @module header fires nothing', async () => {
    const fs = await run('/**\n * @module widgets\n */\nexport function widget() {\n  return 1;\n}\n');
    expect(of(fs, 'file-documentation')).toHaveLength(0);
  });

  it('headerSkipGlobs skips an index file before the header check', async () => {
    // `**/index.{ts,tsx,js}` is in the default headerSkipGlobs; a headerless
    // index file must fire nothing.
    const fs = await run('export const x = 1;\n', 'src/index.ts');
    expect(of(fs, 'file-documentation')).toHaveLength(0);
  });

  it('the fileHeaders gate is OFF by default', async () => {
    const fs = await runFileHeadersSlice([{ path: 'parity.ts', content: 'export const x = 1;\n' }], {
      exemptPatterns: [],
    });
    expect(of(fs, 'file-documentation')).toHaveLength(0);
  });
});
