/**
 * LokiJS `Collection`-compatible facade over a SQLite table. Extracted from
 * `CodeIndexDB` so concern modules (whitelist, project tasks) can construct
 * their own adapter against the shared handle instead of reaching back into
 * the facade.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import {
  ASSERT_TABLE_NAME,
  ASSERT_COLUMN_NAME,
  assertSqlIdentifier,
} from './shared.js';

/** Subset of the LokiJS query shape the adapter translates to SQL. */
export interface LokiFindQuery {
  taskId?: string;
  projectPath?: string;
  status?: string;
  source?: string;
  parentTaskId?: string | null;
  fingerprint?: string;
  [key: string]: any;
}

function isNullClause(key: string): string {
  return `"${key}" IS NULL`;
}
function eqClause(key: string): string {
  return `"${key}" = @${key}`;
}

/**
 * LokiJS `Collection`-compatible facade over a single SQLite table. Translates
 * the subset of the LokiJS query shape concern modules rely on (`find`,
 * `findOne`, `insert`, `update`, `remove`, `clear`, and a chainable builder)
 * into parameterized SQL against the shared handle, so each concern can build
 * its own adapter for its own table instead of reaching back into the facade.
 */
export class SqliteCollectionAdapter {
  /**
   * Bind this adapter to a table on the shared handle, validating the name.
   * @param db The SQLite database handle to run table operations against.
   * @param tableName The table this adapter reads and writes; validated as a SQL identifier.
   */
  constructor(
    private db: SqliteDatabase,
    private tableName: string
  ) {
    assertSqlIdentifier(this.tableName, ASSERT_TABLE_NAME);
  }

  /**
   * Return all rows, or rows matching the query.
   * @param query Optional filter predicates keyed by column, including `$in` / `$lt` operators.
   * @returns The matching rows with their Loki `$loki` row id attached.
   */
  find(query?: LokiFindQuery): any[] {
    if (!query) {
      return (this.db.prepare(`SELECT *, rowid as "$loki" FROM "${this.tableName}"`).all() as any[])
        .map(r => this.unbindRow(r));
    }
    const clauses: string[] = [];
    const params: Record<string, any> = {};
    for (const [key, value] of Object.entries(query)) {
      if (key !== '$loki') assertSqlIdentifier(key, ASSERT_COLUMN_NAME);
      if (value === null || value === undefined) {
        clauses.push(isNullClause(key));
      } else if (key === '$loki' && typeof value === 'object' && value.$in) {
        // Handle $loki: { $in: [...] }
        const placeholders = value.$in.map((_: any, i: number) => `@in_${i}`);
        clauses.push(`rowid IN (${placeholders.join(', ')})`);
        value.$in.forEach((v: any, i: number) => { params[`in_${i}`] = this.bindable(v); });
      } else if (key === 'expiresAt' && typeof value === 'object' && value.$lt) {
        clauses.push(`"expiresAt" < @expiresAt`);
        params['expiresAt'] = value.$lt instanceof Date ? value.$lt.toISOString() : String(value.$lt);
      } else if (key === 'timestamp' && typeof value === 'object' && value.$lt) {
        clauses.push(`"timestamp" < @timestamp`);
        params['timestamp'] = value.$lt instanceof Date ? value.$lt.toISOString() : String(value.$lt);
      } else {
        clauses.push(eqClause(key));
        params[key] = this.bindable(value);
      }
    }
    const sql = `SELECT *, rowid as "$loki" FROM "${this.tableName}"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}`;
    return (this.db.prepare(sql).all(params) as any[]).map(r => this.unbindRow(r));
  }

  /**
   * Return the first row matching the query, or null when none matches.
   * @param query Filter predicates keyed by column; each becomes an equality clause.
   * @returns The first matching row (with `$loki`), or null.
   */
  findOne(query: LokiFindQuery): any | null {
    const clauses: string[] = [];
    const params: Record<string, any> = {};
    for (const [key, value] of Object.entries(query)) {
      if (key !== '$loki') assertSqlIdentifier(key, ASSERT_COLUMN_NAME);
      if (value === null || value === undefined) {
        clauses.push(isNullClause(key));
      } else {
        clauses.push(eqClause(key));
        params[key] = this.bindable(value);
      }
    }
    const sql = `SELECT *, rowid as "$loki" FROM "${this.tableName}"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} LIMIT 1`;
    const row = this.db.prepare(sql).get(params) ?? null;
    return row ? this.unbindRow(row) : null;
  }

