/**
 * Code Index Database using SQLite (better-sqlite3) + FTS5
 * Replaces LokiJS + FlexSearch with durable, transactional storage.
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { discoverFiles, ALL_EXTENSIONS } from './utils/fileDiscovery.js';
import type {
  CompleteProjectTaskResult,
  CreateProjectTaskInput,
  ListProjectTasksOptions,
  ListProjectTasksTreeNode,
  ProjectTask,
  ProjectTaskDeleteMode,
  ProjectTaskDocument
} from './types/projectTask.js';
import { ProjectTaskRepository } from './services/ProjectTaskRepository.js';
import {
  EnhancedFunctionMetadata,
  FunctionMetadata,
  SearchResult,
  SearchOptions,
  ParsedQuery,
  AnalyzerConfigDocument,
  SchemaDefinition,
  SchemaIndexMetadata,
  SchemaUsage
} from './types.js';
import { QueryParser, compileToSQL } from './search/QueryParser.js';
import type { SqlQuery } from './search/QueryParser.js';
import { getPersistedStorageRoot, resolvePersistedIndexPath } from './dataPaths.js';
import { ContextualError, getErrnoCode } from './mcpToolErrors.js';
import {
  WhitelistEntry,
  WhitelistType,
  WhitelistStatus,
  WhitelistSuggestion
} from './types/whitelist.js';

// Types
interface FunctionDocument extends EnhancedFunctionMetadata {
  $loki?: number;
  meta?: any;
}

// ── Content hash ────────────────────────────────────────────────────────

function computeContentHash(body: string | undefined, signature: string | undefined): string {
  const normalized = (body ?? '').replace(/\s+/g, ' ').trim() + '|' + (signature ?? '').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

// ── SqliteCollectionAdapter ─────────────────────────────────────────────
// Presents a LokiJS Collection-like interface backed by a SQLite table,
// so ProjectTaskRepository works without modification.

interface LokiFindQuery {
  taskId?: string;
  projectPath?: string;
  status?: string;
  source?: string;
  parentTaskId?: string | null;
  fingerprint?: string;
  [key: string]: any;
}

class SqliteCollectionAdapter {
  constructor(
    private db: Database.Database,
    private tableName: string
  ) {}

  /** Return all rows, or rows matching the query. */
  find(query?: LokiFindQuery): any[] {
    if (!query) {
      return (this.db.prepare(`SELECT *, rowid as "$loki" FROM "${this.tableName}"`).all() as any[])
        .map(r => this.unbindRow(r));
    }
    const clauses: string[] = [];
    const params: Record<string, any> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) {
        clauses.push(`"${key}" IS NULL`);
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
        clauses.push(`"${key}" = @${key}`);
        params[key] = this.bindable(value);
      }
    }
    const sql = `SELECT *, rowid as "$loki" FROM "${this.tableName}"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}`;
    return (this.db.prepare(sql).all(params) as any[]).map(r => this.unbindRow(r));
  }

  findOne(query: LokiFindQuery): any | null {
    const clauses: string[] = [];
    const params: Record<string, any> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) {
        clauses.push(`"${key}" IS NULL`);
      } else {
        clauses.push(`"${key}" = @${key}`);
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

  insert(doc: any): any {
    const keys = Object.keys(doc);
    const vals = keys.map(k => `@${k}`);
    const sql = `INSERT INTO "${this.tableName}" ("${keys.join('", "')}") VALUES (${vals.join(', ')})`;
    const params: Record<string, unknown> = {};
    for (const k of keys) params[k] = this.bindable(doc[k]);
    const info = this.db.prepare(sql).run(params);
    return { ...doc, $loki: Number(info.lastInsertRowid) };
  }

  update(doc: any): void {
    const keys = Object.keys(doc).filter(k => k !== '$loki' && k !== 'meta');
    const sets = keys.map(k => `"${k}" = @${k}`);
    const params: Record<string, any> = {};
    for (const k of keys) params[k] = this.bindable(doc[k]);
    params['_rowid'] = doc.$loki;
    this.db.prepare(`UPDATE "${this.tableName}" SET ${sets.join(', ')} WHERE rowid = @_rowid`).run(params);
  }

  remove(doc: any): void {
    if (doc.$loki !== undefined) {
      this.db.prepare(`DELETE FROM "${this.tableName}" WHERE rowid = @_rowid`).run({ _rowid: doc.$loki });
    }
  }

  /** Remove all rows matching a query. */
  findAndRemove(query: LokiFindQuery): void {
    const clauses: string[] = [];
    const params: Record<string, any> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) {
        clauses.push(`"${key}" IS NULL`);
      } else if (key === 'timestamp' && typeof value === 'object' && value.$lt) {
        clauses.push(`"timestamp" < @timestamp`);
        params['timestamp'] = value.$lt instanceof Date ? value.$lt.toISOString() : String(value.$lt);
      } else {
        clauses.push(`"${key}" = @${key}`);
        params[key] = value;
      }
    }
    this.db.prepare(`DELETE FROM "${this.tableName}"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}`).run(params);
  }

  clear(): void {
    this.db.prepare(`DELETE FROM "${this.tableName}"`).run();
  }

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

// ── Main class ──────────────────────────────────────────────────────────

export class CodeIndexDB {
  private static instance: CodeIndexDB;
  /** Subclasses (e.g. EnhancedCodeIndexDB) need access for extra tables without `as any`. */
  protected db!: Database.Database;

  /** Public access to raw SQLite handle — used by ledger writes from external surfaces. */
  get rawDb(): Database.Database {
    return this.db;
  }
  private dbPath: string;
  private isInitialized = false;
  private initializePromise: Promise<void> | null = null;

  // Collection adapters (preserve naming for internal clarity)
  private functionsAdapter!: SqliteCollectionAdapter;
  private whitelistAdapter!: SqliteCollectionAdapter;
  private auditResultsAdapter!: SqliteCollectionAdapter;
  private analyzerConfigAdapter!: SqliteCollectionAdapter;
  private codeMapAdapter!: SqliteCollectionAdapter;
  private schemaAdapter!: SqliteCollectionAdapter;
  private schemaUsageAdapter!: SqliteCollectionAdapter;
  private tasksAdapter!: SqliteCollectionAdapter;

  private taskRepository: ProjectTaskRepository | null = null;
  private stmts: Map<string, Database.Statement> = new Map();

  // ── Schema version ──────────────────────────────────────────────────
  private static readonly SCHEMA_VERSION = 2;

  constructor(dbPath: string = ':memory:') {
    this.dbPath = dbPath === ':memory:' ? dbPath : path.resolve(dbPath);
  }

  // ── Singleton ───────────────────────────────────────────────────────

  static getInstance(dbPath?: string): CodeIndexDB {
    if (!CodeIndexDB.instance) {
      const resolved =
        dbPath !== undefined && dbPath !== ''
          ? path.resolve(dbPath)
          : resolvePersistedIndexPath();
      CodeIndexDB.instance = new CodeIndexDB(resolved);
    }
    return CodeIndexDB.instance;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }
    this.initializePromise = this.initializeInternal();
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  private async initializeInternal(): Promise<void> {
    if (this.isInitialized) return;

    // Ensure parent directory exists
    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      const storageRoot = getPersistedStorageRoot();
      try {
        let st: Awaited<ReturnType<typeof fs.stat>> | undefined;
        try {
          st = await fs.stat(dir);
        } catch (e: unknown) {
          const code = getErrnoCode(e);
          if (code && code !== 'ENOENT') {
            throw new ContextualError(
              `Cannot access code index storage directory (${code}): ${dir}`,
              { errnoCode: code, storageRoot, dbPath: this.dbPath,
                hint: 'Fix permissions or set CODE_AUDITOR_DATA_DIR / --data-dir to a writable directory.' },
              e instanceof Error ? e : undefined
            );
          }
        }
        if (st && !st.isDirectory()) {
          throw new ContextualError(
            `Code index storage path exists but is not a directory: ${dir}`,
            { storageRoot, dbPath: this.dbPath,
              hint: 'Remove the conflicting file/path or choose a different CODE_AUDITOR_DATA_DIR / --data-dir.' }
          );
        }
        await fs.mkdir(dir, { recursive: true });
      } catch (e: unknown) {
        if (e instanceof ContextualError) throw e;
        const code = getErrnoCode(e);
        throw new ContextualError(
          `Failed to prepare code index storage: ${e instanceof Error ? e.message : String(e)}`,
          { ...(code && { errnoCode: code }), storageRoot, dbPath: this.dbPath,
            hint: 'Ensure the storage directory is writable (default: <cwd>/.code-index when CODE_AUDITOR_DATA_DIR is unset).' },
          e instanceof Error ? e : undefined
        );
      }
    }

    // Check for LokiJS migration
    const migrationResult = this.maybeMigrateFromLokiJS();

