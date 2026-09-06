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

  it('does not flag type declarations (interfaces/structs) as orphaned — they are never call targets', async () => {
    // A private interface with no edges is not dead code: it is referenced via
    // type annotations/implements, which the call graph does not model.
    const entities = [
      entity('fn', 'alpha', { visibility: 'private', metadata: { callees: ['beta'] } }),
      entity('b', 'beta', { visibility: 'private' }),
      entity('iface', 'User', { visibility: 'private', type: 'interface' }),
      entity('st', 'Config', { visibility: 'private', type: 'struct' }),
    ];
    const references = [ref('fn', 'b')];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);
    const health = await builder.analyzeDependencyHealth(graph);

    const orphaned = health.issues.find(i => i.type === 'orphaned-nodes');
    // Only beta is a candidate but it has an incoming edge; nothing is orphaned.
    expect(orphaned?.affectedNodes ?? []).toEqual([]);
  });

  it('does not flag methods (class-prefixed names) as orphaned — receiver dispatch is invisible to the call graph', async () => {
    // `Client.formatter` is invoked via `this.formatter(...)`/`client.formatter(...)`,
    // which the bare-name reference resolver cannot model. It has no call edges and
    // is unexported, but "no call edges" is not evidence of dead code for a method.
    const entities = [
      entity('fn', 'alpha', { visibility: 'private', metadata: { callees: ['formatter'] } }),
      entity('method', 'Client.formatter', { visibility: 'private' }),
      entity('dead', 'deadcode', { visibility: 'private' }),
    ];
    const references = [ref('fn', 'method')];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);
    const health = await builder.analyzeDependencyHealth(graph);

    const orphaned = health.issues.find(i => i.type === 'orphaned-nodes');
    // Only deadcode (bare name, no edges, no reference) is orphaned; the method is skipped.
    expect(orphaned?.affectedNodes ?? []).toEqual(['dead']);
  });

  it('does not flag object-literal methods (bare name + isMethod) as orphaned', async () => {
    // `{ renameColumn() {} }` merged onto a prototype carries a bare name (no `.`
    // prefix), but `isMethod` marks it as receiver-dispatched — same invisibility.
    const entities = [
      entity('fn', 'alpha', { visibility: 'public' }),
      entity('obj', 'renameColumn', { visibility: 'private', metadata: { isMethod: true } }),
      entity('dead', 'deadcode', { visibility: 'private' }),
    ];
    const references: CrossReference[] = [];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);
    const health = await builder.analyzeDependencyHealth(graph);

    const orphaned = health.issues.find(i => i.type === 'orphaned-nodes');
    expect(orphaned?.affectedNodes ?? []).toEqual(['dead']);
  });
});

describe('DependencyGraphBuilder rendered finding data (Spec 44 render)', () => {
  it('renders cycle paths into the circular-dependency description and details', async () => {
    // a → b → a is a 2-cycle; c → d → c is another 2-cycle.
    const entities = [
      entity('a', 'alpha'),
      entity('b', 'beta'),
      entity('c', 'gamma'),
      entity('d', 'delta'),
    ];
    const references = [ref('a', 'b'), ref('b', 'a'), ref('c', 'd'), ref('d', 'c')];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);
    const health = await builder.analyzeDependencyHealth(graph);

    const issue = health.issues.find(i => i.type === 'circular-dependency');
    expect(issue).toBeDefined();
    // The description names the loop, not just a count.
    expect(issue!.description).toMatch(/alpha → beta/);
    expect(issue!.description).toMatch(/gamma → delta/);
    // The structured details carry the same path.
    const cycles = issue!.details?.cycles as Array<{ path: string }>;
    expect(cycles.some(c => c.path.includes('alpha → beta'))).toBe(true);
  });

  it('renders hub node name + out-degree, and orphan names', async () => {
    // hub has out-edges to 12 sinks → a hub (out-degree 12 ≫ the mean, which is
    // ~1.9 once the sinks form a chain). deadcode is a private function with no
    // edges and no name reference → orphaned.
    const entities = [
      entity('hub', 'hub', { visibility: 'private' }),
      ...Array.from({ length: 12 }, (_, i) => entity(`s${i}`, `sink${i}`, { visibility: 'private' })),
      entity('dead', 'deadcode', { visibility: 'private' }),
    ];
    const references = [
      ...Array.from({ length: 12 }, (_, i) => ref('hub', `s${i}`)),
      // sink0 → sink1 → … → sink11: every sink has out-degree 1, so the hub's
      // out-degree 12 is a genuine outlier above 3×mean rather than the whole graph.
      ...Array.from({ length: 11 }, (_, i) => ref(`s${i}`, `s${i + 1}`)),
    ];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);
    const health = await builder.analyzeDependencyHealth(graph);

    const hub = health.issues.find(i => i.type === 'hub-nodes');
    expect(hub).toBeDefined();
    expect(hub!.description).toMatch(/hub \(12\)/);
    expect(hub!.details).toEqual({ hubs: [{ id: 'hub', name: 'hub', outDegree: 12 }] });

    const orphan = health.issues.find(i => i.type === 'orphaned-nodes');
    expect(orphan).toBeDefined();
    expect(orphan!.description).toContain('deadcode');
    expect(orphan!.details).toEqual({ orphans: [{ id: 'dead', name: 'deadcode' }] });
  });
});
