/**
 * Code Index Database using SQLite (better-sqlite3) + FTS5
 * Replaces LokiJS + FlexSearch with durable, transactional storage.
 *
 * `CodeIndexDB` is the connection owner and transaction boundary, plus the
 * cross-concern orchestrators (sync, diff detection, churn/hotspot/convention
 * mining). Each storage concern — functions, search, coverage, dependency
 * graph, schema usage, whitelist, audit results, analyzer configs, code maps,
 * project tasks, meta, provenance, inferred receivers, conventions, raw SQL —
 * lives in its own module under `codeIndex/` and is exposed as a public field.
 */

import { openSqlite, DB_BUSY_TIMEOUT_MS } from './sqlite/driver.js';
import type { SqliteDatabase } from './sqlite/types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { discoverFiles, ALL_EXTENSIONS } from './utils/fileDiscovery.js';
import { computeContentHash } from './utils/contentHash.js';
import { errorMessage } from './utils/errorMessage.js';
import { getPersistedStorageRoot, resolvePersistedIndexPath } from './dataPaths.js';
import { ContextualError, getErrnoCode } from './mcpToolErrors.js';
import { extractChurn } from './churn/churnExtractor.js';
import { computeHotspots } from './hotspots/hotspotScorer.js';
import { populateCallGraphCache } from './graph/callGraph.js';
import { populateImportGraphCache } from './graph/importGraph.js';
import type {
  EnhancedFunctionMetadata,
  FunctionMetadata,
  IndexHandle,
  SearchResult,
  SearchOptions,
} from './types.js';
import { CoverageIndex } from './codeIndex/coverage.js';
import { DependencyGraphIndex } from './codeIndex/dependencyGraph.js';
import { FunctionIndex } from './codeIndex/functionIndex.js';
import { SearchIndex } from './codeIndex/search.js';
import { SchemaMigrations, migrateFromLokiJS } from './codeIndex/migrations.js';
import { MetaStore } from './codeIndex/meta.js';
import { ProvenanceStore } from './codeIndex/provenance.js';
import { InferredReceiversStore } from './codeIndex/inferredReceivers.js';
import { CodeMapIndex } from './codeIndex/codeMap.js';
import { AnalyzerConfigIndex } from './codeIndex/analyzerConfig.js';
import { AuditResultsIndex } from './codeIndex/auditResults.js';
import { WhitelistIndex } from './codeIndex/whitelist.js';
import { SchemaIndex } from './codeIndex/schema.js';
import { ProjectTasksIndex } from './codeIndex/projectTasks.js';
import { ConventionsIndex } from './codeIndex/conventions.js';
import { RawSqlIndex } from './codeIndex/rawSql.js';

// Re-exported for the security conformance test (`codeIndexDB-security.spec.ts`);
// the implementations live in `codeIndex/shared.ts` so every extracted module and
// the facade share one copy instead of drifting.
export { assertSqlIdentifier, escapeRegExpLiteral } from './codeIndex/shared.js';
export { DB_BUSY_TIMEOUT_MS };

// ── Path containment ─────────────────────────────────────────────────────

