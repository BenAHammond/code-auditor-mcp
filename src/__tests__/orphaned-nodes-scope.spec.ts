/**
 * Spec 73 — `orphaned-nodes` and lexical scope.
 *
 * A nested function (a closure) that is defined and used inside its enclosing
 * function must never read as orphaned. The flat name-based call graph models
 * module-level callers, not lexical scope: a closure is reached through forms
 * the graph cannot observe (`return closure`, passing it as a value,
 * `closure.call`/`closure.apply`, …), so "no edges" is not evidence of dead
 * code. The fix marks nested functions at extraction time
 * (`metadata.isNested`) and the orphan filter exempts them, alongside the
 * existing interface/struct/method/`_`-prefixed/exported guards.
 *
 * This test drives the *full* path — producer (`cross-language-entities`) →
 * `analyzeDependencyGraph` — so it fails if extraction ever stops recording
 * `isNested`, not just if the builder stops honouring it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import { analyzeDependencyGraph } from '../phase/runner.js';
import type { ParsedFile, Entity } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function produce(path: string, source: string): Entity[] {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = { file: path, format: 'typescript', source, ast, adapter: adapter! };
  try {
    return PRODUCERS['cross-language-entities']['typescript'].process(file);
  } finally {
    ast.dispose?.();
  }
}

describe('orphaned-nodes — lexical scope (nested closures are not orphaned)', () => {
  it('extraction marks a nested function/arrow with metadata.isNested', () => {
    const entities = produce(
      '/fixture/scope.ts',
      [
        'export function outer() {',
        '  function inner() { return 1; }',
        '  const arrow = () => 1;',
        '  return inner() + arrow();',
        '}',
      ].join('\n'),
    );
    const byName = new Map(entities.map((e) => [e.name, e] as const));
    expect(byName.get('outer')?.metadata?.isNested).toBeFalsy();
    expect(byName.get('inner')?.metadata?.isNested).toBe(true);
    expect(byName.get('arrow')?.metadata?.isNested).toBe(true);
  });

  it('does not flag a closure defined and called inside its enclosing function', async () => {
    // `inner` is called via `inner.call(null)` — a call form the flat graph
    // cannot model — and `outer` is exported, so `inner` is marked exported by
    // the parent-export walk as well as nested. Neither path may orphan it.
    const entities = produce(
      '/fixture/called.ts',
      [
        'export function outer() {',
        '  function inner() { return 1; }',
        '  return inner.call(null);',
        '}',
      ].join('\n'),
    );
    const findings = await analyzeDependencyGraph(entities, {});
    const orphans = findings.filter((f) => f.ruleId === 'orphaned-nodes');
    expect(orphans.map((f) => f.symbol)).toEqual([]);
  });

  it('does not flag a closure returned as a value from its enclosing function', async () => {
    // `inner` is returned, not called — the graph sees no edge and no reference,
    // so without the nesting guard it reads orphaned. (`outer` itself is a
    // genuinely-dead top-level function and may still be flagged; the point is
    // that the *closure* `inner` is exempt.)
    const entities = produce(
      '/fixture/returned.ts',
      [
        'function outer() {',
        '  function inner() { return 1; }',
        '  return inner;',
        '}',
      ].join('\n'),
    );
    const findings = await analyzeDependencyGraph(entities, {});
    const orphans = findings.filter((f) => f.ruleId === 'orphaned-nodes');
    expect(orphans.map((f) => f.symbol)).not.toContain('inner');
  });

  it('still flags a genuinely-dead top-level function as orphaned', async () => {
    // A top-level unexported function with no callers is still a real orphan —
    // the nesting guard must not suppress top-level dead code.
    const entities = produce(
      '/fixture/dead.ts',
      ['function dead() { return 1; }'].join('\n'),
    );
    const findings = await analyzeDependencyGraph(entities, {});
    const orphans = findings.filter((f) => f.ruleId === 'orphaned-nodes');
    expect(orphans.map((f) => f.symbol)).toEqual(['dead']);
  });
});
