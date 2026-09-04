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
   * Find tightly coupled clusters
   */
  protected findTightlyCoupledClusters(graph: DependencyGraph): { nodes: string[]; coupling: number }[] {
    const clusters = new Map<string, string[]>();

    // Group nodes by cluster
    for (const node of graph.nodes) {
      const cluster = node.cluster || 'default';
      const ids = clusters.get(cluster);
      if (ids) ids.push(node.id);
      else clusters.set(cluster, [node.id]);
    }

    const tightlyCoupled: { nodes: string[]; coupling: number }[] = [];

    for (const nodeIds of clusters.values()) {
      if (nodeIds.length < 3) continue; // coupling over a tiny cluster is meaningless
      const member = new Set(nodeIds);

      // Cohesion: the fraction of a cluster's incident edges that stay internal.
      // A raw internal-density threshold (internalEdges / N×(N−1) > 0.7) is
      // unreachable for any real sparse graph — it would require ~70% of all
      // possible edges to exist — so tight-coupling never fired. Cohesion
      // instead flags clusters whose nodes mostly talk to each other, which is
      // what "tightly coupled" actually means.
      let internalEdges = 0;
      let incidentEdges = 0;
      for (const edge of graph.edges) {
        const fromIn = member.has(edge.from);
        const toIn = member.has(edge.to);
        if (fromIn && toIn) {
          internalEdges++;
          incidentEdges++;
        } else if (fromIn || toIn) {
          incidentEdges++;
        }
      }

      if (incidentEdges === 0) continue;
      const coupling = internalEdges / incidentEdges;
      if (coupling > 0.7) {
        tightlyCoupled.push({ nodes: nodeIds, coupling });
      }
    }

    return tightlyCoupled;
  }

  /**
   * Find hub nodes with too many dependencies
   */
  protected findHubNodes(graph: DependencyGraph): DependencyNode[] {
    const outDegree = new Map<string, number>();

    for (const edge of graph.edges) {
      outDegree.set(edge.from, (outDegree.get(edge.from) || 0) + 1);
    }

    // Derive the hub threshold from the actual out-degree distribution rather
    // than a fixed fraction of corpus size. The old `max(5, N×0.1)` required
    // >830 outgoing edges on an ~8306-node corpus — effectively unreachable, so
    // hub-nodes could never fire (and when it did, only via name collisions).
    // A hub is an outlier: out-degree above a small multiple of the mean.
    const degrees = [...outDegree.values()];
    const mean = degrees.length
      ? degrees.reduce((sum, d) => sum + d, 0) / degrees.length
      : 0;
    const threshold = Math.max(10, Math.ceil(mean * 3));

    return graph.nodes.filter(node =>
      (outDegree.get(node.id) || 0) > threshold
    );
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
  protected findOrphanedNodes(graph: DependencyGraph, referencedNames: Set<string>): DependencyNode[] {
    const connectedNodes = new Set<string>();

    for (const edge of graph.edges) {
      connectedNodes.add(edge.from);
      connectedNodes.add(edge.to);
    }

    return graph.nodes.filter(node => {
      if (connectedNodes.has(node.id)) return false;
      if (node.exported) return false;
      if (referencedNames.has(node.name.toLowerCase())) return false;
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
        case 'warning':
          score -= 10;
          break;
        case 'suggestion':
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
      exported: entity.visibility === 'public' || entity.metadata?.isExported === true
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
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = pathIndex.get(neighbor) ?? 0;
          const cycleNodes = path.slice(cycleStart);

          cycles.push({
            nodes: cycleNodes,
            severity: 'warning',
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

    this.recordCheck({ issues, suggestions }, graph.cycles.length, graph.cycles.flatMap(c => c.nodes), {
      issueType: 'circular-dependency', severity: 'warning', impact: 'high',
      issueDesc: n => `Found ${n} circular dependencies`,
      suggestionType: 'break-cycles', priority: 'high',
      suggestionDesc: 'Break circular dependencies by introducing interfaces or dependency injection',
      implementation: 'Consider using dependency inversion principle to break cycles',
    });

    const clusters = this.findTightlyCoupledClusters(graph);
    this.recordCheck({ issues, suggestions }, clusters.length, clusters.flatMap(c => c.nodes), {
      issueType: 'tight-coupling', severity: 'warning', impact: 'medium',
      issueDesc: n => `Found ${n} tightly coupled clusters`,
      suggestionType: 'reduce-coupling', priority: 'medium',
      suggestionDesc: 'Reduce coupling between modules using interfaces and abstractions',
      implementation: 'Extract common interfaces and use dependency injection',
    });

    const hubNodes = this.findHubNodes(graph);
    this.recordCheck({ issues, suggestions }, hubNodes.length, hubNodes.map(n => n.id), {
      issueType: 'hub-nodes', severity: 'warning', impact: 'medium',
      issueDesc: n => `Found ${n} hub nodes with excessive dependencies`,
      suggestionType: 'split-responsibilities', priority: 'medium',
      suggestionDesc: 'Split large modules to reduce their dependency burden',
      implementation: 'Apply Single Responsibility Principle to break down large modules',
    });

    // Bare names referenced as callees anywhere in the corpus (resolved or
    // not). Used by orphan detection to distinguish "no one calls this" from
    // "the resolver couldn't disambiguate a call to this name".
    const referencedNames = new Set<string>();
    for (const e of this.entities) {
      for (const callee of (e.metadata?.callees as string[] | undefined) ?? []) {
        referencedNames.add((callee.split('.').pop() ?? callee).toLowerCase());
      }
    }

    const orphanedNodes = this.findOrphanedNodes(graph, referencedNames);
    this.recordCheck({ issues, suggestions }, orphanedNodes.length, orphanedNodes.map(n => n.id), {
      issueType: 'orphaned-nodes', severity: 'suggestion', impact: 'low',
      issueDesc: n => `Found ${n} orphaned nodes with no dependencies`,
      suggestionType: 'review-orphans', priority: 'low',
      suggestionDesc: 'Review orphaned nodes to ensure they are still needed',
      implementation: 'Consider removing unused code or integrating orphaned modules',
    });

    return {
      healthScore: this.calculateHealthScore(graph, issues),
      issues,
      suggestions,
    };
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
    });
    sink.suggestions.push({
      type: spec.suggestionType, priority: spec.priority,
      description: spec.suggestionDesc, implementation: spec.implementation,
    });
  }
}

// Supporting interfaces

export interface DependencyIssue {
  type: 'circular-dependency' | 'tight-coupling' | 'hub-nodes' | 'orphaned-nodes';
  severity: 'critical' | 'warning' | 'suggestion';
  description: string;
  affectedNodes: string[];
  impact: 'high' | 'medium' | 'low';
}

export interface DependencySuggestion {
  type: 'break-cycles' | 'reduce-coupling' | 'split-responsibilities' | 'review-orphans';
  priority: 'high' | 'medium' | 'low';
  description: string;
  implementation: string;
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
}
