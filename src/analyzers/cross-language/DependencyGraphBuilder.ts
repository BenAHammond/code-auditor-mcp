/**
 * Cross-Language Dependency Graph Builder
 * Creates dependency graphs that span multiple programming languages
 */

import {
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
  DependencyCycle,
  DependencyMetrics,
  CrossLanguageEntity,
  CrossReference
} from '../../types/crossLanguage.js';

export interface GraphBuilderOptions {
  includeInternalDependencies?: boolean;
  includeExternalDependencies?: boolean;
  maxDepth?: number;
  excludeLanguages?: string[];
  includeTestFiles?: boolean;
  clusterByPackage?: boolean;
}

// ---------------------------------------------------------------------------
// Core: state + stateless graph helpers (leaf layer — no cross-method calls)
// ---------------------------------------------------------------------------

class DependencyGraphBuilderCore {
  protected entities: CrossLanguageEntity[] = [];
  protected references: CrossReference[] = [];
  protected options: GraphBuilderOptions;

  constructor(options: GraphBuilderOptions = {}) {
    this.options = {
      includeInternalDependencies: true,
      includeExternalDependencies: true,
      maxDepth: 10,
      includeTestFiles: false,
      clusterByPackage: true,
      ...options
    };
  }

  /**
   * Create graph edges from references
   */
  protected createEdges(references: CrossReference[], nodes: DependencyNode[]): DependencyEdge[] {
    const nodeIds = new Set(nodes.map(node => node.id));

    return references
      .filter(ref => nodeIds.has(ref.sourceId) && nodeIds.has(ref.targetId))
      .map(ref => ({
        from: ref.sourceId,
        to: ref.targetId,
        type: ref.type,
        weight: ref.confidence,
        protocol: ref.protocol
      }));
  }

  /**
   * Calculate node weight based on various factors
   */
  protected calculateNodeWeight(entity: CrossLanguageEntity): number {
    let weight = 1;

    // Increase weight for exported/public entities
    if (entity.visibility === 'public' || entity.metadata?.isExported) {
      weight += 2;
    }

    // Increase weight for complex entities
    if (entity.complexity && entity.complexity > 5) {
      weight += Math.floor(entity.complexity / 5);
    }

    // Increase weight for interfaces and services
    if (entity.type === 'interface' || entity.type === 'service') {
      weight += 3;
    }

    return weight;
  }

  /**
   * Extract package/module name from file path
   */
  protected extractPackageFromFile(filePath: string, language: string): string {
    const parts = filePath.split('/');

    switch (language) {
      case 'go':
        // For Go, use the last directory as package
        return parts[parts.length - 2] || 'main';
      case 'typescript':
      case 'javascript':
        // For TS/JS, look for common structure patterns
        if (parts.includes('src')) {
          const srcIndex = parts.indexOf('src');
          return parts[srcIndex + 1] || 'src';
        }
        return parts[parts.length - 2] || 'root';
      case 'python':
        // For Python, use directory structure
        return parts[parts.length - 2] || 'main';
      default:
        return 'unknown';
    }
  }

  /**
   * Build adjacency list from edges
   */
  protected buildAdjacencyList(edges: DependencyEdge[]): Map<string, string[]> {
    const adjList = new Map<string, string[]>();

    for (const edge of edges) {
      if (!adjList.has(edge.from)) {
        adjList.set(edge.from, []);
      }
      adjList.get(edge.from)!.push(edge.to);
    }

    return adjList;
  }

  /**
   * Build adjacency list from references
   */
  protected buildAdjacencyListFromReferences(references: CrossReference[]): Map<string, string[]> {
    const adjList = new Map<string, string[]>();

    for (const ref of references) {
      if (!adjList.has(ref.sourceId)) {
        adjList.set(ref.sourceId, []);
      }
      adjList.get(ref.sourceId)!.push(ref.targetId);
    }

    return adjList;
  }

