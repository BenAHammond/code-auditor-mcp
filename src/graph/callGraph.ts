/**
 * Spec 14 R1, R2 — Call Graph Construction, Centrality, and Risk Ranking
 *
 * Builds a weighted call graph from the `function_calls` table, computes
 * PageRank and betweenness centrality, and produces a risk ranking.
 *
 * All advisory — zero violations. Reports and annotations only.
 */

import type Database from 'better-sqlite3';
import type { RiskEntry, GraphStats, BlastRadiusImpact } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface CallGraph {
  /** Adjacency: nodeId → (neighborId → edgeWeight) */
  adjacency: Map<number, Map<number, number>>;
  /** Set of all node IDs in the graph */
  nodeIds: Set<number>;
  /** nodeId → function name */
  nodeNames: Map<number, string>;
  /** nodeId → file path */
  nodePaths: Map<number, string>;
}

export interface CentralityScores {
  pageRank: Map<number, number>;
  betweenness: Map<number, number>;
  /** Number of pivots sampled (Brandes-Pich when > 0) */
  betweennessPivotCount: number;
}

// ── R1 — Call graph construction ───────────────────────────────────────

/**
 * Build a weighted call graph from the `function_calls` table.
 *
 * Resolves `callee_name` TEXT → `functions.id` via name join. Edge weight
 * is the count of call sites between the same (caller, callee) pair.
 */
export function buildCallGraph(db: Database.Database): {
  graph: CallGraph;
  unresolvedCount: number;
  unresolvedShare: number;
} {
  const adjacency = new Map<number, Map<number, number>>();
  const nodeIds = new Set<number>();
  const nodeNames = new Map<number, string>();
  const nodePaths = new Map<number, string>();

  // Collect all function IDs, names, file paths
  const allFns = db.prepare(
    'SELECT id, name, file_path FROM functions'
  ).all() as Array<{ id: number; name: string; file_path: string }>;

  for (const fn of allFns) {
    nodeIds.add(fn.id);
    nodeNames.set(fn.id, fn.name);
    nodePaths.set(fn.id, fn.file_path);
  }

  // Build call graph: group by (caller_id, resolved_callee_id), weight = count
  const callRows = db.prepare(`
    SELECT
      fc.caller_id,
      fc.callee_name,
      f.id AS callee_id
    FROM function_calls fc
    LEFT JOIN functions f ON f.name = fc.callee_name
  `).all() as Array<{ caller_id: number; callee_name: string; callee_id: number | null }>;

  let unresolvedCount = 0;
  const totalCalls = callRows.length;

  // Group edge weights: key = "caller_id→callee_id", count occurrences
  const edgeWeights = new Map<string, number>();
  for (const row of callRows) {
    const callerId = row.caller_id;
    const calleeId = row.callee_id;

    if (calleeId === null || calleeId === undefined) {
      unresolvedCount++;
      // Still add to node set for completeness
      if (!nodeIds.has(callerId)) {
        nodeIds.add(callerId);
      }
      continue;
    }

    // Ensure both nodes are in the graph
    if (!adjacency.has(callerId)) {
      adjacency.set(callerId, new Map());
    }
    if (!adjacency.has(calleeId)) {
      adjacency.set(calleeId, new Map());
    }

    const key = `${callerId}→${calleeId}`;
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
  }

  // Apply edge weights to adjacency
  for (const [key, weight] of edgeWeights) {
    const [callerStr, calleeStr] = key.split('→');
    const callerId = parseInt(callerStr, 10);
    const calleeId = parseInt(calleeStr, 10);
    adjacency.get(callerId)!.set(calleeId, weight);
  }

  const unresolvedShare = totalCalls > 0 ? unresolvedCount / totalCalls : 0;

  return {
    graph: { adjacency, nodeIds, nodeNames, nodePaths },
    unresolvedCount,
    unresolvedShare,
  };
}

/**
 * Build a call graph from the persistent `graph_cache` table (fast path).
 */
