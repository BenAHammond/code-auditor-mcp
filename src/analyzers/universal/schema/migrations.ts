/**
 * Migration/DDL replay + one-hop barrel re-export resolution.
 *
 * Spec 33 item 15 — extracted from UniversalSchemaAnalyzer.ts so the DDL
 * state machine, barrel reader, and streaming DDL-presence detection are
 * importable and testable independently of the analyzer class.
 */

import fs from 'fs/promises';
import { readFileSync, statSync } from 'node:fs';
import path from 'path';
import { MAX_ORPHAN_SOURCE_BYTES } from '../../../types.js';
import { isTestOrSpecPath } from '../../../languages/testConventions.js';
import type { MigrationOp, ReExport } from './types.js';
import type { Dialect } from '../../../mcp-tools/discoveryQueries.js';
import {
  parseSqlProgramTolerant,
  ddlColumnDefinitions,
  ddlForeignKeys as astDdlForeignKeys,
  ddlMigrationOps,
  ddlConstraintColumns,
  ddlTableNames,
  isDdlStatement,
} from '../../../languages/sql/sqlAst.js';
import type { AST } from 'node-sql-parser';

/**
 * Strip SQL identifier delimiters: backticks or double-quotes.
 * @param name
 * @returns
 */
export function stripIdentifier(name: string): string {
  if (
    (name.startsWith('`') && name.endsWith('`')) ||
    (name.startsWith('"') && name.endsWith('"'))
  ) {
    return name.slice(1, -1);
  }
  return name;
}

/**
 * Apply pre-extracted DDL operations to a table set in migration order.
 * Strips identifier delimiters (backticks/quotes) and performs the
 * CREATE/DROP/RENAME state transitions. Callable from the schema reducer
 * without re-parsing raw SQL.
 * @param ops
 * @param tables
 */
export function applyMigrationOps(ops: MigrationOp[], tables: Set<string>): void {
  for (const { op, table, newTable } of ops) {
    if (op === 'CREATE') {
      tables.add(stripIdentifier(table));
    } else if (op === 'DROP') {
      tables.delete(stripIdentifier(table));
    } else {
      tables.delete(stripIdentifier(table));
      tables.add(stripIdentifier(newTable!));
    }
  }
}

/**
 * Parse a migration SQL source and apply stateful CREATE/DROP/RENAME
 * operations to the given table set in migration order.
 * @param source
 * @param tables
 * @param dialect The corpus's named dialect; null is honest abstention — no
 *   parse under a guessed {@link DEFAULT_SQL_DIALECT} (unproven, cannot-fire).
 */
export function processMigrationSource(
  source: string,
  tables: Set<string>,
  dialect: Dialect | null,
): void {
  applyMigrationOps(parseMigrationOps(source, dialect), tables);
}

/** A drop-provenance entry: which migration dropped a table, and the tables
 *  that same migration introduced (evidence, not proof, of a successor). */
export interface DropProvenanceEntry {
  migrationFile: string;
  createdInSameMigration: string[];
}

/** The result of replaying per-file DDL declarations in migration order: the
 *  surviving known-table set (with each table's last-CREATE source file and
 *  column list) and the drop provenance the `stale-table-reference` rule reads.
 *  Both halves derive from one replay, so the known set and the provenance can
 *  never disagree about which table a migration dropped. */
export interface ReplayedDdl {
  netTables: Array<{
    name: string;
    source: string;
    columns: string[];
    uniqueColumns: string[];
    primaryKeyColumns: string[];
    notNullColumns: string[];
    foreignKeys: DdlForeignKey[];
  }>;
  dropProvenance: Map<string, DropProvenanceEntry>;
}

/**
 * Replay per-file DDL declarations in migration order to compute, in one pass,
 * both the net known-table set (a table dropped in a migration and not
 * recreated is *not* known) and the drop provenance (dropped-table name → which
 * migration dropped it and what it introduced). A table created and dropped
 * within the *same* file is a self-contained scratch fixture (its DROP is
 * teardown, not a migration), so it is kept known and excluded from the
 * provenance. This is the shared pure function the legacy schema reducer's
 * inline replay and the phase-model `resolution` / `migration-history`
 * corpus processors both compute, so the two facts are identical by
 * construction (parity-by-construction for `unknown-table` and
 * `stale-table-reference`).
 *
 * @param ddlFiles Per-file declarations with parsed ops and (optionally) the
 *   columns the file declares for each table (order-independent — this sorts by
 *   the numeric prefix in the basename, then localeCompare).
 * @returns The net known-table set and the drop provenance.
 */
