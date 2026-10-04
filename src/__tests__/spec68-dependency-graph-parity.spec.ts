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
 * The fixture is a mutual call cycle between two packages (modA ⇄ modB) plus one
 * unexported dead function (`orphan`). That reliably fires all six rules —
 * circular-dependency/break-cycles (the cross-file cycle), tight-coupling/
 * reduce-coupling (modA ↔ modB: every edge crosses the package boundary, so
 * coupling is 1.0), orphaned-nodes/review-orphans (the dead function).
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
    path: '/fixture/modA/a.ts',
    source: [
      'import { bar, baz } from "./b";',
      'export function foo() { bar(); baz(); }',
      'function orphan() { return 1; }',
    ].join('\n'),
  },
  {
    path: '/fixture/modB/b.ts',
    source: [
      'import { foo } from "./a";',
      'export function bar() { foo(); }',
      'export function baz() { foo(); }',
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
  it('covers exactly the six migrated dependency-graph rules', () => {
    expect(dependencyGraphRules.map((r) => r.id)).toEqual([
      'circular-dependency',
      'break-cycles',
      'tight-coupling',
      'reduce-coupling',
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

  // Spec 68 board §6.1 — the three advisory rules (break-cycles / reduce-coupling /
  // review-orphans) are emitted from the dependency-health *suggestions*, not the
  // issues. The multiset assertion above proves parity but not that each advisory
  // rule actually fires; this pins that liveness explicitly on the cycle+orphan
  // fixture (modA ⇄ modB mutual cycle → break-cycles + reduce-coupling; the dead
  // `orphan` function → review-orphans).
  it('the three advisory rules fire (break-cycles / reduce-coupling / review-orphans)', async () => {
    const { flat } = buildFacts();
    const findings = await analyzeDependencyGraph(flat, {});
    const ids = findings.map((f) => f.ruleId);

    expect(ids).toContain('break-cycles');
    expect(ids).toContain('reduce-coupling');
    expect(ids).toContain('review-orphans');
  });
});