export function buildCallGraphFromCache(db: Database.Database): {
  graph: CallGraph;
  unresolvedCount: number;
  unresolvedShare: number;
} {
  const adjacency = new Map<number, Map<number, number>>();
  const nodeIds = new Set<number>();
  const nodeNames = new Map<number, string>();
  const nodePaths = new Map<number, string>();

  const allFns = db.prepare(
    'SELECT id, name, file_path FROM functions'
  ).all() as Array<{ id: number; name: string; file_path: string }>;

  for (const fn of allFns) {
    nodeIds.add(fn.id);
    nodeNames.set(fn.id, fn.name);
    nodePaths.set(fn.id, fn.file_path);
  }

  const rows = db.prepare(
    `SELECT node_key, neighbor_key, weight FROM graph_cache WHERE graph_type = 'call'`
  ).all() as Array<{ node_key: string; neighbor_key: string; weight: number }>;

  for (const row of rows) {
    const callerId = parseInt(row.node_key, 10);
    const calleeId = parseInt(row.neighbor_key, 10);

    if (!adjacency.has(callerId)) adjacency.set(callerId, new Map());
    if (!adjacency.has(calleeId)) adjacency.set(calleeId, new Map());
    adjacency.get(callerId)!.set(calleeId, row.weight);
  }

  // Unresolved: count function_calls where callee_name doesn't match any function
  const resolvedRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM function_calls fc
    JOIN functions f ON f.name = fc.callee_name
  `).get() as { cnt: number };
  const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM function_calls').get() as { cnt: number };
  const unresolvedCount = totalRow.cnt - resolvedRow.cnt;
  const unresolvedShare = totalRow.cnt > 0 ? unresolvedCount / totalRow.cnt : 0;

  return {
    graph: { adjacency, nodeIds, nodeNames, nodePaths },
    unresolvedCount,
    unresolvedShare,
  };
}

/**
 * Populate `graph_cache` with call and import graph edges.
 * Called after a full sync or scoped sync.
 */
export function populateCallGraphCache(db: Database.Database): void {
  const txn = db.transaction(() => {
    // Clear existing call cache
    db.prepare("DELETE FROM graph_cache WHERE graph_type = 'call'").run();

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO graph_cache (graph_type, node_key, neighbor_key, weight)
       VALUES ('call', ?, ?, ?)`
    );

    // Aggregate call edges with weights
    const rows = db.prepare(`
      SELECT
        fc.caller_id,
        f.id AS callee_id,
        COUNT(*) AS weight
      FROM function_calls fc
      JOIN functions f ON f.name = fc.callee_name
      GROUP BY fc.caller_id, f.id
    `).all() as Array<{ caller_id: number; callee_id: number; weight: number }>;

    for (const row of rows) {
      stmt.run(String(row.caller_id), String(row.callee_id), row.weight);
    }
  });
  txn();
}

// ── R2 — PageRank ──────────────────────────────────────────────────────

/**
 * Compute PageRank on a weighted directed graph.
 *
 * Standard iterative algorithm: damping factor 0.85, convergence 1e-6,
 * max 100 iterations.
 */
export function computePageRank(
  adjacency: Map<number, Map<number, number>>,
  nodeIds: Set<number>,
  damping = 0.85,
  convergence = 1e-6
): Map<number, number> {
  const N = nodeIds.size;
  const nodes = [...nodeIds];
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    nodeIndex.set(nodes[i], i);
  }

  // Initialize scores to 1/N
  let scores = new Float64Array(N);
  for (let i = 0; i < N; i++) scores[i] = 1.0 / N;

  // Pre-compute outbound weights for each node
  const outSum = new Float64Array(N);
  for (const [nodeId, neighbors] of adjacency) {
    const idx = nodeIndex.get(nodeId);
    if (idx === undefined) continue;
    let total = 0;
    for (const weight of neighbors.values()) {
      total += weight;
    }
    outSum[idx] = total;
  }

  for (let iter = 0; iter < 100; iter++) {
    const newScores = new Float64Array(N);
    newScores.fill((1 - damping) / N);

    for (const [callerId, neighbors] of adjacency) {
      const callerIdx = nodeIndex.get(callerId);
      if (callerIdx === undefined) continue;
      const callerOut = outSum[callerIdx];
      if (callerOut === 0) continue;

      const contribution = (damping * scores[callerIdx]) / callerOut;
      for (const [calleeId, weight] of neighbors) {
        const calleeIdx = nodeIndex.get(calleeId);
        if (calleeIdx === undefined) continue;
        newScores[calleeIdx] += contribution * weight;
      }
    }

    // Handle dangling nodes (no outbound edges)
    let danglingSum = 0;
    for (let i = 0; i < N; i++) {
      if (outSum[i] === 0) {
        danglingSum += scores[i];
      }
    }
    if (danglingSum > 0) {
      const distrib = (damping * danglingSum) / N;
      for (let i = 0; i < N; i++) {
        newScores[i] += distrib;
      }
    }

    // Check convergence
    let maxDiff = 0;
    for (let i = 0; i < N; i++) {
      const diff = Math.abs(newScores[i] - scores[i]);
      if (diff > maxDiff) maxDiff = diff;
    }

    scores = newScores;
    if (maxDiff < convergence) break;
  }

  // Convert back to Map<nodeId, score>
  const result = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    result.set(nodes[i], scores[i]);
  }

  return result;
}

