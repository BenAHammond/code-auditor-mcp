/**
 * Spec-49 order #2 — documentation family: substance over length.
 *
 * The four crude documentation rules (`file-documentation`,
 * `function-documentation`, `class-documentation`, `method-documentation`) all
 * reduced to the same proxy — `jsDoc.length < minDescriptionLength` — presence +
 * character length, not substance. A "TODO: implement later" comment is 24
 * characters, so the old check treated it as "documented" and stayed silent; a
 * "Sums." comment is 6 characters, so the old check reported it as "missing
 * documentation" even though it describes the function.
 *
 * The real signal is *substance*, not length. That replacement was re-homed
 * into `phase/rules/documentation.ts` (`isSubstantiveDoc`) and
 * `phase/rules/fileDocumentation.ts` (`isFileHeaderDoc`) when the legacy
 * `UniversalDocumentationAnalyzer` was deleted (§15); this spec re-pins it
 * against the live slices (`runDocumentationSlice` / `runFileHeadersSlice`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { runDocumentationSlice, runFileHeadersSlice } from '../phase/runner.js';
import type { Finding } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts');
  if (!adapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

const of = (findings: Finding[], ruleId: string): Finding[] =>
  findings.filter((f) => f.ruleId === ruleId);

/** The docsMinLines size gate (default 5) would swallow a short fixture; drop it
 *  to 1 so each test exercises the substance check, not the size floor. */
const SYMBOL_THRESHOLDS = { exemptPatterns: [], docsMinLines: 1 };

async function symbols(sourceCode: string, filePath = 'lib/example.ts'): Promise<Finding[]> {
  return runDocumentationSlice([{ path: filePath, content: sourceCode }], SYMBOL_THRESHOLDS);
}

async function headers(sourceCode: string, filePath = 'lib/util.ts'): Promise<Finding[]> {
  return runFileHeadersSlice([{ path: filePath, content: sourceCode }], {
    exemptPatterns: [],
    fileHeaders: true,
  });
}

describe('spec-49 documentation — substance over length', () => {
  describe('function-documentation', () => {
    it('positive: an undocumented exported function fires', async () => {
      const vs = await symbols('export function total(input) { return input; }');
      expect(of(vs, 'function-documentation')).toHaveLength(1);
    });

    it('near-miss: a short but descriptive comment is NOT missing documentation', async () => {
      // 8 chars — the old length proxy (<10) reported "missing" despite the
      // comment genuinely describing the function. The real signal must not fire.
      const vs = await symbols('/** Sums. */\nexport function total(input) { return input; }');
      expect(of(vs, 'function-documentation')).toHaveLength(0);
    });

    it('inverse near-miss: a long placeholder comment IS missing documentation', async () => {
      // 23 chars — the old length proxy (>=10) treated this as "documented".
      // The real signal must fire: a TODO is not documentation.
      const vs = await symbols('/** TODO: implement later */\nexport function total(input) { return input; }');
      expect(of(vs, 'function-documentation')).toHaveLength(1);
    });

    it('near-miss: a descriptive doc that *mentions* "placeholder" is still documentation', async () => {
      // Regression for the placeholder-detection false positive: the word
      // "placeholder" appearing mid-sentence must not be read as a placeholder
      // *comment*; only a comment that leads with the marker is a placeholder.
      const vs = await symbols(
        '/** Renders the placeholder card when the image 404s. */\nexport function cdnIcon(url) { return url; }',
      );
      expect(of(vs, 'function-documentation')).toHaveLength(0);
    });
  });

  describe('class-documentation', () => {
    it('positive: an undocumented exported class fires', async () => {
      const vs = await symbols('export class Ledger { add() { return 1; } }');
      expect(of(vs, 'class-documentation')).toHaveLength(1);
    });

    it('near-miss: a short but descriptive class comment is NOT missing documentation', async () => {
      const vs = await symbols('/** Records. */\nexport class Ledger { add() { return 1; } }');
      expect(of(vs, 'class-documentation')).toHaveLength(0);
    });

    it('inverse near-miss: a long placeholder class comment IS missing documentation', async () => {
      const vs = await symbols('/** TODO: implement */\nexport class Ledger { add() { return 1; } }');
      expect(of(vs, 'class-documentation')).toHaveLength(1);
    });
  });

  describe('method-documentation', () => {
    it('positive: an undocumented public method fires', async () => {
      const vs = await symbols('export class Ledger { add() { return 1; } }');
      expect(of(vs, 'method-documentation')).toHaveLength(1);
    });

    it('near-miss: a short but descriptive method comment is NOT missing documentation', async () => {
      const vs = await symbols('export class Ledger {\n  /** Reads. */\n  fetch() { return 1; }\n}');
      expect(of(vs, 'method-documentation')).toHaveLength(0);
    });

    it('inverse near-miss: a long placeholder method comment IS missing documentation', async () => {
      const vs = await symbols('export class Ledger {\n  /** TODO: implement */\n  fetch() { return 1; }\n}');
      expect(of(vs, 'method-documentation')).toHaveLength(1);
    });
  });

  describe('file-documentation (opt-in fileHeaders)', () => {
    it('positive: a file with no leading comment fires', async () => {
      const vs = await headers('export const a = 1;');
      expect(of(vs, 'file-documentation')).toHaveLength(1);
    });

    it('near-miss: a genuine @fileoverview header is NOT missing documentation', async () => {
      const vs = await headers('/** @fileoverview Core utilities. */\nexport const a = 1;');
      expect(of(vs, 'file-documentation')).toHaveLength(0);
    });

    it('inverse near-miss: a license block is NOT a file header', async () => {
      // A copyright notice documents licensing, not the file's purpose.
      const vs = await headers('/** Copyright 2024 Acme Corp. All rights reserved. */\nexport const a = 1;');
      expect(of(vs, 'file-documentation')).toHaveLength(1);
    });
  });
});