export function replayDdlDeclarations(
  ddlFiles: ReadonlyArray<{
    filePath: string;
    ops: readonly MigrationOp[];
    tableColumns?: Readonly<Record<string, readonly string[]>>;
    uniqueColumns?: Readonly<Record<string, readonly string[]>>;
    primaryKeyColumns?: Readonly<Record<string, readonly string[]>>;
    notNullColumns?: Readonly<Record<string, readonly string[]>>;
    foreignKeys?: Readonly<Record<string, readonly DdlForeignKey[]>>;
  }>,
): ReplayedDdl {
  const numericPrefix = (p: string): number => {
    const base = p.split('/').pop() ?? p;
    const m = base.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };
  const sorted = [...ddlFiles]
    // A DROP (or CREATE) inside a test/spec file is test scaffolding, not a
    // production table lifecycle event. Replaying it would let `DROP TABLE
    // users` in `codeIndexDB-security.spec.ts` mark a production table dropped,
    // turning every later reference into a `stale-table-reference` false
    // positive. Skip test/spec files before replay so only production migrations
    // move the known-table set and the drop provenance.
    .filter((d) => !isTestOrSpecPath(d.filePath))
    .sort((a, b) => {
      const na = numericPrefix(a.filePath);
      const nb = numericPrefix(b.filePath);
      if (na !== nb) return na - nb;
      return a.filePath.localeCompare(b.filePath);
    });

  const knownTables = new Set<string>();
  // Last-CREATE source file + column list per surviving table, so `resolution`
  // names the file that most recently (re)declared the table, with its columns.
  const sourceFile = new Map<string, string>();
  const columnsByTable = new Map<string, string[]>();
  const uniqueColumnsByTable = new Map<string, string[]>();
  const primaryKeyColumnsByTable = new Map<string, string[]>();
  const notNullColumnsByTable = new Map<string, string[]>();
  const foreignKeysByTable = new Map<string, DdlForeignKey[]>();
  const dropProvenance = new Map<string, DropProvenanceEntry>();

  for (const ddlFile of sorted) {
    const before = new Set(knownTables);

    // Replay this file's CREATE/DROP/RENAME transitions, tracking last-CREATE
    // source/columns alongside the net set (the same transitions
    // `applyMigrationOps` performs, but with provenance bookkeeping).
    for (const op of ddlFile.ops) {
      const t = stripIdentifier(op.table);
      if (op.op === 'CREATE') {
        knownTables.add(t);
        sourceFile.set(t, ddlFile.filePath);
        columnsByTable.set(t, [...(ddlFile.tableColumns?.[t] ?? [])]);
        uniqueColumnsByTable.set(t, [...(ddlFile.uniqueColumns?.[t] ?? [])]);
        primaryKeyColumnsByTable.set(t, [...(ddlFile.primaryKeyColumns?.[t] ?? [])]);
        notNullColumnsByTable.set(t, [...(ddlFile.notNullColumns?.[t] ?? [])]);
        foreignKeysByTable.set(t, [...(ddlFile.foreignKeys?.[t] ?? [])]);
      } else if (op.op === 'DROP') {
        knownTables.delete(t);
      } else {
        const nt = stripIdentifier(op.newTable!);
        knownTables.delete(t);
        knownTables.add(nt);
        sourceFile.delete(t);
        columnsByTable.delete(t);
        uniqueColumnsByTable.delete(t);
        primaryKeyColumnsByTable.delete(t);
        notNullColumnsByTable.delete(t);
        foreignKeysByTable.delete(t);
        sourceFile.set(nt, ddlFile.filePath);
        columnsByTable.set(nt, [...(ddlFile.tableColumns?.[nt] ?? [])]);
        uniqueColumnsByTable.set(nt, [...(ddlFile.uniqueColumns?.[nt] ?? [])]);
        primaryKeyColumnsByTable.set(nt, [...(ddlFile.primaryKeyColumns?.[nt] ?? [])]);
        notNullColumnsByTable.set(nt, [...(ddlFile.notNullColumns?.[nt] ?? [])]);
        foreignKeysByTable.set(nt, [...(ddlFile.foreignKeys?.[nt] ?? [])]);
      }
    }

    // Genuinely-new tables introduced by this migration (excludes rename/rebuild
    // churn like `ALTER … RENAME TO x_old` + re-CREATE of the same name).
    const createdHere: string[] = [];
    const createdTables = new Set<string>();
    const droppedTables = new Set<string>();
    for (const op of ddlFile.ops) {
      const t = stripIdentifier(op.table);
      if (op.op === 'CREATE') {
        createdTables.add(t);
        if (!before.has(t)) createdHere.push(t);
      } else if (op.op === 'DROP') {
        droppedTables.add(t);
      }
    }
    for (const op of ddlFile.ops) {
      const t = stripIdentifier(op.table);
      if (op.op === 'DROP') {
        dropProvenance.set(t, { migrationFile: ddlFile.filePath, createdInSameMigration: createdHere });
      } else if (op.op === 'CREATE') {
        dropProvenance.delete(t);
      }
    }
    // A table created and dropped within this same file is a self-contained
    // fixture — a scratch table a test or script creates, uses, then tears
    // down. Its DROP is teardown, not a migration: keep it known and clear the
    // drop provenance this file recorded for it.
    for (const t of createdTables) {
      if (droppedTables.has(t)) {
        knownTables.add(t);
        if (dropProvenance.get(t)?.migrationFile === ddlFile.filePath) {
          dropProvenance.delete(t);
        }
      }
    }
  }

  const netTables: Array<{
    name: string;
    source: string;
    columns: string[];
    uniqueColumns: string[];
    primaryKeyColumns: string[];
    notNullColumns: string[];
    foreignKeys: DdlForeignKey[];
  }> = [];
  for (const name of knownTables) {
    netTables.push({
      name,
      source: sourceFile.get(name) ?? '',
      columns: columnsByTable.get(name) ?? [],
      uniqueColumns: uniqueColumnsByTable.get(name) ?? [],
      primaryKeyColumns: primaryKeyColumnsByTable.get(name) ?? [],
      notNullColumns: notNullColumnsByTable.get(name) ?? [],
      foreignKeys: foreignKeysByTable.get(name) ?? [],
    });
  }

  return { netTables, dropProvenance };
}