// ── R2 — Betweenness Centrality ─────────────────────────────────────────

const BETWEENNESS_EXACT_NODE_CAP = 2000;
const BETWEENNESS_PIVOT_COUNT = 200;

/**
 * Compute Brandes betweenness centrality.
 *
 * When `nodeCount <= 2000`, uses exact Brandes.
 * Above that, uses Brandes-Pich pivot sampling with `BETWEENNESS_PIVOT_COUNT` pivots.
 * Returns scores and the number of pivots sampled (0 = exact).
 */
export function computeBetweenness(
  adjacency: Map<number, Map<number, number>>,
  nodeIds: Set<number>
): { scores: Map<number, number>; pivotCount: number } {
  const N = nodeIds.size;
  const nodes = [...nodeIds];
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    nodeIndex.set(nodes[i], i);
  }

  if (N <= BETWEENNESS_EXACT_NODE_CAP) {
    return { scores: brandesExact(adjacency, nodes, nodeIndex), pivotCount: 0 };
  }

  // Brandes-Pich pivot sampling
  const pivotCount = Math.min(BETWEENNESS_PIVOT_COUNT, N);
  // Deterministic pivot selection: evenly spaced indices
  const pivots: number[] = [];
  const step = Math.floor(N / pivotCount);
  for (let i = 0; i < pivotCount; i++) {
    pivots.push(nodes[Math.min(i * step, N - 1)]);
  }

  return { scores: brandesSampled(adjacency, nodes, nodeIndex, pivots), pivotCount };
}

/**
 * Exact Brandes betweenness on all nodes.
 */
function brandesExact(
  adjacency: Map<number, Map<number, number>>,
  nodes: number[],
  nodeIndex: Map<number, number>
): Map<number, number> {
  const N = nodes.length;
  const bc = new Float64Array(N);

  for (const s of nodes) {
    const { stack, pred, sigma, dist, delta } = brandesBfs(adjacency, nodeIndex, N, s);

    // Accumulate dependencies (reverse BFS order)
    while (stack.length > 0) {
      const w = stack.pop()!;
      const wIdx = nodeIndex.get(w)!;
      for (const v of pred[wIdx]) {
        const vIdx = nodeIndex.get(v)!;
        const weight = sigma[vIdx] / sigma[wIdx];
        delta[vIdx] += weight * (1 + delta[wIdx]);
      }
      if (w !== s) {
        bc[wIdx] += delta[wIdx];
      }
    }
  }

  // Undirected normalization: divide by 2
  // (Brandes for undirected graphs divides by (N-1)(N-2) but we work
  // with a directed call graph, so no normalization is standard.)
  const result = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    result.set(nodes[i], bc[i]);
  }
  return result;
}

/**
 * Sampled Brandes-Pich: run exact Brandes from pivot nodes, extrapolate.
 */
function brandesSampled(
  adjacency: Map<number, Map<number, number>>,
  nodes: number[],
  nodeIndex: Map<number, number>,
  pivots: number[]
): Map<number, number> {
  const N = nodes.length;
  const bc = new Float64Array(N);

  for (const s of pivots) {
    const { stack, pred, sigma, dist, delta } = brandesBfs(adjacency, nodeIndex, N, s);

    while (stack.length > 0) {
      const w = stack.pop()!;
      const wIdx = nodeIndex.get(w)!;
      for (const v of pred[wIdx]) {
        const vIdx = nodeIndex.get(v)!;
        const weight = sigma[vIdx] / sigma[wIdx];
        delta[vIdx] += weight * (1 + delta[wIdx]);
      }
      if (w !== s) {
        bc[wIdx] += delta[wIdx];
      }
    }
  }

  // Scale: multiply by N / pivotCount to estimate the full values
  const scale = N / pivots.length;
  const result = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    result.set(nodes[i], bc[i] * scale);
  }
  return result;
}

