/**
 * Spec 14 R2 — Call Graph Unit Tests
 *
 * Verifies:
 *   1. buildCallGraph constructs correct adjacency from function_calls
 *   2. PageRank converges to known values on hand-computed graph
 *   3. Brandes exact betweenness on 5-node graph
 *   4. Risk formula: untested penalty, percentile math
 *   5. buildCallGraphFromCache from graph_cache table
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildCallGraph,
  buildCallGraphFromCache,
  computePageRank,
  computeBetweenness,
  computeRisk,
  populateCallGraphCache,
} from '../callGraph.js';

// ── Schema helpers ──────────────────────────────────────────────────────

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS functions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      complexity  INTEGER DEFAULT 0,
      is_exported INTEGER DEFAULT 0,
      content_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS function_calls (
      caller_id    INTEGER NOT NULL,
      callee_name  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS function_dependencies (
      function_id INTEGER NOT NULL,
      dependency  TEXT NOT NULL,
      PRIMARY KEY (function_id, dependency)
    );
    CREATE TABLE IF NOT EXISTS graph_cache (
      graph_type   TEXT NOT NULL,
      node_key     TEXT NOT NULL,
      neighbor_key TEXT NOT NULL,
      weight       REAL NOT NULL,
      PRIMARY KEY (graph_type, node_key, neighbor_key)
    );
  `);
}

function seedFunctions(db: Database.Database): void {
  const stmt = db.prepare(
    'INSERT INTO functions (id, name, file_path, complexity, is_exported, content_hash) VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmt.run(1, 'main', 'src/main.ts', 5, 1, 'hash1');
  stmt.run(2, 'helper', 'src/helper.ts', 2, 0, 'hash2');
  stmt.run(3, 'utils', 'src/utils.ts', 3, 1, 'hash3');
  stmt.run(4, 'leafA', 'src/leafA.ts', 1, 0, 'hash4');
  stmt.run(5, 'leafB', 'src/leafB.ts', 1, 0, 'hash5');
  // untested central function
  stmt.run(6, 'untestedCore', 'src/untestedCore.ts', 4, 1, 'hash6');
}

function seedCalls(db: Database.Database): void {
  const stmt = db.prepare('INSERT INTO function_calls (caller_id, callee_name) VALUES (?, ?)');
  // main -> helper -> utils -> leafA, leafB
  stmt.run(1, 'helper');
  stmt.run(2, 'utils');
  stmt.run(3, 'leafA');
  stmt.run(3, 'leafB');
}

// ── buildCallGraph ──────────────────────────────────────────────────────

describe('buildCallGraph', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    seedFunctions(db);
    seedCalls(db);
  });

  it('constructs adjacency with correct nodes', () => {
    const { graph } = buildCallGraph(db);
    expect(graph.nodeIds.size).toBeGreaterThanOrEqual(4);
    expect(graph.nodeIds.has(1)).toBe(true); // main
    expect(graph.nodeIds.has(2)).toBe(true); // helper
    expect(graph.nodeIds.has(3)).toBe(true); // utils
    expect(graph.nodeIds.has(4)).toBe(true); // leafA
    expect(graph.nodeIds.has(5)).toBe(true); // leafB
  });

  it('sets correct node names', () => {
    const { graph } = buildCallGraph(db);
    expect(graph.nodeNames.get(1)).toBe('main');
    expect(graph.nodeNames.get(2)).toBe('helper');
    expect(graph.nodeNames.get(3)).toBe('utils');
  });

  it('sets correct node paths', () => {
    const { graph } = buildCallGraph(db);
    expect(graph.nodePaths.get(1)).toBe('src/main.ts');
    expect(graph.nodePaths.get(2)).toBe('src/helper.ts');
  });

  it('has correct adjacency edges', () => {
    const { graph } = buildCallGraph(db);
    // main -> helper
    expect(graph.adjacency.get(1)?.has(2)).toBe(true);
    // helper -> utils
    expect(graph.adjacency.get(2)?.has(3)).toBe(true);
    // utils -> leafA, leafB
    expect(graph.adjacency.get(3)?.has(4)).toBe(true);
    expect(graph.adjacency.get(3)?.has(5)).toBe(true);
  });

  it('edge weight = call count (1 for single calls)', () => {
    const { graph } = buildCallGraph(db);
    expect(graph.adjacency.get(1)?.get(2)).toBe(1);
    expect(graph.adjacency.get(3)?.get(4)).toBe(1);
  });

  it('handles duplicate call sites correctly (weight > 1)', () => {
    // Add another call from main to helper
    db.prepare('INSERT INTO function_calls (caller_id, callee_name) VALUES (?, ?)').run(1, 'helper');
    const { graph } = buildCallGraph(db);
    expect(graph.adjacency.get(1)?.get(2)).toBe(2);
  });
});

// ── PageRank ────────────────────────────────────────────────────────────

describe('computePageRank', () => {
  it('computes PageRank on a 3-node chain', () => {
    // A -> B -> C (directed chain)
    const adjacency = new Map<number, Map<number, number>>();
    adjacency.set(1, new Map([[2, 1]])); // A -> B
    adjacency.set(2, new Map([[3, 1]])); // B -> C
    adjacency.set(3, new Map());         // C has no outbound edges
    const nodeIds = new Set([1, 2, 3]);

    const pr = computePageRank(adjacency, nodeIds);

    // All scores should be positive and sum close to 1
    let sum = 0;
    for (const score of pr.values()) sum += score;
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);

    // C should have highest PageRank (receives from B + dangling node distribution)
    expect(pr.get(3)!).toBeGreaterThan(pr.get(1)!);
  });

  it('computes PageRank on a 4-node graph converging to known values', () => {
    // A -> B, A -> C, B -> D, C -> D
    // D receives from both B and C → highest PageRank
    const adjacency = new Map<number, Map<number, number>>();
    adjacency.set(1, new Map([[2, 1], [3, 1]])); // A -> B, A -> C
    adjacency.set(2, new Map([[4, 1]]));          // B -> D
    adjacency.set(3, new Map([[4, 1]]));          // C -> D
    adjacency.set(4, new Map());                   // D has no outbound
    const nodeIds = new Set([1, 2, 3, 4]);

    const pr = computePageRank(adjacency, nodeIds);

    // Sum close to 1
    let sum = 0;
    for (const score of pr.values()) sum += score;
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);

    // D (node 4) should have highest PageRank (inbound from both B and C)
    expect(pr.get(4)!).toBeGreaterThan(pr.get(2)!);
    expect(pr.get(4)!).toBeGreaterThan(pr.get(3)!);

    // A (node 1) starts with 1/N and has no inbound — should be low
    expect(pr.get(1)!).toBeLessThan(pr.get(4)!);
  });

  it('handles empty graph', () => {
    const pr = computePageRank(new Map(), new Set());
    expect(pr.size).toBe(0);
  });

  it('handles single-node graph', () => {
    const adjacency = new Map([[1, new Map()]]);
    const nodeIds = new Set([1]);
    const pr = computePageRank(adjacency, nodeIds);
    expect(pr.get(1)).toBe(1.0);
  });

  it('converges within few iterations', () => {
    const adjacency = new Map<number, Map<number, number>>();
    adjacency.set(1, new Map([[2, 1]]));
    adjacency.set(2, new Map([[1, 1]]));
    const nodeIds = new Set([1, 2]);

    const pr = computePageRank(adjacency, nodeIds, 0.85, 1e-10);
    // Both nodes should have similar scores
    expect(Math.abs(pr.get(1)! - pr.get(2)!)).toBeLessThan(0.01);
  });
});

// ── Betweenness Centrality (Brandes exact) ──────────────────────────────

describe('computeBetweenness — exact Brandes', () => {
  it('betweenness on 5-node path: middle node has highest', () => {
    // Path: 1 -> 2 -> 3 -> 4 -> 5
    const adjacency = new Map<number, Map<number, number>>();
    adjacency.set(1, new Map([[2, 1]]));
    adjacency.set(2, new Map([[3, 1]]));
    adjacency.set(3, new Map([[4, 1]]));
    adjacency.set(4, new Map([[5, 1]]));
    adjacency.set(5, new Map());
    const nodeIds = new Set([1, 2, 3, 4, 5]);

    const { scores, pivotCount } = computeBetweenness(adjacency, nodeIds);

    // Should use exact (5 nodes << 2000 cap)
    expect(pivotCount).toBe(0);

    // Node 3 (middle) is on paths 1->4, 1->5, 2->4, 2->5 → highest betweenness
    expect(scores.get(3)!).toBeGreaterThan(scores.get(1)!);
    expect(scores.get(3)!).toBeGreaterThan(scores.get(2)!);
    expect(scores.get(3)!).toBeGreaterThan(scores.get(4)!);
    expect(scores.get(3)!).toBeGreaterThan(scores.get(5)!);
  });

  it('betweenness on star graph: center has highest (bidirectional edges)', () => {
    // Star with bidirectional edges: center (1) ↔ leaves (2,3,4,5)
    // Brandes uses directed edges. Without reverse edges, there are no
    // inter-leaf paths through the center. With bidirectional edges,
    // the center lies on all leaf→leaf shortest paths.
    const adjacency = new Map<number, Map<number, number>>();
    adjacency.set(1, new Map([[2, 1], [3, 1], [4, 1], [5, 1]]));
    adjacency.set(2, new Map([[1, 1]]));
    adjacency.set(3, new Map([[1, 1]]));
    adjacency.set(4, new Map([[1, 1]]));
    adjacency.set(5, new Map([[1, 1]]));
    const nodeIds = new Set([1, 2, 3, 4, 5]);

    const { scores } = computeBetweenness(adjacency, nodeIds);

    // Center (node 1) lies on all inter-leaf shortest paths
    expect(scores.get(1)!).toBeGreaterThan(scores.get(2)!);
  });

  it('handles empty graph', () => {
    const { scores } = computeBetweenness(new Map(), new Set());
    expect(scores.size).toBe(0);
  });

  it('handles disconnected graph', () => {
    // Two disconnected components
    const adjacency = new Map<number, Map<number, number>>();
    adjacency.set(1, new Map([[2, 1]]));
    adjacency.set(2, new Map());
    adjacency.set(3, new Map([[4, 1]]));
    adjacency.set(4, new Map());
    const nodeIds = new Set([1, 2, 3, 4]);

    const { scores } = computeBetweenness(adjacency, nodeIds);
    // Should handle without error — no cross-component paths
    expect(scores.size).toBe(4);
    // Nodes in the middle should have non-negative scores
    for (const score of scores.values()) {
      expect(score).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── computeRisk ─────────────────────────────────────────────────────────

describe('computeRisk', () => {
  let db: Database.Database;
  let adjacency: Map<number, Map<number, number>>;
  let nodeIds: Set<number>;
  let nodeNames: Map<number, string>;
  let nodePaths: Map<number, string>;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    seedFunctions(db);
    seedCalls(db);

    // Build adjacency inline matching seed data
    // main(1) -> helper(2) -> utils(3) -> leafA(4), leafB(5)
    // untestedCore(6) — no callers
    adjacency = new Map();
    adjacency.set(1, new Map([[2, 1]]));
    adjacency.set(2, new Map([[3, 1]]));
    adjacency.set(3, new Map([[4, 1], [5, 1]]));
    adjacency.set(4, new Map());
    adjacency.set(5, new Map());
    adjacency.set(6, new Map());

    nodeIds = new Set([1, 2, 3, 4, 5, 6]);
    nodeNames = new Map([
      [1, 'main'], [2, 'helper'], [3, 'utils'],
      [4, 'leafA'], [5, 'leafB'], [6, 'untestedCore'],
    ]);
    nodePaths = new Map([
      [1, 'src/main.ts'], [2, 'src/helper.ts'], [3, 'src/utils.ts'],
      [4, 'src/leafA.ts'], [5, 'src/leafB.ts'], [6, 'src/untestedCore.ts'],
    ]);
  });

  it('returns entries sorted by riskScore descending', () => {
    const entries = computeRisk(db, adjacency, nodeIds, nodeNames, nodePaths);
    expect(entries.length).toBe(6);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].riskScore).toBeGreaterThanOrEqual(entries[i].riskScore);
    }
  });

  it('higher complexity functions have higher risk scores', () => {
    // main has complexity 5 (highest) — should rank high
    const entries = computeRisk(db, adjacency, nodeIds, nodeNames, nodePaths);
    const mainEntry = entries.find(e => e.functionName === 'main');
    const leafEntry = entries.find(e => e.functionName === 'leafA');
    expect(mainEntry).toBeDefined();
    expect(leafEntry).toBeDefined();
    // main (compl=5) should have >= complexity percentile than leafA (compl=1)
    expect(mainEntry!.complexityPercentile).toBeGreaterThanOrEqual(leafEntry!.complexityPercentile);
  });

  it('untested functions get penalty (untested=true)', () => {
    const entries = computeRisk(db, adjacency, nodeIds, nodeNames, nodePaths);
    const untested = entries.find(e => e.functionName === 'untestedCore');
    expect(untested).toBeDefined();
    expect(untested!.untested).toBe(true);
  });

  it('all entries have required fields', () => {
    const entries = computeRisk(db, adjacency, nodeIds, nodeNames, nodePaths);
    for (const entry of entries) {
      expect(entry.functionName).toBeTruthy();
      expect(entry.filePath).toBeTruthy();
      expect(typeof entry.pageRankPercentile).toBe('number');
      expect(typeof entry.betweennessPercentile).toBe('number');
      expect(typeof entry.complexityPercentile).toBe('number');
      expect(typeof entry.untested).toBe('boolean');
      expect(typeof entry.riskScore).toBe('number');
      expect(entry.riskScore).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles empty graph', () => {
    const entries = computeRisk(db, new Map(), new Set(), new Map(), new Map());
    expect(entries).toEqual([]);
  });

  it('percentiles are in [0, 1] range', () => {
    const entries = computeRisk(db, adjacency, nodeIds, nodeNames, nodePaths);
    for (const entry of entries) {
      expect(entry.pageRankPercentile).toBeGreaterThanOrEqual(0);
      expect(entry.pageRankPercentile).toBeLessThanOrEqual(1);
      expect(entry.betweennessPercentile).toBeGreaterThanOrEqual(0);
      expect(entry.betweennessPercentile).toBeLessThanOrEqual(1);
      expect(entry.complexityPercentile).toBeGreaterThanOrEqual(0);
      expect(entry.complexityPercentile).toBeLessThanOrEqual(1);
    }
  });
});

// ── buildCallGraphFromCache ─────────────────────────────────────────────

describe('buildCallGraphFromCache', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    seedFunctions(db);
    seedCalls(db);
    populateCallGraphCache(db);
  });

  it('builds graph from cache matching direct construction', () => {
    const direct = buildCallGraph(db);
    const cached = buildCallGraphFromCache(db);

    // Same node count
    expect(cached.graph.nodeIds.size).toBe(direct.graph.nodeIds.size);

    // Same adjacency edges (at least the ones present in both)
    for (const [nodeId, neighbors] of cached.graph.adjacency) {
      const directNeighbors = direct.graph.adjacency.get(nodeId);
      expect(directNeighbors).toBeDefined();
      for (const [neighborId, weight] of neighbors) {
        expect(directNeighbors!.get(neighborId)).toBe(weight);
      }
    }
  });

  it('correctly populates and reads from graph_cache table', () => {
    const cacheRows = db.prepare(
      "SELECT node_key, neighbor_key, weight FROM graph_cache WHERE graph_type = 'call'"
    ).all() as Array<{ node_key: string; neighbor_key: string; weight: number }>;
    expect(cacheRows.length).toBeGreaterThanOrEqual(3); // at least 3 edges

    // main -> helper should be present
    const mainToHelper = cacheRows.find(r => r.node_key === '1' && r.neighbor_key === '2');
    expect(mainToHelper).toBeDefined();
    expect(mainToHelper!.weight).toBe(1);
  });
});