/**
 * Extract ordered DDL operations from migration SQL text — the AST replacement
 * for site #7's `DDL_RE`, which had to regex the whole create/drop/alter-rename
 * vocabulary as one alternation. Each statement is parsed tolerantly (a `PRAGMA`
 * or `CREATE TRIGGER` beside a `CREATE TABLE` is a failure the caller accounts
 * for, not a discard of the whole file) and walked by {@link ddlMigrationOps}.
 * Emitted by the schema-sql visitor instead of raw source so the reducer only
 * retains the extracted state transitions, not the full file text.
 * @param source
 * @param dialect The corpus's named dialect; null is honest abstention — the SQL
 *   is NOT parsed under a guessed {@link DEFAULT_SQL_DIALECT}. An undetermined
 *   (or ambiguous) dialect yields `unproven`: the caller surfaces the
 *   `dialect undetermined` cannot-fire reason, never a sqlite-guessed op set.
 * @returns
 */
export function parseMigrationOps(source: string, dialect: Dialect | null): MigrationOp[] {
  // A null dialect is not a licence to guess sqlite. Parsing DDL under a dialect
  // nothing in the manifest suggested is a wrong answer wearing a fact — the
  // same inversion as the dialect gate, one layer over. Abstain: no AST parse and
  // no FTS5 regex recovery, so an ambiguous corpus (pg+mysql) emits zero ops and
  // the cannot-fire reason carries the ambiguity instead.
  if (dialect === null) return [];
  const { statements } = parseSqlProgramTolerant(source, dialect);
  const ops: MigrationOp[] = [];
  for (const stmt of statements) {
    ops.push(...ddlMigrationOps(stmt));
  }
  // FTS5 `CREATE VIRTUAL TABLE … USING fts5(…)` is rejected by node-sql-parser
  // (it is not `CREATE TABLE`), so the tolerant parse drops it and the DDL replay
  // never learns the table exists. That makes a dropped-and-recreated FTS table
  // read as "dropped, never recreated" — the `stale-table-reference` false
  // positive on `functions_fts` (whose v17 migration drops the FTS5 surface, then
  // rebuilds it). Recover those creates here so the replay tracks the virtual
  // table's lifecycle like any other table. The recovered CREATE ops are appended
  // after the AST-derived ops; the replay's net result is unaffected by
  // intra-file ordering because the *last* op per table decides its state — a
  // virtual table's DROP is already captured, so a re-CREATE appended after it
  // correctly restores it to known.
  for (const op of virtualTableCreateOps(source)) {
    ops.push(op);
  }
  return ops;
}