  /**
   * Calculate maximum depth from a node.
   *
   * Bounded longest-path estimate: capped at `maxDepth` and memoized across the
   * whole metrics computation via the shared `depthCache`, so a corpus with many
   * entities sharing one dependency subtree is O(V+E) rather than re-exploring
   * the subtree once per source node. The result feeds only the cosmetic
   * health-score `maxDepth > 15` penalty, so a capped estimate is sufficient.
   */
  protected calculateMaxDepth(
    nodeId: string,
    adjList: Map<string, string[]>,
    depthCache: Map<string, number>,
  ): number {
    const cap = this.options.maxDepth ?? 10;
    const onStack = new Set<string>();

    const dfs = (id: string, depth: number): number => {
      if (depth >= cap) return depth;
      const cached = depthCache.get(id);
      if (cached !== undefined) return cached;
      if (onStack.has(id)) return depth; // back-edge — do not recurse into a cycle
      onStack.add(id);
      const neighbors = adjList.get(id) || [];
      let maxChild = depth;
      for (const neighbor of neighbors) {
        maxChild = Math.max(maxChild, dfs(neighbor, depth + 1));
        if (maxChild >= cap) break;
      }
      onStack.delete(id);
      depthCache.set(id, maxChild);
      return maxChild;
    };

    return dfs(nodeId, 0);
  }

  /**
   * Count strongly connected components using Tarjan's algorithm.
   *
   * The previous implementation returned `Math.ceil(nodes.length / 10)` — a
   * fabricated number with no relationship to the graph. That value surfaced in
   * `graph.metrics.stronglyConnectedComponents` as if it were measured. This
   * runs Tarjan over the same adjacency list `detectCycles` uses so the count
   * is real: singleton nodes are their own component, and each cycle of k nodes
   * is one component.
   */
  protected countStronglyConnectedComponents(nodes: DependencyNode[], edges: DependencyEdge[]): number {
    const adjList = this.buildAdjacencyList(edges);
    const index = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let nextIndex = 0;
    let sccCount = 0;

    const strongConnect = (v: string): void => {
      index.set(v, nextIndex);
      lowLink.set(v, nextIndex);
      nextIndex++;
      stack.push(v);
      onStack.add(v);

      for (const w of adjList.get(v) ?? []) {
        if (!index.has(w)) {
          strongConnect(w);
          lowLink.set(v, Math.min(lowLink.get(v)!, lowLink.get(w)!));
        } else if (onStack.has(w)) {
          lowLink.set(v, Math.min(lowLink.get(v)!, index.get(w)!));
        }
      }

      if (lowLink.get(v) === index.get(v)) {
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
        } while (w !== v);
        sccCount++;
      }
    };

    for (const node of nodes) {
      if (!index.has(node.id)) strongConnect(node.id);
    }

