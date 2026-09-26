/**
 * Spec 68 §5 — the fact DAG.
 *
 * `CorpusProcessor.needs` forms a directed graph over fact kinds: an edge
 * `produces → need` means "this fact depends on that fact, so that fact must
 * complete first." Topological levels over this graph are the schedule — every
 * producer in a level runs concurrently, and a level begins only when the
 * previous level has completed for every file.
 *
 * A cycle in this graph is a real defect (a fact that transitively depends on
 * itself), and it is caught here by a DFS that returns the cycle path so the
 * guard test can name both ends of the back edge (§16 guard 4, criterion 5) —
 * rather than a boolean "has a cycle" that leaves the offending edge to be
 * found by hand.
 */

import type { FactKind } from './types.js';

/** The minimal producer projection the graph walks: what it makes, what it needs. */
export type FactProducer = {
  readonly produces: FactKind;
  readonly needs?: readonly FactKind[];
};

/** Every dependency edge in the graph, as `[produces, needs]` pairs. */
export function factEdges(producers: Readonly<Record<string, FactProducer>>): ReadonlyArray<readonly [FactKind, FactKind]> {
  const edges: Array<readonly [FactKind, FactKind]> = [];
  for (const p of Object.values(producers)) {
    for (const need of p.needs ?? []) edges.push([p.produces, need]);
  }
  return edges;
}

/**
 * Detects a cycle in the producer dependency graph, returning the cycle path
 * (which repeats its first node at the end, so both ends of the back edge are
 * named) or `null` when the graph is acyclic.
 */
export function detectFactCycle(producers: Readonly<Record<string, FactProducer>>): FactKind[] | null {
  const adj = new Map<FactKind, FactKind[]>();
  for (const p of Object.values(producers)) {
    const list = adj.get(p.produces) ?? [];
    for (const need of p.needs ?? []) list.push(need);
    adj.set(p.produces, list);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<FactKind, number>();
  const stack: FactKind[] = [];

  const visit = (node: FactKind): FactKind[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // Back edge: `next` is already on the DFS stack, so `stack.slice(idx)`
        // is the path from `next` back to itself — both ends of the edge named.
        const idx = stack.indexOf(next);
        return [...stack.slice(idx), next];
      }
      if (c === WHITE) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * The schedule: fact kinds grouped into topological levels. A producer with no
 * `needs` is level 0 (nothing precedes it); a corpus producer's level is one
 * past the deepest of its needs' levels. A cycle makes the level-set infinite
 * and is a defect — callers are expected to have run {@link detectFactCycle}
 * first; this function returns `null` on a cycle rather than looping.
 */
export function topologicalLevels(producers: Readonly<Record<string, FactProducer>>): Map<FactKind, number> | null {
  if (detectFactCycle(producers)) return null;

  const level = new Map<FactKind, number>();
  const resolve = (node: FactKind): number => {
    const memo = level.get(node);
    if (memo !== undefined) return memo;
    const p = producers[findProducerFor(node, producers)];
    const needs = p?.needs ?? [];
    const depth = needs.length === 0 ? 0 : 1 + Math.max(...needs.map(resolve));
    level.set(node, depth);
    return depth;
  };

  for (const node of Object.keys(producers).map((k) => producers[k].produces)) {
    resolve(node);
  }
  return level;
}

function findProducerFor(node: FactKind, producers: Readonly<Record<string, FactProducer>>): string {
  for (const [id, p] of Object.entries(producers)) {
    if (p.produces === node) return id;
  }
  // A `needs` target with no producer is a residue defect caught elsewhere
  // (checks.ts `_allConsumed` / `_allProduced`); here it just has no deeper
  // dependencies, so it resolves at level 0.
  return '';
}