/** Regex-scan `source` for `CREATE VIRTUAL TABLE [IF NOT EXISTS] <name>` headers
 *  and emit a CREATE op per name. This is the recovery path for FTS5 virtual
 *  tables, which node-sql-parser cannot parse; a bare identifier (optionally
 *  backtick/double-quoted) is the only supported name shape, matching the
 *  `DDL_HEADER_RE` the ddl-declarations oracle counts. */
const VIRTUAL_TABLE_CREATE_RE = /CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"']?[A-Za-z_][A-Za-z0-9_$]*[`"']?)/gi;

function virtualTableCreateOps(source: string): MigrationOp[] {
  const ops: MigrationOp[] = [];
  let m: RegExpExecArray | null;
  while ((m = VIRTUAL_TABLE_CREATE_RE.exec(source)) !== null) {
    const name = stripIdentifier(m[1]!);
    if (name) ops.push({ op: 'CREATE', table: name });
  }
  return ops;
}

// ── DDL column extraction (Spec 39 — derived applicability) ──────────────────
//
// Sites #9 and #10 are the AST replacements for the regex scanners that used to
// hand-roll paren-depth tracking and quote handling (a SQL parser written one
// bug at a time). The statement is parsed once by the grammar and the column /
// constraint / foreign-key facts are read off the definition nodes.

/**
 * The shared DDL-column extraction body behind `extractDdlTableColumns`,
 * `extractDdlUniqueColumns`, `extractDdlPrimaryKeyColumns`, and
 * `extractDdlNotNullColumns`. Each is the same skeleton — null-dialect → empty,
 * parse the program tolerantly, walk the statements adding lowercased columns to
 * a per-table set via the `columnsFor` helper, fold the map to
 * `Record<table, cols>`. Only the per-statement column selection differs, so it
 * is the `collect` callback here; the null-guard, parse, map lifecycle, and fold
 * are shared. The column-set helper is passed in so a caller that groups by a
 * table derived from the statement (a `UNIQUE (…)` / `PRIMARY KEY (…)`
 * constraint, whose table is the statement's own table rather than a column's)
 * can still route to the right bucket.
 */
function extractDdlColumns(
  source: string,
  dialect: Dialect | null,
  collect: (stmt: AST, columnsFor: (table: string) => Set<string>) => void,
): Record<string, string[]> {
  if (dialect === null) return {}; // honest abstention — no parse under a guessed dialect
  const { statements } = parseSqlProgramTolerant(source, dialect);
  const tableColumns = new Map<string, Set<string>>();
  const columnsFor = (table: string): Set<string> => {
    let cols = tableColumns.get(table);
    if (!cols) {
      cols = new Set<string>();
      tableColumns.set(table, cols);
    }
    return cols;
  };
  for (const stmt of statements) collect(stmt, columnsFor);
  const result: Record<string, string[]> = {};
  for (const [table, cols] of tableColumns) result[table] = [...cols];
  return result;
}