    // Open SQLite database
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    } catch (e: unknown) {
      const code = getErrnoCode(e);
      throw new ContextualError(
        `Failed to open code index database: ${e instanceof Error ? e.message : String(e)}`,
        { ...(code && { errnoCode: code }), dbPath: this.dbPath,
          hint: 'The index file may be corrupted, locked, or on a read-only volume. Try a different CODE_AUDITOR_DATA_DIR.' },
        e instanceof Error ? e : undefined
      );
    }

    // Create schema
    this.createSchema();

    // Initialize collection adapters
    this.functionsAdapter = new SqliteCollectionAdapter(this.db, 'functions');
    this.whitelistAdapter = new SqliteCollectionAdapter(this.db, 'whitelist');
    this.auditResultsAdapter = new SqliteCollectionAdapter(this.db, 'audit_results');
    this.analyzerConfigAdapter = new SqliteCollectionAdapter(this.db, 'analyzer_configs');
    this.codeMapAdapter = new SqliteCollectionAdapter(this.db, 'code_maps');
    this.schemaAdapter = new SqliteCollectionAdapter(this.db, 'schema_definitions');
    this.schemaUsageAdapter = new SqliteCollectionAdapter(this.db, 'schema_usage');
    this.tasksAdapter = new SqliteCollectionAdapter(this.db, 'project_tasks');

    // Init defaults
    const whitelistCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM whitelist').get() as any).cnt;
    if (whitelistCount === 0) {
      await this.initializeDefaultWhitelists();
    }

    // Auto-sync if we just migrated
    if (migrationResult.migrated) {
      const funcCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM functions').get() as any).cnt;
      if (funcCount === 0) {
        try {
          await this.deepSync();
        } catch {
          // Silently skip — index will be rebuilt on next sync
        }
      }
    }

    this.isInitialized = true;
  }

  // ── Schema migrations ────────────────────────────────────────────────

  private runMigrations(): void {
    // Read the currently stored schema version (if any)
    const row = this.db.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    ).get() as { value: string } | undefined;

    const currentVersion = row ? parseInt(row.value, 10) : 0;

    // Migration 1 → 2: Unique index on (name, file_path, line_number)
    // Previously the unique index was on (name, file_path) only, which caused
    // same-named functions at different lines in the same file to collide.
    if (currentVersion < 2) {
      this.db.exec(`
        DROP INDEX IF EXISTS idx_functions_name_file;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_functions_name_file_line ON functions(name, file_path, line_number);
      `);
    }
  }

  // ── SQLite schema ───────────────────────────────────────────────────

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS functions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        name              TEXT NOT NULL,
        file_path         TEXT NOT NULL,
        line_number       INTEGER,
        start_line        INTEGER,
        end_line          INTEGER,
        language          TEXT DEFAULT 'typescript',
        entity_type       TEXT DEFAULT 'function',
        component_type    TEXT,
        signature         TEXT,
        return_type       TEXT,
        complexity        INTEGER DEFAULT 0,
        is_exported       INTEGER DEFAULT 0,
        has_jsdoc         INTEGER DEFAULT 0,
        jsdoc_description TEXT,
        jsdoc_tags        TEXT,
        parameters        TEXT,
        type_info         TEXT,
        hooks             TEXT,
        props             TEXT,
        used_imports      TEXT,
        unused_imports    TEXT,
        import_usage      TEXT,
        has_unused_imports INTEGER DEFAULT 0,
        dependency_depth  INTEGER DEFAULT 0,
        purpose           TEXT DEFAULT '',
        context           TEXT DEFAULT '',
        body              TEXT,
        content_hash      TEXT,
        last_modified     TEXT,
        metadata_json     TEXT,
        created_at        TEXT DEFAULT (datetime('now')),
        updated_at        TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
      CREATE INDEX IF NOT EXISTS idx_functions_file_path ON functions(file_path);
      CREATE INDEX IF NOT EXISTS idx_functions_language ON functions(language);
      CREATE INDEX IF NOT EXISTS idx_functions_entity_type ON functions(entity_type);
      CREATE INDEX IF NOT EXISTS idx_functions_complexity ON functions(complexity);
      CREATE INDEX IF NOT EXISTS idx_functions_content_hash ON functions(content_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_functions_name_file_line ON functions(name, file_path, line_number);

      CREATE VIRTUAL TABLE IF NOT EXISTS functions_fts USING fts5(
        name, signature, jsdoc_description, purpose, context, body,
        content='functions', content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS functions_ai AFTER INSERT ON functions BEGIN
        INSERT INTO functions_fts(rowid, name, signature, jsdoc_description, purpose, context, body)
        VALUES (new.id, new.name, new.signature, new.jsdoc_description, new.purpose, new.context, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS functions_ad AFTER DELETE ON functions BEGIN
        INSERT INTO functions_fts(functions_fts, rowid, name, signature, jsdoc_description, purpose, context, body)
        VALUES ('delete', old.id, old.name, old.signature, old.jsdoc_description, old.purpose, old.context, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS functions_au AFTER UPDATE ON functions BEGIN
        INSERT INTO functions_fts(functions_fts, rowid, name, signature, jsdoc_description, purpose, context, body)
        VALUES ('delete', old.id, old.name, old.signature, old.jsdoc_description, old.purpose, old.context, old.body);
        INSERT INTO functions_fts(rowid, name, signature, jsdoc_description, purpose, context, body)
        VALUES (new.id, new.name, new.signature, new.jsdoc_description, new.purpose, new.context, new.body);
      END;

      CREATE TABLE IF NOT EXISTS function_calls (
        caller_id   INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
        callee_name TEXT NOT NULL,
        PRIMARY KEY (caller_id, callee_name)
      );
      CREATE INDEX IF NOT EXISTS idx_function_calls_callee ON function_calls(callee_name);

      CREATE TABLE IF NOT EXISTS function_dependencies (
        function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
        dependency  TEXT NOT NULL,
        PRIMARY KEY (function_id, dependency)
      );
      CREATE INDEX IF NOT EXISTS idx_function_dependencies_dep ON function_dependencies(dependency);

      CREATE TABLE IF NOT EXISTS whitelist (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        type         TEXT NOT NULL,
        status       TEXT DEFAULT 'Active',
        category     TEXT,
        description  TEXT,
        patterns     TEXT,
        added_by     TEXT DEFAULT 'system',
        added_at     TEXT DEFAULT (datetime('now')),
        updated_at   TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_whitelist_name ON whitelist(name);
      CREATE INDEX IF NOT EXISTS idx_whitelist_type ON whitelist(type);
      CREATE INDEX IF NOT EXISTS idx_whitelist_status ON whitelist(status);

      CREATE TABLE IF NOT EXISTS audit_results (
        audit_id              TEXT PRIMARY KEY,
        timestamp             TEXT NOT NULL,
        project_path          TEXT NOT NULL,
        summary_json          TEXT NOT NULL,
        analyzer_results_json TEXT NOT NULL,
        violations_json       TEXT,
        recommendations_json  TEXT,
        metadata_json         TEXT,
        expires_at            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_results_timestamp ON audit_results(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_results_project_path ON audit_results(project_path);

      CREATE TABLE IF NOT EXISTS analyzer_configs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        analyzer_name TEXT NOT NULL,
        project_path  TEXT,
        is_global     INTEGER DEFAULT 0,
        config_json   TEXT NOT NULL DEFAULT '{}',
        version       TEXT,
        created_by    TEXT DEFAULT 'system',
        created_at    TEXT DEFAULT (datetime('now')),
        updated_at    TEXT DEFAULT (datetime('now')),
        metadata_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_analyzer_configs_key
        ON analyzer_configs(analyzer_name, COALESCE(project_path, '__global__'), is_global);

      CREATE TABLE IF NOT EXISTS code_maps (
        map_id        TEXT NOT NULL,
        section_type  TEXT NOT NULL,
        content       TEXT NOT NULL,
        metadata_json TEXT DEFAULT '{}',
        timestamp     TEXT DEFAULT (datetime('now')),
        size          INTEGER DEFAULT 0,
        PRIMARY KEY (map_id, section_type)
      );
      CREATE INDEX IF NOT EXISTS idx_code_maps_timestamp ON code_maps(timestamp);

      CREATE TABLE IF NOT EXISTS schema_definitions (
        schema_id     TEXT PRIMARY KEY,
        schema_name   TEXT,
        schema_json   TEXT NOT NULL,
        metadata_json TEXT,
        indexed_at    TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS schema_usage (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_id     TEXT,
        table_name    TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        function_name TEXT NOT NULL,
        usage_type    TEXT NOT NULL,
        line          INTEGER,
        "column"      INTEGER,
        raw_query     TEXT,
        parameters    TEXT,
        recorded_at   TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_schema_usage_table ON schema_usage(table_name);
      CREATE INDEX IF NOT EXISTS idx_schema_usage_file ON schema_usage(file_path);
      CREATE INDEX IF NOT EXISTS idx_schema_usage_function ON schema_usage(function_name);

      CREATE TABLE IF NOT EXISTS project_tasks (
        taskId         TEXT PRIMARY KEY,
        projectPath    TEXT NOT NULL,
        title          TEXT NOT NULL,
        description    TEXT DEFAULT '',
        status         TEXT DEFAULT 'pending',
        priority       TEXT DEFAULT 'medium',
        labels         TEXT DEFAULT '[]',
        source         TEXT DEFAULT 'manual',
        parentTaskId   TEXT,
        blockedBy      TEXT DEFAULT '[]',
        dueAt          TEXT,
        sortOrder      INTEGER DEFAULT 0,
        relatedFiles   TEXT DEFAULT '[]',
        relatedSymbols TEXT DEFAULT '[]',
        fingerprint    TEXT,
        metadata       TEXT DEFAULT '{}',
        createdAt      TEXT DEFAULT (datetime('now')),
        updatedAt      TEXT DEFAULT (datetime('now')),
        completedAt    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(projectPath);
      CREATE INDEX IF NOT EXISTS idx_project_tasks_status ON project_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_project_tasks_source ON project_tasks(source);
      CREATE INDEX IF NOT EXISTS idx_project_tasks_fingerprint ON project_tasks(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_project_tasks_sort ON project_tasks(sortOrder);

      -- Spec 11 R1 — Findings Ledger: append-only audit history
      CREATE TABLE IF NOT EXISTS findings_ledger_runs (
        run_id       TEXT PRIMARY KEY,
        timestamp    TEXT NOT NULL,
        git_sha      TEXT,
        git_dirty    INTEGER NOT NULL DEFAULT 0,
        tool_version TEXT NOT NULL,
        command      TEXT NOT NULL,
        surface      TEXT NOT NULL,
        scope        TEXT NOT NULL,
        target       TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        exit_status  INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS findings_ledger_findings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       TEXT NOT NULL REFERENCES findings_ledger_runs(run_id) ON DELETE CASCADE,
        analyzer     TEXT NOT NULL,
        rule         TEXT NOT NULL,
        severity     TEXT NOT NULL,
        message      TEXT NOT NULL,
        file         TEXT NOT NULL,
        line         INTEGER,
        symbol       TEXT DEFAULT '',
        fingerprint  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_runs_surface    ON findings_ledger_runs(surface);
      CREATE INDEX IF NOT EXISTS idx_ledger_runs_timestamp   ON findings_ledger_runs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ledger_findings_run     ON findings_ledger_findings(run_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_findings_fp      ON findings_ledger_findings(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_ledger_findings_rule    ON findings_ledger_findings(analyzer, rule);
    `);

    // Run schema migrations
    this.runMigrations();

    // Record schema version
    this.db.prepare(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`
    ).run(String(CodeIndexDB.SCHEMA_VERSION));
  }

  // ── LokiJS migration ────────────────────────────────────────────────

  private maybeMigrateFromLokiJS(): { migrated: boolean; counts?: { tasks: number; configs: number; whitelist: number } } {
    if (this.dbPath === ':memory:') return { migrated: false };

    const bakPath = this.dbPath + '.loki.bak';
    // If backup already exists alongside a valid SQLite db, skip
    try {
      const st = require('fs').statSync(bakPath);
      if (st.isFile()) {
        // Check if SQLite db exists
        try {
          require('fs').statSync(this.dbPath);
          return { migrated: false };
        } catch { /* fall through */ }
      }
    } catch { /* no backup */ }

    // Check if dbPath is a LokiJS file
    try {
      const raw = require('fs').readFileSync(this.dbPath, 'utf-8');
      if (!raw.startsWith('{"filename":') && !raw.includes('"collections":')) {
        return { migrated: false };
      }
    } catch {
      return { migrated: false };
    }

    // It's LokiJS — migrate
    try {
      const content = require('fs').readFileSync(this.dbPath, 'utf-8');
      const data = JSON.parse(content);

      // LokiJS stores collections as an array of {name, data, ...}
      const collArray: Array<{ name: string; data: any[] }> = Array.isArray(data.collections)
        ? data.collections
        : [];
      const collections: Record<string, any[]> = {};
      for (const c of collArray) {
        collections[c.name] = c.data ?? [];
      }

      // Rename old LokiJS file FIRST, then create fresh SQLite DB
      require('fs').renameSync(this.dbPath, bakPath);

      const migDb = new Database(this.dbPath);
      migDb.pragma('journal_mode = WAL');
      migDb.pragma('foreign_keys = ON');

      // User-authored tables only (function index gets rebuilt by sync).
      // whitelist + analyzer_configs use snake_case (matching raw SQL queries in the main code).
      // project_tasks uses camelCase (matching ProjectTaskRepository document fields).
      migDb.exec(`
        CREATE TABLE IF NOT EXISTS whitelist (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT NOT NULL,
          type         TEXT NOT NULL,
          status       TEXT DEFAULT 'Active',
          category     TEXT,
          description  TEXT,
          patterns     TEXT,
          added_by     TEXT DEFAULT 'system',
          added_at     TEXT DEFAULT (datetime('now')),
          updated_at   TEXT,
          metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS analyzer_configs (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          analyzer_name TEXT NOT NULL,
          project_path  TEXT,
          is_global     INTEGER DEFAULT 0,
          config_json   TEXT NOT NULL DEFAULT '{}',
          version       TEXT,
          created_by    TEXT DEFAULT 'system',
          created_at    TEXT DEFAULT (datetime('now')),
          updated_at    TEXT DEFAULT (datetime('now')),
          metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS project_tasks (
          taskId         TEXT PRIMARY KEY,
          projectPath    TEXT NOT NULL,
          title          TEXT NOT NULL,
          description    TEXT DEFAULT '',
          status         TEXT DEFAULT 'pending',
          priority       TEXT DEFAULT 'medium',
          labels         TEXT DEFAULT '[]',
          source         TEXT DEFAULT 'manual',
          parentTaskId   TEXT,
          blockedBy      TEXT DEFAULT '[]',
          dueAt          TEXT,
          sortOrder      INTEGER DEFAULT 0,
          relatedFiles   TEXT DEFAULT '[]',
          relatedSymbols TEXT DEFAULT '[]',
          fingerprint    TEXT,
          metadata       TEXT DEFAULT '{}',
          createdAt      TEXT DEFAULT (datetime('now')),
          updatedAt      TEXT DEFAULT (datetime('now')),
          completedAt    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_project_tasks_fingerprint ON project_tasks(fingerprint);
      `);

      let taskCount = 0;
      let configCount = 0;
      let whitelistCount = 0;

      // Migrate tasks
      const tasksData = collections['projectTasks'] ?? [];
      const insertTask = migDb.prepare(`INSERT OR IGNORE INTO project_tasks
        (taskId, projectPath, title, description, status, priority, labels, source,
         parentTaskId, blockedBy, dueAt, sortOrder, relatedFiles, relatedSymbols,
         fingerprint, metadata, createdAt, updatedAt, completedAt)
        VALUES (@taskId, @projectPath, @title, @description, @status, @priority, @labels, @source,
                @parentTaskId, @blockedBy, @dueAt, @sortOrder, @relatedFiles, @relatedSymbols,
                @fingerprint, @metadata, @createdAt, @updatedAt, @completedAt)`);
      for (const t of tasksData) {
        insertTask.run({
          taskId: t.taskId ?? '',
          projectPath: t.projectPath ?? '',
          title: t.title ?? '',
          description: t.description ?? '',
          status: t.status ?? 'pending',
          priority: t.priority ?? 'medium',
          labels: JSON.stringify(t.labels ?? []),
          source: t.source ?? 'manual',
          parentTaskId: t.parentTaskId ?? null,
          blockedBy: JSON.stringify(t.blockedBy ?? []),
          dueAt: t.dueAt ?? null,
          sortOrder: t.sortOrder ?? 0,
          relatedFiles: JSON.stringify(t.relatedFiles ?? []),
          relatedSymbols: JSON.stringify(t.relatedSymbols ?? []),
          fingerprint: t.fingerprint ?? null,
          metadata: JSON.stringify(t.metadata ?? t.metadata_json ?? {}),
          createdAt: t.createdAt ?? t.created_at ?? new Date().toISOString(),
          updatedAt: t.updatedAt ?? t.updated_at ?? new Date().toISOString(),
          completedAt: t.completedAt ?? t.completed_at ?? null,
        });
        taskCount++;
      }

      // Migrate analyzer configs (snake_case columns matching createSchema)
      const configsData = collections['analyzerConfigs'] ?? [];
      const insertConfig = migDb.prepare(`INSERT OR IGNORE INTO analyzer_configs
        (analyzer_name, project_path, is_global, config_json, version, created_by, created_at, updated_at, metadata_json)
        VALUES (@analyzerName, @projectPath, @isGlobal, @configJson, @version, @createdBy, @createdAt, @updatedAt, @metadataJson)`);
      for (const c of configsData) {
        insertConfig.run({
          analyzerName: c.analyzerName ?? '',
          projectPath: c.projectPath ?? null,
          isGlobal: c.isGlobal ? 1 : 0,
          configJson: typeof c.config_json === 'string'
            ? c.config_json
            : JSON.stringify(c.config ?? c.config_json ?? {}),
          version: c.version ?? null,
          createdBy: c.createdBy ?? c.created_by ?? 'system',
          createdAt: c.createdAt ?? c.created_at ?? new Date().toISOString(),
          updatedAt: c.updatedAt ?? c.updated_at ?? new Date().toISOString(),
          metadataJson: JSON.stringify(c.metadata ?? c.metadata_json ?? {}),
        });
        configCount++;
      }

      // Migrate whitelist (snake_case columns matching createSchema)
      const whitelistData = collections['whitelist'] ?? [];
      const insertWl = migDb.prepare(`INSERT OR IGNORE INTO whitelist
        (name, type, status, category, description, patterns, added_by, added_at, updated_at, metadata_json)
        VALUES (@name, @type, @status, @category, @description, @patterns, @addedBy, @addedAt, @updatedAt, @metadataJson)`);
      for (const w of whitelistData) {
        insertWl.run({
          name: w.name ?? '',
          type: w.type ?? 'PlatformAPI',
          status: w.status ?? 'Active',
          category: w.category ?? null,
          description: w.description ?? null,
          patterns: JSON.stringify(w.patterns ?? []),
          addedBy: w.addedBy ?? w.added_by ?? 'system',
          addedAt: w.addedAt ?? w.added_at ?? new Date().toISOString(),
          updatedAt: w.updatedAt ?? w.updated_at ?? null,
          metadataJson: JSON.stringify(w.metadata ?? w.metadata_json ?? {}),
        });
        whitelistCount++;
      }

      migDb.close();

      const countLine = [
        taskCount && `${taskCount} tasks`,
        configCount && `${configCount} analyzer configs`,
        whitelistCount && `${whitelistCount} whitelist entries`,
      ].filter(Boolean).join(', ') || '0 entries';
      console.log(`[code-auditor] Migrated ${countLine} from LokiJS to SQLite. Old file saved as ${path.basename(bakPath)}`);
      return { migrated: true, counts: { tasks: taskCount, configs: configCount, whitelist: whitelistCount } };
    } catch (err) {
      // Migration failed — try to restore the backup
      console.error('[code-auditor] LokiJS migration failed:', err instanceof Error ? err.message : String(err));
      try {
        if (require('fs').existsSync(bakPath) && !require('fs').existsSync(this.dbPath)) {
          require('fs').renameSync(bakPath, this.dbPath);
        }
      } catch { /* best effort */ }
      return { migrated: false };
    }
  }

  // ── Init guard ──────────────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
  }

  // ── Helpers: row → EnhancedFunctionMetadata ─────────────────────────

  private rowToFunction(row: any): EnhancedFunctionMetadata {
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
      signature: row.signature ?? '',
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

  private functionToRow(func: FunctionMetadata | EnhancedFunctionMetadata): Record<string, any> {
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
      signature: enhanced.signature ?? '',
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
      body: (func as any).body ?? (func.metadata as any)?.body ?? null,
      content_hash: enhanced.content_hash ?? computeContentHash((func as any).body ?? (func.metadata as any)?.body, enhanced.signature),
      last_modified: new Date().toISOString(),
      metadata_json: func.metadata ? JSON.stringify(func.metadata) : '{}',
    };
  }

  // ── Function CRUD ───────────────────────────────────────────────────

  async registerFunction(func: FunctionMetadata | EnhancedFunctionMetadata): Promise<void> {
    this.ensureInitialized();
    const row = this.functionToRow(func);

    try {
      this.db.prepare(`
        INSERT INTO functions (name, file_path, line_number, start_line, end_line, language,
          entity_type, component_type, signature, return_type, complexity, is_exported, has_jsdoc,
          jsdoc_description, jsdoc_tags, parameters, type_info, hooks, props,
          used_imports, unused_imports, import_usage, has_unused_imports, dependency_depth,
          purpose, context, body, content_hash, last_modified, metadata_json)
        VALUES (@name, @file_path, @line_number, @start_line, @end_line, @language,
          @entity_type, @component_type, @signature, @return_type, @complexity, @is_exported, @has_jsdoc,
          @jsdoc_description, @jsdoc_tags, @parameters, @type_info, @hooks, @props,
          @used_imports, @unused_imports, @import_usage, @has_unused_imports, @dependency_depth,
          @purpose, @context, @body, @content_hash, @last_modified, @metadata_json)
        ON CONFLICT(name, file_path, line_number) DO UPDATE SET
          line_number=excluded.line_number, start_line=excluded.start_line, end_line=excluded.end_line,
          language=excluded.language, entity_type=excluded.entity_type, component_type=excluded.component_type,
          signature=excluded.signature, return_type=excluded.return_type, complexity=excluded.complexity,
          is_exported=excluded.is_exported, has_jsdoc=excluded.has_jsdoc,
          jsdoc_description=excluded.jsdoc_description, jsdoc_tags=excluded.jsdoc_tags,
          parameters=excluded.parameters, type_info=excluded.type_info, hooks=excluded.hooks, props=excluded.props,
          used_imports=excluded.used_imports, unused_imports=excluded.unused_imports,
          import_usage=excluded.import_usage, has_unused_imports=excluded.has_unused_imports,
          dependency_depth=excluded.dependency_depth,
          purpose=excluded.purpose, context=excluded.context, body=excluded.body,
          content_hash=excluded.content_hash, last_modified=excluded.last_modified,
          metadata_json=excluded.metadata_json
      `).run(row);
    } catch (error) {
      throw new Error(`Failed to register function: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async registerFunctions(functions: (FunctionMetadata | EnhancedFunctionMetadata)[]): Promise<{
    success: boolean;
    registered: number;
    failed: number;
    errors?: Array<{ function: string; error: string }>;
  }> {
    this.ensureInitialized();
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
            error: error instanceof Error ? error.message : 'Unknown error'
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

  async syncFileIndex(filePath: string, currentFunctions: (FunctionMetadata | EnhancedFunctionMetadata)[]): Promise<{
    added: number;
    updated: number;
    removed: number;
  }> {
    this.ensureInitialized();
    const stats = { added: 0, updated: 0, removed: 0 };

    const txn = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT id, name, file_path, line_number FROM functions WHERE file_path = ?'
      ).all(filePath) as any[];

      const createKey = (f: any) => `${(f as any).name ?? f.name}:${(f as any).filePath ?? f.file_path}:${(f as any).lineNumber ?? f.line_number}`;
      const currentMap = new Map(currentFunctions.map(f => [createKey(f), f]));

      // Insert/update current functions
      for (const func of currentFunctions) {
        const exists = existing.find(e => e.name === func.name && e.line_number === func.lineNumber);
        if (exists) {
          const row = this.functionToRow(func);
          const keys = Object.keys(row);
          const sets = keys.filter(k => k !== 'name' && k !== 'file_path').map(k => `"${k}" = @${k}`);
          const params = { ...row, _id: exists.id };
          this.db.prepare(`UPDATE functions SET ${sets.join(', ')} WHERE id = @_id`).run(params);
          stats.updated++;
        } else {
          const row = this.functionToRow(func);
          const keys = Object.keys(row);
          const sql = `INSERT INTO functions ("${keys.join('", "')}") VALUES (${keys.map(k => '@' + k).join(', ')})`;
          this.db.prepare(sql).run(row);
          stats.added++;
        }
      }

      // Remove stale functions
      for (const e of existing) {
        if (!currentMap.has(createKey(e))) {
          this.db.prepare('DELETE FROM functions WHERE id = ?').run(e.id);
          stats.removed++;
        }
      }
    });

    txn();
    await this.updateDependencyGraph(filePath);
    return stats;
  }

  // ── Dependency graph ────────────────────────────────────────────────

  async updateDependencyGraph(filePath?: string): Promise<void> {
    this.ensureInitialized();

    const txn = this.db.transaction(() => {
      // For functions in scope, rebuild their call edges
      const functions = filePath
        ? this.db.prepare('SELECT id, name, file_path FROM functions WHERE file_path = ?').all(filePath) as any[]
        : this.db.prepare('SELECT id, name, file_path FROM functions').all() as any[];

      // Clear existing call edges for scoped functions
      if (filePath) {
        this.db.prepare(
          `DELETE FROM function_calls WHERE caller_id IN (SELECT id FROM functions WHERE file_path = ?)`
        ).run(filePath);
      } else {
        this.db.prepare('DELETE FROM function_calls').run();
      }

      // Clear existing dependency edges for scoped functions
      if (filePath) {
        this.db.prepare(
          `DELETE FROM function_dependencies WHERE function_id IN (SELECT id FROM functions WHERE file_path = ?)`
        ).run(filePath);
      } else {
        this.db.prepare('DELETE FROM function_dependencies').run();
      }

      // Rebuild from metadata
      const allFns = filePath
        ? this.db.prepare('SELECT id, name, file_path, metadata_json FROM functions').all() as any[]
        : this.db.prepare('SELECT id, name, file_path, metadata_json FROM functions').all() as any[];

      const insertCall = this.db.prepare(
        'INSERT OR IGNORE INTO function_calls (caller_id, callee_name) VALUES (?, ?)'
      );
      const insertDep = this.db.prepare(
        'INSERT OR IGNORE INTO function_dependencies (function_id, dependency) VALUES (?, ?)'
      );

      for (const fn of allFns) {
        const meta = tryParseJson(fn.metadata_json) ?? {};
        if (meta.functionCalls) {
          for (const callee of meta.functionCalls) {
            insertCall.run(fn.id, callee);
          }
        }
      }

      // Also rebuild dependency edges from the functions' import data
      const insertFnDep = this.db.prepare(
        'INSERT OR IGNORE INTO function_dependencies (function_id, dependency) VALUES (?, ?)'
      );
      for (const fn of allFns) {
        const meta = tryParseJson(fn.metadata_json) ?? {};

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
    });

    txn();
  }

  async getTransitiveDependencies(
    functionName: string,
    maxDepth: number = 10
  ): Promise<Array<{ name: string; depth: number }>> {
    this.ensureInitialized();

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

  async getTransitiveCallers(
    functionName: string,
    maxDepth: number = 10
  ): Promise<Array<{ name: string; depth: number }>> {
    this.ensureInitialized();

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

  async detectCircularDependencies(): Promise<Array<string[]>> {
    this.ensureInitialized();

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

  async calculateDependencyDepths(): Promise<void> {
    this.ensureInitialized();

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

  // ── Search ──────────────────────────────────────────────────────────

  async searchFunctions(options: SearchOptions): Promise<SearchResult> {
    this.ensureInitialized();
    const startTime = Date.now();

    const queryParser = new QueryParser();
    let parsedQuery: ParsedQuery | undefined;

    if (options.query) {
      parsedQuery = options.parsedQuery || queryParser.parse(options.query);
    } else if (options.parsedQuery) {
      parsedQuery = options.parsedQuery;
    }

    // If there's a parsed query, use the SQL path (handles both FTS5 and operator-only queries)
    if (parsedQuery) {
      const compiled = compileToSQL(parsedQuery, { defaultLimit: options.limit || 50, offset: options.offset || 0 });
      return this.executeCompiledSearch(compiled, parsedQuery, options, startTime);
    }

    // Otherwise, get all functions and apply filters in-memory (backward compatible)
    const rows = this.db.prepare('SELECT *, rowid as "$loki" FROM functions').all() as any[];
    let results: FunctionDocument[] = rows.map((r: any) => this.rowToFunctionDoc(r));

    // Apply filters (parsedQuery is undefined here — the if-parsedQuery branch returned early)
    const combinedFilters = this.mergeFilters(options.filters, undefined);
    results = this.applyFilters(results, combinedFilters);

    const totalCount = results.length;
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    results = results.slice(offset, offset + limit);

    const functions = results.map(doc => ({
      ...doc,
      score: 50
    })) as Array<EnhancedFunctionMetadata & { score: number }>;

    return {
      functions,
      totalCount,
      query: options.query,
      parsedQuery,
      executionTime: Date.now() - startTime
    };
  }

  private executeCompiledSearch(
    compiled: SqlQuery,
    parsedQuery: ParsedQuery,
    options: SearchOptions,
    startTime: number
  ): SearchResult {
    let sql: string;
    const params: Record<string, any> = { ...compiled.params };

    let afterFrom = '';

    // Collect JOINs first — they must precede WHERE in SQL
    for (const join of compiled.joinClauses) {
      afterFrom += ` ${join}`;
    }

    if (compiled.ftsMatch) {
      // FTS5 path
      sql = `SELECT f.*, f.rowid as "$loki", bm25(functions_fts) as score
        FROM functions f
        JOIN functions_fts ON functions_fts.rowid = f.id${afterFrom}
        WHERE functions_fts MATCH @_ftsMatch`;
      params['_ftsMatch'] = compiled.ftsMatch;
    } else {
      sql = `SELECT f.*, f.rowid as "$loki", 0 as score FROM functions f${afterFrom} WHERE 1=1`;
    }

    // Add WHERE clauses
    for (const clause of compiled.whereClauses) {
      sql += ` AND (${clause})`;
    }

    // Ordering
    sql += ` ORDER BY ${compiled.orderBy}`;

    // Limit/offset
    sql += ` LIMIT ${compiled.limit} OFFSET ${compiled.offset}`;

    const rows = this.db.prepare(sql).all(params) as any[];

    // Get total count (without limit)
    let totalCount = rows.length;
    try {
      let countSql: string;
      let countAfterFrom = '';
      for (const join of compiled.joinClauses) {
        countAfterFrom += ` ${join}`;
      }
      if (compiled.ftsMatch) {
        countSql = `SELECT COUNT(*) as cnt FROM functions f
          JOIN functions_fts ON functions_fts.rowid = f.id${countAfterFrom}
          WHERE functions_fts MATCH @_ftsMatch`;
      } else {
        countSql = `SELECT COUNT(*) as cnt FROM functions f${countAfterFrom} WHERE 1=1`;
      }
      for (const clause of compiled.whereClauses) {
        countSql += ` AND (${clause})`;
      }
      const countParams = { ...params };
      delete countParams['_ftsMatch'];
      if (compiled.ftsMatch) {
        countParams['_ftsMatch'] = compiled.ftsMatch;
      }
      const countResult = this.db.prepare(countSql).get(countParams) as any;
      totalCount = countResult?.cnt ?? rows.length;
    } catch {
      // Fall back to results length
    }

    // Convert rows to FunctionDocument, applying excluded terms
    let docs = rows.map((r: any) => this.rowToFunctionDoc(r));

    if (parsedQuery.excludedTerms.length > 0) {
      docs = this.excludeTermsFromResults(docs, parsedQuery.excludedTerms);
    }

    // Apply in-memory filters (for filters not handled by compileToSQL)
    const combinedFilters = this.mergeFilters(options.filters, parsedQuery.filters);
    docs = this.applyFilters(docs, combinedFilters);

    const functions = docs.map(doc => ({
      ...doc,
      score: (doc as any).score ?? 0
    })) as Array<EnhancedFunctionMetadata & { score: number }>;

    return {
      functions,
      totalCount,
      query: options.query,
      parsedQuery,
      executionTime: Date.now() - startTime
    };
  }

  private rowToFunctionDoc(row: any): FunctionDocument {
    const func = this.rowToFunction(row);
    const doc: FunctionDocument = {
      ...func,
      $loki: row['$loki'] ?? row.id,
      dependencies: [],
    };
    // Populate dependencies from metadata
    const meta = tryParseJson(row.metadata_json);
    if (meta) {
      // Include both specifier-level (usedImports) and module-level (dependencies)
      const usedImports: string[] = meta.usedImports ?? [];
      const moduleDeps: string[] = meta.dependencies ?? [];
      doc.dependencies = [...new Set([...usedImports, ...moduleDeps])];
    }
    return doc;
  }

  async findDefinition(name: string, filePath?: string): Promise<EnhancedFunctionMetadata | null> {
    this.ensureInitialized();

    let row: any;
    if (filePath) {
      row = this.db.prepare('SELECT * FROM functions WHERE name = ? AND file_path = ?').get(name, filePath);
    } else {
      row = this.db.prepare('SELECT * FROM functions WHERE name = ?').get(name);
    }

    if (!row) return null;
    const func = this.rowToFunction(row);
    return func;
  }

  // ── Stats ───────────────────────────────────────────────────────────

  async getAllFunctions(): Promise<EnhancedFunctionMetadata[]> {
    this.ensureInitialized();
    const rows = this.db.prepare('SELECT * FROM functions').all() as any[];
    return rows.map((r: any) => this.rowToFunction(r));
  }

  async getStats(): Promise<{
    totalFunctions: number;
    languages: Record<string, number>;
    topDependencies: Array<{ name: string; count: number }>;
    filesIndexed: number;
    lastUpdated: Date;
  }> {
    this.ensureInitialized();

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

  // ── Lifecycle: clear & close ────────────────────────────────────────

  async clearIndex(): Promise<void> {
    this.ensureInitialized();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM functions').run();
      // FTS5 triggers handle cleanup
      this.db.prepare('DELETE FROM audit_results').run();
      this.db.prepare('DELETE FROM code_maps').run();
      this.db.prepare('DELETE FROM schema_definitions').run();
      this.db.prepare('DELETE FROM schema_usage').run();
      // Preserve: project_tasks, analyzer_configs, whitelist, findings_ledger_runs, findings_ledger_findings
    })();
  }

  async close(): Promise<void> {
    if (this.isInitialized) {
      this.taskRepository = null;
      this.stmts.clear();
      this.db.close();
      this.isInitialized = false;
    }
  }

  // ── File sync & bulk cleanup ────────────────────────────────────────

  async synchronizeFile(filePath: string): Promise<{
    added: number;
    updated: number;
    removed: number;
  } | null> {
    this.ensureInitialized();

    try {
      await fs.access(filePath);
    } catch {
      // File doesn't exist — remove all functions for it
      const result = this.db.prepare('DELETE FROM functions WHERE file_path = ?').run(filePath);
      return { added: 0, updated: 0, removed: result.changes };
    }

    try {
      const { FunctionScanner } = await import('./functionScanner.js');
      const scanner = new FunctionScanner();
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const language = filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript';
      const parsedFunctions = await scanner.scanFunctions(fileContent, filePath, language);
      return await this.syncFileIndex(filePath, parsedFunctions);
    } catch (error) {
      throw new Error(`Failed to sync file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async bulkCleanup(): Promise<{
    scannedCount: number;
    removedCount: number;
    removedFiles: string[];
    errors: Array<{ file: string; error: string }>;
  }> {
    this.ensureInitialized();

    const files = this.db.prepare('SELECT DISTINCT file_path FROM functions').all() as Array<{ file_path: string }>;
    const removedFiles: string[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    let removedCount = 0;
    let scannedCount = 0;

    for (const { file_path: fp } of files) {
      scannedCount++;
      try {
        await fs.access(fp);
      } catch {
        const result = this.db.prepare('DELETE FROM functions WHERE file_path = ?').run(fp);
        removedCount += result.changes;
        removedFiles.push(fp);
      }
    }

    return { scannedCount, removedCount, removedFiles, errors };
  }

  async deepSync(
    projectRoot?: string,
    progressCallback?: (progress: { current: number; total: number; file: string }) => void
  ): Promise<{
    syncedFiles: number;
    addedFunctions: number;
    updatedFunctions: number;
    removedFunctions: number;
    errors: Array<{ file: string; error: string }>;
  }> {
    this.ensureInitialized();

    let syncedFiles = 0;
    let totalAdded = 0;
    let totalUpdated = 0;
    let totalRemoved = 0;
    const errors: Array<{ file: string; error: string }> = [];

    // Discover files from the filesystem when projectRoot is provided
    let files: string[];
    if (projectRoot) {
      const discovered = await discoverFiles(projectRoot, {
        extensions: ALL_EXTENSIONS,
      });
      files = discovered.sort();
    } else {
      // Fallback: sync files already in the index
      const rows = this.db.prepare('SELECT DISTINCT file_path FROM functions').all() as Array<{ file_path: string }>;
      files = rows.map(r => r.file_path);
    }

    const total = files.length;

    for (let i = 0; i < files.length; i++) {
      const fp = files[i];
      if (progressCallback) {
        progressCallback({ current: i + 1, total, file: fp });
      }
      try {
        const result = await this.synchronizeFile(fp);
        if (result) {
          syncedFiles++;
          totalAdded += result.added;
          totalUpdated += result.updated;
          totalRemoved += result.removed;
        }
      } catch (error) {
        errors.push({
          file: fp,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Clean up stale entries for files that no longer exist on disk
    const allIndexed = this.db.prepare('SELECT DISTINCT file_path FROM functions').all() as Array<{ file_path: string }>;
    for (const { file_path: fp } of allIndexed) {
      try {
        await fs.access(fp);
      } catch {
        // File deleted — remove its functions
        const result = this.db.prepare('DELETE FROM functions WHERE file_path = ?').run(fp);
        if (result.changes > 0) {
          totalRemoved += result.changes;
        }
      }
    }

    return {
      syncedFiles,
      addedFunctions: totalAdded,
      updatedFunctions: totalUpdated,
      removedFunctions: totalRemoved,
      errors
    };
  }

  // ── Diff-scoped audit detection (Spec 04) ────────────────────────────

  /**
   * For a set of file paths, re-parse each file and return only functions
   * whose content_hash differs from the stored value (plus new functions).
   * Deleted functions are removed from the index.
   *
   * Returns the list of changed/new function metadata for scoped analysis,
   * and the set of file paths that were actually touched.
   */
  async detectChangedFunctions(filePaths: string[]): Promise<{
    changedFunctions: EnhancedFunctionMetadata[];
    deletedFunctions: EnhancedFunctionMetadata[];
    changedFilePaths: string[];
    errors: Array<{ file: string; error: string }>;
  }> {
    this.ensureInitialized();

    const changedFunctions: EnhancedFunctionMetadata[] = [];
    const deletedFunctions: EnhancedFunctionMetadata[] = [];
    const changedFilePaths: string[] = [];
    const errors: Array<{ file: string; error: string }> = [];

    const { FunctionScanner } = await import('./functionScanner.js');

    for (const filePath of filePaths) {
      try {
        await fs.access(filePath);
      } catch {
        // File doesn't exist — remove all its functions
        const removed = this.db.prepare(
          'SELECT * FROM functions WHERE file_path = ?'
        ).all(filePath) as any[];
        if (removed.length > 0) {
          const parsed = removed.map((r: any) => this.rowToFunction(r));
          deletedFunctions.push(...parsed);
          this.db.prepare('DELETE FROM functions WHERE file_path = ?').run(filePath);
          changedFilePaths.push(filePath);
        }
        continue;
      }

      try {
        const scanner = new FunctionScanner();
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const language = (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
          ? 'typescript' : 'javascript';
        const currentFunctions = await scanner.scanFunctions(fileContent, filePath, language);

        // Get existing functions for this file from DB
        const existing = this.db.prepare(
          'SELECT * FROM functions WHERE file_path = ?'
        ).all(filePath) as any[];

        // Build a name → existing-row map
        const existingByName = new Map<string, any>();
        for (const e of existing) {
          existingByName.set(e.name, e);
        }

        const currentNames = new Set(currentFunctions.map((f: any) => f.name));
        let fileChanged = false;

        for (const func of currentFunctions) {
          const existingRow = existingByName.get(func.name);
          // Convert scanner output to EnhancedFunctionMetadata shape
          const funcMeta: EnhancedFunctionMetadata = {
            ...func,
            complexity: (func as any).complexity,
            content_hash: computeContentHash(
              (func as any).body ?? (func as any).metadata?.body,
              (func as any).signature
            ),
          } as EnhancedFunctionMetadata;
          const newHash = funcMeta.content_hash!;

          if (!existingRow) {
            // New function
            changedFunctions.push(funcMeta);
            fileChanged = true;
          } else if (existingRow.content_hash !== newHash) {
            // Changed function
            changedFunctions.push(funcMeta);
            fileChanged = true;
          }
        }

        // Detect deleted functions
        for (const e of existing) {
          if (!currentNames.has(e.name)) {
            deletedFunctions.push(this.rowToFunction(e));
            fileChanged = true;
          }
        }

        if (fileChanged) {
          changedFilePaths.push(filePath);
        }

        // Sync the file into the index (upsert + deletes)
        await this.syncFileIndex(filePath, currentFunctions as FunctionMetadata[]);
      } catch (error) {
        errors.push({
          file: filePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return { changedFunctions, deletedFunctions, changedFilePaths, errors };
  }

  /**
   * Given a project root, detect all indexed files whose mtime is newer than
   * the stored last_modified timestamp. Returns file paths for further processing.
   */
  async detectModifiedFiles(projectRoot: string): Promise<string[]> {
    this.ensureInitialized();

    const files = this.db.prepare(
      'SELECT DISTINCT file_path, last_modified FROM functions'
    ).all() as Array<{ file_path: string; last_modified: string | null }>;

    const modifiedFiles: string[] = [];
    const uniqueFiles = new Map<string, string | null>();

    for (const row of files) {
      if (!uniqueFiles.has(row.file_path)) {
        uniqueFiles.set(row.file_path, row.last_modified);
      }
    }

    for (const [filePath, storedMtime] of uniqueFiles) {
      try {
        const stat = await fs.stat(filePath);
        // Normalize to ISO string for comparison
        const currentMtime = stat.mtime.toISOString();
        if (!storedMtime || currentMtime > storedMtime) {
          modifiedFiles.push(filePath);
        }
      } catch {
        // File doesn't exist — it will be handled as a deletion
        modifiedFiles.push(filePath);
      }
    }

    return modifiedFiles;
  }

  /**
   * Get content hashes for a set of file paths. Returns a map:
   * file_path → { name → content_hash }
   */
  getContentHashesForFiles(filePaths: string[]): Map<string, Map<string, string>> {
    this.ensureInitialized();

    const result = new Map<string, Map<string, string>>();

    if (filePaths.length === 0) return result;

    const placeholders = filePaths.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT file_path, name, content_hash FROM functions WHERE file_path IN (${placeholders})`
    ).all(...filePaths) as Array<{ file_path: string; name: string; content_hash: string | null }>;

    for (const row of rows) {
      if (!result.has(row.file_path)) {
        result.set(row.file_path, new Map());
      }
      result.get(row.file_path)!.set(row.name, row.content_hash ?? '');
    }

    return result;
  }

  // ── Legacy search helpers (for in-memory filtering) ─────────────────

  private mergeFilters(
    optionsFilters?: SearchOptions['filters'],
    queryFilters?: ParsedQuery['filters']
  ): SearchOptions['filters'] {
    const merged: SearchOptions['filters'] = {};
    if (optionsFilters) Object.assign(merged, optionsFilters);
    if (queryFilters) {
      if (queryFilters.language) merged.language = queryFilters.language;
      if (queryFilters.filePath) merged.filePath = queryFilters.filePath;
      if (queryFilters.fileType) merged.fileType = queryFilters.fileType;
      if (queryFilters.hasJsDoc !== undefined) merged.hasJsDoc = queryFilters.hasJsDoc;
      if (queryFilters.complexity) merged.complexity = queryFilters.complexity;
      if (queryFilters.dateRange) merged.dateRange = queryFilters.dateRange;
      if (queryFilters.metadata) merged.metadata = queryFilters.metadata;
    }
    return merged;
  }

  private applyFilters(
    results: FunctionDocument[],
    filters?: SearchOptions['filters']
  ): FunctionDocument[] {
    if (!filters) return results;
    let filtered = results;

    if (filters.language) {
      filtered = filtered.filter(doc => doc.language === filters.language);
    }
    if (filters.filePath) {
      if (filters.filePath.includes('*') || filters.filePath.includes('?')) {
        const pattern = filters.filePath.replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\//g, '\\/');
        const regex = new RegExp(pattern);
        filtered = filtered.filter(doc => regex.test(doc.filePath));
      } else if (filters.filePath.endsWith('.ts') || filters.filePath.endsWith('.tsx') ||
                 filters.filePath.endsWith('.js') || filters.filePath.endsWith('.jsx')) {
        filtered = filtered.filter(doc => doc.filePath.endsWith(filters.filePath!));
      } else {
        filtered = filtered.filter(doc => doc.filePath.includes(filters.filePath!));
      }
    }
    if (filters.fileType) {
      filtered = filtered.filter(doc => doc.filePath.endsWith(filters.fileType!));
    }
    if (filters.hasJsDoc !== undefined) {
      filtered = filtered.filter(doc => {
        const hasJsDoc = doc.jsDoc && doc.jsDoc.description && doc.jsDoc.description.length > 0;
        return filters.hasJsDoc ? hasJsDoc : !hasJsDoc;
      });
    }
    if (filters.complexity) {
      filtered = filtered.filter(doc => {
        if (!doc.complexity) return false;
        const min = filters.complexity!.min || 0;
        const max = filters.complexity!.max || Infinity;
        return doc.complexity >= min && doc.complexity <= max;
      });
    }
    if (filters.hasAnyDependency && filters.hasAnyDependency.length > 0) {
      filtered = filtered.filter(doc =>
        filters.hasAnyDependency!.some(dep => doc.dependencies.includes(dep))
      );
    }
    if (filters.metadata) {
      filtered = filtered.filter(doc => {
        if (!doc.metadata) return false;
        const m = filters.metadata!;
        if (m.entityType && doc.metadata.entityType !== m.entityType) return false;
        if (m.componentType && doc.metadata.componentType !== m.componentType) return false;
        if (m.hasHook) {
          if (!doc.metadata.hooks) return false;
          const found = (doc.metadata.hooks as any[]).some((h: any) =>
            h.name?.toLowerCase().includes(m.hasHook!.toLowerCase()));
          if (!found) return false;
        }
        if (m.hasProp) {
          if (!doc.metadata.props) return false;
          const found = (doc.metadata.props as any[]).some((p: any) =>
            p.name?.toLowerCase().includes(m.hasProp!.toLowerCase()));
          if (!found) return false;
        }
        if (m.usesDependency) {
          const dep = m.usesDependency.toLowerCase();
          const inFile = doc.dependencies.some(d => d.toLowerCase().includes(dep));
          const inFunc = (doc.metadata.usedImports as string[] | undefined)?.some(i => i.toLowerCase().includes(dep)) ?? false;
          if (!inFile && !inFunc) return false;
        }
        if (m.callsFunction) {
          const target = m.callsFunction.toLowerCase();
          const calls = doc.metadata.functionCalls as string[] | undefined;
          if (!calls || !calls.some(c => c.toLowerCase().includes(target))) return false;
        }
        if (m.calledByFunction) {
          const caller = m.calledByFunction.toLowerCase();
          const calledBy = doc.metadata.calledBy as string[] | undefined;
          if (!calledBy || !calledBy.some(c => c.toLowerCase().includes(caller))) return false;
        }
        if (m.dependsOnModule) {
          const mod = m.dependsOnModule.toLowerCase();
          const inFile2 = doc.filePath.toLowerCase().includes(mod);
          const inDep = doc.dependencies.some(d => d.toLowerCase().includes(mod));
          const inCall = (doc.metadata.functionCalls as string[] | undefined)?.some(c => c.toLowerCase().includes(mod)) ?? false;
          if (!inFile2 && !inDep && !inCall) return false;
        }
        if (m.hasUnusedImports) {
          const unused = doc.metadata.unusedImports as any[] | undefined;
          if (!unused || unused.length === 0) return false;
        }
        return true;
      });
    }
    return filtered;
  }

  private excludeTermsFromResults(
    results: FunctionDocument[],
    excludedTerms: string[]
  ): FunctionDocument[] {
    return results.filter(doc => {
      const searchText = [
        doc.name, doc.signature, doc.purpose, doc.context,
        doc.jsDoc?.description, doc.returnType,
        ...(doc.parameters || []).map((p: any) => `${p.name} ${p.description || ''}`),
        ...doc.dependencies
      ].filter(Boolean).join(' ').toLowerCase();
      return !excludedTerms.some(term => searchText.includes(term.toLowerCase()));
    });
  }

  // ── Whitelist ───────────────────────────────────────────────────────

  private async initializeDefaultWhitelists(): Promise<void> {
    const defaults: WhitelistEntry[] = [
      { name: 'Date', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'Error', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'Array', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'Map', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'Set', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'Promise', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'RegExp', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'URL', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'dom', addedBy: 'system', addedAt: new Date() },
      { name: 'URLSearchParams', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'dom', addedBy: 'system', addedAt: new Date() },
      { name: 'FormData', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'dom', addedBy: 'system', addedAt: new Date() },
      { name: 'Headers', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'dom', addedBy: 'system', addedAt: new Date() },
      { name: 'fs', type: WhitelistType.NodeBuiltin, status: WhitelistStatus.Active, patterns: ['fs', 'node:fs', 'fs/promises'], addedBy: 'system', addedAt: new Date() },
      { name: 'path', type: WhitelistType.NodeBuiltin, status: WhitelistStatus.Active, patterns: ['path', 'node:path'], addedBy: 'system', addedAt: new Date() },
      { name: 'crypto', type: WhitelistType.NodeBuiltin, status: WhitelistStatus.Active, patterns: ['crypto', 'node:crypto'], addedBy: 'system', addedAt: new Date() },
      { name: 'NextResponse', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nextjs', addedBy: 'system', addedAt: new Date() },
      { name: 'NextRequest', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nextjs', addedBy: 'system', addedAt: new Date() },
      { name: 'Response', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'web-api', addedBy: 'system', addedAt: new Date() },
      { name: 'Request', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'web-api', addedBy: 'system', addedAt: new Date() },
      { name: 'Component', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'react', addedBy: 'system', addedAt: new Date() },
      { name: 'PureComponent', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'react', addedBy: 'system', addedAt: new Date() },
      { name: 'Fragment', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'react', addedBy: 'system', addedAt: new Date() },
      { name: 'StrictMode', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'react', addedBy: 'system', addedAt: new Date() },
      { name: 'Suspense', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'react', addedBy: 'system', addedAt: new Date() },
      { name: 'Pool', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'database', patterns: ['pg'], addedBy: 'system', addedAt: new Date() },
      { name: 'Client', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'database', patterns: ['pg'], addedBy: 'system', addedAt: new Date() },
      { name: 'MongoClient', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'database', patterns: ['mongodb'], addedBy: 'system', addedAt: new Date() },
      { name: 'PrismaClient', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'database', patterns: ['@prisma/client'], addedBy: 'system', addedAt: new Date() },
      { name: 'StackServerApp', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'auth', patterns: ['@stackframe/stack'], addedBy: 'system', addedAt: new Date() },
      { name: 'StackClient', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'auth', patterns: ['@stackframe/stack'], addedBy: 'system', addedAt: new Date() },
      { name: 'ClerkProvider', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'auth', patterns: ['@clerk/nextjs'], addedBy: 'system', addedAt: new Date() },
      { name: 'Auth0Provider', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'auth', patterns: ['@auth0/nextjs-auth0'], addedBy: 'system', addedAt: new Date() },
      { name: 'Axios', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'http', patterns: ['axios'], addedBy: 'system', addedAt: new Date() },
      { name: 'HttpClient', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'http', addedBy: 'system', addedAt: new Date() },
      { name: 'Router', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'express', patterns: ['express'], addedBy: 'system', addedAt: new Date() },
      { name: 'Application', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'express', patterns: ['express'], addedBy: 'system', addedAt: new Date() },
      { name: 'TestingModule', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'testing', patterns: ['@nestjs/testing'], addedBy: 'system', addedAt: new Date() },
      { name: 'MockedProvider', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'testing', patterns: ['@apollo/client/testing'], addedBy: 'system', addedAt: new Date() },
      { name: 'EventEmitter', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nodejs', patterns: ['events', 'node:events'], addedBy: 'system', addedAt: new Date() },
      { name: 'Readable', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nodejs', patterns: ['stream', 'node:stream'], addedBy: 'system', addedAt: new Date() },
      { name: 'Writable', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nodejs', patterns: ['stream', 'node:stream'], addedBy: 'system', addedAt: new Date() },
      { name: 'Transform', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nodejs', patterns: ['stream', 'node:stream'], addedBy: 'system', addedAt: new Date() },
      { name: 'Buffer', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nodejs', addedBy: 'system', addedAt: new Date() },
    ];

    const insert = this.db.prepare(`INSERT INTO whitelist (name, type, status, category, description, patterns, added_by, added_at, metadata_json)
      VALUES (@name, @type, @status, @category, @description, @patterns, @added_by, @added_at, @metadata_json)`);

    for (const entry of defaults) {
      insert.run({
        name: entry.name,
        type: entry.type,
        status: entry.status,
        category: entry.category ?? null,
        description: entry.description ?? null,
        patterns: JSON.stringify(entry.patterns ?? []),
        added_by: entry.addedBy ?? 'system',
        added_at: (entry.addedAt ?? new Date()).toISOString(),
        metadata_json: '{}',
      });
    }
  }

  async getWhitelist(type?: WhitelistType, status?: WhitelistStatus): Promise<WhitelistEntry[]> {
    this.ensureInitialized();
    const rows = this.whitelistAdapter.find({
      ...(type ? { type } : {}),
      ...(status ? { status } : {}),
    });
    return rows.map((r: any) => ({
      name: r.name,
      type: r.type,
      status: r.status,
      category: r.category,
      description: r.description,
      patterns: tryParseJson(r.patterns),
      addedBy: r.added_by ?? r.addedBy,
      addedAt: new Date(r.added_at ?? r.addedAt),
      updatedAt: r.updated_at ? new Date(r.updated_at) : undefined,
      metadata: tryParseJson(r.metadata_json),
    }));
  }

  async addWhitelistEntry(entry: Omit<WhitelistEntry, 'id' | 'addedAt'>): Promise<WhitelistEntry> {
    this.ensureInitialized();
    const row = this.whitelistAdapter.insert({
      name: entry.name,
      type: entry.type,
      status: entry.status ?? WhitelistStatus.Active,
      category: entry.category ?? null,
      description: entry.description ?? null,
      patterns: JSON.stringify(entry.patterns ?? []),
      added_by: entry.addedBy ?? 'user',
      added_at: new Date().toISOString(),
      metadata_json: '{}',
    });
    return {
      name: row.name,
      type: row.type,
      status: row.status,
      category: row.category,
      description: row.description,
      patterns: tryParseJson(row.patterns),
      addedBy: row.added_by,
      addedAt: new Date(row.added_at),
    } as WhitelistEntry;
  }

  async updateWhitelistStatus(name: string, status: WhitelistStatus): Promise<void> {
    this.ensureInitialized();
    this.db.prepare('UPDATE whitelist SET status = ?, updated_at = ? WHERE name = ?')
      .run(status, new Date().toISOString(), name);
  }

  isWhitelisted(name: string, type: WhitelistType): boolean {
    if (!this.isInitialized) return false;
    const rows = this.db.prepare(
      'SELECT name, patterns FROM whitelist WHERE type = ? AND status = ?'
    ).all(type, WhitelistStatus.Active) as any[];

    return rows.some(entry => {
      if (entry.name === name) return true;
      const patterns = tryParseJson(entry.patterns);
      if (patterns && Array.isArray(patterns)) {
        return patterns.some((p: string) => {
          if (p.includes('*')) {
            const regex = new RegExp(p.replace(/\*/g, '.*'));
            return regex.test(name);
          }
          return p === name;
        });
      }
      return false;
    });
  }

  async detectWhitelistCandidates(): Promise<WhitelistSuggestion[]> {
    return [];
  }

  // ── Audit results ───────────────────────────────────────────────────

  async storeAuditResults(auditResult: any, projectPath: string): Promise<string> {
    this.ensureInitialized();
    const auditId = `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.db.prepare(`INSERT INTO audit_results (audit_id, timestamp, project_path, summary_json, analyzer_results_json, violations_json, recommendations_json, metadata_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      auditId,
      new Date().toISOString(),
      projectPath,
      JSON.stringify(auditResult.summary ?? {}),
      JSON.stringify(auditResult.analyzerResults ?? auditResult.results ?? {}),
      JSON.stringify(auditResult.violations ?? null),
      JSON.stringify(auditResult.recommendations ?? null),
      JSON.stringify(auditResult.metadata ?? {}),
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    );

    this.cleanupExpiredAudits();
    return auditId;
  }

  async getAuditResults(auditId: string): Promise<any | null> {
    this.ensureInitialized();
    const row = this.db.prepare('SELECT * FROM audit_results WHERE audit_id = ?').get(auditId) as any;
    if (!row) return null;
    if (new Date(row.expires_at) <= new Date()) {
      this.db.prepare('DELETE FROM audit_results WHERE audit_id = ?').run(auditId);
      return null;
    }
    return {
      auditId: row.audit_id,
      timestamp: new Date(row.timestamp),
      projectPath: row.project_path,
      summary: tryParseJson(row.summary_json),
      analyzerResults: tryParseJson(row.analyzer_results_json),
      violations: tryParseJson(row.violations_json),
      recommendations: tryParseJson(row.recommendations_json),
      metadata: tryParseJson(row.metadata_json),
      expiresAt: new Date(row.expires_at),
    };
  }

  async getMostRecentAuditResults(
    projectPath?: string,
    resultScope?: 'full' | 'scoped'
  ): Promise<any | null> {
    this.ensureInitialized();
    const now = new Date().toISOString();
    let row: any;

    const scopeFilter = resultScope
      ? "AND json_extract(metadata_json, '$.scope') = ?"
      : '';

    if (projectPath) {
      const params: any[] = [projectPath, now];
      if (resultScope) params.push(resultScope);
      row = this.db.prepare(
        `SELECT * FROM audit_results WHERE project_path = ? AND expires_at > ? ${scopeFilter} ORDER BY timestamp DESC, rowid DESC LIMIT 1`
      ).get(...params);
    } else {
      const params: any[] = [now];
      if (resultScope) params.push(resultScope);
      row = this.db.prepare(
        `SELECT * FROM audit_results WHERE expires_at > ? ${scopeFilter} ORDER BY timestamp DESC, rowid DESC LIMIT 1`
      ).get(...params);
    }
    if (!row) return null;
    return {
      auditId: row.audit_id,
      timestamp: new Date(row.timestamp),
      projectPath: row.project_path,
      summary: tryParseJson(row.summary_json),
      analyzerResults: tryParseJson(row.analyzer_results_json),
      violations: tryParseJson(row.violations_json),
      recommendations: tryParseJson(row.recommendations_json),
      metadata: tryParseJson(row.metadata_json),
      expiresAt: new Date(row.expires_at),
    };
  }

  hasOpenTaskByFingerprint(fingerprint: string | null | undefined): boolean {
    if (!fingerprint) return false;
    return this.getTaskRepository().findOpenByFingerprint(fingerprint).length > 0;
  }

  private cleanupExpiredAudits(): void {
    this.db.prepare('DELETE FROM audit_results WHERE expires_at < ?').run(new Date().toISOString());
  }

  // ── Analyzer configs ────────────────────────────────────────────────

  async storeAnalyzerConfig(
    analyzerName: string,
    config: Record<string, any>,
    options?: { projectPath?: string; isGlobal?: boolean; metadata?: any }
  ): Promise<string> {
    this.ensureInitialized();
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

  async getAnalyzerConfig(analyzerName: string, projectPath?: string): Promise<Record<string, any> | null> {
    this.ensureInitialized();
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

  async getAllAnalyzerConfigs(projectPath?: string): Promise<Record<string, any>> {
    this.ensureInitialized();
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

  async deleteAnalyzerConfig(analyzerName: string, options?: { projectPath?: string; isGlobal?: boolean }): Promise<boolean> {
    this.ensureInitialized();
    const result = this.db.prepare(
      'DELETE FROM analyzer_configs WHERE analyzer_name = ? AND COALESCE(project_path, \'__global__\') = ? AND is_global = ?'
    ).run(analyzerName, options?.projectPath ?? '__global__', (options?.isGlobal ?? !options?.projectPath) ? 1 : 0);
    return result.changes > 0;
  }

  async resetAnalyzerConfigs(projectPath?: string): Promise<void> {
    this.ensureInitialized();
    if (projectPath) {
      this.db.prepare('DELETE FROM analyzer_configs WHERE project_path = ? AND is_global = 0').run(projectPath);
    } else {
      this.db.prepare('DELETE FROM analyzer_configs').run();
    }
  }

  // ── Code maps ───────────────────────────────────────────────────────

  async storeCodeMapSection(mapId: string, sectionType: string, content: string, metadata?: any): Promise<void> {
    this.ensureInitialized();
    this.db.prepare(
      `INSERT OR REPLACE INTO code_maps (map_id, section_type, content, metadata_json, timestamp, size)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(mapId, sectionType, content, JSON.stringify(metadata ?? {}), new Date().toISOString(), content.length);
  }

  async getCodeMapSection(mapId: string, sectionType: string): Promise<{ content: string; metadata: any } | null> {
    this.ensureInitialized();
    const row = this.db.prepare('SELECT content, metadata_json FROM code_maps WHERE map_id = ? AND section_type = ?')
      .get(mapId, sectionType) as any;
    return row ? { content: row.content, metadata: tryParseJson(row.metadata_json) ?? {} } : null;
  }

  async listCodeMapSections(mapId: string): Promise<Array<{ sectionType: string; size: number; timestamp: Date }>> {
    this.ensureInitialized();
    const rows = this.db.prepare('SELECT section_type, size, timestamp FROM code_maps WHERE map_id = ?')
      .all(mapId) as any[];
    return rows.map((r: any) => ({ sectionType: r.section_type, size: r.size ?? 0, timestamp: new Date(r.timestamp) }));
  }

  async clearOldCodeMaps(olderThanHours: number = 24): Promise<number> {
    this.ensureInitialized();
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare('DELETE FROM code_maps WHERE timestamp < ?').run(cutoff);
    return result.changes;
  }

  async deleteCodeMap(mapId: string): Promise<number> {
    this.ensureInitialized();
    const result = this.db.prepare('DELETE FROM code_maps WHERE map_id = ?').run(mapId);
    return result.changes;
  }

  // ── Schema management ───────────────────────────────────────────────

  async storeSchema(schema: SchemaDefinition): Promise<string> {
    this.ensureInitialized();
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

  async getSchema(schemaId: string): Promise<SchemaDefinition | null> {
    this.ensureInitialized();
    const row = this.db.prepare('SELECT schema_json FROM schema_definitions WHERE schema_id = ?').get(schemaId) as any;
    return row ? tryParseJson(row.schema_json) : null;
  }

  async getAllSchemas(): Promise<Array<{ schemaId: string; metadata: SchemaIndexMetadata; schema: SchemaDefinition }>> {
    this.ensureInitialized();
    const rows = this.db.prepare('SELECT schema_id, schema_json, metadata_json FROM schema_definitions').all() as any[];
    return rows.map((r: any) => ({
      schemaId: r.schema_id,
      metadata: tryParseJson(r.metadata_json) ?? {},
      schema: tryParseJson(r.schema_json),
    }));
  }

  async deleteSchema(schemaId: string): Promise<boolean> {
    this.ensureInitialized();
    this.db.prepare('DELETE FROM schema_usage WHERE schema_id = ?').run(schemaId);
    const result = this.db.prepare('DELETE FROM schema_definitions WHERE schema_id = ?').run(schemaId);
    return result.changes > 0;
  }

  async recordSchemaUsage(usage: SchemaUsage, schemaId?: string): Promise<void> {
    this.ensureInitialized();
    const existing = this.db.prepare(
      'SELECT id FROM schema_usage WHERE table_name = ? AND file_path = ? AND function_name = ? AND line = ?'
    ).get(usage.tableName, usage.filePath, usage.functionName, usage.line);

    if (existing) {
      this.db.prepare(
        'UPDATE schema_usage SET schema_id = ?, usage_type = ?, "column" = ?, raw_query = ?, parameters = ?, recorded_at = ? WHERE id = ?'
      ).run(schemaId ?? 'default', usage.usageType, usage.column ?? null,
        usage.rawQuery ?? null, JSON.stringify(usage.parameters ?? []),
        new Date().toISOString(), (existing as any).id);
    } else {
      this.db.prepare(
        'INSERT INTO schema_usage (schema_id, table_name, file_path, function_name, usage_type, line, "column", raw_query, parameters, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(schemaId ?? 'default', usage.tableName, usage.filePath, usage.functionName,
        usage.usageType, usage.line ?? null, usage.column ?? null,
        usage.rawQuery ?? null, JSON.stringify(usage.parameters ?? []), new Date().toISOString());
    }
  }

  async getSchemaUsage(options: {
    schemaId?: string; tableName?: string; filePath?: string; functionName?: string; usageType?: string;
  } = {}): Promise<SchemaUsage[]> {
    this.ensureInitialized();
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
      usageType: r.usage_type,
      line: r.line,
      column: r.column,
      rawQuery: r.raw_query,
      parameters: tryParseJson(r.parameters) ?? [],
    }));
  }

  async findFunctionsUsingTable(tableName: string): Promise<Array<{
    functionName: string; filePath: string; usageType: string; line: number;
  }>> {
    this.ensureInitialized();
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

  async getSchemaStats(): Promise<{
    totalSchemas: number; totalTables: number; totalUsagePatterns: number;
    mostUsedTables: Array<{ tableName: string; usageCount: number }>;
    usageByType: Record<string, number>;
  }> {
    this.ensureInitialized();
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

  async searchWithSchemaContext(
    query: string,
    options: SearchOptions & { includeSchemaUsage?: boolean } = {}
  ): Promise<SearchResult & { schemaContext?: Array<{ tableName: string; usageType: string }> }> {
    const searchResult = await this.searchFunctions(options);
    if (!options.includeSchemaUsage) return searchResult;

    const enhancedFunctions = await Promise.all(
      searchResult.functions.map(async (func) => {
        const schemaUsage = await this.getSchemaUsage({
          filePath: func.filePath,
          functionName: func.name
        });
        return {
          ...func,
          schemaUsage,
          affectedTables: [...new Set(schemaUsage.map(u => u.tableName))],
          schemaPatterns: [...new Set(schemaUsage.map(u => u.usageType))]
        };
      })
    );

    const allSchemaUsage = enhancedFunctions.flatMap(f => (f as any).schemaUsage || []);
    const schemaContext = [...new Set(allSchemaUsage.map((u: any) => ({
      tableName: u.tableName, usageType: u.usageType
    })))];

    return { ...searchResult, functions: enhancedFunctions, schemaContext };
  }

  // ── Project tasks ───────────────────────────────────────────────────

  private getTaskRepository(): ProjectTaskRepository {
    this.ensureInitialized();
    if (!this.taskRepository) {
      this.taskRepository = new ProjectTaskRepository(
        () => this.tasksAdapter,
        () => { /* SQLite is auto-persisted; no-op */ }
      );
    }
    return this.taskRepository;
  }

  async createProjectTask(input: CreateProjectTaskInput): Promise<ProjectTask> {
    return this.getTaskRepository().create(input);
  }

  async getProjectTask(taskId: string): Promise<ProjectTask | null> {
    return this.getTaskRepository().getById(taskId);
  }

  async listProjectTasks(projectPath: string, options?: ListProjectTasksOptions): Promise<ProjectTask[]> {
    return this.getTaskRepository().list(projectPath, options);
  }

  async listProjectTasksTree(
    projectPath: string,
    options?: Omit<ListProjectTasksOptions, 'parentTaskId' | 'hasChildren'>
  ): Promise<ListProjectTasksTreeNode[]> {
    return this.getTaskRepository().listTree(projectPath, options);
  }

  async listActionableProjectTasks(
    projectPath: string,
    options?: Omit<ListProjectTasksOptions, 'actionableOnly'>
  ): Promise<ProjectTask[]> {
    return this.getTaskRepository().listActionable(projectPath, options);
  }

  async completeProjectTask(taskId: string): Promise<CompleteProjectTaskResult | null> {
    return this.getTaskRepository().complete(taskId);
  }

  async updateProjectTask(taskId: string, patch: unknown): Promise<ProjectTask | null> {
    return this.getTaskRepository().update(taskId, patch);
  }

  async deleteProjectTask(taskId: string, mode?: ProjectTaskDeleteMode): Promise<boolean> {
    return this.getTaskRepository().delete(taskId, mode);
  }

  // ── Meta key-value store ─────────────────────────────────────────────

  /** Upsert a key-value pair in the meta table. */
  setMeta(key: string, value: string): void {
    this.ensureInitialized();
    this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  /** Retrieve a value from the meta table, or null if absent. */
  getMeta(key: string): string | null {
    this.ensureInitialized();
    const row = this.db.prepare(
      'SELECT value FROM meta WHERE key = ?'
    ).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  // ── Provenance storage (Spec-21 R2 cross-file) ─────────────────────

  /** Store per-file provenance context in the meta table. */
  storeFileProvenance(filePath: string, provenanceData: {
    dbProvenanced: Array<{ identifier: string; reason: string; source: string; chain?: string[] }>;
    validatorProvenanced: Array<{ identifier: string; reason: string; source: string; chain?: string[] }>;
  }): void {
    const key = `provenance:${filePath}`;
    this.setMeta(key, JSON.stringify(provenanceData));
  }

  /** Retrieve per-file provenance context, or null if not stored. */
  getFileProvenance(filePath: string): {
    dbProvenanced: Array<{ identifier: string; reason: string; source: string; chain?: string[] }>;
    validatorProvenanced: Array<{ identifier: string; reason: string; source: string; chain?: string[] }>;
  } | null {
    const raw = this.getMeta(`provenance:${filePath}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Store the inferred receiver set as a meta record. */
  storeInferredReceivers(inferred: Array<{
    identifier: string;
    file: string;
    reason: string;
  }>): void {
    this.setMeta('inferred_receivers', JSON.stringify(inferred));
  }

  /** Retrieve the inferred receiver set, or null if not stored. */
  getInferredReceivers(): Array<{
    identifier: string;
    file: string;
    reason: string;
  }> | null {
    const raw = this.getMeta('inferred_receivers');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function tryParseJson(val: any): any {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val;
  if (typeof val !== 'string') return val;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}
