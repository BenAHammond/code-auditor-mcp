/**
 * Dependency-graph access (Spec 14) — call/import edge construction and the
 * transitive-closure / cycle / depth queries over them. Extracted from
 * `CodeIndexDB`; holds only the raw SQLite handle.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { tryParseJson } from './shared.js';
import { getGraphStats as getGs } from '../graph/callGraph.js';

/**
 * Clear call edges for a scope — one file, or the whole table when unscoped.
 *
 * @param db The SQLite database handle.
 * @param filePath When given, only edges owned by functions in this file are removed.
 */
export function clearCallEdges(db: SqliteDatabase, filePath?: string): void {
  if (filePath) {
    db.prepare(`DELETE FROM function_calls WHERE caller_id IN (SELECT id FROM functions WHERE file_path = ?)`).run(filePath);
  } else {
    db.prepare('DELETE FROM function_calls').run();
  }
}

/**
 * Clear dependency edges for a scope — one file, or the whole table when unscoped.
 *
 * @param db The SQLite database handle.
 * @param filePath When given, only edges owned by functions in this file are removed.
 */
export function clearDependencyEdges(db: SqliteDatabase, filePath?: string): void {
  if (filePath) {
    db.prepare(`DELETE FROM function_dependencies WHERE function_id IN (SELECT id FROM functions WHERE file_path = ?)`).run(filePath);
  } else {
    db.prepare('DELETE FROM function_dependencies').run();
  }
}

/**
 * Read the function rows a graph rebuild needs, scoped to a file when given.
 *
 * @param db The SQLite database handle.
 * @param filePath When given, restrict the read to functions in this file.
 * @returns The function rows (id, name, file_path, metadata_json) used to build edges.
 */
export function loadGraphFunctions(db: SqliteDatabase, filePath?: string): any[] {
  return filePath
    ? db.prepare('SELECT id, name, file_path, metadata_json FROM functions WHERE file_path = ?').all(filePath) as any[]
    : db.prepare('SELECT id, name, file_path, metadata_json FROM functions').all() as any[];
}

/**
 * Rebuild call and dependency edges from function metadata.
 *
 * @param db The SQLite database handle.
 * @param allFns The function rows whose metadata drives the edge inserts.
 */
export function insertGraphEdges(db: SqliteDatabase, allFns: any[]): void {
  const insertCall = db.prepare('INSERT OR IGNORE INTO function_calls (caller_id, callee_name) VALUES (?, ?)');
  const insertFnDep = db.prepare('INSERT OR IGNORE INTO function_dependencies (function_id, dependency) VALUES (?, ?)');
  for (const fn of allFns) {
    const meta = tryParseJson(fn.metadata_json) ?? {};
    if (meta.functionCalls) {
      for (const callee of meta.functionCalls) {
        insertCall.run(fn.id, callee);
      }
    }
    // Add specifier-level dependencies (e.g., useState, useEffect)
    const usedImports: string[] = meta.usedImports ?? [];
    for (const imp of usedImports) {
      insertFnDep.run(fn.id, imp);
    }
    // Add module-level dependencies (e.g., react, express) — stored in
    // metadata.dependencies since v3.0.4 to power the dep: operator
    const moduleDeps: string[] = meta.dependencies ?? [];
    for (const dep of moduleDeps) {
      insertFnDep.run(fn.id, dep);
    }
  }
}

/**
 * Dependency-graph queries over the `function_calls` and `function_dependencies`
 * edge tables, keyed by function name. Rebuilds edges from stored metadata and
 * answers transitive-closure, cycle, and dependency-depth questions over them.
 */
export class DependencyGraphIndex {
  /**
   * Create the index over the shared SQLite handle.
   *
   * @param db The SQLite database handle.
   */
  constructor(private db: SqliteDatabase) {}

  /**
   * Rebuild call and dependency edges from stored metadata. When scoped to a
   * single file, only that file's functions are re-read — avoiding an
   * O(files × functions) re-read on each detached-audit loop iteration.
   *
   * @param filePath When given, rebuild edges for this file only.
   * @returns Resolves once the edge tables have been rebuilt in a transaction.
   */
  async updateDependencyGraph(filePath?: string): Promise<void> {
    const txn = this.db.transaction(() => {
      // Rebuild edges from metadata. When scoped to one file, read only that
      // file's functions — a per-file call previously re-read every function
      // in the index, making the detached-audit loop O(files × functions).
      clearCallEdges(this.db, filePath);
      clearDependencyEdges(this.db, filePath);
      insertGraphEdges(this.db, loadGraphFunctions(this.db, filePath));
    });

    txn.immediate();
  }

