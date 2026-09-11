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

// ---------------------------------------------------------------------------
// Spec 53 R1 — mutation-survivor triage: tests that kill the surviving logic
// mutants in this file. Each test below targets a specific survivor whose guard
// had no distinguishing case in the prior suite.
// ---------------------------------------------------------------------------

describe('DependencyGraphBuilder.createEdges — invalid reference endpoints', () => {
  it('drops references whose source or target is not a graph node', async () => {
    // The edge filter requires BOTH endpoints to be nodes (`&&`). A reference to
    // an unresolvable name must not leak a phantom edge into the graph.
    const entities = [entity('a', 'alpha'), entity('b', 'beta')];
    const references = [
      ref('a', 'b'),        // valid
      ref('a', 'ghost'),    // target not a node
      ref('phantom', 'b'),  // source not a node
    ];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);

    expect(graph.edges.map(e => `${e.from}->${e.to}`)).toEqual(['a->b']);
  });
});

describe('DependencyGraphBuilder SCC — a singleton child beside a cycle', () => {
  it('counts the cycle and the singleton as two components', async () => {
    // alpha → beta (singleton child) and alpha → gamma → alpha (a 2-cycle).
    // Correct Tarjan pops beta's singleton off the stack alone, then completes
    // {alpha, gamma} as one component → 2 SCCs. A pop loop that over-pops (or
    // under-pops) the component corrupts the stack so gamma's back-edge to alpha
    // is missed and alpha/gamma/beta split into 3.
    const entities = [
      entity('alpha', 'alpha'),
      entity('beta', 'beta'),
      entity('gamma', 'gamma'),
    ];
    const references = [ref('alpha', 'beta'), ref('alpha', 'gamma'), ref('gamma', 'alpha')];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);

    expect(graph.metrics.stronglyConnectedComponents).toBe(2);
  });
});

describe('DependencyGraphBuilder tight-coupling', () => {
  it('flags a 3-node mutually-calling cluster', async () => {
    // All three nodes live in one package (cluster "modA") and only call each
    // other → cohesion 1.0, above the 0.7 threshold.
    const entities = [
      entity('a', 'alpha', { file: 'src/modA/a.ts' }),
      entity('b', 'beta', { file: 'src/modA/b.ts' }),
      entity('c', 'gamma', { file: 'src/modA/c.ts' }),
    ];
    const references = [ref('a', 'b'), ref('b', 'c'), ref('c', 'a')];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);
    const health = await builder.analyzeDependencyHealth(graph);

    const issue = health.issues.find(i => i.type === 'tight-coupling');
    expect(issue).toBeDefined();
    expect(issue!.affectedNodes).toEqual(['a', 'b', 'c']);
  });

  it('does not flag a 2-node cluster (below the minimum size of 3)', async () => {
    // Coupling over a tiny cluster is meaningless; the guard is `length < 3`.
    const entities = [
      entity('a', 'alpha', { file: 'src/modA/a.ts' }),
      entity('b', 'beta', { file: 'src/modA/b.ts' }),
    ];
    const references = [ref('a', 'b'), ref('b', 'a')];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);
    const health = await builder.analyzeDependencyHealth(graph);

    expect(health.issues.find(i => i.type === 'tight-coupling')).toBeUndefined();
  });
});

describe('DependencyGraphBuilder cycle path — cycle not at the DFS root', () => {
  it('reports only the cycle members, not the prefix path', async () => {
    // a → b → c → b: the cycle is b ⇄ c. The reported path must be "beta → gamma",
    // not "alpha → beta → gamma" (alpha is not part of the cycle). This pins the
    // `pathIndex.get(neighbor) ?? 0` cycle-start lookup to the true cycle start.
    const entities = [entity('a', 'alpha'), entity('b', 'beta'), entity('c', 'gamma')];
    const references = [ref('a', 'b'), ref('b', 'c'), ref('c', 'b')];

    const builder = new DependencyGraphBuilder({ includeTestFiles: false });
    const graph = await builder.buildGraph(entities, references);
    const health = await builder.analyzeDependencyHealth(graph);

    const issue = health.issues.find(i => i.type === 'circular-dependency');
    expect(issue).toBeDefined();
    expect(issue!.description).toContain('beta → gamma');
    expect(issue!.description).not.toContain('alpha → beta → gamma');
  });
});

describe('DependencyGraphBuilder orphan — metadata.isExported', () => {
  it('does not flag a metadata-exported entity as orphaned', async () => {
    // `visibility` is private, but `metadata.isExported` marks it an entry point.
    const entities = [
      entity('x', 'entry', { visibility: 'private', metadata: { isExported: true } }),
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

describe('DependencyGraphBuilder test-file filtering', () => {
  it('excludes test files by default and includes them when opted in', async () => {
    const entities = [
      entity('a', 'alpha', { file: 'src/alpha.test.ts' }),
      entity('b', 'beta', { file: 'src/beta.ts' }),
    ];
    const references = [ref('a', 'b')];

    const exclude = new DependencyGraphBuilder({ includeTestFiles: false });
    const g1 = await exclude.buildGraph(entities, references);
    expect(g1.nodes.map(n => n.name)).toEqual(['beta']);

    const include = new DependencyGraphBuilder({ includeTestFiles: true });
    const g2 = await include.buildGraph(entities, references);
    expect(g2.nodes.map(n => n.name).sort()).toEqual(['alpha', 'beta']);
  });
});
