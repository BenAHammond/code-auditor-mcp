/**
 * Schema management + usage — the `schema_definitions` and `schema_usage`
 * tables. Extracted from `CodeIndexDB`; holds only the raw SQLite handle.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { tryParseJson } from './shared.js';
import type {
  SchemaDefinition,
  SchemaIndexMetadata,
  SchemaUsage,
} from '../types.js';

/**
 * Schema management for the `schema_definitions` and `schema_usage` tables.
 * Stores whole-schema snapshots, records per-file/table/function usage rows
 * (upserting on table/file/location identity), and answers usage and aggregate
 * statistics queries for the schema analyzer.
 */
export class SchemaIndex {
  /**
   * Hold the SQLite handle used by all schema management methods.
   * @param db The SQLite database handle to store schemas and usage rows in.
   */
  constructor(private db: SqliteDatabase) {}

  /**
   * Store a schema definition and return its generated schema ID.
   * @param schema The schema snapshot to persist, including its databases and tables.
   * @returns The generated schema ID the snapshot was stored under.
   */
  async storeSchema(schema: SchemaDefinition): Promise<string> {
    const schemaId = `schema_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const metadata: SchemaIndexMetadata = {
      schemaId,
      schemaName: schema.name,
      indexedAt: new Date(),
      tableCount: schema.databases.reduce((acc, db) => acc + db.tables.length, 0),
      relationshipCount: schema.databases.reduce((acc, db) => acc + (db.relationships?.length || 0), 0),
      usagePatterns: [],
      discoveredPatterns: [],
      violations: []
    };

    this.db.prepare(
      'INSERT INTO schema_definitions (schema_id, schema_name, schema_json, metadata_json, indexed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(schemaId, schema.name, JSON.stringify(schema), JSON.stringify(metadata), new Date().toISOString());

    return schemaId;
  }

  /**
   * Retrieve a stored schema by ID.
   * @param schemaId The schema ID to look up.
   * @returns The parsed schema definition, or null when no row matches.
   */
  async getSchema(schemaId: string): Promise<SchemaDefinition | null> {
    const row = this.db.prepare('SELECT schema_json FROM schema_definitions WHERE schema_id = ?').get(schemaId) as any;
    return row ? tryParseJson(row.schema_json) : null;
  }

  /**
   * Return all stored schemas with their indexing metadata.
   * @returns Each stored schema with its parsed metadata and definition.
   */
  async getAllSchemas(): Promise<Array<{ schemaId: string; metadata: SchemaIndexMetadata; schema: SchemaDefinition }>> {
    const rows = this.db.prepare('SELECT schema_id, schema_json, metadata_json FROM schema_definitions').all() as any[];
    return rows.map((r: any) => ({
      schemaId: r.schema_id,
      metadata: tryParseJson(r.metadata_json) ?? {},
      schema: tryParseJson(r.schema_json),
    }));
  }

  /**
   * Delete a schema and its usage rows.
   * @param schemaId The schema ID whose definition and usage rows should be removed.
   * @returns True when a schema definition row was deleted.
   */
  async deleteSchema(schemaId: string): Promise<boolean> {
    this.db.prepare('DELETE FROM schema_usage WHERE schema_id = ?').run(schemaId);
    const result = this.db.prepare('DELETE FROM schema_definitions WHERE schema_id = ?').run(schemaId);
    return result.changes > 0;
  }

  /**
   * Record one schema usage, upserting on table/file/location identity.
   * @param usage The usage observation to record (table, file, function, location).
   * @param schemaId The schema to attribute the usage to; defaults to 'default'.
   * @returns a promise that resolves once the usage row is recorded
   */
  async recordSchemaUsage(usage: SchemaUsage, schemaId?: string): Promise<void> {
    const existing = this.db.prepare(
      'SELECT id FROM schema_usage WHERE table_name = ? AND file_path = ? AND function_start_line IS ? AND function_start_column IS ? AND line = ?'
    ).get(usage.tableName, usage.filePath, usage.functionStartLine ?? null, usage.functionStartColumn ?? null, usage.line);

    if (existing) {
      this.db.prepare(
        'UPDATE schema_usage SET schema_id = ?, function_name = ?, usage_type = ?, "column" = ?, raw_query = ?, parameters = ?, origin = ?, recorded_at = ? WHERE id = ?'
      ).run(schemaId ?? 'default', usage.functionName ?? null, usage.usageType, usage.column ?? null,
        usage.rawQuery ?? null, JSON.stringify(usage.parameters ?? []), usage.origin ?? null,
        new Date().toISOString(), (existing as any).id);
    } else {
      this.db.prepare(
        'INSERT INTO schema_usage (schema_id, table_name, file_path, function_name, function_start_line, function_start_column, usage_type, line, "column", raw_query, parameters, origin, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(schemaId ?? 'default', usage.tableName, usage.filePath, usage.functionName ?? null,
        usage.functionStartLine ?? null, usage.functionStartColumn ?? null,
        usage.usageType, usage.line ?? null, usage.column ?? null,
        usage.rawQuery ?? null, JSON.stringify(usage.parameters ?? []), usage.origin ?? null, new Date().toISOString());
    }
  }

  /**
   * Clear all schema_usage entries for a given file path.
   * Used for idempotent per-file writes during indexing — stale entries
   * from a previous scan are removed before fresh references are inserted.
   * @param filePath The file whose previous usage rows should be removed.
   */
  clearSchemaUsageForFile(filePath: string): void {
    this.db.prepare('DELETE FROM schema_usage WHERE file_path = ?').run(filePath);
  }

  /**
   * Query schema usage entries, filtered by the optional options.
   * @param options Optional filters (schemaId, tableName, filePath, functionName, usageType); empty returns all rows.
   * @returns The matching usage rows in their public SchemaUsage shape.
   */
  async getSchemaUsage(options: {
    schemaId?: string; tableName?: string; filePath?: string; functionName?: string; usageType?: string;
  } = {}): Promise<SchemaUsage[]> {
    const clauses: string[] = [];
    const params: any[] = [];
    if (options.schemaId) { clauses.push('schema_id = ?'); params.push(options.schemaId); }
    if (options.tableName) { clauses.push('table_name = ?'); params.push(options.tableName); }
    if (options.filePath) { clauses.push('file_path = ?'); params.push(options.filePath); }
    if (options.functionName) { clauses.push('function_name = ?'); params.push(options.functionName); }
    if (options.usageType) { clauses.push('usage_type = ?'); params.push(options.usageType); }

    const sql = 'SELECT * FROM schema_usage' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '');
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r: any) => ({
      tableName: r.table_name,
      filePath: r.file_path,
      functionName: r.function_name,
      functionStartLine: r.function_start_line,
      functionStartColumn: r.function_start_column,
      usageType: r.usage_type,
      line: r.line,
      column: r.column,
      rawQuery: r.raw_query,
      parameters: tryParseJson(r.parameters) ?? [],
    }));
  }

  /**
   * Find functions that reference the given table.
   * @param tableName The table whose referencing functions to list.
   * @returns The functions that reference the table, with file and usage type.
   */
  async findFunctionsUsingTable(tableName: string): Promise<Array<{
    functionName: string; filePath: string; usageType: string; line: number;
  }>> {
    const rows = this.db.prepare(
      'SELECT function_name, file_path, usage_type, line FROM schema_usage WHERE table_name = ?'
    ).all(tableName) as any[];
    return rows.map((r: any) => ({
      functionName: r.function_name,
      filePath: r.file_path,
      usageType: r.usage_type,
      line: r.line,
    }));
  }

  /**
   * Compute aggregate schema statistics.
   * @returns Totals plus the most-used tables and per-usage-type counts.
   */
  async getSchemaStats(): Promise<{
    totalSchemas: number; totalTables: number; totalUsagePatterns: number;
    mostUsedTables: Array<{ tableName: string; usageCount: number }>;
    usageByType: Record<string, number>;
  }> {
    const totalSchemas = (this.db.prepare('SELECT COUNT(*) as cnt FROM schema_definitions').get() as any).cnt;
    const totalUsagePatterns = (this.db.prepare('SELECT COUNT(*) as cnt FROM schema_usage').get() as any).cnt;

    const schemas = this.db.prepare('SELECT schema_json FROM schema_definitions').all() as any[];
    const totalTables = schemas.reduce((acc: number, s: any) => {
      const schema = tryParseJson(s.schema_json);
      return acc + (schema?.databases?.reduce((dbAcc: number, db: any) => dbAcc + (db.tables?.length ?? 0), 0) ?? 0);
    }, 0);

    const mostUsedTables = (this.db.prepare(
      'SELECT table_name as tableName, COUNT(*) as usageCount FROM schema_usage GROUP BY table_name ORDER BY usageCount DESC LIMIT 10'
    ).all() as any[]);

    const usageByType: Record<string, number> = {};
    const typeRows = this.db.prepare(
      'SELECT usage_type, COUNT(*) as cnt FROM schema_usage GROUP BY usage_type'
    ).all() as any[];
    for (const r of typeRows) {
      usageByType[r.usage_type] = r.cnt;
    }

    return { totalSchemas, totalTables, totalUsagePatterns, mostUsedTables, usageByType };
  }
}