  /** Convert a doc value to something SQLite can bind (primitives + Buffer, null). */
  private bindable(v: unknown): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
    return v;
  }

  /** Try to parse a value that looks like serialized JSON back to its native form. */
  private unbindable(v: unknown): unknown {
    if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
      try { return JSON.parse(v); } catch { /* not JSON, leave as string */ }
    }
    return v;
  }

  private unbindRow(row: any): any {
    if (!row) return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = this.unbindable(v);
    }
    return out;
  }

  /**
   * Insert a new row from the document's keys and values.
   * @param doc The document to persist; each key becomes a column, JSON-serialized if needed.
   * @returns The stored document with its new `$loki` row id.
   */
  insert(doc: any): any {
    const keys = Object.keys(doc);
    for (const k of keys) assertSqlIdentifier(k, ASSERT_COLUMN_NAME);
    const vals = keys.map(k => `@${k}`);
    const sql = `INSERT INTO "${this.tableName}" ("${keys.join('", "')}") VALUES (${vals.join(', ')})`;
    const params: Record<string, unknown> = {};
    for (const k of keys) params[k] = this.bindable(doc[k]);
    const info = this.db.prepare(sql).run(params);
    return { ...doc, $loki: Number(info.lastInsertRowid) };
  }

  /**
   * Update an existing row identified by the document's `$loki` id.
   * @param doc The document to update; `$loki` locates the row and `meta` is left untouched.
   */
  update(doc: any): void {
    const keys = Object.keys(doc).filter(k => k !== '$loki' && k !== 'meta');
    const sets: string[] = [];
    const params: Record<string, any> = {};
    for (const k of keys) {
      assertSqlIdentifier(k, ASSERT_COLUMN_NAME);
      sets.push(`"${k}" = @${k}`);
      params[k] = this.bindable(doc[k]);
    }
    params['_rowid'] = doc.$loki;
    this.db.prepare(`UPDATE "${this.tableName}" SET ${sets.join(', ')} WHERE rowid = @_rowid`).run(params);
  }

  /**
   * Delete a single row identified by the document's `$loki` id.
   * @param doc The document to remove; deletion is keyed on its `$loki` row id.
   */
  remove(doc: any): void {
    if (doc.$loki !== undefined) {
      this.db.prepare(`DELETE FROM "${this.tableName}" WHERE rowid = @_rowid`).run({ _rowid: doc.$loki });
    }
  }

  /**
   * Remove all rows matching a query.
   * @param query Filter predicates keyed by column; each becomes a clause on the DELETE.
   */
  findAndRemove(query: LokiFindQuery): void {
    const clauses: string[] = [];
    const params: Record<string, any> = {};
    for (const [key, value] of Object.entries(query)) {
      if (key !== '$loki') assertSqlIdentifier(key, ASSERT_COLUMN_NAME);
      if (value === null || value === undefined) {
        clauses.push(isNullClause(key));
      } else if (key === 'timestamp' && typeof value === 'object' && value.$lt) {
        clauses.push(`"timestamp" < @timestamp`);
        params['timestamp'] = value.$lt instanceof Date ? value.$lt.toISOString() : String(value.$lt);
      } else {
        clauses.push(eqClause(key));
        params[key] = value;
      }
    }
    this.db.prepare(`DELETE FROM "${this.tableName}"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}`).run(params);
  }

  /** Delete every row in the table. */
  clear(): void {
    this.db.prepare(`DELETE FROM "${this.tableName}"`).run();
  }

  /**
   * Return a chainable query builder (find/where/simplesort/limit/data) that
   * lazily loads rows from the table only when a terminal method runs.
   * @returns The chain builder, resolved into a row array by `data()`.
   */
  chain(): any {
    return {
      _table: this.tableName,
      _db: this.db,
      _query: null as LokiFindQuery | null,
      _result: null as any[] | null,
      find(query?: LokiFindQuery) {
        this._query = query ?? null;
        return this;
      },
      where(fn: (r: any) => boolean) {
        if (this._result === null) {
          this._result = this._query !== null
            ? new SqliteCollectionAdapter(this._db, this._table).find(this._query)
            : new SqliteCollectionAdapter(this._db, this._table).find();
        }
        this._result = this._result.filter(fn);
        return this;
      },
      simplesort(field: string, opts: { desc?: boolean } = {}) {
        if (this._result === null) {
          this._result = this._query !== null
            ? new SqliteCollectionAdapter(this._db, this._table).find(this._query)
            : new SqliteCollectionAdapter(this._db, this._table).find();
        }
        this._result.sort((a: any, b: any) => {
          const av = a[field] ?? '';
          const bv = b[field] ?? '';
          if (av < bv) return opts.desc ? 1 : -1;
          if (av > bv) return opts.desc ? -1 : 1;
          return 0;
        });
        return this;
      },
      limit(n: number) {
        if (this._result === null) {
          this._result = this._query !== null
            ? new SqliteCollectionAdapter(this._db, this._table).find(this._query)
            : new SqliteCollectionAdapter(this._db, this._table).find();
        }
        this._result = this._result.slice(0, n);
        return this;
      },
      data() {
        return this._result ?? [];
      }
    };
  }
}
