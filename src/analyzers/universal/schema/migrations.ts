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
 * Extract column names from migration SQL — CREATE TABLE bodies (via a
 * depth-tracking paren scan that finds each matching close paren) and
 * ALTER TABLE … ADD COLUMN statements. Returns lowercased, deduplicated names
 * so the schema reducer can answer "does any table carry a tenant-scoping
 * column?" without materializing per-table column lists.
 * @param source Migration/DDL SQL text.
 * @returns The set of column names declared across the source.
 */
export function extractDdlColumnNames(source: string): string[] {
  const columns = new Set<string>();

  const createRe = /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(source)) !== null) {
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
      const name = leadingColumnName(def);
      if (name) columns.add(name.toLowerCase());
    }
    createRe.lastIndex = closeParen + 1;
  }

  const alterRe = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)/gi;
  while ((match = alterRe.exec(source)) !== null) {
    columns.add(stripIdentifier(match[2]).toLowerCase());
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
): Promise<{ ops: MigrationOp[]; columns: string[]; skipped: boolean; bytes: number }> {
  if (sourceCode !== '') {
    return { ops: parseMigrationOps(sourceCode), columns: extractDdlColumnNames(sourceCode), skipped: false, bytes: Buffer.byteLength(sourceCode) };
  }
  let size = 0;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    size = 0;
  }
  if (size <= MAX_ORPHAN_SOURCE_BYTES) {
    // Empty or small file whose read produced an empty string — nothing to do.
    return { ops: [], columns: [], skipped: false, bytes: size };
  }
  if (!(await sqlFileHasDdl(filePath))) {
    return { ops: [], columns: [], skipped: true, bytes: size };
  }
  const full = await fs.readFile(filePath, 'utf-8');
  return { ops: parseMigrationOps(full), columns: extractDdlColumnNames(full), skipped: false, bytes: size };
}