    return sccCount;
  }

  /**
   * Find tightly coupled clusters.
   *
   * Tight coupling is a property of a *pair* of modules, not of one module: two
   * packages are tightly coupled when their mutual edges dominate the edges that
   * stay inside either package — the pair is more entangled with each other than
   * with itself, so neither can change without the other. The prior metric
   * measured a single cluster's *cohesion* (`internalEdges / incidentEdges`) and
   * reported it as coupling, which inverted the concept — a package whose nodes
   * mostly call each other is cohesive (good design), not coupled — and flagged
   * every well-factored package. See `specs/spec70-worklist.md` §4.
   *
   * Coupling here is `cross / (cross + within)` for each unordered pair of
   * distinct clusters, where `cross` = aToB + bToA (edges spanning the
   * boundary) and `within` = edges that stay inside either cluster. A pair is
   * flagged only when edges flow in *both* directions (a one-directional
   * fan-in — three functions in A calling a shared utility in B — is a
   * dependency, not coupling), the pair has at least three cross edges, and
   * the ratio exceeds the coupling threshold.
   */
  protected findTightlyCoupledClusters(graph: DependencyGraph): TightlyCoupledCluster[] {
    const clusters = new Map<string, string[]>();

    // Group nodes by cluster
    for (const node of graph.nodes) {
      const cluster = node.cluster || 'default';
      const ids = clusters.get(cluster);
      if (ids) ids.push(node.id);
      else clusters.set(cluster, [node.id]);
    }

    const clusterOf = new Map<string, string>();
    for (const [cluster, ids] of clusters) {
      for (const id of ids) clusterOf.set(id, cluster);
    }

    // Single pass over edges: bucket each as internal (both endpoints in one
    // cluster) or cross-cluster, split by direction. The coupling ratio is then
    // per-pair, and the scan is O(V + E + P), not O(P · E) for P cluster pairs.
    const withinByCluster = new Map<string, number>();
    const crossEdges = new Map<string, Map<string, { aToB: number; bToA: number }>>();
    const pair = (lo: string, hi: string): { aToB: number; bToA: number } => {
      let inner = crossEdges.get(lo);
      if (!inner) { inner = new Map(); crossEdges.set(lo, inner); }
      let counts = inner.get(hi);
      if (!counts) { counts = { aToB: 0, bToA: 0 }; inner.set(hi, counts); }
      return counts;
    };

    for (const edge of graph.edges) {
      const a = clusterOf.get(edge.from);
      const b = clusterOf.get(edge.to);
      if (a === undefined || b === undefined) continue; // endpoint outside the node set
      if (a === b) {
        withinByCluster.set(a, (withinByCluster.get(a) ?? 0) + 1);
      } else {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const counts = pair(lo, hi);
        if (a < b) counts.aToB++;
        else counts.bToA++;
      }
    }

    const tightlyCoupled: TightlyCoupledCluster[] = [];
    for (const [a, inner] of crossEdges) {
      for (const [b, counts] of inner) {
        if (counts.aToB === 0 || counts.bToA === 0) continue; // one-directional dependency, not coupling
        const cross = counts.aToB + counts.bToA;
        if (cross < 3) continue; // a lone edge is a dependency, not tight coupling
        const aIds = clusters.get(a)!;
        const bIds = clusters.get(b)!;
        if (aIds.length + bIds.length < 3) continue; // coupling over a tiny pair is meaningless
        const within = (withinByCluster.get(a) ?? 0) + (withinByCluster.get(b) ?? 0);
        const coupling = cross / (cross + within);
        if (coupling > 0.7) {
          tightlyCoupled.push({ nodes: [...aIds, ...bIds], coupling, clusters: [a, b] });
        }
      }
    }

    return tightlyCoupled;
  }

  /**
   * Find orphaned nodes with no dependencies.
   *
   * A node is only genuinely orphaned when all three hold: it has no edges in
   * the graph, it is not exported (an exported entity is an entry point called
   * from outside the graph — a different fact than "nothing calls it"), and
   * nothing in the corpus calls anything by its name. The last guard matters
   * because the reference resolver drops ambiguous edges: a bare call name that
   * collides with many entities is treated as "unknown", not "absent", so the
   * dropped edge must not become evidence that the target is unreferenced.
   */
  protected findOrphanedNodes(graph: DependencyGraph, index: ReferenceIndex): DependencyNode[] {
    const connectedNodes = new Set<string>();

    for (const edge of graph.edges) {
      connectedNodes.add(edge.from);
      connectedNodes.add(edge.to);
    }

    return graph.nodes.filter(node => {
      // Type declarations (interfaces, structs) are never call targets — they
      // are referenced via implements/extends/type-annotations, which the call
      // graph does not model. "No call edges" is therefore not evidence of dead
      // code for them; flagging them orphaned produced a flood of 1081
      // interfaces on a corpus whose actual signal was ~139 functions.
      if (node.type === 'interface' || node.type === 'struct') return false;
      // `_`-prefixed declarations are unused by convention — compile-time check
      // seeds (seeded-defects.ts's `_notSerializable`) or unused markers. An
      // orphaned-node finding means "dead code to delete", which does not apply
      // to a name the author already marked as intentionally unused.
      if (node.name.startsWith('_')) return false;
      // Methods are invoked via `this.` / receiver / prototype dispatch, which a
      // name-only call graph cannot model. Class-prefixed names (`Client.formatter`,
      // Go `Foo.Bar`) never resolve — the reference resolver matches a bare callee
      // (`formatter`) against the full entity name. Object-literal methods
      // (`{ renameColumn() {} }` merged onto a prototype) carry a bare name and so
      // evade the `.` guard, but are dispatched the same way; `isMethod` covers
      // both. "No call edges" is therefore not evidence of dead code for a method —
      // treating it as such produced 857 false orphans on knex alone (97% of 885).
      if (node.isMethod || node.name.includes('.')) return false;
      if (connectedNodes.has(node.id)) return false;
      if (node.exported) return false;
      if (isNameReferenced(node.name, node.file, index)) return false;
      return true;
    });
  }

  /**
   * Calculate overall health score
   */
  protected calculateHealthScore(graph: DependencyGraph, issues: DependencyIssue[]): number {
    let score = 100;

    for (const issue of issues) {
      switch (issue.severity) {
        case 'critical':
          score -= 20;
          break;
        case 'severe':
          score -= 10;
          break;
        case 'high':
          score -= 5;
          break;
      }
    }

    // Additional penalties
    if (graph.cycles.length > 0) {
      score -= graph.cycles.length * 5;
    }

    if (graph.metrics.maxDepth > 15) {
      score -= 10;
    }

    return Math.max(0, score);
  }

  /**
   * Generate suggestion for breaking cycles
   */
  protected generateCycleSuggestion(cycleNodes: string[]): string {
    if (cycleNodes.length === 2) {
      return 'Consider using dependency injection or extracting a common interface';
    } else if (cycleNodes.length <= 5) {
      return 'Consider introducing a mediator pattern or event-driven architecture';
    } else {
      return 'This is a complex cycle - consider major refactoring to break it down into smaller modules';
    }
  }

  /**
   * Check if a file is a test file
   */
  protected isTestFile(filePath: string): boolean {
    return filePath.includes('test') ||
           filePath.includes('spec') ||
           filePath.includes('__tests__') ||
           filePath.endsWith('.test.ts') ||
           filePath.endsWith('.test.js') ||
           filePath.endsWith('.spec.ts') ||
           filePath.endsWith('.spec.js') ||
           filePath.endsWith('_test.go');
  }
}

