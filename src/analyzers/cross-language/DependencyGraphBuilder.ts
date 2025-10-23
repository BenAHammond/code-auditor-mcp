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

export class DependencyGraphBuilder {
  private entities: CrossLanguageEntity[] = [];
  private references: CrossReference[] = [];
  private options: GraphBuilderOptions;

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
   * Build a comprehensive dependency graph
   */
  async buildGraph(
    entities: CrossLanguageEntity[], 
    references: CrossReference[]
  ): Promise<DependencyGraph> {
    this.entities = entities;
    this.references = references;

    console.log(`[DependencyGraphBuilder] Building graph from ${entities.length} entities and ${references.length} references`);

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

    console.log(`[DependencyGraphBuilder] Generated graph with ${nodes.length} nodes, ${edges.length} edges, ${cycles.length} cycles`);
    return graph;
  }

  /**
   * Build a focused subgraph around specific entities
   */
  async buildSubgraph(
    targetEntityIds: string[],
    entities: CrossLanguageEntity[],
    references: CrossReference[],
    depth: number = 2
  ): Promise<DependencyGraph> {
    console.log(`[DependencyGraphBuilder] Building subgraph for ${targetEntityIds.length} target entities with depth ${depth}`);
    
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
   */
  async analyzeDependencyHealth(graph: DependencyGraph): Promise<{
    healthScore: number;
    issues: DependencyIssue[];
    suggestions: DependencySuggestion[];
  }> {
    const issues: DependencyIssue[] = [];
    const suggestions: DependencySuggestion[] = [];

    // Check for circular dependencies
    if (graph.cycles.length > 0) {
      issues.push({
        type: 'circular-dependency',
        severity: 'critical',
        description: `Found ${graph.cycles.length} circular dependencies`,
        affectedNodes: graph.cycles.flatMap(cycle => cycle.nodes),
        impact: 'high'
      });

      suggestions.push({
        type: 'break-cycles',
        priority: 'high',
        description: 'Break circular dependencies by introducing interfaces or dependency injection',
        implementation: 'Consider using dependency inversion principle to break cycles'
      });
    }

    // Check for tightly coupled clusters
    const tightlyCoupledClusters = this.findTightlyCoupledClusters(graph);
    if (tightlyCoupledClusters.length > 0) {
      issues.push({
        type: 'tight-coupling',
        severity: 'warning',
        description: `Found ${tightlyCoupledClusters.length} tightly coupled clusters`,
        affectedNodes: tightlyCoupledClusters.flatMap(cluster => cluster.nodes),
        impact: 'medium'
      });

      suggestions.push({
        type: 'reduce-coupling',
        priority: 'medium',
        description: 'Reduce coupling between modules using interfaces and abstractions',
        implementation: 'Extract common interfaces and use dependency injection'
      });
    }

    // Check for hub nodes (too many dependencies)
    const hubNodes = this.findHubNodes(graph);
    if (hubNodes.length > 0) {
      issues.push({
        type: 'hub-nodes',
        severity: 'warning',
        description: `Found ${hubNodes.length} hub nodes with excessive dependencies`,
        affectedNodes: hubNodes.map(node => node.id),
        impact: 'medium'
      });

      suggestions.push({
        type: 'split-responsibilities',
        priority: 'medium',
        description: 'Split large modules to reduce their dependency burden',
        implementation: 'Apply Single Responsibility Principle to break down large modules'
      });
    }

    // Check for orphaned nodes
    const orphanedNodes = this.findOrphanedNodes(graph);
    if (orphanedNodes.length > 0) {
      issues.push({
        type: 'orphaned-nodes',
        severity: 'suggestion',
        description: `Found ${orphanedNodes.length} orphaned nodes with no dependencies`,
        affectedNodes: orphanedNodes.map(node => node.id),
        impact: 'low'
      });

      suggestions.push({
        type: 'review-orphans',
        priority: 'low',
        description: 'Review orphaned nodes to ensure they are still needed',
        implementation: 'Consider removing unused code or integrating orphaned modules'
      });
    }

    // Calculate health score
    const healthScore = this.calculateHealthScore(graph, issues);

    return {
      healthScore,
      issues,
      suggestions
    };
  }

  /**
   * Filter entities based on options
   */
  private filterEntities(entities: CrossLanguageEntity[]): CrossLanguageEntity[] {
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
  private createNodes(entities: CrossLanguageEntity[]): DependencyNode[] {
    return entities.map(entity => ({
      id: entity.id,
      name: entity.name,
      language: entity.language,
      type: entity.type,
      file: entity.file,
      weight: this.calculateNodeWeight(entity),
      cluster: this.determineCluster(entity)
    }));
  }

  /**
   * Create graph edges from references
   */
  private createEdges(references: CrossReference[], nodes: DependencyNode[]): DependencyEdge[] {
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
   * Detect circular dependencies using DFS
   */
  private detectCycles(nodes: DependencyNode[], edges: DependencyEdge[]): DependencyCycle[] {
    const cycles: DependencyCycle[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const adjList = this.buildAdjacencyList(edges);

    const dfs = (nodeId: string, path: string[]): void => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const neighbors = adjList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, [...path]);
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = path.indexOf(neighbor);
          const cycleNodes = path.slice(cycleStart);
          
          cycles.push({
            nodes: cycleNodes,
            severity: cycleNodes.length > 5 ? 'critical' : 'warning',
            suggestion: this.generateCycleSuggestion(cycleNodes)
          });
        }
      }

      recursionStack.delete(nodeId);
    };

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        dfs(node.id, []);
      }
    }

    return cycles;
  }

  /**
   * Calculate various graph metrics
   */
  private calculateMetrics(
    nodes: DependencyNode[], 
    edges: DependencyEdge[], 
    cycles: DependencyCycle[]
  ): DependencyMetrics {
    const adjList = this.buildAdjacencyList(edges);
    
    // Calculate depths from each node
    const depths = nodes.map(node => this.calculateMaxDepth(node.id, adjList));
    
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
  private findReachableEntities(
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
  private applyPackageClustering(nodes: DependencyNode[]): void {
    for (const node of nodes) {
      if (!node.cluster) {
        node.cluster = this.extractPackageFromFile(node.file, node.language);
      }
    }
  }

  /**
   * Calculate node weight based on various factors
   */
  private calculateNodeWeight(entity: CrossLanguageEntity): number {
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
   * Determine cluster for an entity
   */
  private determineCluster(entity: CrossLanguageEntity): string {
    if (this.options.clusterByPackage) {
      return this.extractPackageFromFile(entity.file, entity.language);
    }
    return entity.language;
  }

  /**
   * Extract package/module name from file path
   */
  private extractPackageFromFile(filePath: string, language: string): string {
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
  private buildAdjacencyList(edges: DependencyEdge[]): Map<string, string[]> {
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
  private buildAdjacencyListFromReferences(references: CrossReference[]): Map<string, string[]> {
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
   * Calculate maximum depth from a node
   */
  private calculateMaxDepth(nodeId: string, adjList: Map<string, string[]>): number {
    const visited = new Set<string>();
    
    const dfs = (currentId: string): number => {
      if (visited.has(currentId)) return 0; // Avoid cycles
      
      visited.add(currentId);
      const neighbors = adjList.get(currentId) || [];
      
      if (neighbors.length === 0) return 1;
      
      const maxChildDepth = Math.max(...neighbors.map(neighbor => dfs(neighbor)));
      visited.delete(currentId);
      
      return 1 + maxChildDepth;
    };
    
    return dfs(nodeId);
  }

  /**
   * Count strongly connected components (simplified)
   */
  private countStronglyConnectedComponents(nodes: DependencyNode[], edges: DependencyEdge[]): number {
    // Simplified implementation - would use Tarjan's algorithm in practice
    return Math.ceil(nodes.length / 10); // Rough estimate
  }

  /**
   * Find tightly coupled clusters
   */
  private findTightlyCoupledClusters(graph: DependencyGraph): { nodes: string[]; coupling: number }[] {
    const clusters = new Map<string, string[]>();
    
    // Group nodes by cluster
    for (const node of graph.nodes) {
      const cluster = node.cluster || 'default';
      if (!clusters.has(cluster)) {
        clusters.set(cluster, []);
      }
      clusters.get(cluster)!.push(node.id);
    }
    
    const tightlyCoupled: { nodes: string[]; coupling: number }[] = [];
    
    for (const [clusterName, nodeIds] of clusters) {
      const internalEdges = graph.edges.filter(edge => 
        nodeIds.includes(edge.from) && nodeIds.includes(edge.to)
      );
      
      const coupling = internalEdges.length / (nodeIds.length * (nodeIds.length - 1));
      
      if (coupling > 0.7) { // High coupling threshold
        tightlyCoupled.push({ nodes: nodeIds, coupling });
      }
    }
    
    return tightlyCoupled;
  }

  /**
   * Find hub nodes with too many dependencies
   */
  private findHubNodes(graph: DependencyGraph): DependencyNode[] {
    const dependencyCounts = new Map<string, number>();
    
    for (const edge of graph.edges) {
      dependencyCounts.set(edge.from, (dependencyCounts.get(edge.from) || 0) + 1);
    }
    
    const threshold = Math.max(5, graph.nodes.length * 0.1); // 10% of nodes or minimum 5
    
    return graph.nodes.filter(node => 
      (dependencyCounts.get(node.id) || 0) > threshold
    );
  }

  /**
   * Find orphaned nodes with no dependencies
   */
  private findOrphanedNodes(graph: DependencyGraph): DependencyNode[] {
    const connectedNodes = new Set<string>();
    
    for (const edge of graph.edges) {
      connectedNodes.add(edge.from);
      connectedNodes.add(edge.to);
    }
    
    return graph.nodes.filter(node => !connectedNodes.has(node.id));
  }

  /**
   * Calculate overall health score
   */
  private calculateHealthScore(graph: DependencyGraph, issues: DependencyIssue[]): number {
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
  private generateCycleSuggestion(cycleNodes: string[]): string {
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
  private isTestFile(filePath: string): boolean {
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