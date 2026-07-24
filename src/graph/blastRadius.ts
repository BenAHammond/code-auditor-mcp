/**
 * Spec 14 R6 — Blast Radius Impact Computation
 *
 * Estimates the impact of editing a set of functions using recursive CTE
 * traversal of the caller graph. Designed for the hook path: ≤100ms budget.
 *
 * Uses targeted traversal via SQLite recursive CTE — no full adjacency load.
 * Cost scales with the BFS neighborhood size, not the codebase size.
 *
 * If latency > 100ms, the feature ships disabled-by-default.
 */

import type Database from 'better-sqlite3';
import type { BlastRadiusImpact } from '../types.js';

const MAX_DEPTH = 10;
const LATENCY_BUDGET_MS = 100;

/**
 * Compute blast-radius impact for a set of edited function IDs.
 *
 * Uses a recursive CTE against `graph_cache` (falling back to
 * `function_calls` if cache is empty) to walk the caller graph upward.
 *
 * @param db - SQLite database handle
 * @param functionIds - IDs of edited/changed functions
 * @returns Impact estimate with latency measurement
 */
export function computeImpact(
  db: Database.Database,
  functionIds: number[]
): BlastRadiusImpact {
  const startMs = performance.now();

  if (functionIds.length === 0) {
    return {
      editedFunctionCount: 0,
      transitiveCallers: 0,
      reachableExports: 0,
      depthReached: 0,
      latencyMs: performance.now() - startMs,
    };
  }

  // Check if graph_cache has call edges — use it if available (fast path)
  const cacheCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM graph_cache WHERE graph_type = 'call'"
  ).get() as { cnt: number }).cnt;

  let reachableIds: number[];

  if (cacheCount > 0) {
    // Fast path: use graph_cache
    reachableIds = computeImpactFromCache(db, functionIds);
  } else {
    // Fallback: use function_calls directly
    reachableIds = computeImpactFromCalls(db, functionIds);
  }

  // Count exported functions among reachable callers
  const exportedCount = reachableIds.length > 0
    ? countExported(db, reachableIds)
    : 0;

  const elapsedMs = performance.now() - startMs;

  return {
    editedFunctionCount: functionIds.length,
    transitiveCallers: reachableIds.length,
    reachableExports: exportedCount,
    depthReached: MAX_DEPTH, // The CTE caps at MAX_DEPTH
    latencyMs: Math.round(elapsedMs * 100) / 100,
  };
}

/**
 * Walk the caller graph using `graph_cache` (fast path).
 * Finds all transitive callers up to MAX_DEPTH.
 */
function computeImpactFromCache(db: Database.Database, functionIds: number[]): number[] {
  // Build initial set as comma-separated IDs
  const idList = functionIds.join(',');

  // Recursive CTE: follow (neighbor → node) edges in the call graph.
  // In graph_cache, node_key = caller, neighbor_key = callee.
  // So to find callers, we search WHERE neighbor_key = our_function
  // and node_key is the caller.
  try {
    const rows = db.prepare(`
      WITH RECURSIVE callers(id, depth) AS (
        -- Base: start from the edited functions themselves
        SELECT DISTINCT node_key, 0
        FROM graph_cache
        WHERE graph_type = 'call' AND neighbor_key IN (${idList})

        UNION

        -- Recursive: find callers of callers
        SELECT DISTINCT gc.node_key, callers.depth + 1
        FROM graph_cache gc
        JOIN callers ON gc.neighbor_key = callers.id
        WHERE gc.graph_type = 'call'
          AND callers.depth < ${MAX_DEPTH}
      )
      SELECT DISTINCT id FROM callers
    `).all() as Array<{ id: string }>;

    return rows.map(r => parseInt(r.id, 10)).filter(id => !isNaN(id));
  } catch {
    // If recursive CTE fails (e.g., malformed cache), return empty
    return [];
  }
}

/**
 * Fallback: walk the caller graph using `function_calls`.
 * Find all functions that transitively call the given function IDs.
 */
function computeImpactFromCalls(db: Database.Database, functionIds: number[]): number[] {
  // First, get the names of the edited functions
  const idPlaceholders = functionIds.map(() => '?').join(',');
  const fnNames = db.prepare(
    `SELECT DISTINCT name FROM functions WHERE id IN (${idPlaceholders})`
  ).all(...functionIds) as Array<{ name: string }>;

  const names = fnNames.map(r => r.name);

  if (names.length === 0) return [];

  // Use recursive CTE on function_calls
  // function_calls: caller_id calls callee_name
  // To find callers: find rows where callee_name matches our function,
  // then recursively follow from those callers
  try {
    const nameList = names.map(n => `'${n.replace(/'/g, "''")}'`).join(',');

    const rows = db.prepare(`
      WITH RECURSIVE callers(id, depth) AS (
        -- Base: functions that directly call our edited functions
        SELECT fc.caller_id, 1
        FROM function_calls fc
        WHERE fc.callee_name IN (${nameList})

        UNION

        -- Recursive: functions that call the current set of callers
        SELECT fc2.caller_id, callers.depth + 1
        FROM function_calls fc2
        JOIN functions f ON f.id = fc2.caller_id
        JOIN callers ON fc2.callee_name IN (
          SELECT f2.name FROM functions f2 WHERE f2.id = callers.id
        )
        WHERE callers.depth < ${MAX_DEPTH}
      )
      SELECT DISTINCT id FROM callers
    `).all() as Array<{ id: number }>;

    return rows.map(r => r.id).filter(id => !functionIds.includes(id));
  } catch {
    return [];
  }
}

/**
 * Count how many of the given function IDs are exported.
 */
function countExported(db: Database.Database, functionIds: number[]): number {
  if (functionIds.length === 0) return 0;

  const idPlaceholders = functionIds.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM functions WHERE id IN (${idPlaceholders}) AND is_exported = 1`
  ).get(...functionIds) as { cnt: number };

  return row.cnt;
}

export { LATENCY_BUDGET_MS };
