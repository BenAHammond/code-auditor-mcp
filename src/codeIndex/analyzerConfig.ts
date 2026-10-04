/**
 * Analyzer-config storage — the `analyzer_configs` table (global and
 * project-scoped configs). Extracted from `CodeIndexDB`; holds only the raw
 * SQLite handle.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { tryParseJson } from './shared.js';

/**
 * Data access for the `analyzer_configs` table: store, retrieve, and delete
 * analyzer configuration (global or project-scoped), keyed by analyzer name.
 */
export class AnalyzerConfigIndex {
  /**
   * Wrap the shared SQLite handle for analyzer-config storage.
   * @param db the SQLite database handle.
   */
  constructor(private db: SqliteDatabase) {}

  /**
   * Upsert an analyzer configuration (global or project-scoped).
   * @param analyzerName the analyzer the configuration belongs to.
   * @param config the configuration object to store, serialized as JSON.
   * @param options optional scoping: `projectPath` ties the row to one project, `isGlobal` marks it global, and `metadata` carries extra JSON.
   * @returns the analyzer name the configuration was stored under.
   */
  async storeAnalyzerConfig(
    analyzerName: string,
    config: Record<string, any>,
    options?: { projectPath?: string; isGlobal?: boolean; metadata?: any }
  ): Promise<string> {
    const projectPath = options?.projectPath ?? null;
    const isGlobal = options?.isGlobal ?? true;

    const existing = this.db.prepare(
      'SELECT id FROM analyzer_configs WHERE analyzer_name = ? AND COALESCE(project_path, \'__global__\') = ? AND is_global = ?'
    ).get(analyzerName, projectPath ?? '__global__', isGlobal ? 1 : 0);

    if (existing) {
      this.db.prepare(
        'UPDATE analyzer_configs SET config_json = ?, updated_at = ?, metadata_json = ? WHERE id = ?'
      ).run(JSON.stringify(config), new Date().toISOString(), JSON.stringify(options?.metadata ?? {}), (existing as any).id);
    } else {
      this.db.prepare(
        `INSERT INTO analyzer_configs (analyzer_name, project_path, is_global, config_json, created_by, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`
      ).run(analyzerName, projectPath, isGlobal ? 1 : 0, JSON.stringify(config),
        new Date().toISOString(), new Date().toISOString(), JSON.stringify(options?.metadata ?? {}));
    }

    return analyzerName;
  }

  /**
   * Retrieve an analyzer config, preferring project-scoped then global.
   * @param analyzerName the analyzer whose configuration to read.
   * @param projectPath when given, look up the project-scoped row first before falling back to the global one.
   * @returns the parsed configuration object, or null when neither scope has a row.
   */
  async getAnalyzerConfig(analyzerName: string, projectPath?: string): Promise<Record<string, any> | null> {
    if (projectPath) {
      const row = this.db.prepare(
        'SELECT config_json FROM analyzer_configs WHERE analyzer_name = ? AND project_path = ? AND is_global = 0'
      ).get(analyzerName, projectPath) as any;
      if (row) return tryParseJson(row.config_json);
    }
    const globalRow = this.db.prepare(
      'SELECT config_json FROM analyzer_configs WHERE analyzer_name = ? AND is_global = 1'
    ).get(analyzerName) as any;
    return globalRow ? tryParseJson(globalRow.config_json) : null;
  }

  /**
   * Return all analyzer configs (global plus project-local when scoped).
   * @param projectPath when given, overlay that project's local configs onto the global set.
   * @returns a map of analyzer name to parsed configuration.
   */
  async getAllAnalyzerConfigs(projectPath?: string): Promise<Record<string, any>> {
    const configs: Record<string, any> = {};

    const globals = this.db.prepare('SELECT analyzer_name, config_json FROM analyzer_configs WHERE is_global = 1').all() as any[];
    for (const c of globals) {
      configs[c.analyzer_name] = tryParseJson(c.config_json);
    }

    if (projectPath) {
      const locals = this.db.prepare(
        'SELECT analyzer_name, config_json FROM analyzer_configs WHERE project_path = ? AND is_global = 0'
      ).all(projectPath) as any[];
      for (const c of locals) {
        configs[c.analyzer_name] = tryParseJson(c.config_json);
      }
    }

    return configs;
  }

  /**
   * Delete an analyzer config, returning whether a row was removed.
   * @param analyzerName the analyzer whose configuration to delete.
   * @param options optional scoping: `projectPath` and `isGlobal` select which row to remove.
   * @returns true when a row was removed, false when nothing matched.
   */
  async deleteAnalyzerConfig(analyzerName: string, options?: { projectPath?: string; isGlobal?: boolean }): Promise<boolean> {
    const result = this.db.prepare(
      'DELETE FROM analyzer_configs WHERE analyzer_name = ? AND COALESCE(project_path, \'__global__\') = ? AND is_global = ?'
    ).run(analyzerName, options?.projectPath ?? '__global__', (options?.isGlobal ?? !options?.projectPath) ? 1 : 0);
    return result.changes > 0;
  }

  /**
   * Delete analyzer configs, scoped to a project when a path is given.
   * @param projectPath when given, delete only that project's local configs; otherwise clear the whole table.
   * @returns a promise that resolves once the config rows are deleted
   */
  async resetAnalyzerConfigs(projectPath?: string): Promise<void> {
    if (projectPath) {
      this.db.prepare('DELETE FROM analyzer_configs WHERE project_path = ? AND is_global = 0').run(projectPath);
    } else {
      this.db.prepare('DELETE FROM analyzer_configs').run();
    }
  }
}