/**
 * Brandes single-source BFS helper.
 * Returns predecessors, sigma (shortest-path counts), distances, deltas, and BFS stack.
 */
function brandesBfs(
  adjacency: Map<number, Map<number, number>>,
  nodeIndex: Map<number, number>,
  N: number,
  source: number
): {
  stack: number[];
  pred: number[][];
  sigma: Float64Array;
  dist: Int32Array;
  delta: Float64Array;
} {
  const stack: number[] = [];
  const pred: number[][] = Array.from({ length: N }, () => []);
  const sigma = new Float64Array(N);
  const dist = new Int32Array(N);
  const delta = new Float64Array(N);

  dist.fill(-1);
  const sIdx = nodeIndex.get(source)!;
  dist[sIdx] = 0;
  sigma[sIdx] = 1;

  const queue: number[] = [source];

  while (queue.length > 0) {
    const v = queue.shift()!;
    const vIdx = nodeIndex.get(v)!;
    stack.push(v);

    const neighbors = adjacency.get(v);
    if (!neighbors) continue;

    for (const [w, _weight] of neighbors) {
      const wIdx = nodeIndex.get(w);
      if (wIdx === undefined) continue;

      // First visit
      if (dist[wIdx] < 0) {
        dist[wIdx] = dist[vIdx] + 1;
        queue.push(w);
      }

      // Edge lies on a shortest path
      if (dist[wIdx] === dist[vIdx] + 1) {
        sigma[wIdx] += sigma[vIdx];
        pred[wIdx].push(v);
      }
    }
  }

  return { stack, pred, sigma, dist, delta };
}

// ── R2 — Risk ranking ───────────────────────────────────────────────────

/**
 * Detect whether a function is untested by checking if any transitive caller
 * (depth ≤ 2) resides in a file matching test globs.
 */
function detectUntested(
  db: Database.Database,
  functionId: number,
  adjacency: Map<number, Map<number, number>>
): boolean {
  // Perform a 2-hop BFS in the callers direction (who calls this function)
  const visited = new Set<number>();
  const queue: Array<{ id: number; depth: number }> = [{ id: functionId, depth: 0 }];
  visited.add(functionId);

  // Build reverse adjacency (callee → callers) from forward adjacency
  const reverseAdj = new Map<number, Set<number>>();
  for (const [callerId, neighbors] of adjacency) {
    for (const calleeId of neighbors.keys()) {
      if (!reverseAdj.has(calleeId)) {
        reverseAdj.set(calleeId, new Set());
      }
      reverseAdj.get(calleeId)!.add(callerId);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > 2) continue;

    // Check if this caller's file matches test patterns
    if (current.depth > 0) {
      const fileRow = db.prepare(
        'SELECT file_path FROM functions WHERE id = ?'
      ).get(current.id) as { file_path: string } | undefined;

      if (fileRow && isTestFile(fileRow.file_path)) {
        return false; // Found a test — NOT untested
      }
    }

    // Follow reverse edges (who calls this node)
    const callers = reverseAdj.get(current.id);
    if (callers) {
      for (const callerId of callers) {
        if (!visited.has(callerId)) {
          visited.add(callerId);
          queue.push({ id: callerId, depth: current.depth + 1 });
        }
      }
    }
  }

  return true; // No test caller found — untested
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    filePath.includes('__tests__') ||
    filePath.includes('/test/') ||
    filePath.includes('/tests/')
  );
}

/**
 * Compute a risk score for every function.
 *
 * risk = max(pageRank percentile, betweenness percentile)
 *      × complexity percentile
 *      × (1 + untested)  — where untested = 1 if true, 0 otherwise
 */
