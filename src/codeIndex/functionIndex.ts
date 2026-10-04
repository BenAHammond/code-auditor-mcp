/**
 * Function-index access — the `functions` table CRUD, row marshalling, and
 * per-file upsert/stale-removal. Extracted from `CodeIndexDB`; holds only the
 * raw SQLite handle. Orchestration that spans concerns (dependency-graph
 * rebuild after a sync, churn/hotspot/convention mining) stays on the facade.
 */

import type { SqliteDatabase, SqliteStatement } from '../sqlite/types.js';
import { tryParseJson } from './shared.js';
import { computeContentHash } from '../utils/contentHash.js';
import { errorMessage } from '../utils/errorMessage.js';
import type { FunctionMetadata, EnhancedFunctionMetadata } from '../types.js';

/** Identity key for a function row: name, file path, and line number. */
function functionRowKey(f: any): string {
  return `${(f as any).name ?? f.name}:${(f as any).filePath ?? f.file_path}:${(f as any).lineNumber ?? f.line_number}`;
}

/** Single-statement upsert for one function row, keyed on
 *  `(name, file_path, line_number)`. Prepared once and reused across a batch so
 *  the per-function write path is a bound `.run`, not a re-parse — the
 *  `ON CONFLICT DO UPDATE` carries both the insert and the update shape, which
 *  removes the per-function `UPDATE`/`INSERT` decision (and its dynamic SET
 *  list) that the previous `syncFileIndexRow` re-prepared on every iteration. */
const SQL_UPSERT_FUNCTION = `
  INSERT INTO functions (name, file_path, line_number, start_line, end_line, language,
    entity_type, component_type, return_type, complexity, is_exported, has_jsdoc,
    jsdoc_description, jsdoc_tags, parameters, type_info, hooks, props,
    used_imports, unused_imports, import_usage, has_unused_imports, dependency_depth,
    purpose, context, body, content_hash, file_hash, last_modified, metadata_json)
  VALUES (@name, @file_path, @line_number, @start_line, @end_line, @language,
    @entity_type, @component_type, @return_type, @complexity, @is_exported, @has_jsdoc,
    @jsdoc_description, @jsdoc_tags, @parameters, @type_info, @hooks, @props,
    @used_imports, @unused_imports, @import_usage, @has_unused_imports, @dependency_depth,
    @purpose, @context, @body, @content_hash, @file_hash, @last_modified, @metadata_json)
  ON CONFLICT(name, file_path, line_number) DO UPDATE SET
    line_number=excluded.line_number, start_line=excluded.start_line, end_line=excluded.end_line,
    language=excluded.language, entity_type=excluded.entity_type, component_type=excluded.component_type,
    return_type=excluded.return_type, complexity=excluded.complexity,
    is_exported=excluded.is_exported, has_jsdoc=excluded.has_jsdoc,
    jsdoc_description=excluded.jsdoc_description, jsdoc_tags=excluded.jsdoc_tags,
    parameters=excluded.parameters, type_info=excluded.type_info, hooks=excluded.hooks, props=excluded.props,
    used_imports=excluded.used_imports, unused_imports=excluded.unused_imports,
    import_usage=excluded.import_usage, has_unused_imports=excluded.has_unused_imports,
    dependency_depth=excluded.dependency_depth,
    purpose=excluded.purpose, context=excluded.context, body=excluded.body,
    content_hash=excluded.content_hash, file_hash=excluded.file_hash, last_modified=excluded.last_modified,
    metadata_json=excluded.metadata_json`;

/** SQLite's bound-variable ceiling for a single statement. The historical
 *  `SQLITE_MAX_VARIABLE_NUMBER` default is 999 (newer builds raise it to 32766);
 *  chunking against the older floor keeps one statement valid on every backend. */
const MAX_SQLITE_BIND_PARAMS = 999;

/** Delete rows for functions that no longer exist in the current set. Batches
 *  the stale ids into chunked `id IN (…)` statements — the per-row DELETE that
 *  preceded this issued one round-trip per removed function, an N+1 on the
 *  write path when a file loses many functions at once. */
