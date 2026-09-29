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
import type { MigrationOp, ReExport } from './types.js';

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
 */
export function processMigrationSource(
  source: string,
  tables: Set<string>,
): void {
  applyMigrationOps(parseMigrationOps(source), tables);
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
  netTables: Array<{ name: string; source: string; columns: string[]; uniqueColumns: string[] }>;
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
 * inline replay and the phase-model `table-catalog` / `migration-history`
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
  }>,
): ReplayedDdl {
  const numericPrefix = (p: string): number => {
    const base = p.split('/').pop() ?? p;
    const m = base.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };
  const sorted = [...ddlFiles].sort((a, b) => {
    const na = numericPrefix(a.filePath);
    const nb = numericPrefix(b.filePath);
    if (na !== nb) return na - nb;
    return a.filePath.localeCompare(b.filePath);
  });

  const knownTables = new Set<string>();
  // Last-CREATE source file + column list per surviving table, so `table-catalog`
  // names the file that most recently (re)declared the table, with its columns.
  const sourceFile = new Map<string, string>();
  const columnsByTable = new Map<string, string[]>();
  const uniqueColumnsByTable = new Map<string, string[]>();
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
      } else if (op.op === 'DROP') {
        knownTables.delete(t);
      } else {
        const nt = stripIdentifier(op.newTable!);
        knownTables.delete(t);
        knownTables.add(nt);
        sourceFile.delete(t);
        columnsByTable.delete(t);
        uniqueColumnsByTable.delete(t);
        sourceFile.set(nt, ddlFile.filePath);
        columnsByTable.set(nt, [...(ddlFile.tableColumns?.[nt] ?? [])]);
        uniqueColumnsByTable.set(nt, [...(ddlFile.uniqueColumns?.[nt] ?? [])]);
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

  const netTables: Array<{ name: string; source: string; columns: string[]; uniqueColumns: string[] }> = [];
  for (const name of knownTables) {
    netTables.push({
      name,
      source: sourceFile.get(name) ?? '',
      columns: columnsByTable.get(name) ?? [],
      uniqueColumns: uniqueColumnsByTable.get(name) ?? [],
    });
  }

  return { netTables, dropProvenance };
}

/**
 * The DDL state-machine regex shared by the standalone analyze() path and the
 * pipeline's schema-sql visitor. Single ordered pass — applies CREATE/DROP/
 * RENAME in statement order within each migration file (fixes the rename-replay
 * bug where CREATE after RENAME in the same file was silently dropped).
 */
const DDL_RE = /(CREATE)\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)|(DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)|(ALTER)\s+TABLE\s+(`[^`]+`|"[^"]+"|\w+)\s+RENAME\s+TO\s+(`[^`]+`|"[^"]+"|\w+)/gi;

/**
 * Extract ordered DDL operations from migration SQL text. Emitted by the
 * schema-sql visitor instead of raw source so the reducer only retains the
 * extracted state transitions, not the full file text.
 * @param source
 * @returns
 */
export function parseMigrationOps(source: string): MigrationOp[] {
  const ops: MigrationOp[] = [];
  let match: RegExpExecArray | null;
  DDL_RE.lastIndex = 0;
  while ((match = DDL_RE.exec(source)) !== null) {
    const op = match[1] || match[3] || match[5];
    if (op === 'CREATE') {
      ops.push({ op: 'CREATE', table: match[2] });
    } else if (op === 'DROP') {
      ops.push({ op: 'DROP', table: match[4] });
    } else if (op === 'ALTER') {
      ops.push({ op: 'RENAME', table: match[6], newTable: match[7] });
    }
  }
  return ops;
}

// ── DDL column extraction (Spec 39 — derived applicability) ──────────────────

/**
 * Split a CREATE TABLE column-definition body on top-level commas. Commas
 * inside nested parens (type arguments, CHECK clauses) and inside string
 * literals are preserved so a column definition is never split mid-expression.
 * @param body The text between the CREATE TABLE parens.
 * @returns The individual column/constraint definitions.
 */
function splitColumnDefs(body: string): string[] {
  const defs: string[] = [];
  let depth = 0;
  let current = '';
  let inString: '"' | "'" | '`' | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      current += ch;
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      defs.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) defs.push(current);
  return defs;
}

/**
 * Extract the leading column name from a single column definition. Table-level
 * constraint clauses (PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK, CONSTRAINT …)
 * have no leading column identifier and are skipped.
 * @param def A single column or constraint definition.
 * @returns The column name, or null when the definition is a table constraint.
 */
