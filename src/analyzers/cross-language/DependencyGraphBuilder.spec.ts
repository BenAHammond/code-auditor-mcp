import { describe, it, expect } from 'vitest';
import { DependencyGraphBuilder } from './DependencyGraphBuilder.js';
import type { CrossLanguageEntity, CrossReference } from '../../types/crossLanguage.js';

function entity(id: string, name: string, opts: Partial<CrossLanguageEntity> = {}): CrossLanguageEntity {
  return {
    id,
    name,
    language: 'typescript',
    file: `src/${name}.ts`,
    type: 'function',
    signature: `function ${name}() {}`,
    parameters: [],
    calls: [],
    calledBy: [],
    purpose: '',
    context: '',
    searchTokens: [name],
    ...opts,
  };
}

function ref(sourceId: string, targetId: string): CrossReference {
  return {
    sourceId,
    targetId,
    type: 'calls',
    sourceLanguage: 'typescript',
    targetLanguage: 'typescript',
    confidence: 0.7,
  };
}

describe('DependencyGraphBuilder.countStronglyConnectedComponents (Tarjan)', () => {
  it('reports real SCC counts, not a fabricated node/10 figure', async () => {
    // a ⇄ b form one 2-cycle (one SCC); c is an isolated singleton (one SCC).
    const entities = [
      entity('a', 'alpha'),
      entity('b', 'beta'),
      entity('c', 'gamma'),
    ];
    const references = [ref('a', 'b'), ref('b', 'a')];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);

    expect(graph.metrics.stronglyConnectedComponents).toBe(2);
  });

  it('counts every node as its own component in an acyclic graph', async () => {
    const entities = [entity('a', 'alpha'), entity('b', 'beta'), entity('c', 'gamma')];
    const references = [ref('a', 'b'), ref('b', 'c')];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);

    expect(graph.metrics.stronglyConnectedComponents).toBe(3);
  });
});

describe('DependencyGraphBuilder orphan detection', () => {
  it('does not flag exported entry points or unresolvable-name targets as orphaned', async () => {
    // a calls beta (resolved edge) and helper (unresolvable — no edge to helper).
    const entities = [
      entity('a', 'alpha', { visibility: 'private', metadata: { callees: ['beta', 'helper'] } }),
      entity('b', 'beta', { visibility: 'private' }),
      entity('c', 'entrypoint', { visibility: 'public' }),       // exported → not orphaned
      entity('d', 'deadcode', { visibility: 'private' }),        // truly orphaned
      entity('e', 'helper', { visibility: 'private' }),          // referenced by name → not orphaned
    ];
    const references = [ref('a', 'b')];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);
    const health = await builder.analyzeDependencyHealth(graph);

    const orphaned = health.issues.find(i => i.type === 'orphaned-nodes');
    expect(orphaned).toBeDefined();
    expect(orphaned!.affectedNodes).toEqual(['d']);
  });
});
