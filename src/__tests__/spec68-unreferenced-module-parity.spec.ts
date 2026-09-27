/**
 * Spec 68 §8 — parity: the migrated `unreferenced-module` rule reproduces the
 * old Stage-4 reducer's file-level reachability findings exactly.
 *
 * The legacy emission lived inside `createDependencyGraphReducer`'s file
 * reachability block: a file that exports symbols yet is imported by nothing
 * and is not a framework/package entry point is a dead module, anchored at
 * `line:1`, `severity: severe`. The phase model splits that into:
 *
 *   - a `file-imports` producer (`extractFileImports` — the re-homed
 *     `clCollectFileInfo` walk);
 *   - a `reachability` corpus processor (`computeReachability` — the re-homed
 *     `clComputeReachability`, projected to plain data);
 *   - one rule (`unreferencedModuleRule`) that re-applies the exact filter
 *     order (hasExports → not test → not entry point → no importers).
 *
 * This test runs BOTH paths on one fixture and asserts the identity multiset
 * on `(file, line, column, rule, severity)` is equal and non-empty. The
 * fixture exercises every suppression arm: a live module (imported), two dead
 * modules, a test file (`.test.`), an entry-point basename (`main`), and a
 * framework route basename (`page`). Both paths are pure free functions over
 * the same extracted facts, so the pin is by construction; what it verifies is
 * the wiring producer → corpus → rule.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS, CORPUS_PRODUCERS } from '../phase/producers.js';
import { unreferencedModuleRule } from '../phase/rules/unreferencedModule.js';
import { createDependencyGraphReducer } from '../pipelineAdapters.js';
import type { ParsedFile, Entity, FileImportsFact } from '../phase/types.js';
import type { Violation } from '../types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

/** Produce the legacy per-file fact shape: entities + the file-imports trio. */
function produce(
  path: string,
  source: string,
): { entities: Entity[]; imports: string[]; hasExports: boolean; unresolvedDynamicImports: FileImportsFact['unresolvedDynamicImports'] } {
  const format = path.endsWith('.go') ? 'go' : path.endsWith('.tsx') ? 'tsx' : 'typescript';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = { file: path, format, source, ast, adapter: adapter! };
  try {
    const entities = PRODUCERS['cross-language-entities'][format].process(file);
    const [info] = PRODUCERS['file-imports'][format].process(file);
    return { entities, imports: info.imports, hasExports: info.hasExports, unresolvedDynamicImports: info.unresolvedDynamicImports };
  } finally {
    ast.dispose?.();
  }
}

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

const FIXTURE: ReadonlyArray<{ path: string; source: string }> = [
  { path: '/fixture/lib/dead.ts', source: 'export function deadFn() { return 1; }' },
  { path: '/fixture/lib/plain.ts', source: 'export function plainFn() { return 2; }' },
  { path: '/fixture/lib/used.ts', source: 'export function helper() { return 3; }' },
  {
    path: '/fixture/main.ts',
    source: "import { helper } from './lib/used';\nexport function run() { return helper(); }",
  },
  { path: '/fixture/lib/dead.test.ts', source: 'export function testHelper() { return 4; }' },
  { path: '/fixture/page.tsx', source: 'export function Page() { return null; }' },
];

describe('Spec 68 unreferenced-module parity (new analyze(ctx) === old reducer)', () => {
  it('reproduces the legacy multiset exactly and non-empty', async () => {
    const byFile: Record<string, ReturnType<typeof produce>> = {};
    const flat: FileImportsFact[] = [];
    for (const { path, source } of FIXTURE) {
      const produced = produce(path, source);
      byFile[path] = produced;
      flat.push({ file: path, imports: produced.imports, hasExports: produced.hasExports, unresolvedDynamicImports: produced.unresolvedDynamicImports });
    }

    // Legacy: the Stage-4 reducer's file-reachability block (no config → its
    // own defaults: corpus = the fact set, DEFAULT_VIRTUAL_MODULES, no
    // package entries, projectRoot '').
    const legacy = await createDependencyGraphReducer().reduce(
      { 'cross-language-entities': byFile },
      { isScoped: false },
    );
    const old = (legacy.violations as Violation[])
      .filter((v) => v.rule === 'unreferenced-module')
      .map((v) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
      .sort();

    // New: file-imports → reachability (corpus processor, default fallback) →
    // the rule.
    const reachability = CORPUS_PRODUCERS['reachability'].process({ 'file-imports': flat });
    const fresh = unreferencedModuleRule.analyze({
      facts: { 'file-imports': flat, 'reachability': reachability },
      formats: ['typescript', 'tsx', 'javascript', 'go'],
      thresholds: {},
    }).map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
      .sort();

    expect(fresh).toEqual(old);
    expect(old.length).toBeGreaterThan(0);
  });

  it('flags exactly the two dead modules (not test/entry/live files)', async () => {
    const byFile: Record<string, ReturnType<typeof produce>> = {};
    const flat: FileImportsFact[] = [];
    for (const { path, source } of FIXTURE) {
      const produced = produce(path, source);
      byFile[path] = produced;
      flat.push({ file: path, imports: produced.imports, hasExports: produced.hasExports, unresolvedDynamicImports: produced.unresolvedDynamicImports });
    }
    const reachability = CORPUS_PRODUCERS['reachability'].process({ 'file-imports': flat });
    const files = unreferencedModuleRule.analyze({
      facts: { 'file-imports': flat, 'reachability': reachability },
      formats: ['typescript', 'tsx', 'javascript', 'go'],
      thresholds: {},
    }).map((f) => f.file).sort();

    expect(files).toEqual(['/fixture/lib/dead.ts', '/fixture/lib/plain.ts']);
  });
});