function leadingColumnName(def: string): string | null {
  const m = /^\s*(?:CONSTRAINT\s+(?:`[^`]+`|"[^"]+"|\w+))?\s*(`[^`]+`|"[^"]+"|\w+)/.exec(def);
  if (!m) return null;
  const name = stripIdentifier(m[1]);
  const upper = name.toUpperCase();
  if (
    upper === 'PRIMARY' || upper === 'UNIQUE' || upper === 'CONSTRAINT' ||
    upper === 'FOREIGN' || upper === 'CHECK' || upper === 'KEY' || upper === 'INDEX'
  ) {
    return null;
  }
  return name;
}

/**
 * Extract per-table column names from migration SQL — CREATE TABLE bodies (via
 * a depth-tracking paren scan that finds each matching close paren) and
 * ALTER TABLE … ADD COLUMN statements. Returns a `Record<table, columns>` with
 * lowercased, deduplicated column names, so the schema reducer can answer
 * "does THIS table carry a tenant-scoping column?" — the per-query question the
 * flat set cannot.
 * @param source Migration/DDL SQL text.
 * @returns Per-table lowercased column-name lists.
 */
export function extractDdlTableColumns(source: string): Record<string, string[]> {
  const tableColumns = new Map<string, Set<string>>();
  const columnsFor = (table: string): Set<string> => {
    let cols = tableColumns.get(table);
    if (!cols) {
      cols = new Set<string>();
      tableColumns.set(table, cols);
    }
    return cols;
  };

  const createRe = /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(source)) !== null) {
    const table = stripIdentifier(match[1]);
    const openParen = createRe.lastIndex - 1;
    let depth = 0;
    let closeParen = -1;
    let inString: '"' | "'" | '`' | null = null;
    for (let i = openParen; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { closeParen = i; break; } }
    }
    if (closeParen === -1) {
      createRe.lastIndex = openParen + 1;
      continue;
    }
    const cols = columnsFor(table);
    const body = source.slice(openParen + 1, closeParen);
    for (const def of splitColumnDefs(body)) {
      const name = leadingColumnName(def);
      if (name) cols.add(name.toLowerCase());
    }
    createRe.lastIndex = closeParen + 1;
  }

  const alterRe = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)\s+ADD\s+(?!CONSTRAINT\b)(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)/gi;
  while ((match = alterRe.exec(source)) !== null) {
    columnsFor(stripIdentifier(match[1])).add(stripIdentifier(match[2]).toLowerCase());
  }

  // ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY ("col"[, "col"…]) REFERENCES …
  // — tables whose tenant-scoping column is declared only through a foreign-key
  // constraint (Drizzle's default for `organization_id → organizations.id`)
  // never appear in CREATE TABLE bodies or ADD COLUMN, so without this pass most
  // tenant tables fall out of the Tier-3 DDL set and `missing-org-filter` reads
  // a fraction of the real tenant schema (Spec 68 — declared inputs).
  const fkRe = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)\s+ADD\s+CONSTRAINT\s+(?:`[^`]+`|"[^"]+"|\w+)\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s+REFERENCES/gi;
  while ((match = fkRe.exec(source)) !== null) {
    const cols = columnsFor(stripIdentifier(match[1]));
    for (const col of match[2].split(',')) {
      const name = stripIdentifier(col.trim()).toLowerCase();
      if (name) cols.add(name);
    }
  }

  const result: Record<string, string[]> = {};
  for (const [table, cols] of tableColumns) result[table] = [...cols];
  return result;
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
 * @returns Per-table lowercased natural-UNIQUE column-name lists.
 */
export function extractDdlUniqueColumns(source: string): Record<string, string[]> {
  const uniqueColumns = new Map<string, Set<string>>();
  const uniqueFor = (table: string): Set<string> => {
    let cols = uniqueColumns.get(table);
    if (!cols) {
      cols = new Set<string>();
      uniqueColumns.set(table, cols);
    }
    return cols;
  };

  const createRe = /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(source)) !== null) {
    const table = stripIdentifier(match[1]);
    const openParen = createRe.lastIndex - 1;
    let depth = 0;
    let closeParen = -1;
    let inString: '"' | "'" | '`' | null = null;
    for (let i = openParen; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { closeParen = i; break; } }
    }
    if (closeParen === -1) {
      createRe.lastIndex = openParen + 1;
      continue;
    }
    const body = source.slice(openParen + 1, closeParen);
    for (const def of splitColumnDefs(body)) {
      const leading = leadingColumnName(def);
      if (leading) {
        // Column-level `col … UNIQUE`. PRIMARY KEY is excluded: a surrogate PK
        // is the IDOR surface, not a bootstrap-lookup signal.
        if (/\bUNIQUE\b/i.test(def)) {
          uniqueFor(table).add(leading.toLowerCase());
        }
      } else {
        // Table-level `UNIQUE (…)` (and `CONSTRAINT x UNIQUE (…)`). PRIMARY KEY
        // is excluded for the same reason.
        const tm = /\bUNIQUE\b\s*\(([^)]*)\)/i.exec(def);
        if (tm) {
          for (const raw of tm[1].split(',')) {
            const name = stripIdentifier(raw.trim()).toLowerCase();
            if (name) uniqueFor(table).add(name);
          }
        }
      }
    }
    createRe.lastIndex = closeParen + 1;
  }

  // ALTER TABLE … ADD [CONSTRAINT …] UNIQUE (col[, …]) — PRIMARY KEY excluded.
  const alterUniqueRe = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)\s+ADD\s+(?:CONSTRAINT\s+(?:`[^`]+`|"[^"]+"|\w+)\s+)?UNIQUE\s*\(([^)]*)\)/gi;
  while ((match = alterUniqueRe.exec(source)) !== null) {
    const cols = uniqueFor(stripIdentifier(match[1]));
    for (const raw of match[2].split(',')) {
      const name = stripIdentifier(raw.trim()).toLowerCase();
      if (name) cols.add(name);
    }
  }

  const result: Record<string, string[]> = {};
  for (const [table, cols] of uniqueColumns) result[table] = [...cols];
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
 * @returns The set of column names declared across the source.
 */
export function extractDdlColumnNames(source: string): string[] {
  const columns = new Set<string>();
  for (const cols of Object.values(extractDdlTableColumns(source))) {
    for (const c of cols) columns.add(c);
  }
  return [...columns];
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

/** Lightweight DDL presence marker — detection only, no capture groups. */
const DDL_PRESENCE_RE = /(?:CREATE|DROP|ALTER)\s+(?:VIRTUAL\s+)?TABLE/i;

/**
 * Detect whether an SQL file contains any DDL statement without materializing
 * the whole file. Streams in 1 MB chunks, carrying a small tail across chunk
 * boundaries so a marker split at "CREATE TA/BLE" is still caught. Used by the
 * schema-sql visitor for oversized orphans yielded with empty source by stage 1.
 * @param filePath
 * @returns
 */
export async function sqlFileHasDdl(filePath: string): Promise<boolean> {
  const CHUNK = 1024 * 1024; // 1 MB
  const CARRY = 32; // "ALTER VIRTUAL TABLE IF NOT EXISTS" — enough to bridge a boundary
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    let carry = '';
    let pos = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, pos);
      if (bytesRead === 0) break;
      const text = carry + buffer.toString('utf8', 0, bytesRead);
      if (DDL_PRESENCE_RE.test(text)) return true;
      carry = text.slice(-CARRY);
      pos += bytesRead;
    }
    return false;
  } finally {
    await handle.close();
  }
}

/**
 * Extract migration ops from an SQL file, honoring stage-1 streaming: when
 * `sourceCode` is empty the file was too large to materialize, so DDL presence
 * is detected by streaming; only a real oversized migration is read in full
 * (rare). Returns a `skipped` flag so the pipeline can surface the skip in
 * coverage without emitting a violation.
 * @param filePath
 * @param sourceCode
 * @returns
 */
export async function extractMigrationOpsFromFile(
  filePath: string,
  sourceCode: string,
): Promise<{ ops: MigrationOp[]; columns: string[]; tableColumns: Record<string, string[]>; skipped: boolean; bytes: number }> {
  if (sourceCode !== '') {
    return {
      ops: parseMigrationOps(sourceCode),
      columns: extractDdlColumnNames(sourceCode),
      tableColumns: extractDdlTableColumns(sourceCode),
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
  if (!(await sqlFileHasDdl(filePath))) {
    return { ops: [], columns: [], tableColumns: {}, skipped: true, bytes: size };
  }
  const full = await fs.readFile(filePath, 'utf-8');
  return {
    ops: parseMigrationOps(full),
    columns: extractDdlColumnNames(full),
    tableColumns: extractDdlTableColumns(full),
    skipped: false,
    bytes: size,
  };
}
