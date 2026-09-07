/**
 * Spec-49 order #2 — documentation family.
 *
 * The four crude documentation rules (`file-documentation`,
 * `function-documentation`, `class-documentation`, `method-documentation`) all
 * reduce to the same proxy: `jsDoc.length < minDescriptionLength` — presence +
 * character length, not substance. A "TODO: implement later" comment is 24
 * characters, so the old check treats it as "documented" and stays silent; a
 * "Sums." comment is 6 characters, so the old check reports it as "missing
 * documentation" even though it describes the function.
 *
 * The real signal is *substance*, not length: a doc comment is documentation
 * only when it says something descriptive, and a placeholder (`TODO`/`FIXME`/
 * `@todo`/`@fixme`) or a bare license block is not documentation. This spec
 * pins that replacement for all four rules.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../../languages/index.js';
import { parseFile } from '../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../languages/types.js';
import { UniversalDocumentationAnalyzer, DEFAULT_DOCUMENTATION_CONFIG } from './UniversalDocumentationAnalyzer.js';
import type { Violation } from '../../types.js';

let analyzer: UniversalDocumentationAnalyzer;
let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not found');
  analyzer = new UniversalDocumentationAnalyzer();
}, 30_000);

async function run(
  sourceCode: string,
  filePath = 'lib/example.ts',
  config: Partial<typeof DEFAULT_DOCUMENTATION_CONFIG> = {},
): Promise<Violation[]> {
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error('failed to parse fixture');
  const cfg = { ...DEFAULT_DOCUMENTATION_CONFIG, ...config };
  return (await (analyzer as any).analyzeAST(ast, tsAdapter, cfg, sourceCode)) as Violation[];
}

const of = (vs: Violation[], rule: string) => vs.filter((v) => v.rule === rule);

// Multi-line bodies clear the R1.3 minimum-size gate (docsMinLines default 5).
const BODY = `{
  const a = input.a;
  const b = input.b;
  const c = a + b;
  return c;
}`;

describe('spec-49 documentation — substance over length', () => {
  describe('function-documentation', () => {
    it('positive: an undocumented exported function fires', async () => {
      const vs = await run(`export function total(input) ${BODY}`);
      expect(of(vs, 'function-documentation')).toHaveLength(1);
    });

    it('near-miss: a short but descriptive comment is NOT missing documentation', async () => {
      // 8 chars — the old length proxy (<10) reported "missing" despite the
      // comment genuinely describing the function. The real signal must not fire.
      const vs = await run(`/** Sums. */\nexport function total(input) ${BODY}`);
      expect(of(vs, 'function-documentation')).toHaveLength(0);
    });

    it('inverse near-miss: a long placeholder comment IS missing documentation', async () => {
      // 23 chars — the old length proxy (>=10) treated this as "documented".
      // The real signal must fire: a TODO is not documentation.
      const vs = await run(`/** TODO: implement later */\nexport function total(input) ${BODY}`);
      expect(of(vs, 'function-documentation')).toHaveLength(1);
    });

    it('near-miss: a descriptive doc that *mentions* "placeholder" is still documentation', async () => {
      // Regression for the placeholder-detection false positive: the word
      // "placeholder" appearing mid-sentence ("falls back to the placeholder")
      // must not be read as a placeholder *comment*. Only a comment that leads
      // with the marker is a placeholder.
      const vs = await run(
        `/** Renders the placeholder card when the image 404s. */\nexport function cdnIcon(url) ${BODY}`,
      );
      expect(of(vs, 'function-documentation')).toHaveLength(0);
    });
  });

  describe('class-documentation', () => {
    it('positive: an undocumented exported class fires', async () => {
      const vs = await run('export class Ledger { add() { return 1; } }');
      expect(of(vs, 'class-documentation')).toHaveLength(1);
    });

    it('near-miss: a short but descriptive class comment is NOT missing documentation', async () => {
      // 10 chars — the old length proxy reported "missing" despite the comment
      // describing the class. The real signal must not fire.
      const vs = await run('/** Records. */\nexport class Ledger { add() { return 1; } }');
      expect(of(vs, 'class-documentation')).toHaveLength(0);
    });

    it('inverse near-miss: a long placeholder class comment IS missing documentation', async () => {
      const vs = await run('/** TODO: implement */\nexport class Ledger { add() { return 1; } }');
      expect(of(vs, 'class-documentation')).toHaveLength(1);
    });
  });

  describe('method-documentation', () => {
    it('positive: an undocumented public method fires', async () => {
      const vs = await run('export class Ledger { add() { return 1; } }');
      expect(of(vs, 'method-documentation')).toHaveLength(1);
    });

    it('near-miss: a short but descriptive method comment is NOT missing documentation', async () => {
      // 8 chars — the old length proxy reported "missing" despite the comment
      // describing the method. The real signal must not fire.
      const vs = await run('export class Ledger {\n  /** Reads. */\n  fetch() { return 1; }\n}');
      expect(of(vs, 'method-documentation')).toHaveLength(0);
    });

    it('inverse near-miss: a long placeholder method comment IS missing documentation', async () => {
      const vs = await run('export class Ledger {\n  /** TODO: implement */\n  fetch() { return 1; }\n}');
      expect(of(vs, 'method-documentation')).toHaveLength(1);
    });
  });

  describe('file-documentation (opt-in fileHeaders)', () => {
    const HEADERS = { fileHeaders: true } as const;

    it('positive: a file with no leading comment fires', async () => {
      const vs = await run('export const a = 1;', 'lib/util.ts', HEADERS);
      expect(of(vs, 'file-documentation')).toHaveLength(1);
    });

    it('near-miss: a genuine @fileoverview header is NOT missing documentation', async () => {
      const vs = await run('/** @fileoverview Core utilities. */\nexport const a = 1;', 'lib/util.ts', HEADERS);
      expect(of(vs, 'file-documentation')).toHaveLength(0);
    });

    it('inverse near-miss: a license block is NOT a file header', async () => {
      // 49 chars — the old length proxy treated any long leading comment as a
      // file header. The real signal must fire: a copyright notice documents
      // licensing, not the file's purpose.
      const vs = await run(
        '/** Copyright 2024 Acme Corp. All rights reserved. */\nexport const a = 1;',
        'lib/util.ts',
        HEADERS,
      );
      expect(of(vs, 'file-documentation')).toHaveLength(1);
    });
  });
});
