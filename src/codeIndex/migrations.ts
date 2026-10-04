/**
 * Schema migrations + DDL for the code index. Extracted from `CodeIndexDB`;
 * holds only the raw SQLite handle. Also owns the LokiJS source-file migration
 * (`migrateFromLokiJS`) as a free function — it opens its own connection and
 * rewrites files, so it takes the path as a parameter rather than living on
 * the facade.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { openSqlite, DB_BUSY_TIMEOUT_MS } from '../sqlite/driver.js';
import { statSync, existsSync, readFileSync, renameSync, openSync, readSync, closeSync } from 'fs';
import path from 'path';

const PRAGMA_TABLE_INFO_FINDINGS_LEDGER_RUNS = "PRAGMA table_info('findings_ledger_runs')";
const PRAGMA_JOURNAL_WAL = 'journal_mode = WAL';
const PRAGMA_FOREIGN_KEYS_ON = 'foreign_keys = ON';

/** Leading bytes read from a candidate index file to decide whether it is a
 *  LokiJS JSON export. Both signature markers (`{"filename":` prefix and the
 *  top-level `"collections":` key) sit within the first line of any LokiJS
 *  export, so 64 KiB is a wide margin over a 16-byte SQLite header — and
 *  ~1/300th of a real index file, so the sniff stays sub-millisecond. */
const LOKIJS_SNIFF_BYTES = 64 * 1024;

/** The full DDL for a fresh index, as a single idempotent script.
 *  Split out of `createSchema` so the method stays a driver (is-fresh check →
 *  exec → migrate → stamp version) and the schema shape lives as data, not
 *  control flow. Every statement is `CREATE ... IF NOT EXISTS`, so re-running is
 *  safe and a fresh DB is stamped at the current version without replaying
 *  migrations.
 */
