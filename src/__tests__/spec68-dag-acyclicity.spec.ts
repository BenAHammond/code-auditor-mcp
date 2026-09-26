/**
 * Spec 68 §5 / §16 guard 4 / criterion 5 — the fact DAG is acyclic.
 *
 * `CorpusProcessor.needs` forms a graph over fact kinds. A cycle means a fact
 * transitively depends on itself, which no topological schedule can order.
 * The guard is not "PRODUCERS happens to be acyclic today" — it is that a
 * seeded cycle is *detected* and both ends of the back edge are *named*, so the
 * defect cannot hide as "the scheduler hung" or "one fact never appeared."
 *
 * This test does not need the WASM grammars: the graph is built from the
 * producer declarations alone.
 */

import { describe, it, expect } from 'vitest';
import { PRODUCERS, CORPUS_PRODUCERS } from '../phase/producers.js';
import { detectFactCycle, factEdges, topologicalLevels, type FactProducer } from '../phase/dag.js';
import type { FactKind } from '../phase/types.js';

/** The DAG walks only the corpus producers — a `needs` edge exists only on a
 *  corpus processor (file producers have no upstream facts). */
function asFactProducers(): Record<string, FactProducer> {
  const out: Record<string, FactProducer> = {};
  for (const [id, p] of Object.entries(CORPUS_PRODUCERS)) {
    out[id] = { produces: p.produces, needs: p.needs };
  }
  return out;
}

describe('Spec 68 §5 — fact DAG', () => {
  it('the declared PRODUCERS graph is acyclic', () => {
    expect(detectFactCycle(asFactProducers())).toBeNull();
  });

  it('every corpus processor edge points at a declared producer (no dangling needs)', () => {
    const produced = new Set<FactKind>([
      ...(Object.keys(PRODUCERS) as FactKind[]),
      ...(Object.keys(CORPUS_PRODUCERS) as FactKind[]),
    ]);
    for (const [from, to] of factEdges(asFactProducers())) {
      expect(produced.has(to)).toBe(true);
    }
  });

  it('assigns a topological level to every produced fact kind', () => {
    const levels = topologicalLevels(asFactProducers());
    expect(levels).not.toBeNull();
    // Every corpus producer's level is strictly after the deepest of its needs.
    for (const p of Object.values(CORPUS_PRODUCERS)) {
      const self = levels!.get(p.produces)!;
      for (const n of p.needs) {
        expect(self).toBeGreaterThan(levels!.get(n)!);
      }
    }
  });

  it('detects a seeded two-node cycle and names both ends of the back edge', () => {
    const cycle: Record<string, FactProducer> = {
      a: { produces: 'table-catalog', needs: ['ddl-declarations'] },
      b: { produces: 'ddl-declarations', needs: ['table-catalog'] },
    };
    const path = detectFactCycle(cycle);
    expect(path).not.toBeNull();
    // The path repeats its first node at the end — both ends of the back edge.
    expect(path![0]).toBe(path![path!.length - 1]);
    expect(new Set(path)).toEqual(new Set(['table-catalog', 'ddl-declarations']));
  });

  it('detects a seeded self-loop (a fact depending on itself)', () => {
    const loop: Record<string, FactProducer> = {
      a: { produces: 'table-catalog' as FactKind, needs: ['table-catalog'] },
    };
    const path = detectFactCycle(loop);
    expect(path).toEqual(['table-catalog', 'table-catalog']);
  });

  it('a longer seeded cycle is reported as the full path, not just a boolean', () => {
    const three: Record<string, FactProducer> = {
      a: { produces: 'table-catalog', needs: ['ddl-declarations'] },
      b: { produces: 'ddl-declarations', needs: ['schema-usage'] },
      c: { produces: 'schema-usage', needs: ['table-catalog'] },
    };
    const path = detectFactCycle(three);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(4); // three edges, first node repeated at the end
    expect(path![0]).toBe(path![path!.length - 1]);
  });

  it('topologicalLevels returns null on a cycle rather than looping forever', () => {
    const cycle: Record<string, FactProducer> = {
      a: { produces: 'table-catalog', needs: ['ddl-declarations'] },
      b: { produces: 'ddl-declarations', needs: ['table-catalog'] },
    };
    expect(topologicalLevels(cycle)).toBeNull();
  });
});