/**
 * Extract per-table column names from migration SQL — CREATE TABLE column
 * definitions, ALTER TABLE … ADD COLUMN, and the columns of a foreign-key
 * constraint (Drizzle's `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY
 * ("organization_id") …` declares the tenant column through the constraint, not
 * a column definition). Returns a `Record<table, columns>` with lowercased,
 * deduplicated column names, so the schema reducer can answer "does THIS table
 * carry a tenant-scoping column?" — the per-query question the flat set cannot.
 * @param source Migration/DDL SQL text.
 * @param dialect The corpus's named dialect; null is honest abstention — no
   *   parse under a guessed {@link DEFAULT_SQL_DIALECT} (unproven, cannot-fire).
 * @returns Per-table lowercased column-name lists.
 */
export function extractDdlTableColumns(source: string, dialect: Dialect | null): Record<string, string[]> {
  return extractDdlColumns(source, dialect, (stmt, columnsFor) => {
    for (const col of ddlColumnDefinitions(stmt)) {
      if (col.table) columnsFor(col.table).add(col.column.toLowerCase());
    }
    // FK-constraint columns are the tenant-column pass: a table whose only
    // tenant column is declared through `ADD CONSTRAINT … FOREIGN KEY` still
    // surfaces its columns here (Spec 68 — declared inputs).
    for (const fk of astDdlForeignKeys(stmt)) {
      const cols = columnsFor(fk.table);
      for (const column of fk.columns) cols.add(column.toLowerCase());
    }
  });
}

/**
 * Extract per-table *natural* UNIQUE column names from migration SQL — the
 * bootstrap-lookup signal `missing-org-filter` reads: a query whose predicate
 * carries one of these is a structurally-scoped lookup by a natural key. Covers
 * the three DDL spellings of `UNIQUE`:
 *
 *   - column-level:  `slug TEXT UNIQUE`
 *   - table-level:   `UNIQUE (slug)`, `UNIQUE (a, b)`
 *   - ALTER:         `ALTER TABLE t ADD CONSTRAINT … UNIQUE (col)`
 *
 * PRIMARY KEY is deliberately *excluded*. A surrogate primary key is not a
 * bootstrap lookup: `WHERE id = $1` on a tenant table returns exactly one row
 * selected by a caller-supplied id — that is the IDOR surface the rule exists
 * to catch, not a signal that tenant scoping is unnecessary (see
 * `specs/rule-authenticity-ledger.md:46`, and the Thing 1 correction that
 * narrowed this signal to natural keys).
 *
 * Returns lowercased SQL column names keyed by table. A column that is unique
 * only through a composite constraint still appears — the predicate test is
 * "does the filter name this column", not "is the column alone unique".
 * @param source Migration/DDL SQL text.
 * @param dialect The corpus's named dialect; null is honest abstention — no
   *   parse under a guessed {@link DEFAULT_SQL_DIALECT} (unproven, cannot-fire).
 * @returns Per-table lowercased natural-UNIQUE column-name lists.
 */
export function extractDdlUniqueColumns(source: string, dialect: Dialect | null): Record<string, string[]> {
  return extractDdlColumns(source, dialect, (stmt, columnsFor) => {
    const table = ddlTableNames(stmt)[0] ?? '';
    // Column-level `col … UNIQUE`. PRIMARY KEY is excluded (surrogate PK is the
    // IDOR surface, not a bootstrap-lookup signal) — `ddlColumnDefinitions`
    // carries `unique` and `primaryKey` separately.
    for (const col of ddlColumnDefinitions(stmt)) {
      if (col.unique) columnsFor(col.table).add(col.column.toLowerCase());
    }
    // Table-level / ALTER `UNIQUE (…)` / `CONSTRAINT x UNIQUE (…)`.
    for (const name of ddlConstraintColumns(stmt, 'unique')) {
      columnsFor(table).add(name.toLowerCase());
    }
  });
}

/**
 * Extract per-table PRIMARY KEY columns from migration SQL — the surrogate-vs-
 * natural distinction `missing-org-filter` needs to keep PK *separate* from
 * UNIQUE (Spec 69 R3, criterion 8). Covers the DDL spellings of a primary key:
 *
 *   - column-level:  `id SERIAL PRIMARY KEY`, `id INTEGER PRIMARY KEY`
 *   - table-level:   `PRIMARY KEY (id)`, `CONSTRAINT pk PRIMARY KEY (id)`
 *   - ALTER:         `ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (col)`
 *
 * Returns lowercased SQL column names keyed by table. A composite PK lists every
 * member column. PRIMARY KEY and UNIQUE are *never* merged here — the caller
 * records them as separate flags so the quiet set can stay natural-UNIQUE-only.
 * @param source Migration/DDL SQL text.
 * @param dialect The corpus's named dialect; null is honest abstention — no
   *   parse under a guessed {@link DEFAULT_SQL_DIALECT} (unproven, cannot-fire).
 * @returns Per-table lowercased PRIMARY-KEY column-name lists.
 */