// ---------------------------------------------------------------------------
// Traversal: node/edge construction and graph traversal (mid layer)
// ---------------------------------------------------------------------------

class DependencyGraphBuilderTraversal extends DependencyGraphBuilderCore {
  /**
   * Filter entities based on options
   */
  protected filterEntities(entities: CrossLanguageEntity[]): CrossLanguageEntity[] {
    let filtered = entities;

    // Filter by language
    if (this.options.excludeLanguages?.length) {
      filtered = filtered.filter(entity =>
        !this.options.excludeLanguages!.includes(entity.language)
      );
    }

    // Filter test files
    if (!this.options.includeTestFiles) {
      filtered = filtered.filter(entity =>
        !this.isTestFile(entity.file)
      );
    }

    return filtered;
  }

  /**
   * Create graph nodes from entities
   */
  protected createNodes(entities: CrossLanguageEntity[]): DependencyNode[] {
    return entities.map(entity => ({
      id: entity.id,
      name: entity.name,
      language: entity.language,
      type: entity.type,
      file: entity.file,
      weight: this.calculateNodeWeight(entity),
      cluster: this.determineCluster(entity),
      exported: entity.visibility === 'public' || entity.metadata?.isExported === true,
      isMethod: entity.metadata?.isMethod === true
    }));
  }

  /**
   * Determine cluster for an entity
   */
  protected determineCluster(entity: CrossLanguageEntity): string {
    if (this.options.clusterByPackage) {
      return this.extractPackageFromFile(entity.file, entity.language);
    }
    return entity.language;
  }

  /**
   * Detect circular dependencies using DFS
   */
  protected detectCycles(nodes: DependencyNode[], edges: DependencyEdge[]): DependencyCycle[] {
    const cycles: DependencyCycle[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const adjList = this.buildAdjacencyList(edges);
    const fileById = new Map(nodes.map(n => [n.id, n.file] as const));

    // Shared mutable path (push/pop) + an index map for O(1) cycle-start lookup.
    // Avoids the previous `[...path]` snapshot on every recursion — that made a
    // deep graph O(E · path-length) and re-allocated a path array per edge.
    const path: string[] = [];
    const pathIndex = new Map<string, number>();

    const dfs = (nodeId: string): void => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      pathIndex.set(nodeId, path.length);
      path.push(nodeId);

      const neighbors = adjList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        // A self-edge is a function calling itself — recursion, not a module
        // cycle. The graph models function-call references, so a recursive
        // function (`dfs` calling `dfs`) would otherwise be reported as a
        // single-node "circular dependency", which mislabels the graph's
        // granularity as module-level when it is function-level.
        if (neighbor === nodeId) continue;
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = pathIndex.get(neighbor) ?? 0;
          const cycleNodes = path.slice(cycleStart);

          // A cycle whose nodes all share one file is mutual recursion, not a
          // module dependency cycle — see {@link spansMultipleFiles}. Only a
          // cycle crossing a file (module) boundary is a reportable
          // circular-dependency.
          if (!spansMultipleFiles(cycleNodes, fileById)) continue;

          cycles.push({
            nodes: cycleNodes,
            severity: 'severe',
            suggestion: this.generateCycleSuggestion(cycleNodes)
          });
        }
      }