export function computeRisk(
  db: Database.Database,
  adjacency: Map<number, Map<number, number>>,
  nodeIds: Set<number>,
  nodeNames: Map<number, string>,
  nodePaths: Map<number, string>
): RiskEntry[] {
  const pageRank = computePageRank(adjacency, nodeIds);
  const { scores: betweenness } = computeBetweenness(adjacency, nodeIds);

  const nodes = [...nodeIds];
  const N = nodes.length;
  if (N === 0) return [];

  // Sort nodes by each metric to compute percentiles
  const prSorted = nodes.map(id => ({ id, score: pageRank.get(id) ?? 0 })).sort((a, b) => a.score - b.score);
  const bwSorted = nodes.map(id => ({ id, score: betweenness.get(id) ?? 0 })).sort((a, b) => a.score - b.score);

  const prPercentile = new Map<number, number>();
  const bwPercentile = new Map<number, number>();

  for (let i = 0; i < N; i++) {
    prPercentile.set(prSorted[i].id, i / (N - 1));
    bwPercentile.set(bwSorted[i].id, i / (N - 1));
  }

  // Get complexity from DB
  const complexityRows = db.prepare(
    'SELECT id, complexity, name, file_path FROM functions WHERE id IN (' +
    nodes.map(() => '?').join(',') + ')'
  ).all(...nodes) as Array<{ id: number; complexity: number; name: string; file_path: string }>;

  const complexityMap = new Map<number, number>();
  for (const row of complexityRows) {
    complexityMap.set(row.id, row.complexity ?? 0);
  }

  // Complexity percentile
  const cxSorted = complexityRows
    .map(r => ({ id: r.id, cx: r.complexity ?? 0 }))
    .sort((a, b) => a.cx - b.cx);

  const cxPercentile = new Map<number, number>();
  for (let i = 0; i < cxSorted.length; i++) {
    cxPercentile.set(cxSorted[i].id, i / (Math.max(cxSorted.length - 1, 1)));
  }

  // Build risk entries
  const entries: RiskEntry[] = [];

  for (const nodeId of nodes) {
    // Skip unresolved externals (IDs that appear only as callees but aren't in functions table)
    const name = nodeNames.get(nodeId);
    const filePath = nodePaths.get(nodeId);
    if (!name || !filePath) continue;

    const pr = prPercentile.get(nodeId) ?? 0;
    const bw = bwPercentile.get(nodeId) ?? 0;
    const cx = cxPercentile.get(nodeId) ?? 0;
    const untested = detectUntested(db, nodeId, adjacency);

    const risk = Math.max(pr, bw) * cx * (1 + (untested ? 1 : 0));

    entries.push({
      functionName: name,
      filePath,
      pageRankPercentile: pr,
      betweennessPercentile: bw,
      complexityPercentile: cx,
      untested,
      riskScore: risk,
    });
  }

  // Sort by risk descending
  entries.sort((a, b) => b.riskScore - a.riskScore);
  return entries;
}

// ── Graph statistics ────────────────────────────────────────────────────

export function getGraphStats(db: Database.Database): GraphStats {
  const callRows = db.prepare(
    `SELECT COUNT(*) as cnt FROM graph_cache WHERE graph_type = 'call'`
  ).get() as { cnt: number };

  const importRows = db.prepare(
    `SELECT COUNT(*) as cnt FROM graph_cache WHERE graph_type = 'import'`
  ).get() as { cnt: number };

  const callNodes = (db.prepare(
    "SELECT COUNT(DISTINCT node_key) as cnt FROM graph_cache WHERE graph_type = 'call'"
  ).get() as { cnt: number }).cnt;

  const importNodes = (db.prepare(
    "SELECT COUNT(DISTINCT node_key) as cnt FROM graph_cache WHERE graph_type = 'import'"
  ).get() as { cnt: number }).cnt;

  const totalCalls = (db.prepare('SELECT COUNT(*) as cnt FROM function_calls').get() as { cnt: number }).cnt;
  const resolvedCalls = (db.prepare(
    'SELECT COUNT(*) as cnt FROM function_calls fc JOIN functions f ON f.name = fc.callee_name'
  ).get() as { cnt: number }).cnt;
  const unresolvedCalls = totalCalls - resolvedCalls;
  const unresolvedShare = totalCalls > 0 ? unresolvedCalls / totalCalls : 0;

  return {
    callNodes,
    callEdges: callRows.cnt,
    unresolvedCalls,
    unresolvedShare,
    importNodes,
    importEdges: importRows.cnt,
  };
}
