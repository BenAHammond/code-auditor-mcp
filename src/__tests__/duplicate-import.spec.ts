/**
 * Spec 49 Session 27 — `duplicate-import` (authenticity ledger row 122).
 *
 * The ledger gap: the rule's *detection* is a defensible proxy — it counts
 * same-`source` import statements per file and reports a module imported more
 * than once. But the reported location is **fabricated** as `{line:1, column:1}`
 * regardless of where the import actually sits, even though every
 * `ImportInfo` carries its real `location` from `toSourceLocation`.
 *
 * The honest fix: record each import's real location alongside its count and
 * report the violation at the first import's actual line, not a hardcoded 1:1.
 *
 * These three tests pin the location honesty through `analyzeAST`:
 *   1. positive — a module imported twice fires at the real import line (≥2,
 *      not the fabricated line 1).
 *   2. near-miss — two imports of *different* modules stay silent.
 *   3. inverse near-miss — duplicate imports deep in the file (line 1 is a
 *      comment, not an import) still report the real import line, falsifying
 *      the old hardcoded `{line:1, column:1}`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDRYAnalyzer, DEFAULT_DRY_CONFIG } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import type { Violation } from '../types.js';

let analyzer: UniversalDRYAnalyzer;
let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not found');
  analyzer = new UniversalDRYAnalyzer();
}, 30_000);

async function run(sourceCode: string, overrides: Record<string, unknown> = {}): Promise<Violation[]> {
  const ast = parseFile('duplicate-import.ts', sourceCode)!;
  if (!ast) throw new Error('failed to parse fixture');
  return (await (analyzer as any).analyzeAST(
    ast,
    tsAdapter,
    { ...DEFAULT_DRY_CONFIG, ...overrides },
    sourceCode,
  )) as Violation[];
}

const dupImports = (vs: Violation[]) => vs.filter((v) => v.rule === 'duplicate-import');

/** Enable the import sub-rule (off by default). */
const IMPORTS_ON = { checkImports: true };

// Line 1 = comment, line 2 = blank, first import at line 3, second at line 4.
const DUPLICATE_AT_LINES_3_4 = `// header

import { alpha } from "./mod";
import { beta } from "./mod";`;

// Line 1 = comment, first import at line 9.
const DUPLICATE_DEEP_IN_FILE = `// license header

const VERSION = "1.0.0";

export function setup() {
  return VERSION;
}

import { alpha } from "./shared";
import { beta } from "./shared";`;

describe('duplicate-import — honest location', () => {
  it('fires for a module imported twice and reports the real import line', async () => {
    const vs = dupImports(await run(DUPLICATE_AT_LINES_3_4, IMPORTS_ON));
    expect(vs).toHaveLength(1);

    const v = vs[0];
    expect(v.message).toContain('"./mod"');
    expect(v.message).toContain('2 times');
    // The real first import is at line 3 — not the fabricated line 1.
    expect(v.line).toBe(3);
    expect(v.line).not.toBe(1);
  });

  it('stays silent on imports of different modules (near-miss)', async () => {
    const vs = dupImports(await run(
      'import { a } from "./mod";\nimport { b } from "./other";',
      IMPORTS_ON,
    ));
    expect(vs).toHaveLength(0);
  });

  it('reports the real import line when the duplicate sits deep in the file', async () => {
    const vs = dupImports(await run(DUPLICATE_DEEP_IN_FILE, IMPORTS_ON));
    expect(vs).toHaveLength(1);

    const v = vs[0];
    // Line 1 is a comment here — the fabricated 1:1 would land on it; the honest
    // location is the first import at line 9.
    expect(v.line).toBe(9);
    expect(v.line).not.toBe(1);
  });
});