const SCHEMA_DDL = `
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
        file_hash         TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_functions_is_exported ON functions(is_exported);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_functions_name_file_line ON functions(name, file_path, line_number);

      CREATE VIRTUAL TABLE IF NOT EXISTS functions_fts USING fts5(
        name, jsdoc_description, purpose, context, body,
        content='functions', content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS functions_ai AFTER INSERT ON functions BEGIN
        INSERT INTO functions_fts(rowid, name, jsdoc_description, purpose, context, body)
        VALUES (new.id, new.name, new.jsdoc_description, new.purpose, new.context, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS functions_ad AFTER DELETE ON functions BEGIN
        INSERT INTO functions_fts(functions_fts, rowid, name, jsdoc_description, purpose, context, body)
        VALUES ('delete', old.id, old.name, old.jsdoc_description, old.purpose, old.context, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS functions_au AFTER UPDATE ON functions BEGIN
        INSERT INTO functions_fts(functions_fts, rowid, name, jsdoc_description, purpose, context, body)
        VALUES ('delete', old.id, old.name, old.jsdoc_description, old.purpose, old.context, old.body);
        INSERT INTO functions_fts(rowid, name, jsdoc_description, purpose, context, body)
        VALUES (new.id, new.name, new.jsdoc_description, new.purpose, new.context, new.body);
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
        function_name TEXT,
        function_start_line   INTEGER,
        function_start_column INTEGER,
        usage_type    TEXT NOT NULL,
        line          INTEGER,
        "column"      INTEGER,
        raw_query     TEXT,
        parameters    TEXT,
        origin        TEXT,
        recorded_at   TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_schema_usage_table ON schema_usage(table_name);
      CREATE INDEX IF NOT EXISTS idx_schema_usage_file ON schema_usage(file_path);
      CREATE INDEX IF NOT EXISTS idx_schema_usage_function ON schema_usage(function_name);
      CREATE INDEX IF NOT EXISTS idx_schema_usage_usage_type ON schema_usage(usage_type);

      -- Spec 60 — import classification at emission (one row per static import
      -- specifier occurrence). classification is free TEXT (no constraint).
      CREATE TABLE IF NOT EXISTS import_specifiers (
        file_path       TEXT NOT NULL,
        specifier       TEXT NOT NULL,
        classification  TEXT NOT NULL,
        resolved_path   TEXT,
        line            INTEGER,
        PRIMARY KEY (file_path, specifier, line)
      );
      CREATE INDEX IF NOT EXISTS idx_import_specifiers_class ON import_specifiers(classification);
      CREATE INDEX IF NOT EXISTS idx_import_specifiers_resolved ON import_specifiers(resolved_path);

      CREATE TABLE IF NOT EXISTS coverage_data (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        function_name TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        line_number   INTEGER,
        basis         TEXT NOT NULL DEFAULT 'static-reach',
        covered       INTEGER NOT NULL DEFAULT 0,
        source        TEXT,
        imported_at   TEXT DEFAULT (datetime('now')),
        UNIQUE(function_name, file_path, line_number)
      );
      CREATE INDEX IF NOT EXISTS idx_cov_basis ON coverage_data(basis);
      CREATE INDEX IF NOT EXISTS idx_cov_covered ON coverage_data(covered);
      CREATE INDEX IF NOT EXISTS idx_cov_function ON coverage_data(function_name);

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
        tool_git_sha TEXT,
        command      TEXT NOT NULL,
        surface      TEXT NOT NULL,
        scope        TEXT NOT NULL,
        target       TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        exit_status  INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT DEFAULT '{}',
        status        TEXT NOT NULL DEFAULT 'completed',
        project_root  TEXT,
        started_at    TEXT,
        heartbeat_at  TEXT,
        finished_at   TEXT,
        error         TEXT,
        progress_json TEXT,
        stderr_log    TEXT,
        content_hash  TEXT,
        files_count   INTEGER,
        file_manifest_json TEXT,
        runner_pid           INTEGER,
        runner_pid_started_at TEXT,
        runner_host          TEXT
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
      CREATE TABLE IF NOT EXISTS findings_ledger_coverage (
        run_id    TEXT NOT NULL REFERENCES findings_ledger_runs(run_id) ON DELETE CASCADE,
        analyzer  TEXT NOT NULL,
        rule_id   TEXT NOT NULL,
        state     TEXT NOT NULL,
        count     INTEGER NOT NULL DEFAULT 0,
        reason    TEXT,
        PRIMARY KEY (run_id, analyzer, rule_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_runs_surface    ON findings_ledger_runs(surface);
      CREATE INDEX IF NOT EXISTS idx_ledger_runs_timestamp   ON findings_ledger_runs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ledger_coverage_run     ON findings_ledger_coverage(run_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_findings_run     ON findings_ledger_findings(run_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_findings_fp      ON findings_ledger_findings(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_ledger_findings_rule    ON findings_ledger_findings(analyzer, rule);

      -- Spec 10: Style intelligence tables
      CREATE TABLE IF NOT EXISTS style_declarations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        property        TEXT NOT NULL,
        raw_value       TEXT NOT NULL,
        normalized_value TEXT,
        mechanism       TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        line            INTEGER NOT NULL,
        context         TEXT,
        variant_context TEXT,
        token_ref       TEXT,
        content_hash    TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_style_decls_property   ON style_declarations(property);
      CREATE INDEX IF NOT EXISTS idx_style_decls_mechanism  ON style_declarations(mechanism);
      CREATE INDEX IF NOT EXISTS idx_style_decls_file_path  ON style_declarations(file_path);
      CREATE INDEX IF NOT EXISTS idx_style_decls_token_ref  ON style_declarations(token_ref);
      CREATE INDEX IF NOT EXISTS idx_style_decls_content_hash ON style_declarations(content_hash);

      CREATE VIRTUAL TABLE IF NOT EXISTS style_declarations_fts USING fts5(
        property, raw_value, normalized_value,
        content='style_declarations', content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS style_tokens (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        value      TEXT NOT NULL,
        file_path  TEXT NOT NULL,
        mechanism  TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_style_tokens_name ON style_tokens(name);

      CREATE TABLE IF NOT EXISTS style_class_usage (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        class_name   TEXT NOT NULL,
        file_path    TEXT NOT NULL,
        line         INTEGER NOT NULL,
        mechanism    TEXT NOT NULL,
        unresolvable INTEGER DEFAULT 0,
        created_at   TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_style_class_usage_name   ON style_class_usage(class_name);
      CREATE INDEX IF NOT EXISTS idx_style_class_usage_file   ON style_class_usage(file_path);
      CREATE INDEX IF NOT EXISTS idx_style_class_usage_unres  ON style_class_usage(unresolvable);

      -- Spec 45 R5: Stylesheet sources the style indexer could not read.
      -- When any rows exist, styles/undefined-class findings carry them as
      -- incomplete-definition context instead of going silent.
      CREATE TABLE IF NOT EXISTS style_unread_sources (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path  TEXT NOT NULL UNIQUE,
        reason     TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Spec 45 R5: defined-class catalog (class_name, file_path) so the
      -- undefined-class detector can resolve a class name with an indexed
      -- "class_name IN (...)" lookup. Populated by the style indexer on insert.
      CREATE TABLE IF NOT EXISTS style_defined_classes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        class_name TEXT NOT NULL,
        file_path  TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(class_name, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_style_defined_class_name ON style_defined_classes(class_name);

      -- Spec 12: Convention mining
      CREATE TABLE IF NOT EXISTS conventions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        antecedent TEXT,
        consequent TEXT,
        pattern TEXT,
        directory TEXT,
        file_path TEXT,
        line INTEGER,
        support INTEGER DEFAULT 0,
        total_cases INTEGER DEFAULT 0,
        confidence REAL DEFAULT 0,
        exemplar_file TEXT,
        exemplar_line INTEGER,
        export_kind TEXT,
        hash TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_conv_domain ON conventions(domain);
      CREATE INDEX IF NOT EXISTS idx_conv_rule_id ON conventions(rule_id);
      CREATE INDEX IF NOT EXISTS idx_conv_directory ON conventions(directory);
      CREATE INDEX IF NOT EXISTS idx_conv_file_path ON conventions(file_path);
      CREATE INDEX IF NOT EXISTS idx_conv_hash ON conventions(hash);

      -- Spec 13: Hotspots & temporal analysis
      CREATE TABLE IF NOT EXISTS file_churn (
        file_path            TEXT PRIMARY KEY,
        commit_count         INTEGER NOT NULL DEFAULT 0,
        lines_added          INTEGER NOT NULL DEFAULT 0,
        lines_deleted        INTEGER NOT NULL DEFAULT 0,
        distinct_authors     INTEGER NOT NULL DEFAULT 0,
        dominant_author      TEXT,
        dominant_author_share REAL DEFAULT 0,
        last_touched         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_file_churn_cc ON file_churn(commit_count);

      CREATE TABLE IF NOT EXISTS function_churn (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        function_id          INTEGER REFERENCES functions(id) ON DELETE CASCADE,
        function_name        TEXT NOT NULL,
        file_path            TEXT NOT NULL,
        commit_count         INTEGER NOT NULL DEFAULT 0,
        distinct_authors     INTEGER NOT NULL DEFAULT 0,
        dominant_author      TEXT,
        dominant_author_share REAL DEFAULT 0,
        renamed              INTEGER DEFAULT 0,
        confidence           REAL DEFAULT 1.0
      );
      CREATE INDEX IF NOT EXISTS idx_func_churn_fid ON function_churn(function_id);

      CREATE TABLE IF NOT EXISTS hotspot_scores (
        target       TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        score        REAL NOT NULL DEFAULT 0,
        churn_pct    REAL NOT NULL DEFAULT 0,
        complexity_pct REAL NOT NULL DEFAULT 0,
        commit_count INTEGER NOT NULL DEFAULT 0,
        distinct_authors INTEGER NOT NULL DEFAULT 0,
        dominant_author TEXT,
        dominant_author_share REAL DEFAULT 0,
        bus_factor_risk INTEGER DEFAULT 0,
        complexity   INTEGER NOT NULL DEFAULT 0,
        updated_at   TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hotspot_scores_score ON hotspot_scores(score DESC);

      CREATE TABLE IF NOT EXISTS dry_pair_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        pair_fingerprint TEXT NOT NULL,
        file1           TEXT NOT NULL,
        symbol1         TEXT,
        line1           INTEGER NOT NULL,
        content_hash1   TEXT NOT NULL,
        file2           TEXT NOT NULL,
        symbol2         TEXT,
        line2           INTEGER NOT NULL,
        content_hash2   TEXT NOT NULL,
        similarity      REAL NOT NULL,
        timestamp       TEXT DEFAULT (datetime('now')),
        run_id          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dph_fingerprint ON dry_pair_history(pair_fingerprint);
      CREATE INDEX IF NOT EXISTS idx_dph_run ON dry_pair_history(run_id);

      -- Spec 14: graph cache for call/import graph construction
      CREATE TABLE IF NOT EXISTS graph_cache (
        graph_type   TEXT NOT NULL,
        node_key     TEXT NOT NULL,
        neighbor_key TEXT NOT NULL,
        weight       REAL NOT NULL,
        PRIMARY KEY (graph_type, node_key, neighbor_key)
      );
      CREATE INDEX IF NOT EXISTS idx_gc_type_node ON graph_cache(graph_type, node_key);
      CREATE INDEX IF NOT EXISTS idx_gc_type_neighbor ON graph_cache(graph_type, neighbor_key);

      -- Spec 68 §12: processed-facts store (see migration 17 → 18).
      CREATE TABLE IF NOT EXISTS phase_facts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_kind   TEXT NOT NULL,
        file_path   TEXT,
        payload     TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_phase_facts_kind_file ON phase_facts(fact_kind, file_path);
`;