  /**
   * Return every function transitively reached from the given function by
   * following call edges, up to a maximum hop depth.
   *
   * @param functionName The starting function name.
   * @param maxDepth The maximum number of call-edge hops to traverse.
   * @returns Distinct callee names with their distance, ordered by depth then name.
   */
  async getTransitiveDependencies(
    functionName: string,
    maxDepth: number = 10
  ): Promise<Array<{ name: string; depth: number }>> {
    const result: Array<{ name: string; depth: number }> = [];
    const visited = new Set<number>();

    // Find starting function(s)
    const startFns = this.db.prepare(
      'SELECT id FROM functions WHERE name = ?'
    ).all(functionName) as any[];

    if (startFns.length === 0) return result;

    // Use recursive CTE for transitive closure
    const rows = this.db.prepare(`
      WITH RECURSIVE deps(id, callee_name, depth) AS (
        SELECT fc.caller_id, fc.callee_name, 1
        FROM function_calls fc
        WHERE fc.caller_id IN (SELECT id FROM functions WHERE name = ?)
        UNION
        SELECT fc.caller_id, fc.callee_name, deps.depth + 1
        FROM function_calls fc
        JOIN deps ON fc.caller_id IN (SELECT id FROM functions WHERE name = deps.callee_name)
        WHERE deps.depth < ?
      )
      SELECT DISTINCT callee_name as name, depth FROM deps ORDER BY depth, name
    `).all(functionName, maxDepth) as Array<{ name: string; depth: number }>;

    return rows;
  }

  /**
   * Return every function that transitively calls the given function, by walking
   * call edges backward up to a maximum hop depth.
   *
   * @param functionName The function whose callers are sought.
   * @param maxDepth The maximum number of call-edge hops to traverse.
   * @returns Distinct caller names with their distance, ordered by depth then name.
   */
  async getTransitiveCallers(
    functionName: string,
    maxDepth: number = 10
  ): Promise<Array<{ name: string; depth: number }>> {
    const rows = this.db.prepare(`
      WITH RECURSIVE callers(id, caller_name, depth) AS (
        SELECT fc.caller_id, f.name, 1
        FROM function_calls fc
        JOIN functions f ON f.id = fc.caller_id
        WHERE fc.callee_name = ?
        UNION
        SELECT fc.caller_id, f2.name, callers.depth + 1
        FROM function_calls fc
        JOIN functions f2 ON f2.id = fc.caller_id
        JOIN functions f3 ON f3.name = callers.caller_name AND fc.callee_name = f3.name
        WHERE callers.depth < ?
      )
      SELECT DISTINCT caller_name as name, depth FROM callers ORDER BY depth, name
    `).all(functionName, maxDepth) as Array<{ name: string; depth: number }>;

    return rows;
  }

  /**
   * Find call cycles by walking call edges until a path returns to its start.
   *
   * @returns Each cycle as a list of function names in traversal order.
   */
  async detectCircularDependencies(): Promise<Array<string[]>> {
    // SQLite recursive CTE for cycle detection
    const rows = this.db.prepare(`
      WITH RECURSIVE paths(start_name, path, current_name, depth) AS (
        SELECT f.name, f.name, fc.callee_name, 1
        FROM functions f
        JOIN function_calls fc ON fc.caller_id = f.id
        UNION
        SELECT paths.start_name,
               paths.path || '→' || fc.callee_name,
               fc.callee_name,
               paths.depth + 1
        FROM paths
        JOIN functions f ON f.name = paths.current_name
        JOIN function_calls fc ON fc.caller_id = f.id
        WHERE paths.depth < 20
          AND instr(paths.path, fc.callee_name) = 0
      )
      SELECT DISTINCT path FROM paths
      WHERE current_name = start_name AND depth > 1
    `).all() as Array<{ path: string }>;

    return rows.map(r => r.path.split('→'));
  }

  /**
   * Compute and persist each function's deepest transitive dependency distance.
   *
   * @returns Resolves once every function's dependency_depth has been updated.
   */
  async calculateDependencyDepths(): Promise<void> {
    const functions = this.db.prepare('SELECT id, name FROM functions').all() as any[];
    const update = this.db.prepare('UPDATE functions SET dependency_depth = ? WHERE id = ?');

    // Calculate depths outside transaction since getTransitiveDependencies is async
    const depths: Array<{ id: number; maxDepth: number }> = [];
    for (const fn of functions) {
      const deps = await this.getTransitiveDependencies(fn.name);
      const maxDepth = deps.length > 0 ? Math.max(...deps.map(d => d.depth)) : 0;
      depths.push({ id: fn.id, maxDepth });
    }

    const txn = this.db.transaction(() => {
      for (const { id, maxDepth } of depths) {
        update.run(maxDepth, id);
      }
    });

    txn();
  }

  /** Get graph statistics — delegates to graph/callGraph.ts (Spec 14 R1). */
  getGraphStats(): import('../types.js').GraphStats {
    return getGs(this.db);
  }
}
