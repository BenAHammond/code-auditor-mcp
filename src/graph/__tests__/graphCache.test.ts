/**
 * Spec 14 R1 — Graph Cache Incremental Update Tests
 *
 * Verifies:
 *   1. populateCallGraphCache builds correct cache rows
 *   2. populateImportGraphCache builds correct cache rows
 *   3. Rebuilding after adding new functions/calls updates the cache (simulates scoped sync)
 *   4. Rebuilding after removing functions/calls updates the cache (simulates scoped sync)
 *   5. Cache survives across separate reads (persistence)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildCallGraph,
  buildCallGraphFromCache,
  populateCallGraphCache,
} from '../callGraph.js';
import {
  buildImportGraph,
  buildImportGraphFromCache,
  populateImportGraphCache,
} from '../importGraph.js';

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

function seedFunctions(db: Database.Database, fns: Array<[number, string, string, number?]>): void {
  const stmt = db.prepare(
    'INSERT INTO functions (id, name, file_path, is_exported, content_hash) VALUES (?, ?, ?, ?, ?)'
  );
  for (const [id, name, filePath, exported = 1] of fns) {
    stmt.run(id, name, filePath, exported, `hash${id}`);
  }
}

function seedCalls(db: Database.Database, calls: Array<[number, string]>): void {
  const stmt = db.prepare('INSERT INTO function_calls (caller_id, callee_name) VALUES (?, ?)');
  for (const [callerId, calleeName] of calls) {
    stmt.run(callerId, calleeName);
  }
}

function seedDependencies(db: Database.Database, deps: Array<[number, string]>): void {
  const stmt = db.prepare('INSERT OR IGNORE INTO function_dependencies (function_id, dependency) VALUES (?, ?)');
  for (const [fnId, dep] of deps) {
    stmt.run(fnId, dep);
  }
}

function countCallCacheRows(db: Database.Database): number {
  return (db.prepare(
    "SELECT COUNT(*) as cnt FROM graph_cache WHERE graph_type = 'call'"
  ).get() as { cnt: number }).cnt;
}

function countImportCacheRows(db: Database.Database): number {
  return (db.prepare(
    "SELECT COUNT(*) as cnt FROM graph_cache WHERE graph_type = 'import'"
  ).get() as { cnt: number }).cnt;
}

// ── populateCallGraphCache ──────────────────────────────────────────────

describe('populateCallGraphCache', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    seedFunctions(db, [
      [1, 'main', 'src/main.ts'],
      [2, 'helper', 'src/helper.ts'],
      [3, 'utils', 'src/utils.ts'],
    ]);
    seedCalls(db, [
      [1, 'helper'],
      [1, 'utils'],
      [2, 'utils'],
    ]);
  });

  it('populates graph_cache with correct call edges', () => {
    populateCallGraphCache(db);

    const rows = db.prepare(
      "SELECT node_key, neighbor_key, weight FROM graph_cache WHERE graph_type = 'call'"
    ).all() as Array<{ node_key: string; neighbor_key: string; weight: number }>;

    // Should have 3 edges: main→helper, main→utils, helper→utils
    expect(rows.length).toBe(3);

    const edgeKeys = rows.map(r => `${r.node_key}→${r.neighbor_key}`);
    expect(edgeKeys).toContain('1→2'); // main → helper
    expect(edgeKeys).toContain('1→3'); // main → utils
    expect(edgeKeys).toContain('2→3'); // helper → utils
  });

  it('edge weight is 1 for single call sites', () => {
    populateCallGraphCache(db);

    const row = db.prepare(
      "SELECT weight FROM graph_cache WHERE graph_type = 'call' AND node_key = '1' AND neighbor_key = '2'"
    ).get() as { weight: number };

    expect(row.weight).toBe(1);
  });

  it('edge weight aggregates duplicate call sites', () => {
    // Add another call from main to helper
    seedCalls(db, [[1, 'helper']]);
    populateCallGraphCache(db);

    const row = db.prepare(
      "SELECT weight FROM graph_cache WHERE graph_type = 'call' AND node_key = '1' AND neighbor_key = '2'"
    ).get() as { weight: number };

    expect(row.weight).toBe(2);
  });

  it('clears stale edges on rebuild (does not accumulate)', () => {
    populateCallGraphCache(db);

    // Delete all calls and rebuild
    db.exec('DELETE FROM function_calls');
    populateCallGraphCache(db);

    expect(countCallCacheRows(db)).toBe(0);
  });
});

// ── populateImportGraphCache ────────────────────────────────────────────

describe('populateImportGraphCache', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    seedFunctions(db, [
      [1, 'fnA', 'src/module_a/a.ts'],
      [2, 'fnB', 'src/module_b/b.ts'],
    ]);
    seedDependencies(db, [
      [1, 'src/module_b/b.ts'], // a.ts imports b.ts
    ]);
  });

  it('populates graph_cache with correct import edges', () => {
    populateImportGraphCache(db);

    const rows = db.prepare(
      "SELECT node_key, neighbor_key, weight FROM graph_cache WHERE graph_type = 'import'"
    ).all() as Array<{ node_key: string; neighbor_key: string; weight: number }>;

    // Should have at least 1 edge: module_a/a.ts → module_b/b.ts
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const edgeFound = rows.some(
      r => r.node_key === 'src/module_a/a.ts' && r.neighbor_key === 'src/module_b/b.ts'
    );
    expect(edgeFound).toBe(true);
  });

  it('clears stale edges on rebuild', () => {
    populateImportGraphCache(db);
    const initialCount = countImportCacheRows(db);

    // Delete all dependencies and rebuild
    db.exec('DELETE FROM function_dependencies');
    populateImportGraphCache(db);

    expect(countImportCacheRows(db)).toBe(0);
    expect(initialCount).toBeGreaterThan(0); // Sanity: had edges before clear
  });
});

// ── Incremental update simulation (scoped sync) ─────────────────────────

describe('graph cache — incremental update simulation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    seedFunctions(db, [
      [1, 'alpha', 'src/alpha.ts'],
      [2, 'beta', 'src/beta.ts'],
      [3, 'gamma', 'src/gamma.ts'],
    ]);
    seedCalls(db, [
      [1, 'beta'],
    ]);
    seedDependencies(db, [
      [1, 'src/beta.ts'],
    ]);

    // Initial cache population
    populateCallGraphCache(db);
    populateImportGraphCache(db);
  });

  it('call cache reflects new functions and calls after rebuild', () => {
    // Simulate scoped sync: add new function + call edge
    seedFunctions(db, [[4, 'delta', 'src/delta.ts']]);
    seedCalls(db, [[1, 'delta'], [2, 'delta']]);

    // Rebuild cache (same as scoped sync does)
    populateCallGraphCache(db);

    const rows = db.prepare(
      "SELECT node_key, neighbor_key FROM graph_cache WHERE graph_type = 'call'"
    ).all() as Array<{ node_key: string; neighbor_key: string }>;

    const edgeKeys = rows.map(r => `${r.node_key}→${r.neighbor_key}`);
    expect(edgeKeys).toContain('1→2'); // alpha → beta (existing, preserved)
    expect(edgeKeys).toContain('1→4'); // alpha → delta (new)
    expect(edgeKeys).toContain('2→4'); // beta → delta (new)

    // Old edges for unchanged calls should still be present
    expect(rows.length).toBe(3);
  });

  it('call cache excludes removed calls after rebuild', () => {
    // Verify initial state
    expect(countCallCacheRows(db)).toBe(1);

    // Simulate scoped sync: delete the call from alpha to beta
    db.exec('DELETE FROM function_calls WHERE caller_id = 1 AND callee_name = \'beta\'');

    // Add new, different call
    seedCalls(db, [[1, 'gamma']]);

    // Rebuild cache
    populateCallGraphCache(db);

    const rows = db.prepare(
      "SELECT node_key, neighbor_key FROM graph_cache WHERE graph_type = 'call'"
    ).all() as Array<{ node_key: string; neighbor_key: string }>;

    const edgeKeys = rows.map(r => `${r.node_key}→${r.neighbor_key}`);
    expect(edgeKeys).not.toContain('1→2'); // alpha → beta (removed)
    expect(edgeKeys).toContain('1→3');     // alpha → gamma (new)
    expect(rows.length).toBe(1);
  });

  it('import cache reflects new dependencies after rebuild', () => {
    // Initial state: 1 edge
    expect(countImportCacheRows(db)).toBeGreaterThanOrEqual(1);

    // Simulate scoped sync: add new dependency
    seedDependencies(db, [[2, 'src/gamma.ts']]);

    // Rebuild cache
    populateImportGraphCache(db);

    const rows = db.prepare(
      "SELECT node_key, neighbor_key FROM graph_cache WHERE graph_type = 'import'"
    ).all() as Array<{ node_key: string; neighbor_key: string }>;

    // Should have new edge: beta.ts → gamma.ts
    const newEdge = rows.some(
      r => r.node_key === 'src/beta.ts' && r.neighbor_key === 'src/gamma.ts'
    );
    expect(newEdge).toBe(true);

    // Original edge should still be present
    const oldEdge = rows.some(
      r => r.node_key === 'src/alpha.ts' && r.neighbor_key === 'src/beta.ts'
    );
    expect(oldEdge).toBe(true);
  });

  it('cache survives rebuild on empty function_calls', () => {
    // Delete all calls
    db.exec('DELETE FROM function_calls');

    // Rebuild should not error, cache should be empty
    populateCallGraphCache(db);
    expect(countCallCacheRows(db)).toBe(0);
  });

  it('buildCallGraphFromCache matches buildCallGraph after rebuild', () => {
    // Initial state: alpha calls beta
    const direct = buildCallGraph(db);
    const cached = buildCallGraphFromCache(db);
    expect(cached.graph.nodeIds.size).toBe(direct.graph.nodeIds.size);

    // Add delta and rebuild
    seedFunctions(db, [[4, 'delta', 'src/delta.ts']]);
    seedCalls(db, [[1, 'delta'], [2, 'delta'], [3, 'delta']]);
    populateCallGraphCache(db);

    const direct2 = buildCallGraph(db);
    const cached2 = buildCallGraphFromCache(db);

    // Same node count after rebuild
    expect(cached2.graph.nodeIds.size).toBe(direct2.graph.nodeIds.size);

    // Same adjacency structure
    for (const [nodeId, neighbors] of cached2.graph.adjacency) {
      const directNeighbors = direct2.graph.adjacency.get(nodeId);
      expect(directNeighbors).toBeDefined();
      for (const [neighborId, weight] of neighbors) {
        expect(directNeighbors!.get(neighborId)).toBe(weight);
      }
    }
  });
});