export function extractDdlPrimaryKeyColumns(source: string, dialect: Dialect | null): Record<string, string[]> {
  return extractDdlColumns(source, dialect, (stmt, columnsFor) => {
    const table = ddlTableNames(stmt)[0] ?? '';
    // Column-level `id … PRIMARY KEY`.
    for (const col of ddlColumnDefinitions(stmt)) {
      if (col.primaryKey) columnsFor(col.table).add(col.column.toLowerCase());
    }
    // Table-level `PRIMARY KEY (…)` / `CONSTRAINT pk PRIMARY KEY (…)`.
    for (const name of ddlConstraintColumns(stmt, 'primary key')) {
      columnsFor(table).add(name.toLowerCase());
    }
  });
}

/**
 * Extract per-table NOT NULL columns from migration SQL. Column-level only —
 * SQL has no table-level NOT NULL constraint. Returns lowercased SQL column
 * names keyed by table; the resolution fact records the flag separately so a
 * rule can distinguish a required column from a nullable one.
 * @param source Migration/DDL SQL text.
 * @param dialect The corpus's named dialect; null is honest abstention — no
   *   parse under a guessed {@link DEFAULT_SQL_DIALECT} (unproven, cannot-fire).
 * @returns Per-table lowercased NOT-NULL column-name lists.
 */
export function extractDdlNotNullColumns(source: string, dialect: Dialect | null): Record<string, string[]> {
  return extractDdlColumns(source, dialect, (stmt, columnsFor) => {
    for (const col of ddlColumnDefinitions(stmt)) {
      if (col.notNull) columnsFor(col.table).add(col.column.toLowerCase());
    }
  });
}

/** One foreign-key reference the DDL declares: the referencing column in the
 *  declaring table, and the referenced table + column it points at. */
export interface DdlForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}

/**
 * Extract per-table foreign-key references from migration SQL. Covers the DDL
 * spellings of a reference:
 *
 *   - column-level:  `org_id INTEGER REFERENCES organizations(id)`
 *   - table-level:   `FOREIGN KEY (org_id) REFERENCES organizations(id)`
 *   - ALTER:         `ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (col) REFERENCES other(col)`
 *
 * Returns lowercased SQL names keyed by the declaring table. The reference is a
 * separate fact from PK/UNIQUE/NOT NULL (Spec 69 R3 — each constraint recorded
 * separately), so a rule can trace which column links to which other table.
 * @param source Migration/DDL SQL text.
 * @param dialect The corpus's named dialect; null is honest abstention — no
   *   parse under a guessed {@link DEFAULT_SQL_DIALECT} (unproven, cannot-fire).
 * @returns Per-table foreign-key references.
 */
