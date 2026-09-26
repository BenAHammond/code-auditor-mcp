/**
 * Spec 68 §3.2 — parity: the migrated dependency-graph rules reproduce the old
 * Stage-4 reducer's findings exactly.
 *
 * A rule is "migrated" only when the new `analyze(ctx)` over the
 * `cross-language-entities` fact produces the *same* findings the pre-migration
 * `createDependencyGraphReducer` produced on a fixture — same file, line,
 * column, rule, severity. Not a "similar count": the full multiset of identity
 * tuples. This test runs BOTH paths (the old reducer still live at the time it
 * is written) and asserts the multisets are equal and non-empty. It is the pin
 * that lets §15 delete the reducer without losing the golden reference.
 *
 * The fixture is a two-file cycle (foo ⇄ bar) plus one unexported dead function
 * (`orphan`). That reliably fires the six of the eight rules that a small
 * graph can reach — circular-dependency/break-cycles (the cycle),
 * tight-coupling/reduce-coupling (both files share the `cycle` cluster at
 * cohesion 1.0), orphaned-nodes/review-orphans (the dead function). hub-nodes
 * and split-responsibilities need an out-degree outlier (>10 on a tiny graph)
 * and are intentionally not exercised here; the full-multiset equality still
 * pins their empty-vs-empty case.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import { analyzeDependencyGraph } from '../phase/runner.js';
import { dependencyGraphRules } from '../phase/rules/dependencyGraph.js';
import { createDependencyGraphReducer } from '../pipelineAdapters.js';
import type { ParsedFile, Entity } from '../phase/types.js';
import type { Violation } from '../types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function produce(path: string, source: string): Entity[] {
  const format = path.endsWith('.go') ? 'go' : path.endsWith('.tsx') ? 'tsx' : 'typescript';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = { file: path, format, source, ast, adapter: adapter! };
  try {
    return PRODUCERS['cross-language-entities'][format].process(file);
  } finally {
    ast.dispose?.();
  }
}

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

const FIXTURE: ReadonlyArray<{ path: string; source: string }> = [
  {
    path: '/fixture/cycle/a.ts',
    source: [
      'import { bar } from "./b";',
      'export function foo() { bar(); }',
      'function orphan() { return 1; }',
    ].join('\n'),
  },
  {
    path: '/fixture/cycle/b.ts',
    source: [
      'import { foo } from "./a";',
      'export function bar() { foo(); }',
    ].join('\n'),
  },
];

/** Build the producer's per-file fact map and the flat entity array. */
function buildFacts() {
  const byFile: Record<string, { entities: Entity[] }> = {};
  const flat: Entity[] = [];
  for (const { path, source } of FIXTURE) {
    const entities = produce(path, source);
    byFile[path] = { entities };
    flat.push(...entities);
  }
  return { byFile, flat };
}

describe('Spec 68 dependency-graph parity (new analyze(ctx) === old reducer)', () => {
  it('covers exactly the eight migrated dependency-graph rules', () => {
    expect(dependencyGraphRules.map((r) => r.id)).toEqual([
      'circular-dependency',
      'break-cycles',
      'tight-coupling',
      'reduce-coupling',
      'hub-nodes',
      'split-responsibilities',
      'orphaned-nodes',
      'review-orphans',
    ]);
  });

  it('produces the same identity multiset as the legacy reducer', async () => {
    const { byFile, flat } = buildFacts();

    const legacy = await createDependencyGraphReducer().reduce(
      { 'cross-language-entities': byFile },
      { isScoped: false },
    );
    const old = (legacy.violations as Violation[]).map((v) => key({
      file: v.file,
      line: v.line,
      column: v.column,
      rule: v.rule,
      severity: v.severity,
    })).sort();

    const fresh = await analyzeDependencyGraph(flat, {});
    const nu = fresh.map((f) => key({
      file: f.file,
      line: f.line,
      column: f.column,
      rule: f.ruleId,
      severity: f.severity,
    })).sort();

    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });
});