      path.pop();
      pathIndex.delete(nodeId);
      recursionStack.delete(nodeId);
    };

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        dfs(node.id);
      }
    }

    return cycles;
  }

  /**
   * Calculate various graph metrics
   */
  protected calculateMetrics(
    nodes: DependencyNode[],
    edges: DependencyEdge[],
    cycles: DependencyCycle[]
  ): DependencyMetrics {
    const adjList = this.buildAdjacencyList(edges);

    // Shared memo so the depth from each node is computed once, not per-source.
    const depthCache = new Map<string, number>();
    const depths = nodes.map(node => this.calculateMaxDepth(node.id, adjList, depthCache));

    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      cycleCount: cycles.length,
      averageDepth: depths.reduce((sum, depth) => sum + depth, 0) / depths.length,
      maxDepth: Math.max(...depths),
      stronglyConnectedComponents: this.countStronglyConnectedComponents(nodes, edges)
    };
  }

  /**
   * Find entities reachable within specified depth
   */
  protected findReachableEntities(
    startIds: string[],
    entities: CrossLanguageEntity[],
    references: CrossReference[],
    maxDepth: number
  ): CrossLanguageEntity[] {
    const reachable = new Set(startIds);
    const adjList = this.buildAdjacencyListFromReferences(references);

    let currentLevel = new Set(startIds);

    for (let depth = 0; depth < maxDepth && currentLevel.size > 0; depth++) {
      const nextLevel = new Set<string>();

      for (const nodeId of currentLevel) {
        const neighbors = adjList.get(nodeId) || [];
        for (const neighbor of neighbors) {
          if (!reachable.has(neighbor)) {
            reachable.add(neighbor);
            nextLevel.add(neighbor);
          }
        }
      }

      currentLevel = nextLevel;
    }

    return entities.filter(entity => reachable.has(entity.id));
  }

  /**
   * Apply package-based clustering to nodes
   */
  protected applyPackageClustering(nodes: DependencyNode[]): void {
    for (const node of nodes) {
      if (!node.cluster) {
        node.cluster = this.extractPackageFromFile(node.file, node.language);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Builder: public orchestration API (top layer)
// ---------------------------------------------------------------------------

/**
 * Dependency graph builder.
 */
export class DependencyGraphBuilder extends DependencyGraphBuilderTraversal {
  /**
   * Build a comprehensive dependency graph
   * @param entities
   * @param references
   * @returns
   */
  async buildGraph(
    entities: CrossLanguageEntity[],
    references: CrossReference[]
  ): Promise<DependencyGraph> {
    this.entities = entities;
    this.references = references;

    // Filter entities based on options
    const filteredEntities = this.filterEntities(entities);

    // Create nodes
    const nodes = this.createNodes(filteredEntities);

    // Create edges from references
    const edges = this.createEdges(references, nodes);

    // Detect cycles
    const cycles = this.detectCycles(nodes, edges);

    // Calculate metrics
    const metrics = this.calculateMetrics(nodes, edges, cycles);

    // Apply clustering if enabled
    if (this.options.clusterByPackage) {
      this.applyPackageClustering(nodes);
    }

    const graph: DependencyGraph = {
      nodes,
      edges,
      cycles,
      metrics
    };

    return graph;
  }

  /**
   * Build a focused subgraph around specific entities
   * @param depth
   * @param entities
   * @param references
   * @param targetEntityIds
   * @returns
   */
  async buildSubgraph(
    targetEntityIds: string[],
    entities: CrossLanguageEntity[],
    references: CrossReference[],
    depth: number = 2
  ): Promise<DependencyGraph> {
    // Find all entities within the specified depth
    const reachableEntities = this.findReachableEntities(targetEntityIds, entities, references, depth);

    // Build graph with only reachable entities
    return this.buildGraph(reachableEntities, references.filter(ref =>
      reachableEntities.some(e => e.id === ref.sourceId) &&
      reachableEntities.some(e => e.id === ref.targetId)
    ));
  }

  /**
   * Analyze dependency health and suggest improvements
   * @param graph
   * @returns
   */
  async analyzeDependencyHealth(graph: DependencyGraph): Promise<{
    healthScore: number;
    issues: DependencyIssue[];
    suggestions: DependencySuggestion[];
  }> {
    const issues: DependencyIssue[] = [];
    const suggestions: DependencySuggestion[] = [];
    const sink = { issues, suggestions };
    const idToName = new Map(graph.nodes.map(n => [n.id, n.name] as const));

    this.recordCycleCheck(sink, graph, idToName);
    this.recordClusterCheck(sink, graph);
    this.recordOrphanCheck(sink, graph);

    return {
      healthScore: this.calculateHealthScore(graph, issues),
      issues,
      suggestions,
    };
  }

  /** Record the circular-dependency check (cycles rendered node-by-node). */
  private recordCycleCheck(sink: CheckSink, graph: DependencyGraph, idToName: Map<string, string>): void {
    this.recordCheck(sink, graph.cycles.length, graph.cycles.flatMap(c => c.nodes), {
      issueType: 'circular-dependency', severity: 'severe', impact: 'high',
      issueDesc: () =>
        graph.cycles.map(c => c.nodes.map(id => idToName.get(id) ?? id).join(' → ')).join('; '),
      suggestionType: 'break-cycles', priority: 'high',
      suggestionDesc: 'Break circular dependencies by introducing interfaces or dependency injection',
      implementation: 'Consider using dependency inversion principle to break cycles',
      details: {
        cycles: graph.cycles.map(c => ({ nodes: c.nodes, path: c.nodes.map(id => idToName.get(id) ?? id).join(' → ') })),
      },
    });
  }

  /** Record the tight-coupling check (cluster pairs rendered with their coupling %). */
  private recordClusterCheck(sink: CheckSink, graph: DependencyGraph): void {
    const clusters = this.findTightlyCoupledClusters(graph);
    this.recordCheck(sink, clusters.length, clusters.flatMap(c => c.nodes), {
      issueType: 'tight-coupling', severity: 'high', impact: 'medium',
      issueDesc: () =>
        clusters.map(c => `${c.clusters[0]} ↔ ${c.clusters[1]} (${(c.coupling * 100).toFixed(0)}%)`).join('; '),
      suggestionType: 'reduce-coupling', priority: 'medium',
      suggestionDesc: 'Reduce coupling between modules using interfaces and abstractions',
      implementation: 'Extract common interfaces and use dependency injection',
      details: {
        clusters: clusters.map(c => ({ clusters: c.clusters, coupling: c.coupling })),
      },
    });
  }

  /**
   * Build the scope-aware name-reference index for orphan detection.
   *
   * Each entity carries its file's complete reference set (`fileReferences`),
   * collected from the whole file — including anonymous functions, JSX tags and
   * bare function values — rather than just the callees of extracted bodies.
   * The index folds those into per-file and global maps so a name can be
   * resolved same-file first (then same-directory, then unique-global), instead
   * of against a flat entity table with no scope awareness.
   */
  private collectReferenceIndex(): ReferenceIndex {
    const byFile = new Map<string, Set<string>>();
    const globalFiles = new Map<string, Set<string>>();
    for (const e of this.entities) {
      // `fileReferences` is the complete whole-file reference set; `callees` is
      // the legacy per-body subset (⊆ fileReferences when both are present), kept
      // as a fallback for entities that predate fileReferences (e.g. unit fixtures).
      const refs =
        (e.metadata?.fileReferences as string[] | undefined) ??
        (e.metadata?.callees as string[] | undefined) ??
        [];
      if (refs.length === 0) continue;
      let fileSet = byFile.get(e.file);
      if (!fileSet) {
        fileSet = new Set<string>();
        byFile.set(e.file, fileSet);
      }
      for (const ref of refs) {
        const lower = (ref.split('.').pop() ?? ref).toLowerCase();
        fileSet.add(lower);
        let files = globalFiles.get(lower);
        if (!files) {
          files = new Set<string>();
          globalFiles.set(lower, files);
        }
        files.add(e.file);
      }
    }
    return { byFile, globalFiles };
  }

  /** Record the orphaned-node check. */
  private recordOrphanCheck(sink: CheckSink, graph: DependencyGraph): void {
    const orphanedNodes = this.findOrphanedNodes(graph, this.collectReferenceIndex());
    this.recordCheck(sink, orphanedNodes.length, orphanedNodes.map(n => n.id), {
      issueType: 'orphaned-nodes', severity: 'severe', impact: 'low',
      issueDesc: () => orphanedNodes.map(n => n.name).join(', '),
      suggestionType: 'review-orphans', priority: 'low',
      suggestionDesc: 'Review orphaned nodes to ensure they are still needed',
      implementation: 'Consider removing unused code or integrating orphaned modules',
      details: {
        orphans: orphanedNodes.map(n => ({ id: n.id, name: n.name })),
      },
    });
  }

  /** Push an issue+suggestion pair when `count` is non-zero. */
  private recordCheck(
    sink: CheckSink,
    count: number,
    affectedNodes: string[],
    spec: CheckSpec,
  ): void {
    if (count === 0) return;
    sink.issues.push({
      type: spec.issueType, severity: spec.severity, impact: spec.impact,
      description: spec.issueDesc(count), affectedNodes,
      details: spec.details,
    });
    sink.suggestions.push({
      type: spec.suggestionType, priority: spec.priority,
      description: spec.suggestionDesc, implementation: spec.implementation,
      affectedNodes,
    });
  }
}

// Supporting interfaces

/**
 * Whether a detected cycle crosses a file (module) boundary.
 *
 * The graph models function-call references, so a cycle whose nodes all live in
 * one file is mutual recursion — a validator's `validateAgainstSchema` ⇄
 * `checkArrayConstraints`, a parser's `evaluate` ⇄ `evalObject` — normal
 * recursive-descent structure, not a module dependency cycle. `circular-dependency`
 * is a module-level concept (file A imports file B imports file A); a same-file
 * call cycle never crosses a module boundary, so it must not be reported as one.
 * This is the N-node generalization of the self-edge skip in {@link detectCycles}
 * (a self-edge is the 1-node case of the same phenomenon).
 */
function spansMultipleFiles(cycleNodes: string[], fileById: Map<string, string>): boolean {
  return new Set(cycleNodes.map(id => fileById.get(id))).size > 1;
}

/**
 * Scope-aware name resolution for orphan detection, mirroring the reference
 * resolver's order: same file → same directory → unique global. A node is
 * "referenced" (and therefore not orphaned) when its bare name appears in any
 * of those scopes; the same-file case is what makes "defined and called in one
 * file" an impossibility to orphan.
 */
function isNameReferenced(name: string, file: string, index: ReferenceIndex): boolean {
  const lower = name.toLowerCase();
  if (index.byFile.get(file)?.has(lower)) return true;
  const dir = file.split('/').slice(0, -1).join('/');
  for (const [otherFile, names] of index.byFile) {
    if (otherFile === file) continue;
    if (otherFile.split('/').slice(0, -1).join('/') === dir && names.has(lower)) return true;
  }
  return (index.globalFiles.get(lower)?.size ?? 0) === 1;
}

/** Per-file and global name-reference maps used by {@link isNameReferenced}. */
interface ReferenceIndex {
  byFile: Map<string, Set<string>>;
  globalFiles: Map<string, Set<string>>;
}

/** A tightly-coupled cluster pair: the two cluster keys, their union of nodes, and the coupling ratio. */
interface TightlyCoupledCluster {
  nodes: string[];
  coupling: number;
  /** The two cluster (package) keys whose shared boundary the coupling measures. */
  clusters: [string, string];
}

export interface DependencyIssue {
  type: 'circular-dependency' | 'tight-coupling' | 'orphaned-nodes';
  severity: 'critical' | 'severe' | 'high';
  description: string;
  affectedNodes: string[];
  impact: 'high' | 'medium' | 'low';
  /** Structured resolution data (cycle paths, cluster coupling, orphan names). */
  details?: Record<string, unknown>;
}

export interface DependencySuggestion {
  type: 'break-cycles' | 'reduce-coupling' | 'review-orphans';
  priority: 'high' | 'medium' | 'low';
  description: string;
  implementation: string;
  /** Node ids this suggestion applies to, for downstream resolution. */
  affectedNodes?: string[];
}

/** The issue+suggestion sinks a {@link DependencyGraphBuilder.recordCheck} call writes into. */
interface CheckSink {
  issues: DependencyIssue[];
  suggestions: DependencySuggestion[];
}

/** Descriptor for how a non-zero check result should be phrased as issue+suggestion. */
interface CheckSpec {
  issueType: DependencyIssue['type'];
  severity: DependencyIssue['severity'];
  impact: DependencyIssue['impact'];
  issueDesc: (n: number) => string;
  suggestionType: DependencySuggestion['type'];
  priority: DependencySuggestion['priority'];
  suggestionDesc: string;
  implementation: string;
  /** Structured resolution data attached to the issue (cycle paths, cluster coupling, …). */
  details?: Record<string, unknown>;
}