export function extractDdlForeignKeys(source: string, dialect: Dialect | null): Record<string, DdlForeignKey[]> {
  if (dialect === null) return {}; // honest abstention — no parse under a guessed dialect
  const { statements } = parseSqlProgramTolerant(source, dialect);
  const fks = new Map<string, DdlForeignKey[]>();
  const fksFor = (table: string): DdlForeignKey[] => {
    let list = fks.get(table);
    if (!list) {
      list = [];
      fks.set(table, list);
    }
    return list;
  };
  // Dedupe by (column, refTable, refColumn) — the same FK is often re-declared
  // in a later migration (DROP + re-ADD), and the replay keeps the last CREATE.
  const seen = new Set<string>();

  for (const stmt of statements) {
    for (const fk of astDdlForeignKeys(stmt)) {
      const refTable = stripIdentifier(fk.referencesTable).toLowerCase();
      const refCols = fk.referencesColumns.map((c) => stripIdentifier(c).toLowerCase());
      const cols = fk.columns.map((c) => stripIdentifier(c).toLowerCase());
      for (let i = 0; i < cols.length; i++) {
        const key = `${cols[i]}|${refTable}|${refCols[i] ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          fksFor(fk.table).push({ column: cols[i], refTable, refColumn: refCols[i] ?? '' });
        }
      }
    }
  }

  const result: Record<string, DdlForeignKey[]> = {};
  for (const [table, list] of fks) result[table] = list;
  return result;
}

/**
 * Extract column names from migration SQL — CREATE TABLE bodies (via a
 * depth-tracking paren scan that finds each matching close paren) and
 * ALTER TABLE … ADD COLUMN statements. Returns lowercased, deduplicated names
 * so the schema reducer can answer "does any table carry a tenant-scoping
 * column?" without materializing per-table column lists. The flat union of
 * {@link extractDdlTableColumns}.
 * @param source Migration/DDL SQL text.
 * @param dialect The corpus's named dialect; null is honest abstention — no
   *   parse under a guessed {@link DEFAULT_SQL_DIALECT} (unproven, cannot-fire).
 * @returns The set of column names declared across the source.
 */
export function extractDdlColumnNames(source: string, dialect: Dialect | null): string[] {
  const columns = new Set<string>();
  for (const cols of Object.values(extractDdlTableColumns(source, dialect))) {
    for (const c of cols) columns.add(c);
  }
  return [...columns];
}

/**
 * Extract the DDL SQL fragments embedded in host-language source — the TS/JS
 * migration files whose `CREATE/DROP/ALTER TABLE` statements live inside string
 * or template literals (Durable-Object-local DDL and raw `sql.exec(...)` bodies
 * that migration discovery never sees). This is the literal-*extraction* half of
 * that path: the raw TS/JS text carries the SQL verbatim inside the literals, so
 * this names the strings to hand to the AST extractors — it is NOT itself a SQL
 * parse, and it is deliberately NOT a general "find SQL anywhere" sweep. It only
 * matches a literal that contains a CREATE/DROP/ALTER TABLE (or VIRTUAL TABLE)
 * header, the same boundary the legacy schema-code visitor drew; every matched
 * fragment is then parsed by {@link parseMigrationOps} /
 * {@link extractDdlTableColumns} downstream.
 *
 * Returns the fragments joined as a `;`-separated program (so a template literal
 * holding several statements parses as one), or `null` when the source carries no
 * DDL-bearing literal.
 * @param source The raw TS/JS (or other host-language) source text.
 * @returns Pure SQL for the DDL extractors, or null when none is present.
 */
export function extractDdlSqlFromSource(source: string): string | null {
  const templateRe = /`([^`]*(?:CREATE|DROP|ALTER)\s+(?:TABLE|VIRTUAL\s+TABLE)\s+[^`]+)`/gis;
  const stringRe = /(["'])((?:\s*(?:CREATE|DROP|ALTER)\s+(?:TABLE|VIRTUAL\s+TABLE)\s+[^"']+))\1/gis;
  const fragments: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = templateRe.exec(source)) !== null) {
    const sql = m[1].trim();
    if (sql) fragments.push(sql);
  }
  while ((m = stringRe.exec(source)) !== null) {
    const sql = m[2].trim();
    if (sql) fragments.push(sql);
  }
  return fragments.length > 0 ? fragments.join(';\n') : null;
}

// ── One-hop barrel re-export resolution (Spec 33 item 9) ─────────────────────

/**
 * Extract `export * from 'x'` and `export { a, b as c } from 'x'` statements
 * from barrel source.  Regex-based — matches the analyzer's existing
 * migration/ORM discovery idiom and avoids a tree-sitter round-trip per barrel.
 * Local re-exports without a `from` clause are not re-exports and are skipped.
 * @param source
 * @returns
 */
export function extractReExports(source: string): ReExport[] {
  const results: ReExport[] = [];

  const starRe = /export\s*\*\s*from\s*(['"])([^'"]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = starRe.exec(source)) !== null) {
    results.push({ source: m[2], star: true, renamed: new Map() });
  }

  const namedRe = /export\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
  while ((m = namedRe.exec(source)) !== null) {
    const renamed = new Map<string, string>();
    for (const raw of m[1].split(',')) {
      const spec = raw.trim();
      if (!spec) continue;
      const asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(spec);
      if (asMatch) {
        // `export { original as local } from 'x'`
        renamed.set(asMatch[2], asMatch[1]);
      } else {
        const name = /^(\w+)$/.exec(spec);
        if (name) renamed.set(name[1], name[1]);
      }
    }
    results.push({ source: m[3], star: false, renamed });
  }

  return results;
}

/**
 * Resolve a relative module specifier to a file on disk, trying common source
 * extensions and index files.  Returns the resolved path (absolute or relative
 * to the importing file's directory) or null when the file cannot be found.
 *
 * @param fromFile The importing file (its directory is the resolution base).
 * @param specifier The relative module specifier to resolve.
 * @returns The resolved file path, or null when not found.
 */
export function resolveBarrelModulePath(fromFile: string, specifier: string): string | null {
  const fromDir = path.dirname(fromFile);
  const base = path.resolve(fromDir, specifier);

  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx'].map(ext => base + ext),
    ...['.ts', '.tsx', '.js', '.jsx'].map(ext => path.join(base, 'index' + ext)),
  ];

  for (const candidate of candidates) {
    try {
      // Cheap existence check without throwing on directory candidates.
      const stat = statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Default barrel reader — resolves the specifier relative to `fromFile` on disk.
 *
 * @param fromFile The importing file (its directory is the resolution base).
 * @param specifier The relative module specifier to read.
 * @returns The resolved file's source text, or null when unreadable.
 */
export function readModuleFromDisk(fromFile: string, specifier: string): string | null {
  const resolved = resolveBarrelModulePath(fromFile, specifier);
  if (!resolved) return null;
  try {
    return readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Extract migration ops from an SQL file, honoring stage-1 streaming: when
 * `sourceCode` is empty the file was too large to materialize, so it is read in
 * full only to answer "is this a migration or a data dump?" — the AST successor
 * to site #8's streaming `CREATE|DROP|ALTER TABLE` regex. The parsed statements
 * decide: a file with no table DDL is a data dump and is skipped (surfaced in
 * coverage, no violation); one with table DDL has its ops/columns extracted.
 * Only a real oversized migration is read in full (rare).
 * @param filePath
 * @param sourceCode
 * @param dialect The corpus's named dialect; null is honest abstention — no
 *   parse under a guessed {@link DEFAULT_SQL_DIALECT} (unproven, cannot-fire).
 * @returns
 */
export async function extractMigrationOpsFromFile(
  filePath: string,
  sourceCode: string,
  dialect: Dialect | null,
): Promise<{ ops: MigrationOp[]; columns: string[]; tableColumns: Record<string, string[]>; skipped: boolean; bytes: number }> {
  if (sourceCode !== '') {
    return {
      ops: parseMigrationOps(sourceCode, dialect),
      columns: extractDdlColumnNames(sourceCode, dialect),
      tableColumns: extractDdlTableColumns(sourceCode, dialect),
      skipped: false,
      bytes: Buffer.byteLength(sourceCode),
    };
  }
  let size = 0;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    size = 0;
  }
  if (size <= MAX_ORPHAN_SOURCE_BYTES) {
    // Empty or small file whose read produced an empty string — nothing to do.
    return { ops: [], columns: [], tableColumns: {}, skipped: false, bytes: size };
  }
  const full = await fs.readFile(filePath, 'utf-8');
  if (dialect === null) {
    // Honest abstention — a null dialect must not guess sqlite just to answer
    // "migration or data dump". Report no ops/columns and let the caller's
    // dialect-undetermined cannot-fire reason carry the abstention.
    return { ops: [], columns: [], tableColumns: {}, skipped: false, bytes: size };
  }
  const { statements } = parseSqlProgramTolerant(full, dialect);
  if (!statements.some((stmt) => isDdlStatement(stmt))) {
    return { ops: [], columns: [], tableColumns: {}, skipped: true, bytes: size };
  }
  return {
    ops: statements.flatMap((stmt) => ddlMigrationOps(stmt)),
    columns: extractDdlColumnNames(full, dialect),
    tableColumns: extractDdlTableColumns(full, dialect),
    skipped: false,
    bytes: size,
  };
}