function removeStaleFunctionRows(
  db: SqliteDatabase,
  existing: any[],
  currentMap: Map<string, unknown>,
  stats: { removed: number },
): void {
  const staleIds: unknown[] = [];
  for (const e of existing) {
    if (!currentMap.has(functionRowKey(e))) staleIds.push(e.id);
  }

  for (let i = 0; i < staleIds.length; i += MAX_SQLITE_BIND_PARAMS) {
    const chunk = staleIds.slice(i, i + MAX_SQLITE_BIND_PARAMS);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = db
      .prepare(`DELETE FROM functions WHERE id IN (${placeholders})`)
      .run(...chunk);
    stats.removed += result.changes;
  }
}

/**
 * Data access for the `functions` table: CRUD, row marshalling, and per-file
 * upsert/stale-removal.
 */
export class FunctionIndex {
  /**
   * Wrap the shared SQLite handle for function-index access.
   * @param db the SQLite database handle.
   */
  constructor(private db: SqliteDatabase) {}

  /** The single-function upsert statement, parsed once and reused across a
   *  batch. Lazily prepared because the first caller may be either the
   *  per-function `registerFunction` path or the per-file `syncFileIndexRow`
   *  batch path. */
  private upsertStmt?: SqliteStatement;
  private functionUpsertStmt(): SqliteStatement {
    return (this.upsertStmt ??= this.db.prepare(SQL_UPSERT_FUNCTION));
  }

  /**
   * Marshal a DB row into the `EnhancedFunctionMetadata` shape consumers read.
   * @param row the raw `functions` table row.
   * @returns the function metadata with parsed parameters, jsDoc, and metadata fields.
   */
  rowToFunction(row: any): EnhancedFunctionMetadata {
    return {
      name: row.name,
      filePath: row.file_path,
      lineNumber: row.line_number,
      startLine: row.start_line,
      endLine: row.end_line,
      language: row.language,
      dependencies: [],
      purpose: row.purpose ?? '',
      context: row.context ?? '',
      parameters: tryParseJson(row.parameters) ?? [],
      jsDoc: { description: row.jsdoc_description ?? '' },
      imports: [],
      body: row.body ?? '',
      comments: [],
      isAsync: false,
      isGenerator: false,
      returnType: row.return_type,
      visibility: 'public',
      complexity: row.complexity ?? 0,
      content_hash: row.content_hash,
      metadata: tryParseJson(row.metadata_json) ?? {},
      hooks: tryParseJson(row.hooks),
      props: tryParseJson(row.props),
    } as EnhancedFunctionMetadata;
  }