/** Migration 16 → 17: drop the always-empty `signature` column (Spec 63 R6) and
 *  rebuild the FTS surface without it. Kept as a free function (not a method) so
 *  the schema-upgrade code stays split into query-budget-sized units.
 *  @param db The SQLite database handle to migrate in place.
 *  @param currentVersion The stored schema version; migration is a no-op at 17+. */
export function migrateSchemaUsageToV17(db: SqliteDatabase, currentVersion: number): void {
  if (currentVersion >= 17) return;
  // Clear the derived index FIRST, while the existing FTS surface and its
  // triggers are still the ones that match the current schema. `DELETE FROM
  // functions` fires the live `functions_ad` trigger per row, keeping
  // `functions_fts` in step, and cascades to `function_calls` /
  // `function_dependencies`. It must precede the FTS drop: firing the
  // `functions_ad` trigger against a freshly recreated (empty) external-content
  // `functions_fts` while `functions` still holds rows yields
  // SQLITE_CORRUPT, not a clean delete.
  db.exec(`DELETE FROM functions`);

  // Drop the FTS surface — SQLite refuses DROP COLUMN while the FTS triggers
  // reference the column, and the FTS table's column list must shed
  // `signature` too.
  db.exec(`
    DROP TRIGGER IF EXISTS functions_ai;
    DROP TRIGGER IF EXISTS functions_ad;
    DROP TRIGGER IF EXISTS functions_au;
    DROP TABLE IF EXISTS functions_fts;
  `);

  // Drop the column only if it still exists. A fresh DB is created by
  // `createSchema` *without* the column (it already reflects v17), and the
  // migrations then run on top of it with `currentVersion` 0 — so this guard
  // is what lets an old index be upgraded in place without breaking a brand
  // new one (same idempotence as the 14→15 / 15→16 column guards).
  const fnCols = db
    .prepare(`PRAGMA table_info('functions')`)
    .all() as Array<{ name: string }>;
  if (fnCols.some((c) => c.name === 'signature')) {
    db.exec(`ALTER TABLE functions DROP COLUMN signature`);
  }

  // Rebuild the FTS surface without `signature`.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS functions_fts USING fts5(
      name, jsdoc_description, purpose, context, body,
      content='functions', content_rowid='id',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS functions_ai AFTER INSERT ON functions BEGIN
      INSERT INTO functions_fts(rowid, name, jsdoc_description, purpose, context, body)
      VALUES (new.id, new.name, new.jsdoc_description, new.purpose, new.context, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS functions_ad AFTER DELETE ON functions BEGIN
      INSERT INTO functions_fts(functions_fts, rowid, name, jsdoc_description, purpose, context, body)
      VALUES ('delete', old.id, old.name, old.jsdoc_description, old.purpose, old.context, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS functions_au AFTER UPDATE ON functions BEGIN
      INSERT INTO functions_fts(functions_fts, rowid, name, jsdoc_description, purpose, context, body)
      VALUES ('delete', old.id, old.name, old.jsdoc_description, old.purpose, old.context, old.body);
      INSERT INTO functions_fts(rowid, name, jsdoc_description, purpose, context, body)
      VALUES (new.id, new.name, new.jsdoc_description, new.purpose, new.context, new.body);
    END;
  `);
}

  /** Copy the three user-authored LokiJS collections (tasks, analyzer configs,
   *  whitelist) into their SQLite tables, returning the row count of each.
   *
   * @param migDb The fresh SQLite database opened for the migration.
   * @param collections The LokiJS collections keyed by name.
   * @returns The migrated row counts, keyed `tasks` / `configs` / `whitelist`.
   */
export function migrateLokiCollections(
    migDb: SqliteDatabase,
    collections: Record<string, any[]>,
  ): { tasks: number; configs: number; whitelist: number } {
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

    return { tasks: taskCount, configs: configCount, whitelist: whitelistCount };
  }

/**
 * Migrate a legacy LokiJS index file at `dbPath` to SQLite. Returns whether a
 * migration occurred. Extracted from `CodeIndexDB.maybeMigrateFromLokiJS` so the
 * facade no longer carries the 19-branch migration routine; the function opens
 * its own connection and rewrites files, so it takes the path as a parameter.
 * @param dbPath The database file path to inspect and, if it is a LokiJS file, migrate.
 * @returns Whether a migration occurred, and the migrated row counts when it did.
 */
export function migrateFromLokiJS(dbPath: string): { migrated: boolean; counts?: { tasks: number; configs: number; whitelist: number } } {
  if (dbPath === ':memory:') return { migrated: false };

  const bakPath = dbPath + '.loki.bak';
  // If backup already exists alongside a valid SQLite db, skip
  try {
    const st = statSync(bakPath);
    if (st.isFile()) {
      // Check if SQLite db exists
      try {
        statSync(dbPath);
        return { migrated: false };
      } catch { /* fall through */ }
    }
  } catch { /* no backup */ }

  // Check if dbPath is a LokiJS file. A LokiJS export is a single JSON object
  // whose `filename`/`collections` keys sit at the very top, so the leading
  // bytes are enough to tell it apart from a SQLite binary (`SQLite format 3\0`).
  // Reading only a header chunk instead of the whole file avoids slurping a
  // multi-MB index into memory on every process start (measured ~55 ms CPU on a
  // 19.7 MB index) just to decide the answer is "not LokiJS".
  try {
    const fd = openSync(dbPath, 'r');
    let header = '';
    try {
      const buf = Buffer.alloc(LOKIJS_SNIFF_BYTES);
      const n = readSync(fd, buf, 0, LOKIJS_SNIFF_BYTES, 0);
      header = buf.toString('utf-8', 0, n);
    } finally {
      closeSync(fd);
    }
    if (!header.startsWith('{"filename":') && !header.includes('"collections":')) {
      return { migrated: false };
    }
  } catch {
    return { migrated: false };
  }

  // It's LokiJS — migrate
  try {
    const content = readFileSync(dbPath, 'utf-8');
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
    renameSync(dbPath, bakPath);

    const migDb = openSqlite(dbPath, { timeoutMs: DB_BUSY_TIMEOUT_MS });
    migDb.pragma(PRAGMA_JOURNAL_WAL);
    migDb.pragma(PRAGMA_FOREIGN_KEYS_ON);

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

    const { tasks: taskCount, configs: configCount, whitelist: whitelistCount } =
      migrateLokiCollections(migDb, collections);

    migDb.close();

    const countLine = [
      taskCount && `${taskCount} tasks`,
      configCount && `${configCount} analyzer configs`,
      whitelistCount && `${whitelistCount} whitelist entries`,
    ].filter(Boolean).join(', ') || '0 entries';
    console.error(`[code-auditor] Migrated ${countLine} from LokiJS to SQLite. Old file saved as ${path.basename(bakPath)}`);
    return { migrated: true, counts: { tasks: taskCount, configs: configCount, whitelist: whitelistCount } };
  } catch (err) {
    // Migration failed — try to restore the backup
    console.error('[code-auditor] LokiJS migration failed:', err instanceof Error ? err.message : String(err));
    try {
      if (existsSync(bakPath) && !existsSync(dbPath)) {
        renameSync(bakPath, dbPath);
      }
    } catch { /* best effort */ }
    return { migrated: false };
  }
}

/**
 * Schema migration runner + DDL owner for the code index. Replays the ordered
 * migration steps (2 → 18) against an existing index, and creates a fresh index
 * at the current shape when no `functions` table exists yet.
 */
export class SchemaMigrations {
  /**
   * Hold the SQLite handle to migrate and stamp with the schema version.
   * @param db The SQLite database handle to migrate.
   */
  constructor(private db: SqliteDatabase) {}

  // ── Schema migrations ────────────────────────────────────────────────

  private runMigrations(): void {
    // Read the currently stored schema version (if any)
    const row = this.db.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    ).get() as { value: string } | undefined;

    const currentVersion = row ? parseInt(row.value, 10) : 0;
    this.migrateCoreTables(currentVersion);
    this.migrateConventionsExportKind(currentVersion);
    this.migrateRunLifecycle(currentVersion);
    this.migrateStyleCatalog(currentVersion);
    this.migrateSchemaUsageAndSignature(currentVersion);
  }

  /** Run a schema script only when the stored version precedes the target. */
  private migrateFrom(currentVersion: number, targetVersion: number, sql: string): void {
    if (currentVersion < targetVersion) this.db.exec(sql);
  }

  /** Add missing columns to findings_ledger_runs, batching the ALTERs into one
   *  exec (loop-query / N+1). Reused by the two run-lifecycle migrations. */
  private addRunColumns(currentVersion: number, targetVersion: number, newRunCols: Array<[string, string]>): void {
    if (currentVersion >= targetVersion) return;
    const runCols = this.db
      .prepare(PRAGMA_TABLE_INFO_FINDINGS_LEDGER_RUNS)
      .all() as Array<{ name: string }>;
    const hasRunCol = (name: string) => runCols.some((c) => c.name === name);
    const missingCols = newRunCols.filter(([name]) => !hasRunCol(name));
    if (missingCols.length > 0) {
      this.db.exec(
        missingCols
          .map(([name, decl]) => `ALTER TABLE findings_ledger_runs ADD COLUMN ${name} ${decl}`)
          .join(';\n'),
      );
    }
  }

  /** Migrations 2 → 7 — the pure-DDL table/index additions. */
  private migrateCoreTables(currentVersion: number): void {
    // Migration 1 → 2: Unique index on (name, file_path, line_number)
    // Previously the unique index was on (name, file_path) only, which caused
    // same-named functions at different lines in the same file to collide.
    this.migrateFrom(currentVersion,2, `
        DROP INDEX IF EXISTS idx_functions_name_file;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_functions_name_file_line ON functions(name, file_path, line_number);
      `);

    // Migration 2 → 3: Style intelligence tables (Spec 10)
    this.migrateFrom(currentVersion,3, `
        CREATE TABLE IF NOT EXISTS style_declarations (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          property        TEXT NOT NULL,
          raw_value       TEXT NOT NULL,
          normalized_value TEXT,
          mechanism       TEXT NOT NULL,
          file_path       TEXT NOT NULL,
          line            INTEGER NOT NULL,
          context         TEXT,
          variant_context TEXT,
          token_ref       TEXT,
          content_hash    TEXT,
          created_at      TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_style_decls_property   ON style_declarations(property);
        CREATE INDEX IF NOT EXISTS idx_style_decls_mechanism  ON style_declarations(mechanism);
        CREATE INDEX IF NOT EXISTS idx_style_decls_file_path  ON style_declarations(file_path);
        CREATE INDEX IF NOT EXISTS idx_style_decls_token_ref  ON style_declarations(token_ref);
        CREATE INDEX IF NOT EXISTS idx_style_decls_content_hash ON style_declarations(content_hash);

        CREATE VIRTUAL TABLE IF NOT EXISTS style_declarations_fts USING fts5(
          property, raw_value, normalized_value,
          content='style_declarations', content_rowid='id',
          tokenize='porter unicode61'
        );

        CREATE TABLE IF NOT EXISTS style_tokens (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          value      TEXT NOT NULL,
          file_path  TEXT NOT NULL,
          mechanism  TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_style_tokens_name ON style_tokens(name);

        CREATE TABLE IF NOT EXISTS style_class_usage (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          class_name   TEXT NOT NULL,
          file_path    TEXT NOT NULL,
          line         INTEGER NOT NULL,
          mechanism    TEXT NOT NULL,
          unresolvable INTEGER DEFAULT 0,
          created_at   TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_style_class_usage_name   ON style_class_usage(class_name);
        CREATE INDEX IF NOT EXISTS idx_style_class_usage_file   ON style_class_usage(file_path);
        CREATE INDEX IF NOT EXISTS idx_style_class_usage_unres  ON style_class_usage(unresolvable);
      `);

    // Migration 3 → 4: Convention mining tables (Spec 12)
    this.migrateFrom(currentVersion,4, `
        CREATE TABLE IF NOT EXISTS conventions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          antecedent TEXT,
          consequent TEXT,
          pattern TEXT,
          directory TEXT,
          file_path TEXT,
          line INTEGER,
          support INTEGER DEFAULT 0,
          total_cases INTEGER DEFAULT 0,
          confidence REAL DEFAULT 0,
          exemplar_file TEXT,
          exemplar_line INTEGER,
          hash TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_conv_domain ON conventions(domain);
        CREATE INDEX IF NOT EXISTS idx_conv_rule_id ON conventions(rule_id);
        CREATE INDEX IF NOT EXISTS idx_conv_directory ON conventions(directory);
        CREATE INDEX IF NOT EXISTS idx_conv_hash ON conventions(hash);
      `);

    // Migration 4 → 5: Hotspots & temporal analysis (Spec 13)
    this.migrateFrom(currentVersion,5, `
        CREATE TABLE IF NOT EXISTS file_churn (
          file_path            TEXT PRIMARY KEY,
          commit_count         INTEGER NOT NULL DEFAULT 0,
          lines_added          INTEGER NOT NULL DEFAULT 0,
          lines_deleted        INTEGER NOT NULL DEFAULT 0,
          distinct_authors     INTEGER NOT NULL DEFAULT 0,
          dominant_author      TEXT,
          dominant_author_share REAL DEFAULT 0,
          last_touched         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_file_churn_cc ON file_churn(commit_count);

        CREATE TABLE IF NOT EXISTS function_churn (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          function_id          INTEGER REFERENCES functions(id) ON DELETE CASCADE,
          function_name        TEXT NOT NULL,
          file_path            TEXT NOT NULL,
          commit_count         INTEGER NOT NULL DEFAULT 0,
          distinct_authors     INTEGER NOT NULL DEFAULT 0,
          dominant_author      TEXT,
          dominant_author_share REAL DEFAULT 0,
          renamed              INTEGER DEFAULT 0,
          confidence           REAL DEFAULT 1.0
        );
        CREATE INDEX IF NOT EXISTS idx_func_churn_fid ON function_churn(function_id);

        CREATE TABLE IF NOT EXISTS hotspot_scores (
          target       TEXT PRIMARY KEY,
          type         TEXT NOT NULL,
          score        REAL NOT NULL DEFAULT 0,
          churn_pct    REAL NOT NULL DEFAULT 0,
          complexity_pct REAL NOT NULL DEFAULT 0,
          commit_count INTEGER NOT NULL DEFAULT 0,
          distinct_authors INTEGER NOT NULL DEFAULT 0,
          dominant_author TEXT,
          dominant_author_share REAL DEFAULT 0,
          bus_factor_risk INTEGER DEFAULT 0,
          complexity   INTEGER NOT NULL DEFAULT 0,
          updated_at   TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_hotspot_scores_score ON hotspot_scores(score DESC);

        CREATE TABLE IF NOT EXISTS dry_pair_history (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          pair_fingerprint TEXT NOT NULL,
          file1           TEXT NOT NULL,
          symbol1         TEXT,
          line1           INTEGER NOT NULL,
          content_hash1   TEXT NOT NULL,
          file2           TEXT NOT NULL,
          symbol2         TEXT,
          line2           INTEGER NOT NULL,
          content_hash2   TEXT NOT NULL,
          similarity      REAL NOT NULL,
          timestamp       TEXT DEFAULT (datetime('now')),
          run_id          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dph_fingerprint ON dry_pair_history(pair_fingerprint);
        CREATE INDEX IF NOT EXISTS idx_dph_run ON dry_pair_history(run_id);
      `);

    // Migration 5 → 6: Graph cache for call/import graph construction (Spec 14)
    this.migrateFrom(currentVersion,6, `
        CREATE TABLE IF NOT EXISTS graph_cache (
          graph_type   TEXT NOT NULL,
          node_key     TEXT NOT NULL,
          neighbor_key TEXT NOT NULL,
          weight       REAL NOT NULL,
          PRIMARY KEY (graph_type, node_key, neighbor_key)
        );
        CREATE INDEX IF NOT EXISTS idx_gc_type_node ON graph_cache(graph_type, node_key);
        CREATE INDEX IF NOT EXISTS idx_gc_type_neighbor ON graph_cache(graph_type, neighbor_key);
      `);

    // Migration 6 → 7: Coverage data for cross-domain analysis (Spec 15)
    this.migrateFrom(currentVersion,7, `
        CREATE TABLE IF NOT EXISTS coverage_data (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          function_name TEXT NOT NULL,
          file_path     TEXT NOT NULL,
          line_number   INTEGER,
          basis         TEXT NOT NULL DEFAULT 'static-reach',
          covered       INTEGER NOT NULL DEFAULT 0,
          source        TEXT,
          imported_at   TEXT DEFAULT (datetime('now')),
          UNIQUE(function_name, file_path, line_number)
        );
        CREATE INDEX IF NOT EXISTS idx_cov_basis ON coverage_data(basis);
        CREATE INDEX IF NOT EXISTS idx_cov_covered ON coverage_data(covered);
        CREATE INDEX IF NOT EXISTS idx_cov_function ON coverage_data(function_name);
      `);
  }

  /** Migration 7 → 8: export_kind on conventions (Spec 22 R5.1). */
  private migrateConventionsExportKind(currentVersion: number): void {
    // Migration 7 → 8: export_kind on conventions (Spec 22 R5.1)
    if (currentVersion < 8) {
      const cols = this.db
        .prepare(`PRAGMA table_info('conventions')`)
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'export_kind')) {
        this.db.exec(`ALTER TABLE conventions ADD COLUMN export_kind TEXT`);
      }
    }
  }

  /** Migration 8 → 9 / 9 → 10 / 10 → 11 — detached-run lifecycle + queryable
   *  coverage (Spec 41), PID-based lease liveness (Spec 41 Amendment B), and
   *  unread stylesheet sources (Spec 45 R5). */
  private migrateRunLifecycle(currentVersion: number): void {
    // Migration 8 → 9: Detached-run lifecycle + queryable coverage (Spec 41).
    // `findings_ledger_runs` gains the job-lifecycle columns (status, timing,
    // provenance, lease heartbeat, progress, stderr log); the one genuinely new
    // table is `findings_ledger_coverage` (per-rule state + reason rows that
    // `writeAuditToLedger` previously dropped).
    this.addRunColumns(currentVersion,9, [
      ['status', "TEXT NOT NULL DEFAULT 'completed'"],
      ['project_root', 'TEXT'],
      ['started_at', 'TEXT'],
      ['heartbeat_at', 'TEXT'],
      ['finished_at', 'TEXT'],
      ['error', 'TEXT'],
      ['progress_json', 'TEXT'],
      ['stderr_log', 'TEXT'],
      ['content_hash', 'TEXT'],
      ['files_count', 'INTEGER'],
      ['file_manifest_json', 'TEXT'],
    ]);
    this.migrateFrom(currentVersion,9, `
        CREATE TABLE IF NOT EXISTS findings_ledger_coverage (
          run_id    TEXT NOT NULL REFERENCES findings_ledger_runs(run_id) ON DELETE CASCADE,
          analyzer  TEXT NOT NULL,
          rule_id   TEXT NOT NULL,
          state     TEXT NOT NULL,
          count     INTEGER NOT NULL DEFAULT 0,
          reason    TEXT,
          PRIMARY KEY (run_id, analyzer, rule_id)
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_coverage_run ON findings_ledger_coverage(run_id);
      `);

    // Migration 9 → 10: PID-based lease liveness (Spec 41 Amendment B).
    // The heartbeat is no longer the primary liveness signal for the common
    // case (a healthy child whose synchronous `syncFileIndex` phase starves the
    // event loop, so its heartbeat interval cannot fire). The child records its
    // PID + process start time + hostname at lease claim; `reclaimStaleRunning`
    // then skips any `running` row whose PID is still the same live process, and
    // only reclaims when the process is genuinely gone (or on a foreign host,
    // where the PID means nothing and the heartbeat stays the fallback).
    this.addRunColumns(currentVersion,10, [
      ['runner_pid', 'INTEGER'],
      ['runner_pid_started_at', 'TEXT'],
      ['runner_host', 'TEXT'],
    ]);

    // Migration 10 → 11: unread stylesheet sources (Spec 45 R5).
    // Records stylesheets whose dialect the style indexer cannot read, so
    // styles/undefined-class findings can carry them as incomplete-definition
    // context instead of asserting a class is undefined against the whole project.
    this.migrateFrom(currentVersion,11, `
        CREATE TABLE IF NOT EXISTS style_unread_sources (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path  TEXT NOT NULL UNIQUE,
          reason     TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
  }

  /** Migration 11 → 12: defined-class catalog (Spec 45 — styles/undefined-class). */
  private migrateStyleCatalog(currentVersion: number): void {
    // Migration 11 → 12: defined-class catalog (Spec 45 — styles/undefined-class).
    // A dedicated (class_name, file_path) table so the undefined-class detector
    // can resolve a class name with an indexed `class_name IN (...)` lookup
    // instead of loading every style_declarations row and regex-extracting
    // selectors from `context` in JS. Populated by the style indexer on insert;
    // backfilled here once so an in-place upgrade does not leave the catalog
    // empty (unchanged-file hashing would otherwise skip the re-extract).
    if (currentVersion < 12) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS style_defined_classes (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          class_name TEXT NOT NULL,
          file_path  TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(class_name, file_path)
        );
        CREATE INDEX IF NOT EXISTS idx_style_defined_class_name ON style_defined_classes(class_name);
      `);

      const definedRows = this.db
        .prepare('SELECT DISTINCT context, file_path FROM style_declarations WHERE context IS NOT NULL')
        .all() as Array<{ context: string; file_path: string }>;
      const insertDefined = this.db.prepare(
        'INSERT OR IGNORE INTO style_defined_classes (class_name, file_path) VALUES (?, ?)',
      );
      const backfill = this.db.transaction(() => {
        for (const r of definedRows) {
          for (const m of r.context.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
            insertDefined.run(m[1], r.file_path);
          }
        }
      });
      backfill();
    }
  }

  /** Migrations 12 → 18 — import_specifiers, schema_usage identity/origin,
   *  tool_git_sha, the signature-column removal (Spec 63 R6), and phase_facts. */
  private migrateSchemaUsageAndSignature(currentVersion: number): void {
    // Migration 12 → 13: import_specifiers (Spec 60 — import classification at
    // emission). One row per static import specifier occurrence, classified
    // package / unresolved-alias / internal-resolved / internal-broken /
    // unresolved-virtual (Spec 60.1 widened the three-class scheme to five;
    // `classification` is free TEXT, no constraint, so no further migration).
    // Nothing consumes it yet (Spec 61 persists edges; Spec 62 derives coverage).
    // Flat — resolved_path inline, no lookup table, no join.
    this.migrateFrom(currentVersion,13, `
      CREATE TABLE IF NOT EXISTS import_specifiers (
        file_path       TEXT NOT NULL,
        specifier       TEXT NOT NULL,
        classification  TEXT NOT NULL,
        resolved_path   TEXT,
        line            INTEGER,
        PRIMARY KEY (file_path, specifier, line)
      );
      CREATE INDEX IF NOT EXISTS idx_import_specifiers_class ON import_specifiers(classification);
      CREATE INDEX IF NOT EXISTS idx_import_specifiers_resolved ON import_specifiers(resolved_path);
    `);

    // Migration 13 → 14: schema_usage identity becomes a coordinate (Spec 61
    // Amendment A). function_name stops holding source text and becomes the
    // nullable display name (null for anonymous handlers); identity is the
    // inline (file_path, function_start_line, function_start_column) coordinate.
    // function_name drops its NOT NULL so anonymous handlers store NULL, distinct
    // from 'top-level' (function_start_line IS NULL). Old rows keep their
    // (now-legacy) names but are regenerated on the next per-file sync.
    if (currentVersion < 14) {
      const suCols = this.db
        .prepare(`PRAGMA table_info('schema_usage')`)
        .all() as Array<{ name: string }>;
      if (!suCols.some((c) => c.name === 'function_start_line')) {
        this.db.exec(`
          ALTER TABLE schema_usage RENAME TO schema_usage_old;
          CREATE TABLE schema_usage (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            schema_id     TEXT,
            table_name    TEXT NOT NULL,
            file_path     TEXT NOT NULL,
            function_name TEXT,
            function_start_line   INTEGER,
            function_start_column INTEGER,
            usage_type    TEXT NOT NULL,
            line          INTEGER,
            "column"      INTEGER,
            raw_query     TEXT,
            parameters    TEXT,
            origin        TEXT,
            recorded_at   TEXT DEFAULT (datetime('now'))
          );
          INSERT INTO schema_usage (id, schema_id, table_name, file_path, function_name, usage_type, line, "column", raw_query, parameters, recorded_at)
            SELECT id, schema_id, table_name, file_path, function_name, usage_type, line, "column", raw_query, parameters, recorded_at FROM schema_usage_old;
          DROP TABLE schema_usage_old;
          CREATE INDEX IF NOT EXISTS idx_schema_usage_table ON schema_usage(table_name);
          CREATE INDEX IF NOT EXISTS idx_schema_usage_file ON schema_usage(file_path);
          CREATE INDEX IF NOT EXISTS idx_schema_usage_function ON schema_usage(function_name);
          CREATE INDEX IF NOT EXISTS idx_schema_usage_usage_type ON schema_usage(usage_type);
        `);
      }
    }

    // Migration 14 → 15: tool's own git sha on the run (the second axis next to
    // tool_version). `git_sha` already records the *audited project* commit; this
    // records the *code-auditor* commit so a count change is attributable to a
    // tool commit, not just a version. NULL when running from a published
    // install (no .git) — best-effort, and tool_version stays always-present.
    this.addRunColumns(currentVersion,15, [['tool_git_sha', 'TEXT']]);

    // Migration 15 → 16: schema_usage gains an `origin` column. Rows produced by
    // the knex-style fluent-builder read extractor carry `origin = 'query-builder'`;
    // every other extractor (raw SQL, tagged template, .sql, ORM) leaves it NULL.
    // The cross-domain lifecycle rules use it to exempt tables whose usage is
    // entirely query-builder — scratch/test tables built and consumed through the
    // fluent builder are not one-sided lifecycle defects.
    if (currentVersion < 16) {
      const suCols = this.db
        .prepare(`PRAGMA table_info('schema_usage')`)
        .all() as Array<{ name: string }>;
      if (!suCols.some((c) => c.name === 'origin')) {
        this.db.exec(`ALTER TABLE schema_usage ADD COLUMN origin TEXT`);
      }
    }

    // Migration 16 → 17: Spec 63 R6 dropped the always-empty `signature` column
    // and the `signature` term of `computeContentHash`. Two consequences for a
    // pre-bump index:
    //   1. Every stored `content_hash` was computed under the old `body|signature`
    //      formula, so it no longer matches what `detectChangedFunctions`
    //      recomputes — a stale index left in place would be *silently consumed*
    //      (a no-edit `changed` run reports the whole file changed and attributes
    //      it to the code, not the index).
    //   2. The `functions.signature` column (always `''`) and its FTS mirror must
    //      go. SQLite refuses `DROP COLUMN` while the FTS triggers reference the
    //      column, so the triggers and FTS table are dropped first, the column is
    //      dropped, and the FTS surface is rebuilt without `signature`.
    migrateSchemaUsageToV17(this.db, currentVersion);

    // Migration 17 → 18: the phase facts store (Spec 68 §12). The index stops
    // being a function cache and becomes the processed-facts store of record:
    // per-file workers return serialized fact fragments, the parent writes them
    // here in batched transactions, and corpus processors + rules read them back
    // read-only under WAL (§6.2/§6.3). One row per (fact_kind, file_path); corpus
    // facts (e.g. `resolution`, `reachability`) carry a NULL file_path.
    this.migrateFrom(currentVersion,18, `
      CREATE TABLE IF NOT EXISTS phase_facts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_kind   TEXT NOT NULL,
        file_path   TEXT,
        payload     TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_phase_facts_kind_file ON phase_facts(fact_kind, file_path);
    `);

    // Migration 18 → 19: functions gains a `file_hash` — the content-hash of the
    // file's whole normalized source — so `detectChangedFunctions` can skip the
    // tree-sitter re-scan when a file's content is unchanged since its last
    // index sync (the warm path for `changed` on an already-indexed file). The
    // column is NULL until the first sync writes it; a NULL file_hash never
    // short-circuits, so an in-place-upgraded index degrades to the old always-
    // scan behavior until its next sync, with no correctness gap.
    if (currentVersion < 19) {
      const fnCols = this.db
        .prepare(`PRAGMA table_info('functions')`)
        .all() as Array<{ name: string }>;
      if (!fnCols.some((c) => c.name === 'file_hash')) {
        this.db.exec(`ALTER TABLE functions ADD COLUMN file_hash TEXT`);
      }
    }

  }

  // ── SQLite schema ───────────────────────────────────────────────────

  /** Whether a table already exists in the connected database. */
  private tableExists(name: string): boolean {
    const row = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
    ).get(name) as { name: string } | undefined;
    return row !== undefined;
  }

  /**
   * Create the index schema, upgrading an existing index in place or stamping a
   * fresh one at the current version.
   * @param schemaVersion The schema version to record after creation or upgrade.
   */
  createSchema(schemaVersion: number): void {
    // A fresh database is created by `CREATE TABLE` in SCHEMA_DDL at the
    // *current* schema shape — there is no history to replay. Migrations run
    // only against an existing index being upgraded in place. Stamping a fresh DB
    // at the current version and skipping the blocks turns "every future migration
    // author must remember to write an idempotence guard" into "there is nothing
    // to guard against" — the same structural move as the tier function and the
    // exhaustiveness assertion. Detected before the exec because `functions` is
    // created by it.
    const isFresh = !this.tableExists('functions');

    this.db.exec(SCHEMA_DDL);

    // Run schema migrations (only an existing index needs upgrading)
    if (!isFresh) {
      this.runMigrations();
    }

    // Record schema version
    this.db.prepare(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`
    ).run(String(schemaVersion));
  }
}