/** True when `filePath` is `root` itself or a descendant of `root` (not outside it). */
function isPathUnderRoot(root: string, filePath: string): boolean {
  const rel = path.relative(root, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ── Hoisted SQL / identifier constants ─────────────────────────────────
const PRAGMA_JOURNAL_WAL = 'journal_mode = WAL';
const PRAGMA_FOREIGN_KEYS_ON = 'foreign_keys = ON';
const SQL_DISTINCT_FILE_PATHS = 'SELECT DISTINCT file_path FROM functions';
const SQL_DELETE_FUNCTIONS_IN_FILEPATHS = 'DELETE FROM functions WHERE file_path IN (SELECT value FROM json_each(?))';

// ── Main class ──────────────────────────────────────────────────────────

/**
 * SQLite-backed code index for a single project. Connection owner and
 * transaction boundary; storage concerns live on the public module fields
 * (`functionIndex`, `search`, `coverage`, `graph`, `whitelist`, `schema`,
 * `projectTasks`, `meta`, …) and cross-concern orchestration stays here.
 */
export class CodeIndexDB {
  private static instance: CodeIndexDB;
  /** Subclasses (e.g. EnhancedCodeIndexDB) need access for extra tables without `as any`. */
  protected db!: SqliteDatabase;

  /** Public access to raw SQLite handle — used by ledger writes from external surfaces. */
  get rawDb(): SqliteDatabase {
    return this.db;
  }
  private dbPath: string;
  private isInitialized = false;
  private initializePromise: Promise<void> | null = null;
  /** Set when initialize() fails, so downstream `ensureInitialized()` can name the
   *  *cause* (e.g. missing better-sqlite3 binding) instead of the generic
   *  "Database not initialized". Cleared on success and on close(). */
  private initFailure: Error | null = null;

  // ── Concern modules (public fields — assigned in initializeInternal) ──
  migrations!: SchemaMigrations;
  functionIndex!: FunctionIndex;
  search!: SearchIndex;
  coverage!: CoverageIndex;
  graph!: DependencyGraphIndex;
  meta!: MetaStore;
  provenance!: ProvenanceStore;
  inferredReceivers!: InferredReceiversStore;
  codeMap!: CodeMapIndex;
  analyzerConfig!: AnalyzerConfigIndex;
  auditResults!: AuditResultsIndex;
  whitelist!: WhitelistIndex;
  schema!: SchemaIndex;
  projectTasks!: ProjectTasksIndex;
  conventions!: ConventionsIndex;
  rawSql!: RawSqlIndex;

  /**
   * Read-only facade analyzers consume — the raw-SQL, meta, and coverage
   * concerns composed into the `IndexHandle` contract. Built once at
   * initialization; a plain object field (not delegator methods), so it adds
   * nothing to `solid/class-size`.
   */
  indexHandle!: IndexHandle;

  // ── Schema version ──────────────────────────────────────────────────
  private static readonly SCHEMA_VERSION = 19;

  /**
   * Create an index handle for the given SQLite file (in-memory by default).
   *
   * @param dbPath - Path to the SQLite database file, or ':memory:'.
   */
  constructor(dbPath: string = ':memory:') {
    this.dbPath = dbPath === ':memory:' ? dbPath : path.resolve(dbPath);
  }

  // ── Singleton ───────────────────────────────────────────────────────

  /** The project root this singleton was opened for (used for mismatch detection). */
  private static currentProjectRoot: string | undefined;

  /**
   * Return the process-wide singleton, reopening the store when the requested
   * path differs from the one currently open.
   *
   * @param dbPath - Optional explicit database file path.
   * @param projectRoot - The project root the store is scoped to.
   * @returns The singleton index instance.
   */
  static getInstance(dbPath?: string, projectRoot?: string): CodeIndexDB {
    let resolved: string;
    if (dbPath !== undefined && dbPath !== '') {
      resolved = dbPath === ':memory:' ? ':memory:' : path.resolve(dbPath);
    } else {
      resolved = resolvePersistedIndexPath(projectRoot);
    }

    if (!CodeIndexDB.instance) {
      CodeIndexDB.instance = new CodeIndexDB(resolved);
      CodeIndexDB.currentProjectRoot = projectRoot;
    } else if (CodeIndexDB.instance.dbPath !== resolved) {
      // :memory: is a test escape hatch — never replace it with a file path.
      if (CodeIndexDB.instance.dbPath === ':memory:') {
        return CodeIndexDB.instance;
      }
      // Different project — close old and create new (Bug #4 / Item 1)
      try { CodeIndexDB.instance.db?.close(); } catch { /* ignore */ }
      CodeIndexDB.instance = new CodeIndexDB(resolved);
      CodeIndexDB.instance.isInitialized = false;
      CodeIndexDB.currentProjectRoot = projectRoot;
    }
    return CodeIndexDB.instance;
  }

  /** Reset the singleton — used by tests that need a fresh in-memory instance. */
  static resetInstance(): void {
    if (CodeIndexDB.instance) {
      try { CodeIndexDB.instance.db.close(); } catch { /* ignore */ }
      CodeIndexDB.instance.isInitialized = false;
    }
    (CodeIndexDB as any).instance = null;
  }

  /**
   * The project root the current singleton was opened for (undefined when opened
   * cwd-scoped). Detached-job readers use this to resolve the same DB the writer
   * opened, without re-resolving against cwd and flipping the singleton away.
   */
  static get currentProject(): string | undefined {
    return CodeIndexDB.currentProjectRoot;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Initialize the database schema and adapters once, memoized via a shared
   * promise so concurrent callers await the same initialization.
   *
   * @returns A promise that resolves once initialization completes.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }
    this.initializePromise = this.initializeInternal();
    try {
      await this.initializePromise;
    } catch (e) {
      // Remember why init failed so a later ensureInitialized() (e.g. an analyzer
      // calling count()) surfaces the cause instead of "Database not initialized".
      this.initFailure = e instanceof Error ? e : new Error(String(e));
      throw e;
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
            hint: 'Ensure the storage directory is writable (default: a user-level OS cache dir when CODE_AUDITOR_DATA_DIR is unset).' },
          e instanceof Error ? e : undefined
        );
      }
    }

    // Check for LokiJS migration
    const migrationResult = migrateFromLokiJS(this.dbPath);

    // Open SQLite database (with auto-recovery for corrupted files)
    let retried = false;
    try {
      this.db = openSqlite(this.dbPath, { timeoutMs: DB_BUSY_TIMEOUT_MS });
      this.db.pragma(PRAGMA_JOURNAL_WAL);
      this.db.pragma(PRAGMA_FOREIGN_KEYS_ON);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // No usable backend (e.g. node:sqlite absent and better-sqlite3's binding
      // missing) surfaces from openSqlite with its own clear cause + fix; pass
      // it through unwrapped so that message is not buried under the generic
      // storage hint.
      if (/no usable backend is available/i.test(msg)) {
        throw new ContextualError(
          msg,
          { dbPath: this.dbPath },
          e instanceof Error ? e : undefined
        );
      }
      // Auto-recover from corrupted / non-db files (Bug #4 / Item 1)
      if (!retried && this.dbPath !== ':memory:' && /(not a database|malformed|corrupt)/i.test(msg)) {
        retried = true;
        try { await fs.unlink(this.dbPath); } catch { /* ignore */ }
        this.db = openSqlite(this.dbPath, { timeoutMs: DB_BUSY_TIMEOUT_MS });
        this.db.pragma(PRAGMA_JOURNAL_WAL);
        this.db.pragma(PRAGMA_FOREIGN_KEYS_ON);
      } else {
        const code = getErrnoCode(e);
        throw new ContextualError(
          `Failed to open code index database: ${msg}`,
          { ...(code && { errnoCode: code }), dbPath: this.dbPath,
            hint: 'The index file may be corrupted, locked, or on a read-only volume. Try a different CODE_AUDITOR_DATA_DIR.' },
          e instanceof Error ? e : undefined
        );
      }
    }

    // Create schema
    this.migrations = new SchemaMigrations(this.db);
    this.migrations.createSchema(CodeIndexDB.SCHEMA_VERSION);

    // Construct concern modules against the shared handle.
    this.functionIndex = new FunctionIndex(this.db);
    this.search = new SearchIndex(this.db, this.functionIndex);
    this.coverage = new CoverageIndex(this.db);
    this.graph = new DependencyGraphIndex(this.db);
    this.meta = new MetaStore(this.db);
    this.provenance = new ProvenanceStore(this.db);
    this.inferredReceivers = new InferredReceiversStore(this.db);
    this.codeMap = new CodeMapIndex(this.db);
    this.analyzerConfig = new AnalyzerConfigIndex(this.db);
    this.auditResults = new AuditResultsIndex(this.db);
    this.whitelist = new WhitelistIndex(this.db);
    this.schema = new SchemaIndex(this.db);
    this.projectTasks = new ProjectTasksIndex(this.db);
    this.conventions = new ConventionsIndex(this.db);
    this.rawSql = new RawSqlIndex(this.db);

    // Compose the read-only analyzer facade from the raw-SQL, meta, and
    // coverage modules. This is the same shape the detached-audit runner builds
    // inline; keeping it here gives every consumer one source of truth.
    this.indexHandle = {
      query: (sql, params) => this.rawSql.query(sql, params),
      count: (table) => this.rawSql.count(table),
      tableHasRows: (table) => this.rawSql.tableHasRows(table),
      run: (sql, params) => this.rawSql.run(sql, params),
      exec: (sql) => this.rawSql.exec(sql),
      getMeta: (key) => this.meta.getMeta(key),
      getUntestedTopDecile: (decile) => this.coverage.getUntestedTopDecile(decile),
      rawDb: this.db,
    };

    // Init defaults
    const whitelistCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM whitelist').get() as any).cnt;
    if (whitelistCount === 0) {
      await this.whitelist.initializeDefaultWhitelists();
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
    this.initFailure = null;
  }

  // ── Init guard ──────────────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      // If initialize() already failed, re-throw the *cause* (e.g. the
      // better-sqlite3 native binding is missing) rather than the generic
      // "not initialized" — the latter names neither the cause nor the fix.
      if (this.initFailure) throw this.initFailure;
      throw new Error('Database not initialized. Call initialize() first.');
    }
  }

  // ── Function sync (orchestration) ────────────────────────────────────

  /**
   * Upsert one file's functions and remove rows that no longer exist, then
   * rebuild the dependency graph for that file.
   *
   * @param filePath - The file whose functions are being synced.
   * @param currentFunctions - The functions currently present in the file.
   * @param fileHash - Optional file-level content hash stamped onto each written
   *   row for diff detection.
   * @returns Counts of added, updated, and removed rows.
   */
  async syncFileIndex(filePath: string, currentFunctions: (FunctionMetadata | EnhancedFunctionMetadata)[], fileHash?: string): Promise<{
    added: number;
    updated: number;
    removed: number;
  }> {
    this.ensureInitialized();
    const stats = { added: 0, updated: 0, removed: 0 };

    // Record the file's actual mtime (not wall clock) so detectModifiedFiles can
    // compare like-for-like: an unchanged file's mtime round-trips to an identical
    // ISO string and never reads as "newer".
    let lastModified: string | undefined;
    try {
      lastModified = (await fs.stat(filePath)).mtime.toISOString();
    } catch {
      // stat failed — fall back to wall clock; detectModifiedFiles will then treat
      // an unreadable file as modified, which is the safe direction.
    }

    this.db.transaction(() => this.functionIndex.syncFileIndexRow(filePath, currentFunctions, stats, lastModified, fileHash)).immediate();
    await this.graph.updateDependencyGraph(filePath);
    return stats;
  }

  /**
   * Batch variant of {@link syncFileIndex}: upsert many files in a single write
   * transaction, then rebuild the dependency graph once (unscoped). The
   * detached-audit path previously called {@link syncFileIndex} once per file —
   * one transaction plus one dependency-graph rebuild per file, and the
   * rebuild's un-scoped `SELECT` made that O(files × functions). Collapsing it
   * to one transaction is Amendment B2.
   *
   * @param entries - The per-file sync entries (path plus current functions).
   * @returns Counts of added, updated, and removed rows across all files.
   */
  async syncFileIndexBatch(
    entries: Array<{ filePath: string; currentFunctions: (FunctionMetadata | EnhancedFunctionMetadata)[]; fileHash?: string }>
  ): Promise<{ added: number; updated: number; removed: number }> {
    this.ensureInitialized();
    const stats = { added: 0, updated: 0, removed: 0 };

    // Stat every file once (in parallel) so each row stores that file's real mtime,
    // not wall clock — the same baseline detectModifiedFiles compares against.
    const mtimes = new Map<string, string | undefined>();
    await Promise.all(
      entries.map(async ({ filePath }) => {
        try {
          mtimes.set(filePath, (await fs.stat(filePath)).mtime.toISOString());
        } catch {
          mtimes.set(filePath, undefined);
        }
      })
    );

    this.db.transaction(() => {
      for (const { filePath, currentFunctions, fileHash } of entries) {
        this.functionIndex.syncFileIndexRow(filePath, currentFunctions, stats, mtimes.get(filePath), fileHash);
      }
    }).immediate();
    await this.graph.updateDependencyGraph();
    return stats;
  }

  // ── Lifecycle: clear & close ────────────────────────────────────────

  /**
   * Delete all index data while preserving project tasks, configs, whitelist,
   * and ledger rows.
   *
   * @returns A promise that resolves once the index is cleared.
   */
  async clearIndex(): Promise<void> {
    this.ensureInitialized();
    // Delete every indexed table inside a single transaction. Each DELETE is a
    // literal statement (no interpolation → no sql-injection), one table per
    // statement (no multi-table `exec` → no complex-query), prepared once outside
    // the loop and only `.run()` inside it (no prepare-in-loop → no loop-query),
    // and executed through one shared loop (one query site → no too-many-queries).
    // `meta` keeps the keyed subset below; the FTS5 triggers handle functions_fts
    // cleanup on the functions delete. Preserved by design: project_tasks,
    // analyzer_configs, whitelist, findings_ledger_runs, findings_ledger_findings.
    this.db.transaction(() => {
      const deletes = [
        this.db.prepare('DELETE FROM functions'),
        this.db.prepare('DELETE FROM audit_results'),
        this.db.prepare('DELETE FROM code_maps'),
        this.db.prepare('DELETE FROM schema_definitions'),
        this.db.prepare('DELETE FROM schema_usage'),
        this.db.prepare('DELETE FROM conventions'),
        this.db.prepare('DELETE FROM file_churn'),
        this.db.prepare('DELETE FROM function_churn'),
        this.db.prepare('DELETE FROM hotspot_scores'),
        this.db.prepare('DELETE FROM dry_pair_history'),
        this.db.prepare('DELETE FROM graph_cache'),
        this.db.prepare("DELETE FROM meta WHERE key IN ('churn_hash', 'conventions_hash', 'style_last_sync')"),
      ];
      for (const del of deletes) del.run();
    })();
  }

  /**
   * Close the database handle and release resources, if initialized.
   *
   * @returns A promise that resolves once the handle is closed.
   */
  async close(): Promise<void> {
    if (this.isInitialized) {
      this.db.close();
      this.isInitialized = false;
    }
    this.initFailure = null;
  }

  // ── File sync & bulk cleanup ────────────────────────────────────────

  /**
   * Re-scan a single file and reconcile its indexed functions, removing rows
   * when the file no longer exists.
   *
   * @param filePath - The file to synchronize.
   * @returns Counts of added, updated, and removed rows (null on scan error).
   */
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
      const parsedFunctions = await scanner.scanFunctions(fileContent, filePath);
      return await this.syncFileIndex(filePath, parsedFunctions);
    } catch (error) {
      throw new Error(`Failed to sync file: ${errorMessage(error)}`);
    }
  }

  /**
   * Remove stale function rows whose files are deleted or no longer part of
   * the discovery set.
   *
   * @param projectRoot - Optional project root to reconcile against.
   * @returns Scan counts, removed rows, and per-file errors.
   */
  async bulkCleanup(projectRoot?: string): Promise<{
    scannedCount: number;
    removedCount: number;
    removedFiles: string[];
    errors: Array<{ file: string; error: string }>;
  }> {
    this.ensureInitialized();

    const files = this.db.prepare(SQL_DISTINCT_FILE_PATHS).all() as Array<{ file_path: string }>;
    const removedFiles: string[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    let removedCount = 0;
    let scannedCount = 0;

    // Reconcile against the DISCOVERY set when a project root is given. A
    // gitignored file (corpus-expansion/, .wrangler/dist, …) is no longer source
    // even though it still exists on disk, so `fs.access` alone would keep its
    // stale DRY rows forever. The root is passed explicitly (never inferred from
    // the singleton, which a long-lived MCP process could have left stale); the
    // root-less `index cleanup` CLI / MCP cleanup tools fall back to an on-disk
    // existence check so they still drop rows for genuinely deleted files.
    let discovered: Set<string> | null = null;
    if (projectRoot) {
      try {
        discovered = new Set(await discoverFiles(projectRoot));
      } catch {
        // Discovery failure → fall back to the existence check rather than
        // deleting everything we can't enumerate.
        discovered = null;
      }
    }

    const stalePaths: string[] = [];
    for (const { file_path: fp } of files) {
      scannedCount++;
      let stale = false;
      if (discovered) {
        // Only reconcile paths under this root: the store is project-scoped, but
        // a shared store can hold sibling-root paths we must not delete here.
        stale = isPathUnderRoot(projectRoot!, fp) && !discovered.has(fp);
      } else {
        try {
          await fs.access(fp);
        } catch {
          stale = true;
        }
      }
      if (stale) {
        stalePaths.push(fp);
        removedFiles.push(fp);
      }
    }

    // Batch the deletes — one `IN (SELECT value FROM json_each(?))` DELETE for the
    // whole stale set, instead of one DELETE per stale file (loop-query / N+1).
    // A single JSON-array bind expands through json_each, so a large stale set
    // can't exceed the SQLite bind-parameter ceiling.
    if (stalePaths.length > 0) {
      const result = this.db
        .prepare(SQL_DELETE_FUNCTIONS_IN_FILEPATHS)
        .run(JSON.stringify(stalePaths));
      removedCount += result.changes;
    }

    return { scannedCount, removedCount, removedFiles, errors };
  }

  /**
   * Re-scan the whole project (or the already-indexed files) and reconcile the
   * index, reporting aggregate counts.
   *
   * @param projectRoot - Optional project root to discover files from.
   * @param progressCallback - Optional per-file progress callback.
   * @returns Aggregate sync counts and errors.
   */
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
      const rows = this.db.prepare(SQL_DISTINCT_FILE_PATHS).all() as Array<{ file_path: string }>;
      files = rows.map(r => r.file_path);
    }

    const total = files.length;

    // Parse each file and defer its index write to one batched transaction plus
    // one dependency-graph rebuild after the loop. The previous per-file
    // `synchronizeFile` → `syncFileIndex` path was one transaction plus one
    // per-file dependency-graph rebuild per file — the same O(files × functions)
    // query-in-loop N+1 Amendment B2 collapsed in the detached-audit path.
    // Tree-sitter parsing stays per-file (it is the inherent cost); only the DB
    // write is batched. Progress and per-file error attribution are unchanged.
    const syncEntries: Array<{ filePath: string; currentFunctions: FunctionMetadata[] }> = [];
    const inaccessiblePaths: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const fp = files[i];
      if (progressCallback) {
        progressCallback({ current: i + 1, total, file: fp });
      }

      let accessible = true;
      try {
        await fs.access(fp);
      } catch {
        accessible = false;
      }

      if (!accessible) {
        // File doesn't exist — defer its delete to one batched DELETE after the
        // loop (the same json_each batch the stale cleanup below uses), instead
        // of one `DELETE … WHERE file_path = ?` per missing file (loop-query N+1).
        inaccessiblePaths.push(fp);
        syncedFiles++;
        continue;
      }

      try {
        const { FunctionScanner } = await import('./functionScanner.js');
        const scanner = new FunctionScanner();
        const fileContent = await fs.readFile(fp, 'utf-8');
        const parsedFunctions = await scanner.scanFunctions(fileContent, fp);
        syncEntries.push({ filePath: fp, currentFunctions: parsedFunctions });
        syncedFiles++;
      } catch (error) {
        errors.push({
          file: fp,
          error: `Failed to sync file: ${errorMessage(error)}`
        });
      }
    }

    if (syncEntries.length > 0) {
      const batchStats = await this.syncFileIndexBatch(syncEntries);
      totalAdded += batchStats.added;
      totalUpdated += batchStats.updated;
      totalRemoved += batchStats.removed;
    }

    // Batch-delete the functions of every file that vanished between discovery
    // and the scan (one json_each DELETE, not one per file).
    if (inaccessiblePaths.length > 0) {
      const removed = this.db
        .prepare(SQL_DELETE_FUNCTIONS_IN_FILEPATHS)
        .run(JSON.stringify(inaccessiblePaths));
      totalRemoved += removed.changes;
    }

    // Clean up stale entries: a file is stale when it is no longer in the
    // discovery set (deleted OR gitignored since the last sync). Comparing
    // against discovery — not `fs.access` — makes a gitignored-but-present file
    // an orphan too, matching what discoverFiles prunes at scan time. Without a
    // project root (files came from the index itself), fall back to the on-disk
    // existence check.
    const discoveredSet = projectRoot ? new Set(files) : null;
    const allIndexed = this.db.prepare(SQL_DISTINCT_FILE_PATHS).all() as Array<{ file_path: string }>;
    const stalePaths: string[] = [];
    for (const { file_path: fp } of allIndexed) {
      let stale = false;
      if (discoveredSet) {
        stale = isPathUnderRoot(projectRoot!, fp) && !discoveredSet.has(fp);
      } else {
        try {
          await fs.access(fp);
        } catch {
          stale = true;
        }
      }
      if (stale) stalePaths.push(fp);
    }

    // Batch the deletes — one `IN (SELECT value FROM json_each(?))` DELETE for the
    // whole stale set, instead of one DELETE per stale file (loop-query / N+1). A
    // single JSON-array bind expands through json_each, so a large stale set can't
    // exceed the SQLite bind-parameter ceiling.
    if (stalePaths.length > 0) {
      const result = this.db
        .prepare(SQL_DELETE_FUNCTIONS_IN_FILEPATHS)
        .run(JSON.stringify(stalePaths));
      totalRemoved += result.changes;
    }

    // Spec 13 — Extract git churn data after index is built and stale entries
    // are cleaned up. Runs before conventions mining so hotspot data is
    // available for reordering. Degrades gracefully when no repo exists.
    if (projectRoot) {
      try {
        extractChurn(this.db, projectRoot, { churnWindowMonths: 12 });
        // Compute hotspot scores from churn data
        computeHotspots(this.db);
      } catch (err) {
        // Churn extraction failure is non-fatal — continue without hotspot data.
        // Log the error so the agent/user knows hotspots are unavailable.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[code-audit] Churn/hotspot extraction failed (non-fatal): ${message}`);
      }
    }

    // Spec 12 — Mine codebase conventions after sync when the functions table
    // has changed. Content-hash-based skip: stored hash avoids re-mining.
    this.conventions.mineAllConventions(projectRoot);

    // Spec 14 — Populate graph caches after index is built
    try {
      populateCallGraphCache(this.db);
      populateImportGraphCache(this.db);
    } catch {
      // Graph cache population failure is non-fatal — continue without graph data
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
   *
   * @param filePaths - The file paths to re-parse and diff.
   * @returns Changed and deleted functions, touched paths, and per-file errors.
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

    // First pass: split the changed set into files that no longer exist (deleted)
    // and files that are still on disk. The deleted set is handled with one batched
    // SELECT + DELETE below — a per-file query here was a query-in-loop N+1.
    const missingFiles: string[] = [];
    for (const filePath of filePaths) {
      try {
        await fs.access(filePath);
      } catch {
        missingFiles.push(filePath);
      }
    }

    if (missingFiles.length > 0) {
      const removed = this.db.prepare(
        `SELECT * FROM functions WHERE file_path IN (SELECT value FROM json_each(?))`
      ).all(JSON.stringify(missingFiles)) as any[];
      if (removed.length > 0) {
        deletedFunctions.push(...removed.map((r: any) => this.functionIndex.rowToFunction(r)));
        this.db.prepare(
          SQL_DELETE_FUNCTIONS_IN_FILEPATHS
        ).run(JSON.stringify(missingFiles));
        const touched = new Set(removed.map((r: any) => r.file_path));
        changedFilePaths.push(...missingFiles.filter((fp) => touched.has(fp)));
      }
    }

    const missingSet = new Set(missingFiles);

    // Batch-fetch the existing functions for every still-present file in one
    // query, grouped in memory — a per-file `SELECT … WHERE file_path = ?` inside
    // the diff loop below was a query-in-loop N+1.
    const presentFiles = filePaths.filter((fp) => !missingSet.has(fp));
    const existingByFile = new Map<string, any[]>();
    if (presentFiles.length > 0) {
      const rows = this.db.prepare(
        `SELECT * FROM functions WHERE file_path IN (SELECT value FROM json_each(?))`
      ).all(JSON.stringify(presentFiles)) as any[];
      for (const row of rows) {
        const list = existingByFile.get(row.file_path) ?? [];
        list.push(row);
        existingByFile.set(row.file_path, list);
      }
    }

    // Collect per-file sync entries here and batch them after the loop — a
    // `syncFileIndex` call inside the loop was a per-file transaction plus a
    // per-file dependency-graph rebuild (query-in-loop N+1). `syncFileIndexBatch`
    // collapses that to one transaction and one unscoped rebuild (Amendment B2),
    // and carries each file's content hash so the warm-path short-circuit keeps
    // its stored `file_hash` baseline.
    const syncEntries: Array<{ filePath: string; currentFunctions: FunctionMetadata[]; fileHash: string }> = [];

    for (const filePath of filePaths) {
      if (missingSet.has(filePath)) continue;

      try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const fileHash = computeContentHash(fileContent);
        const existing = existingByFile.get(filePath) ?? [];

        // Short-circuit: when the file's whole-content hash round-trips to the
        // stored `file_hash`, no function can be new, changed, or deleted — skip
        // the tree-sitter re-scan and the re-sync. This is the warm path for
        // `changed` on an already-indexed, unchanged file. The hash is content-
        // based (not mtime), so it preserves the precise change-detection
        // guarantee; a NULL stored hash (first sync after upgrade) never
        // short-circuits, so the index self-heals.
        if (existing.length > 0 && existing[0].file_hash && existing[0].file_hash === fileHash) {
          continue;
        }

        const scanner = new FunctionScanner();
        const currentFunctions = await scanner.scanFunctions(fileContent, filePath);

        // Key identity on (name, line_number) — the table's unique index —
        // not name alone. Two same-named functions in one file (overloads, a
        // method and a free function, the same name in two scopes) otherwise
        // collapse to one map entry, and an edit to the shadowed one is
        // reported against the wrong row or not at all. file_path is constant
        // across the loop, so (name, line_number) is the distinguishing pair.
        const keyOf = (name: unknown, lineNumber: unknown): string =>
          `${name}:${lineNumber}`;
        const existingByName = new Map<string, any>();
        for (const e of existing) {
          existingByName.set(keyOf(e.name, e.line_number), e);
        }

        const currentKeys = new Set(
          currentFunctions.map((f: any) => keyOf(f.name, f.lineNumber))
        );
        let fileChanged = false;

        for (const func of currentFunctions) {
          const existingRow = existingByName.get(
            keyOf(func.name, (func as any).lineNumber)
          );
          // Convert scanner output to EnhancedFunctionMetadata shape
          const funcMeta: EnhancedFunctionMetadata = {
            ...func,
            complexity: (func as any).complexity,
            content_hash: computeContentHash((func as any).body),
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
          if (!currentKeys.has(keyOf(e.name, e.line_number))) {
            deletedFunctions.push(this.functionIndex.rowToFunction(e));
            fileChanged = true;
          }
        }

        if (fileChanged) {
          changedFilePaths.push(filePath);
        }

        // Defer the index write: collected above and flushed in one batch after
        // the loop (see `syncEntries`).
        syncEntries.push({ filePath, currentFunctions: currentFunctions as FunctionMetadata[], fileHash });
      } catch (error) {
        errors.push({
          file: filePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // One batched write + one dependency-graph rebuild for all changed files.
    if (syncEntries.length > 0) {
      await this.syncFileIndexBatch(syncEntries);
    }

    return { changedFunctions, deletedFunctions, changedFilePaths, errors };
  }

  /**
   * Given a project root, detect all indexed files whose mtime is newer than
   * the stored last_modified timestamp. Returns file paths for further processing.
   *
   * @param projectRoot - The project root to scan.
   * @returns The file paths whose mtime is newer than the stored timestamp.
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

  // ── Cross-concern search (search + schema usage) ─────────────────────

  /**
   * Search functions and optionally annotate results with schema usage context.
   *
   * @param options - Search options, including includeSchemaUsage.
   * @returns The search result, with schema context when requested.
   */
  async searchWithSchemaContext(
    options: SearchOptions & { includeSchemaUsage?: boolean } = {}
  ): Promise<SearchResult & { schemaContext?: Array<{ tableName: string; usageType: string }> }> {
    const searchResult = await this.search.searchFunctions(options);
    if (!options.includeSchemaUsage) return searchResult;

    const enhancedFunctions = await Promise.all(
      searchResult.functions.map(async (func) => {
        const schemaUsage = await this.schema.getSchemaUsage({
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
}