  /**
   * Marshal function metadata into the row shape the `functions` table stores.
   * @param func the function metadata to convert.
   * @param lastModified optional last-modified timestamp to stamp on the row.
   * @param fileHash optional file-level content hash stamped onto the row's
   *   `file_hash` column for diff detection.
   * @returns the row object keyed by the table's column names.
   */
  functionToRow(func: FunctionMetadata | EnhancedFunctionMetadata, lastModified?: string, fileHash?: string): Record<string, any> {
    const enhanced = func as EnhancedFunctionMetadata;
    const jsDoc = (func as any).jsDoc;
    return {
      name: func.name,
      file_path: func.filePath,
      line_number: func.lineNumber ?? 0,
      start_line: (func as any).startLine ?? null,
      end_line: (func as any).endLine ?? null,
      language: func.language ?? 'typescript',
      entity_type: (func.metadata as any)?.entityType ?? 'function',
      component_type: (func.metadata as any)?.componentType ?? null,
      return_type: enhanced.returnType ?? null,
      complexity: enhanced.complexity ?? (func.metadata as any)?.complexity ?? 0,
      is_exported: (func.metadata as any)?.isExported ? 1 : 0,
      has_jsdoc: (jsDoc && jsDoc.description) ? 1 : 0,
      jsdoc_description: typeof jsDoc === 'string' ? jsDoc : (jsDoc?.description ?? ''),
      jsdoc_tags: jsDoc?.tags ? JSON.stringify(jsDoc.tags) : null,
      parameters: enhanced.parameters ? JSON.stringify(enhanced.parameters) : null,
      type_info: (func.metadata as any)?.typeInfo ? JSON.stringify((func.metadata as any).typeInfo) : null,
      hooks: (enhanced as any).hooks ? JSON.stringify((enhanced as any).hooks) : null,
      props: (enhanced as any).props ? JSON.stringify((enhanced as any).props) : null,
      used_imports: (func.metadata as any)?.usedImports ? JSON.stringify((func.metadata as any).usedImports) : null,
      unused_imports: (func.metadata as any)?.unusedImports ? JSON.stringify((func.metadata as any).unusedImports) : null,
      import_usage: (func.metadata as any)?.importUsage ? JSON.stringify((func.metadata as any).importUsage) : null,
      has_unused_imports: (func.metadata as any)?.unusedImports?.length > 0 ? 1 : 0,
      dependency_depth: (func.metadata as any)?.dependencyDepth ?? 0,
      purpose: func.purpose ?? '',
      context: func.context ?? '',
      body: (func as any).body ?? null,
      content_hash: enhanced.content_hash ?? computeContentHash((func as any).body),
      file_hash: fileHash ?? null,
      last_modified: lastModified ?? new Date().toISOString(),
      // body lives only in the dedicated `body` column, never in metadata_json
      // (previously triple-stored). JSON.stringify omits the undefined value, so
      // this strips any stray `body` key at the write boundary.
      metadata_json: func.metadata ? JSON.stringify({ ...func.metadata, body: undefined }) : '{}',
    };
  }

  /**
   * Insert or update a single function row (upsert keyed on name, file, line).
   * @param func the function metadata to persist.
   * @returns a promise that resolves once the row is upserted
   */
  async registerFunction(func: FunctionMetadata | EnhancedFunctionMetadata): Promise<void> {
    const row = this.functionToRow(func);

    try {
      this.functionUpsertStmt().run(row);
    } catch (error) {
      throw new Error(`Failed to register function: ${errorMessage(error)}`);
    }
  }

  /**
   * Register many functions in one transaction, reporting per-function errors.
   * @param functions the function metadata records to persist.
   * @returns a summary with a success flag, registered/failed counts, and per-function error details.
   */
  async registerFunctions(functions: (FunctionMetadata | EnhancedFunctionMetadata)[]): Promise<{
    success: boolean;
    registered: number;
    failed: number;
    errors?: Array<{ function: string; error: string }>;
  }> {
    let registered = 0;
    let failed = 0;
    const errors: Array<{ function: string; error: string }> = [];

    const insertAll = this.db.transaction((funcs: (FunctionMetadata | EnhancedFunctionMetadata)[]) => {
      for (const func of funcs) {
        try {
          this.registerFunction(func);
          registered++;
        } catch (error) {
          failed++;
          errors.push({
            function: func.name || 'unknown',
            error: errorMessage(error)
          });
        }
      }
    });

    insertAll(functions);

    return {
      success: failed === 0,
      registered,
      failed,
      errors: errors
    };
  }

