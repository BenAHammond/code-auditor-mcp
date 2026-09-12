/**
 * Spec 55 R3 — rule-level test-file exclusion.
 *
 * `loop-query`, `unfiltered-query`, and `too-many-queries` are query-shape
 * rules that must never fire on test files: a test harness issuing many
 * queries in a loop is doing its job. The exclusion is at the rule level
 * (not a severity cap — that mechanism was removed in Spec 54), so the
 * security/org-filter rules (`sql-injection-risk`, `missing-org-filter`,
 * `hardcoded-connection`) still fire on test files.
 *
 * These tests run the real `UniversalDataAccessAnalyzer` via `analyzeAST`
 * and `checkQueryPatterns` directly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { checkQueryPatterns } from '../analyzers/universal/schema/codeAnalysis.js';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tsAdapter: LanguageAdapter;
let analyzer: UniversalDataAccessAnalyzer;
let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDataAccessAnalyzer();
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-testfile-excl-'));
}, 30_000);

/** Parse a snippet written to `filePath` and run the data-access analyzer. */
async function dataAccessViolationsAt(code: string, filePath: string): Promise<any[]> {
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${filePath}`);
  return (await (analyzer as any).analyzeAST(ast, tsAdapter, DEFAULT_DATA_ACCESS_CONFIG, sourceCode)) as any[];
}

/** A loop that eagerly queries on every iteration — a genuine N+1 in production code. */
const LOOP_QUERY = `import { db } from './db';
export function sweep(ids: string[]) {
  for (const id of ids) {
    db.prepare("SELECT * FROM items WHERE id = ?").bind(id).all();
  }
}
`;

/** An unfiltered DELETE — a mass-mutation foot-gun, fires unfiltered-query. */
const UNFILTERED = `import { db } from './db';
export function nuke() {
  return db.exec("DELETE FROM users");
}
`;

describe('Spec 55 R3 — query-shape rules are excluded from test files', () => {
  it('loop-query fires on a normal source file', async () => {
    const vs = await dataAccessViolationsAt(LOOP_QUERY, join(tmpDir, 'sweep.ts'));
    expect(vs.some((v) => v.rule === 'loop-query')).toBe(true);
  });

  it('loop-query does NOT fire on a *.test.ts file', async () => {
    const vs = await dataAccessViolationsAt(LOOP_QUERY, join(tmpDir, 'sweep.test.ts'));
    expect(vs.some((v) => v.rule === 'loop-query')).toBe(false);
  });

  it('loop-query does NOT fire on a file under tests/', async () => {
    await mkdir(join(tmpDir, 'tests'), { recursive: true });
    const vs = await dataAccessViolationsAt(LOOP_QUERY, join(tmpDir, 'tests', 'sweep.ts'));
    expect(vs.some((v) => v.rule === 'loop-query')).toBe(false);
  });

  it('unfiltered-query fires on a normal source file', async () => {
    const vs = await dataAccessViolationsAt(UNFILTERED, join(tmpDir, 'all.ts'));
    expect(vs.some((v) => v.rule === 'unfiltered-query')).toBe(true);
  });

  it('unfiltered-query does NOT fire on a *.test.ts file', async () => {
    const vs = await dataAccessViolationsAt(UNFILTERED, join(tmpDir, 'all.test.ts'));
    expect(vs.some((v) => v.rule === 'unfiltered-query')).toBe(false);
  });

  it('too-many-queries is excluded from a *.test.ts file', async () => {
    const source = [
      'function f() {',
      '  db.query("SELECT 1"); db.query("SELECT 2"); db.query("SELECT 3");',
      '  db.query("SELECT 4"); db.query("SELECT 5"); db.query("SELECT 6");',
      '}',
    ].join('\n');
    const filePath = join(tmpDir, 'many.test.ts');
    const ast = parseFile(filePath, source)!;
    const violations = checkQueryPatterns(ast, tsAdapter, source, {} as any);
    expect(violations.filter((v) => v.rule === 'too-many-queries')).toHaveLength(0);
  });
});