  /**
   * Upsert/remove one file's function rows. Runs inside the caller's
   * transaction (no nested `db.transaction` here) so a batch sync can wrap many
   * files in a single write transaction.
   *
   * @param filePath the file whose function rows are being synced.
   * @param currentFunctions the functions present in the file now.
   * @param stats accumulator the add/update/remove counts are written into.
   * @param lastModified optional last-modified timestamp to stamp on written rows.
   * @param fileHash optional file-level content hash stamped onto each written row
   *   for diff detection.
   */
  syncFileIndexRow(
    filePath: string,
    currentFunctions: (FunctionMetadata | EnhancedFunctionMetadata)[],
    stats: { added: number; updated: number; removed: number },
    lastModified?: string,
    fileHash?: string
  ): void {
    const existing = this.db.prepare(
      'SELECT id, name, file_path, line_number FROM functions WHERE file_path = ?'
    ).all(filePath) as any[];

    const currentMap = new Map(currentFunctions.map(f => [functionRowKey(f), f]));

    // Existing rows keyed by (name, line_number) — file_path is already scoped by
    // the SELECT above — so added-vs-updated is an O(1) map hit instead of the
    // O(n²) `existing.find` scan this replaced.
    const existingByKey = new Map<string, any>(
      existing.map((e) => [`${e.name}:${e.line_number}`, e]),
    );

    // Single prepared upsert reused across the whole file batch: one parse, one
    // bound `.run` per function. `ON CONFLICT DO UPDATE` collapses the previous
    // per-function `UPDATE` vs `INSERT` branch (and its dynamic SET list) into a
    // single statement, removing the prepare-per-iteration N+1 on this write path.
    const upsert = this.functionUpsertStmt();
    for (const func of currentFunctions) {
      const key = `${func.name}:${func.lineNumber}`;
      upsert.run(this.functionToRow(func, lastModified, fileHash));
      if (existingByKey.has(key)) stats.updated++;
      else stats.added++;
    }

    // Remove stale functions
    removeStaleFunctionRows(this.db, existing, currentMap, stats);
  }

  /**
   * Resolve one indexed function by name, optionally scoped to a file.
   * @param name the function name to look up.
   * @param filePath when given, restrict the match to that file.
   * @returns the matching function, or null when no row matches.
   */
  async findDefinition(name: string, filePath?: string): Promise<EnhancedFunctionMetadata | null> {
    let row: any;
    if (filePath) {
      row = this.db.prepare('SELECT * FROM functions WHERE name = ? AND file_path = ?').get(name, filePath);
    } else {
      row = this.db.prepare('SELECT * FROM functions WHERE name = ?').get(name);
    }

    if (!row) return null;
    return this.rowToFunction(row);
  }

  /**
   * Return all indexed functions.
   * @returns every function row marshalled into metadata.
   */
  async getAllFunctions(): Promise<EnhancedFunctionMetadata[]> {
    const rows = this.db.prepare('SELECT * FROM functions').all() as any[];
    return rows.map((r: any) => this.rowToFunction(r));
  }

  /**
   * Row count of the `functions` table — for callers that only need `.length`.
   * @returns the number of indexed function rows.
   */
  async getFunctionCount(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM functions').get() as any;
    return row?.n ?? 0;
  }

  /**
   * Compute aggregate index statistics (function count, languages, top
   * dependencies, files indexed, and last-updated time).
   * @returns the aggregate stats object.
   */
  async getStats(): Promise<{
    totalFunctions: number;
    languages: Record<string, number>;
    topDependencies: Array<{ name: string; count: number }>;
    filesIndexed: number;
    lastUpdated: Date;
  }> {
    const totalFunctions = (this.db.prepare('SELECT COUNT(*) as cnt FROM functions').get() as any).cnt;
    const languages: Record<string, number> = {};
    const langRows = this.db.prepare('SELECT language, COUNT(*) as cnt FROM functions GROUP BY language').all() as any[];
    for (const r of langRows) {
      languages[r.language] = r.cnt;
    }

    const depRows = this.db.prepare(
      'SELECT dependency as name, COUNT(*) as cnt FROM function_dependencies GROUP BY dependency ORDER BY cnt DESC LIMIT 10'
    ).all() as any[];
    const topDependencies = depRows.map((r: any) => ({ name: r.name, count: r.cnt }));

    const filesIndexed = (this.db.prepare('SELECT COUNT(DISTINCT file_path) as cnt FROM functions').get() as any).cnt;

    return {
      totalFunctions,
      languages,
      topDependencies,
      filesIndexed,
      lastUpdated: new Date()
    };
  }
}
