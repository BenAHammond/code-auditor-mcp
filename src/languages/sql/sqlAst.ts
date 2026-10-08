/**
 * SQL as a parsed format — the AST seam.
 *
 * Spec 70 R1: a SQL grammar joins the shipped grammars, SQL strings reaching a
 * data-access call site are parsed into an AST like any other format, and the
 * dialect is a *closed decision* — one named grammar, not a fallback ladder.
 * Here that grammar is `node-sql-parser`; the dialect is a required parameter
 * (the corpus's named {@link Dialect} discriminant, from the discovery-query
 * registry), never a hardcoded constant — guessing `sqlite` on a Postgres repo
 * would be a silent wrong answer. It is pure JavaScript (no WASM, no two-phase
 * init), so it loads synchronously through the ordinary dependency path rather
 * than the `initParsers()` WASM loader.
 *
 * The seam is {@link parseSql}: `{ ok: true, ast }` or `{ ok: false, reason }`.
 * Every rule that reads SQL facts gets an AST or it gets nothing. There is no
 * regex path to fall back to — a string the grammar cannot parse is a parse
 * failure, and the caller turns that into `cannot-fire` with the reason. The
 * twelve regex sites in the security family convert by consuming the helpers
 * below (statement kind, relations, where facts, tenant predicate, insert
 * columns, DDL facts), each of which walks the AST rather than scanning text.
 *
 * `node-sql-parser` is a CommonJS module; the default import is required in ESM.
 */
import pkg, { type AST } from 'node-sql-parser';
import type { Dialect } from '../../mcp-tools/discoveryQueries.js';

const { Parser } = pkg;
const parser = new Parser();

/**
 * The named default dialect a caller parses under when detection names none.
 *
 * Spec 70 R2: parsing a SQL literal does not require *proving* the site's
 * dialect first — one grammar is named, with its dialect stated, and the parse
 * is attempted under it. When {@link detectDialect} returns null (a repo names
 * no driver, or names several), the caller still attempts the parse under this
 * default rather than abstaining before it has looked. The default is sqlite:
 * node-sql-parser's sqlite grammar is the most permissive, and the rest of this
 * module already standardizes on "the sqlite grammar" as the baseline (see the
 * `truncateConflictClause` / `ON CONFLICT` notes below).
 *
 * The honesty rule is not weakened, it moves: a literal that *parses* under the
 * default yields facts; a literal that *fails* is reported `cannot-fire` with a
 * reason naming **both** the parse failure and the fact that the dialect is
 * undetermined (so the failure may be dialect-specific syntax), never a silent
 * empty fact set.
 */
export const DEFAULT_SQL_DIALECT: Dialect = 'sqlite';

// ─── Parse result ────────────────────────────────────────────────────────────

export type SqlStatementKind =
  | 'select'
  | 'insert'
  | 'replace'
  | 'update'
  | 'delete'
  | 'create'
  | 'alter'
  | 'drop'
  | 'use'
  | 'other';

export interface SqlParseOk {
  readonly ok: true;
  readonly ast: AST;
  readonly kind: SqlStatementKind;
  /** When the input was several statements, every per-statement AST (in order). */
  readonly statements?: AST[];
  /**
   * True when a top-level `ON CONFLICT` clause was truncated before parsing (see
   * {@link truncateConflictClause}). The clause's update action is "present but
   * unread" — every fact actually extracted (target table, write status,
   * predicate presence) is answered by the parsed prefix, and this flag records
   * that a conflict clause existed rather than silently dropping it.
   */
  readonly conflictClauseTruncated?: boolean;
}

export interface SqlParseFail {
  readonly ok: false;
  readonly reason: string;
}

export type SqlParseResult = SqlParseOk | SqlParseFail;

/** Map a node-sql-parser statement `type` to the closed {@link SqlStatementKind}. */
function statementKind(type: unknown): SqlStatementKind {
  switch (type) {
    case 'select': return 'select';
    case 'insert': return 'insert';
    case 'replace': return 'replace';
    case 'update': return 'update';
    case 'delete': return 'delete';
    case 'create': return 'create';
    case 'alter': return 'alter';
    case 'drop': return 'drop';
    case 'use': return 'use';
    default: return 'other';
  }
}

/** node-sql-parser's `astify` return — a single statement, a list, or nothing. */
type AstifyResult = AST[] | AST;

/** DDL statement kinds — schema definition (CREATE/ALTER/DROP/USE), not a
 *  row-level data-access query. Schema is extracted separately by the `.sql`
 *  visitor and Durable Object DDL (`pipelineAdapters.ts`); a data-access call is
 *  a DML query or an ORM operation, and a DDL literal must not surface as one. */
export function isDdlStatementKind(kind: SqlStatementKind): boolean {
  return kind === 'create' || kind === 'alter' || kind === 'drop' || kind === 'use';
}

// ─── Declared input normalization ─────────────────────────────────────────────
//
// These are *input rewrites*, not a regex fallback. Each one changes a spelling
// that node-sql-parser's grammars reject into an equivalent spelling they accept,
// without changing anything a rule reads (tables, filters, statement kind). A
// literal that still fails after normalization is a real `cannot-fire`; a literal
// these rewrites recover is parsed honestly.

/** A quote delimiter the scanner is inside, or null when at top level. */
type QuoteChar = '"' | "'" | '`';

/**
 * The standalone transaction-control statements the sqlite grammar does not
 * accept, recognized — not parsed — as SQL. A `BEGIN`/`COMMIT`/`ROLLBACK` is
 * unambiguous SQL with no data-access facts (no relations, no WHERE, not a
 * write), so it proves its receiver is a handle and contributes nothing to any
 * table/filter fact. Recognized via a closed set, case-insensitively, with an
 * optional trailing `;`.
 */
const TRANSACTION_CONTROL = new Set([
  'begin',
  'begin transaction',
  'begin deferred',
  'begin immediate',
  'begin exclusive',
  'commit',
  'commit transaction',
  'end',
  'end transaction',
  'rollback',
  'rollback transaction',
]);

/** A synthetic statement for recognized transaction control. The AST walkers
 *  treat an unknown statement type as "no relations / no where / not a write",
 *  which is exactly the facts a BEGIN/COMMIT/ROLLBACK has. */
const TRANSACTION_MARKER: AST = { type: 'transaction' } as unknown as AST;

/** True when `trimmed` is a standalone transaction-control statement. */
function isStandaloneTransactionControl(trimmed: string): boolean {
  const t = trimmed.replace(/;\s*$/, '').trim().toLowerCase();
  return TRANSACTION_CONTROL.has(t);
}

/**
 * Migration-file statements that name no *stored* table — recognized, not parsed,
 * as SQL. A `PRAGMA` / `DROP INDEX` / `DROP VIEW` / `DROP TRIGGER` / `CREATE VIEW`
 * / `CREATE TRIGGER` declares no table the rules track (an index/view/trigger is
 * not a stored table, and a PRAGMA is a connection setting), so a migration's
 * `PRAGMA foreign_keys=OFF` contributes nothing to any table/filter fact — the
 * same "recognized, no facts" move as transaction control. Recognition is
 * DDL-path only (in {@link parseSqlProgramTolerant}), never in {@link parseSql}:
 * the per-call-site path must NOT recognize a `PRAGMA`, because
 * `PRAGMA table_info(x)` names `x` and a caller reading "no tables" would take
 * that as clean (an unknown/stale-table miss). Of these, some the sqlite grammar
 * *rejects* (`PRAGMA`, `DROP INDEX`, `DROP TRIGGER`, a compound
 * `CREATE VIEW … UNION ALL`) and recognition avoids a spurious `cannot-fire`; the
 * rest (`DROP VIEW`, a simple `CREATE VIEW`, `CREATE TRIGGER`) actually parse,
 * and are recognized anyway so the DDL table walker never reads a view/trigger
 * name as a stored table. `DROP TABLE` is deliberately absent: it *does* name a
 * stored table the lifecycle rules track, and the grammar parses it. Recognized
 * via a closed keyword set, case-insensitively, with an optional trailing `;`.
 */
const NO_FACTS_DDL_PREFIXES = ['pragma', 'drop index', 'drop view', 'drop trigger', 'create view', 'create trigger'] as const;

/** A synthetic statement for recognized no-fact DDL. The AST walkers treat an
 *  unknown statement type as "no relations / no where / not a write", which is
 *  exactly the facts a PRAGMA / DROP INDEX / DROP VIEW / DROP TRIGGER has. */
const NO_FACTS_MARKER: AST = { type: 'no-facts' } as unknown as AST;

function isNoTableFactsDdl(trimmed: string): boolean {
  const t = trimmed.replace(/;\s*$/, '').trim().toLowerCase();
  for (const p of NO_FACTS_DDL_PREFIXES) {
    if (!t.startsWith(p)) continue;
    const after = t[p.length] ?? '';
    if (t.length === p.length || /\s/.test(after)) return true;
  }
  return false;
}

/**
 * Rewrite D1-style numbered positional parameters (`?1`, `?2`, …) to the bare
 * `?` the sqlite grammar accepts. Parameter numbering is an ordering hint, not a
 * fact: it does not affect which tables are read or whether a tenant predicate
 * exists, so the rewrite is lossless for every consumer of this module. A `?`
 * inside a single-quoted string literal is left untouched (that `?` is literal
 * text, not a placeholder); quoted identifiers (`"…"`, `` `…` ``) are also
 * skipped so an identifier containing `?` is not rewritten. A doubled quote
 * (`''` inside a string) stays inside the region.
 * @param sql The SQL text to rewrite.
 * @returns The SQL with D1-style numbered parameters (`?1`) rewritten to bare `?`.
 */
export function normalizePositionalParams(sql: string): string {
  let out = '';
  let i = 0;
  let quote: QuoteChar | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += ch + ch;
          i += 2;
          continue;
        }
        quote = null;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '?' && /\d/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /\d/.test(sql[j])) j++;
      out += '?';
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Rewrite a JavaScript template substitution (`${…}`) to the SQL placeholder
 * `?`. A `${…}` in the SQL text is a host-language interpolation — a value,
 * identifier, or table name filled in at query-composition time — which the SQL
 * grammar cannot tokenize (`${` is not a SQL spelling). A value-position
 * substitution (`WHERE id = ${id}`, `SELECT ${cols} …`) is exactly a parameter,
 * so `?` is a lossless rewrite: it preserves every table/filter fact the AST
 * walk reads. A *table-position* substitution (`FROM ${table}`) rewrites to
 * `FROM ?`, which the grammar rejects — the honest `cannot-fire`, because a
 * dynamic table name is genuinely unreadable. A `${…}` inside a quoted string
 * or quoted identifier is literal text the grammar already accepts, so it is
 * left untouched (rewriting it would corrupt a string literal that happens to
 * contain `$`).
 * @param sql The SQL text to rewrite.
 * @returns The SQL with `${…}` template substitutions rewritten to `?` placeholders.
 */
export function normalizeTemplateSubstitutions(sql: string): string {
  let out = '';
  let i = 0;
  let quote: QuoteChar | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += ch + ch;
          i += 2;
          continue;
        }
        quote = null;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '$' && sql[i + 1] === '{') {
      // Skip to the matching `}` (no nested braces in a substitution).
      let j = i + 2;
      while (j < sql.length && sql[j] !== '}') j++;
      out += '?';
      i = j < sql.length ? j + 1 : sql.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Rewrite sqlite's length-qualified `TEXT(N)` type spelling to `VARCHAR(N)`.
 * Drizzle's sqlite dialect emits `text(N)` for string columns, and
 * node-sql-parser's sqlite grammar accepts the length form only for `varchar(N)`
 * — it rejects `text(N)` even though sqlite itself accepts it. SQLite gives
 * `TEXT(N)` and `VARCHAR(N)` the same TEXT affinity, so the rewrite is lossless
 * for every fact an AST walk reads (table/column names, types, declared lengths)
 * and recovers a statement that would otherwise report a spurious `cannot-fire`.
 * Only the `text` keyword *immediately followed by `(`* is rewritten — a bare
 * `text` (no length), a longer identifier (`textual`), and any occurrence inside
 * a string literal or quoted identifier are left intact.
 * @param sql The SQL text to rewrite.
 * @returns The SQL with length-qualified `text(N)` rewritten to `varchar(N)`.
 */
export function normalizeSqliteTextLength(sql: string): string {
  let out = '';
  let i = 0;
  let quote: QuoteChar | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += ch + ch; i += 2; continue; }
        quote = null;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    // `text` as a whole word, followed by optional whitespace then `(`.
    if (ch === 't' || ch === 'T') {
      const word = sql.slice(i, i + 4);
      if (word.toLowerCase() === 'text') {
        const prev = i === 0 ? '' : sql[i - 1];
        const next = sql[i + 4] ?? '';
        const wordStart = i === 0 || !/[a-zA-Z0-9_$]/.test(prev);
        const wordEnd = !/[a-zA-Z0-9_$]/.test(next);
        let j = i + 4;
        while (j < sql.length && /\s/.test(sql[j])) j++;
        if (wordStart && wordEnd && sql[j] === '(') {
          out += 'varchar';
          i += 4;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Rewrite a string literal whose entire content is one backslash (`'\'`) to the
 * doubled spelling (`'\\'`). SQLite spells "the escape character is a single
 * backslash" as `'\'`, but node-sql-parser's lexer reads the bare `'\'` as an
 * unterminated escaped-quote (`\'` with no closing quote) and rejects the whole
 * statement — so a `LIKE … ESCAPE '\'` clause (recall-protocol's FTS-escape
 * spelling) fails to parse. Doubling the backslash is the same value spelled the
 * way the grammar accepts (`'\\'` is one literal backslash), so the rewrite is
 * lossless: the escape character is still one backslash, and no fact a rule
 * reads (relations, filters, statement kind) changes. Only the exact three-char
 * sequence `'\'` is rewritten, and only where it opens a string literal (never
 * inside a quoted identifier or a longer string), so a `'\''` (backslash then
 * escaped quote) or a double-quoted identifier containing `'\'` is left intact.
 * @param sql The SQL text to rewrite.
 * @returns The SQL with a lone-backslash string literal rewritten to `'\\'`.
 */
export function normalizeEscapeClause(sql: string): string {
  let out = '';
  let i = 0;
  let quote: QuoteChar | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += ch + ch; i += 2; continue; }
        quote = null;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      if (ch === "'" && sql[i + 1] === '\\' && sql[i + 2] === "'" && sql[i + 3] !== "'") {
        out += "'\\\\'";
        i += 3;
        continue;
      }
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Rewrite a bare `?` placeholder in a `LIMIT`/`OFFSET` clause to a literal
 * (`LIMIT 1` / `OFFSET 0`). node-sql-parser's sqlite grammar accepts `LIMIT 5`
 * but rejects `LIMIT ?` (a bound-parameter limit) even though sqlite itself
 * accepts it — so a parameterized `SELECT … LIMIT ? OFFSET ?` (recall-protocol's
 * paging spelling) fails to parse. The fact a rule reads from a LIMIT/OFFSET
 * clause is *presence*, not the value (see `whereFacts`), so substituting a
 * concrete literal is lossless: `LIMIT ?` still reports "has a limit". The
 * rewrite fires only on a bare `?` immediately after the keyword (whitespace
 * optional), and skips string literals and quoted identifiers.
 * @param sql The SQL text to rewrite.
 * @returns The SQL with `LIMIT ?` → `LIMIT 1` and `OFFSET ?` → `OFFSET 0`.
 */
export function normalizeLimitOffsetPlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let quote: QuoteChar | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += ch + ch; i += 2; continue; }
        quote = null;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue; }
    let keyword: string | null = null;
    let value: string | null = null;
    const lower6 = sql.slice(i, i + 6).toLowerCase();
    if (lower6.startsWith('limit')) { keyword = sql.slice(i, i + 5); value = '1'; }
    else if (lower6.startsWith('offset')) { keyword = sql.slice(i, i + 6); value = '0'; }
    if (keyword !== null && value !== null) {
      const prev = i === 0 ? '' : sql[i - 1];
      const after = sql[i + keyword.length] ?? '';
      if (!/[a-zA-Z0-9_$]/.test(prev) && !/[a-zA-Z0-9_$]/.test(after)) {
        let j = i + keyword.length;
        while (j < sql.length && /\s/.test(sql[j])) j++;
        if (sql[j] === '?') {
          out += keyword + ' ' + value;
          i = j + 1;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Rewrite a `CREATE VIRTUAL TABLE name USING fts5(cols…)` declaration to the
 * `CREATE TABLE name (cols…)` the sqlite grammar accepts. node-sql-parser's
 * sqlite grammar has no `CREATE VIRTUAL TABLE`, so a full-text-search table
 * (recall-protocol's `strategies_fts`, declared `USING fts5(...)`) fails to parse
 * and blanks the table — even though a virtual table is a first-class queryable
 * relation the lifecycle rules track exactly like a stored table. The facts a
 * rule reads from the declaration are the table name and its column names; the
 * FTS5 module wrapper (`USING fts5`, a column's `UNINDEXED`, the trailing
 * `tokenize = '…'` option) is module configuration, not a table fact. So the
 * rewrite drops the module syntax and keeps the columns, recovering the same
 * table/column facts a `CREATE TABLE` would carry. Only a `CREATE VIRTUAL TABLE`
 * (word-boundary matched, case-insensitive) whose module argument list parses to
 * at least one bare column is rewritten; anything else — a module option list
 * with no columns, an unexpected shape — is left untouched and reports an honest
 * parse failure rather than a fabricated table.
 * @param sql The SQL text to rewrite.
 * @returns The SQL with `CREATE VIRTUAL TABLE … USING <module>(cols)` rewritten to `CREATE TABLE … (cols)`.
 */
export function normalizeVirtualTable(sql: string): string {
  let out = '';
  let i = 0;
  let quote: QuoteChar | null = null;
  const HEADER = 'create virtual table';
  while (i < sql.length) {
    const ch = sql[i];
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += ch + ch; i += 2; continue; }
        quote = null;
      }
      out += ch; i++; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue; }
    const beforeOk = i === 0 || !/[a-zA-Z0-9_$]/.test(sql[i - 1]);
    const afterHeader = sql[i + HEADER.length] ?? '';
    const afterOk = !/[a-zA-Z0-9_$]/.test(afterHeader);
    if (beforeOk && afterOk && sql.slice(i, i + HEADER.length).toLowerCase() === HEADER) {
      // `CREATE VIRTUAL TABLE <name> USING <module>( <args> )`
      let j = i + HEADER.length;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      const nameStart = j;
      while (j < sql.length && !/\s/.test(sql[j]) && sql[j] !== '(') j++;
      const name = sql.slice(nameStart, j);
      while (j < sql.length && /\s/.test(sql[j])) j++;
      if (sql.slice(j, j + 5).toLowerCase() === 'using') {
        let k = j + 5;
        while (k < sql.length && /\s/.test(sql[k])) k++;
        while (k < sql.length && /[a-zA-Z0-9_$]/.test(sql[k])) k++; // module name
        while (k < sql.length && /\s/.test(sql[k])) k++;
        if (sql[k] === '(') {
          // find the module argument list's matching `)` (nested parens + quotes)
          let m = k + 1;
          let depth = 1;
          let q: QuoteChar | null = null;
          while (m < sql.length && depth > 0) {
            const c = sql[m];
            if (q !== null) {
              if (c === q) {
                if (sql[m + 1] === q) { m += 2; continue; }
                q = null;
              }
              m++; continue;
            }
            if (c === '"' || c === "'" || c === '`') { q = c; m++; continue; }
            if (c === '(') depth++;
            else if (c === ')') depth--;
            m++;
          }
          const cols = extractFtsColumnNames(sql.slice(k + 1, m - 1));
          if (cols.length > 0 && name.length > 0) {
            out += `CREATE TABLE ${name} (${cols.join(', ')})`;
            i = m;
            continue;
          }
        }
      }
      out += ch; i++; continue;
    }
    out += ch; i++;
  }
  return out;
}

/** Split an FTS5 module argument list into its bare column names, dropping
 *  `UNINDEXED`/`NOT INDEXED` modifiers and `name = '…'` option entries. */
function extractFtsColumnNames(args: string): string[] {
  const parts: string[] = [];
  let i = 0;
  let start = 0;
  let depth = 0;
  let quote: QuoteChar | null = null;
  while (i < args.length) {
    const ch = args[i];
    if (quote !== null) {
      if (ch === quote) {
        if (args[i + 1] === quote) { i += 2; continue; }
        quote = null;
      }
      i++; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(args.slice(start, i).trim()); start = i + 1; }
    i++;
  }
  parts.push(args.slice(start).trim());
  const cols: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    if (part.includes('=')) continue; // `tokenize = '…'`, `prefix = '…'`, `content = …`
    const name = part.split(/\s+/)[0];
    if (name) cols.push(name);
  }
  return cols;
}

/**
 * Apply the declared input normalizations for a dialect: D1 numbered parameters
 * `?n` → `?`, template substitutions `${…}` → `?`, `LIMIT ?`/`OFFSET ?` → a
 * concrete literal, `'\'` → `'\\'`, `CREATE VIRTUAL TABLE … USING fts5(…)` →
 * `CREATE TABLE …`, and — sqlite only, since it is a sqlite-specific spelling —
 * length-qualified `text(N)` → `varchar(N)`.
 */
function applyDeclaredNormalizations(trimmed: string, dialect: Dialect): string {
  // Strip comments first. Every normalizer below tracks quoted strings to avoid
  // rewriting inside them, but none of them models `--` / `/* … */` comments. An
  // apostrophe in a comment — `don't` in a migration's header block — opens a
  // quote that swallows the rest of the file and silently disables every rewrite
  // after it (`text(N)` → `varchar(N)` and the rest). Comments are semantically
  // inert, so dropping them before the quote-tracking rewrites is lossless and
  // keeps the normalizers' quote state honest.
  const uncommented = stripComments(trimmed);
  const positional = normalizePositionalParams(uncommented);
  const templated = normalizeTemplateSubstitutions(positional);
  const limited = normalizeLimitOffsetPlaceholders(templated);
  const escaped = normalizeEscapeClause(limited);
  const tabled = normalizeVirtualTable(escaped);
  return dialect === 'sqlite' ? normalizeSqliteTextLength(tabled) : tabled;
}

/**
 * Split a (possibly multi-statement) SQL string on top-level `;`. Semicolons
 * inside single/double-quoted strings and backtick identifiers are not statement
 * boundaries, and empty fragments (a trailing `;`) are dropped. A single string
 * literal carrying several DDL statements (`DROP TABLE a; DROP TABLE b;`) parses
 * as its statements instead of failing "expected a single statement".
 *
 * A `CREATE TRIGGER … BEGIN … END` body carries `;` between its own statements
 * that are not statement boundaries, so the trigger's `BEGIN … END` block is
 * tracked and its internal `;` kept inside the statement — otherwise a trigger
 * would be mid-body-split into a dangling header and a bare `END`. The tracking
 * is scoped to a statement whose leading text is `CREATE TRIGGER`, so a
 * transaction's `BEGIN;` or a stray `CASE`/`END` in ordinary SQL is split exactly
 * as before. A `CASE … END` inside the body is tracked so its `END` is not
 * mistaken for the trigger's closing `END`.
 * @param sql The SQL text to split.
 * @returns The top-level statements, in order, with empty fragments dropped.
 */
export function splitSqlStatements(sql: string): string[] {
  const parts: string[] = [];
  let current = '';
  let i = 0;
  let quote: QuoteChar | null = null;
  let beginDepth = 0;
  let caseDepth = 0;
  const wordBoundary = (c: string | undefined) => c === undefined || !/[a-zA-Z0-9_$]/.test(c);

  while (i < sql.length) {
    const ch = sql[i];
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          current += ch + ch;
          i += 2;
          continue;
        }
        quote = null;
      }
      current += ch;
      i++;
      continue;
    }
    // Skip comments before quote tracking: an apostrophe inside `-- don't` must
    // not open a string literal and swallow every later `;` in the file, and a
    // `;` inside a comment is prose, not a statement boundary. Mirrors
    // `truncateConflictClause`'s comment handling. The comment text is dropped
    // (semantically inert — the parser never needs it to extract ops).
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[a-zA-Z0-9_$]/.test(sql[j])) j++;
      const word = sql.slice(i, j).toLowerCase();
      const prev = i === 0 ? undefined : sql[i - 1];
      const after = sql[j];
      if (wordBoundary(prev) && wordBoundary(after)) {
        if (word === 'begin') {
          if (current.trimStart().toLowerCase().startsWith('create trigger')) beginDepth++;
        } else if (word === 'case') {
          if (beginDepth > 0) caseDepth++;
        } else if (word === 'end') {
          if (caseDepth > 0) caseDepth--;
          else if (beginDepth > 0) beginDepth--;
        }
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ';') {
      if (beginDepth === 0 && caseDepth === 0) {
        const part = current.trim();
        if (part.length > 0) parts.push(part);
        current = '';
      } else {
        current += ch;
      }
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  const tail = current.trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

/**
 * Truncate a SQL string at its top-level `ON CONFLICT` clause, returning the
 * prefix and a flag recording that a conflict clause was present but not parsed.
 *
 * Spec 70 (ON CONFLICT disposition): node-sql-parser's `sqlite` grammar has no
 * `ON CONFLICT`, so a D1 `INSERT … ON CONFLICT (…) DO UPDATE` upsert is a parse
 * failure — and the failure took the whole statement down, blanking the target
 * table / write-status facts the prefix already answers. Those facts (target
 * table, write status, predicate presence) are all answered by the
 * `INSERT INTO x (cols) VALUES (…)` prefix, so the clause is cut at a *top-level*
 * `ON CONFLICT` (not inside a string literal, comment, or parenthesized
 * subexpression) and the prefix is parsed. The flag keeps "an upsert is present"
 * distinct from "the write is a plain INSERT" — a future rule reading the update
 * action sees "present but unread" rather than absent. This is a truncation, not
 * a normalization: the clause's update action is recorded as dropped, never
 * silently re-written into an equivalent spelling.
 * @param sql The SQL text to scan.
 * @returns The prefix before a top-level `ON CONFLICT` clause, plus a flag recording that a clause was truncated.
 */
export function truncateConflictClause(sql: string): { text: string; truncated: boolean } {
  let i = 0;
  let quote: QuoteChar | null = null;
  let depth = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) { i += 2; continue; }
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; i++; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth--; i++; continue; }
    if (depth === 0 && (ch === 'o' || ch === 'O')) {
      const before = i > 0 ? sql[i - 1] : '';
      const beforeOk = !/[a-z0-9_$]/i.test(before);
      if (beforeOk && sql.slice(i, i + 11).toLowerCase() === 'on conflict') {
        const after = sql[i + 11];
        const afterOk = after === undefined || !/[a-z0-9_]/i.test(after);
        if (afterOk) {
          return { text: sql.slice(0, i).trim(), truncated: true };
        }
      }
    }
    i++;
  }
  return { text: sql, truncated: false };
}

/** Parse one already-normalized statement string into a single-statement result. */
function parseSingleStatement(text: string, dialect: Dialect): SqlParseResult {
  const { text: toParse, truncated } = truncateConflictClause(text);
  let astified: AstifyResult;
  try {
    astified = parser.astify(toParse, { database: dialect });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const conflictClauseTruncated = truncated || undefined;
  if (Array.isArray(astified)) {
    if (astified.length === 0) {
      // The grammar consumed the input but produced no statement (e.g. a
      // comment-only fragment) — an honest cannot-fire, not a crash.
      return { ok: false, reason: 'SQL did not produce a statement' };
    }
    if (astified.length === 1) {
      return { ok: true, ast: astified[0], kind: statementKind(astified[0].type), conflictClauseTruncated };
    }
    // A `;` the splitter missed — parse all of them and report the program.
    return { ok: true, ast: astified[0], kind: statementKind(astified[0].type), statements: astified, conflictClauseTruncated };
  }
  if (astified === null || typeof astified !== 'object') {
    return { ok: false, reason: 'SQL did not produce a statement' };
  }
  return { ok: true, ast: astified, kind: statementKind(astified.type), conflictClauseTruncated };
}

/**
 * Parse a SQL string — one statement, or several separated by `;`. Returns
 * `{ ok: false, reason }` on an empty string, a parse error (after the declared
 * normalization below), or a program where any statement fails to parse. A
 * multi-statement string that fully parses is `ok` with `statements` holding
 * every AST.
 *
 * Normalization, applied before the grammar: (a) D1 numbered parameters `?n` →
 * `?`; (b) a multi-statement string is split on top-level `;` and each statement
 * parsed individually; (c) a standalone transaction-control statement is
 * recognized as SQL with no facts. Anything still failing after those is a
 * genuine `cannot-fire` (e.g. `ON CONFLICT … DO UPDATE`, a Postgres `::` cast).
 *
 * @param text The SQL text to parse.
 * @param dialect The dialect to parse under — the corpus's named dialect, or
 *   {@link DEFAULT_SQL_DIALECT} when detection named none. The caller is still
 *   responsible for the honesty: when it supplied the default because the dialect
 *   is undetermined, a parse failure must be reported naming both the failure and
 *   the undetermined dialect.
 * @returns `{ ok: true, ast, kind }` on success (with `statements` for a multi-statement string), or `{ ok: false, reason }` on an empty string, parse error, or unparseable program.
 */
export function parseSql(text: string, dialect: Dialect): SqlParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty SQL string' };
  }
  if (isStandaloneTransactionControl(trimmed)) {
    return { ok: true, ast: TRANSACTION_MARKER, kind: 'other' };
  }
  const normalized = applyDeclaredNormalizations(trimmed, dialect);
  const statements = splitSqlStatements(normalized);
  if (statements.length === 0) {
    // Only top-level `;` (or a substitution that normalized to nothing) — no
    // statement text survives to parse.
    return { ok: false, reason: 'SQL contained no statements' };
  }
  if (statements.length > 1) {
    const asts: AST[] = [];
    let anyTruncated = false;
    for (const statement of statements) {
      const result = parseSingleStatement(statement, dialect);
      if (!result.ok) {
        return { ok: false, reason: `statement ${asts.length + 1} failed: ${result.reason}` };
      }
      asts.push(result.ast);
      if (result.conflictClauseTruncated) anyTruncated = true;
    }
    return { ok: true, ast: asts[0], kind: statementKind(asts[0].type), statements: asts, conflictClauseTruncated: anyTruncated || undefined };
  }
  return parseSingleStatement(statements[0], dialect);
}

/** The result of parsing a `.sql` file — a list of statements or a failure. */
export type SqlProgramResult =
  | { readonly ok: true; readonly statements: AST[] }
  | { readonly ok: false; readonly reason: string };

/**
 * A template placeholder (`{{VERSION}}`, `{{.MigrationName}}`). A migration that
 * carries one is not SQL until it is rendered at deploy time, so it is classified
 * "not SQL", not "unparseable SQL" — a distinct failure reason a caller can
 * bucket separately from dialect gaps.
 */
const TEMPLATE_PLACEHOLDER = /\{\{[^}]*\}\}/;

/**
 * Remove `--` line comments and `/* … *\/` block comments (respecting quoted
 * strings), so a `{{…}}` that appears only in a comment — prose naming a
 * placeholder — is not mistaken for a template marker. A template placeholder
 * that changes the SQL is inline in the statement text; one in a comment does not
 * affect whether the file parses.
 */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  let quote: QuoteChar | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote !== null) {
      if (ch === quote) {
        if (next === quote) { out += ch + ch; i += 2; continue; }
        quote = null;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue; }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Parse a `.sql` file's full text into its statements. Used by the DDL
 * discovery path (which reads whole migration files), not by the per-call-site
 * parse. Empty text is an empty program, not a failure; a templated migration
 * (`{{…}}`) is "not SQL until rendered"; a syntax error anywhere is a failure of
 * the whole file (the same "parse or nothing" contract as {@link parseSql}).
 *
 * D1 numbered parameters (`?n` → `?`) are normalized before parsing, as in
 * {@link parseSql}.
 *
 * @param text The `.sql` file's full text.
 * @param dialect The corpus's named dialect.
 * @returns A parsed program, or a failure reason (templated migration / syntax error).
 */
export function parseSqlProgram(text: string, dialect: Dialect): SqlProgramResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, statements: [] };
  if (TEMPLATE_PLACEHOLDER.test(stripComments(trimmed))) {
    return { ok: false, reason: 'templated migration (contains {{…}} placeholder — not SQL until rendered)' };
  }
  const normalized = applyDeclaredNormalizations(trimmed, dialect);
  let astified: AstifyResult;
  try {
    astified = parser.astify(normalized, { database: dialect });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (Array.isArray(astified)) return { ok: true, statements: astified };
  if (astified === null || typeof astified !== 'object') return { ok: true, statements: [] };
  return { ok: true, statements: [astified] };
}

/** One statement of a program that failed to parse. */
export interface SqlStatementFailure {
  readonly index: number;
  readonly reason: string;
}

/** A tolerant program parse: every statement that parsed, plus the ones that
 *  failed (with their reasons). */
export interface TolerantSqlProgram {
  readonly statements: AST[];
  readonly failures: readonly SqlStatementFailure[];
  /** Indices into `statements` whose text carried a top-level `ON CONFLICT`
   *  clause truncated before parsing (see {@link truncateConflictClause}). */
  readonly truncatedConflictIndices: readonly number[];
}

/**
 * Parse a `.sql` migration file tolerantly — statement by statement. The
 * `parseSqlProgram` all-or-nothing contract is right for a single call-site
 * query string (a query either parses or it is `cannot-fire`), but a migration
 * file is a *sequence* of DDL statements, and one statement the grammar rejects
 * (an `UPDATE … FROM`, a Drizzle `ALTER COLUMN "a" TO "a" <type>`) must not
 * discard the well-formed `CREATE TABLE` beside it. Each statement is split on a
 * top-level `;` and parsed individually; a `PRAGMA` / `DROP INDEX` / `DROP VIEW`
 * / `DROP TRIGGER` / `CREATE VIEW` / `CREATE TRIGGER` is *recognized* as no-fact
 * DDL (not parsed, not a failure), the successes are walked for DDL facts, and
 * the remaining failures are reported so the caller can account for what it did
 * not read. This is the honest successor to the regex scanners, which silently
 * skipped whatever they did not match.
 *
 * @param text The `.sql` file's full text.
 * @param dialect The corpus's named dialect.
 * @param recognizeNoFactsDdl When true (a migration file), a `PRAGMA` /
 *   `DROP INDEX` / `DROP VIEW` / `DROP TRIGGER` / `CREATE VIEW` / `CREATE TRIGGER`
 *   is recognized as no-fact DDL rather than a parse failure. When false (a code
 *   SQL argument — see {@link parseSqlTables}), it is left to the grammar, so a
 *   `PRAGMA table_info(x)` surfaces as a parse failure (it names `x`) rather than
 *   reading "no tables" as clean.
 * @returns The statements that parsed, the failures with reasons, and the indices of statements whose `ON CONFLICT` clause was truncated.
 */
export function parseSqlProgramTolerant(text: string, dialect: Dialect, recognizeNoFactsDdl: boolean = true): TolerantSqlProgram {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { statements: [], failures: [], truncatedConflictIndices: [] };
  if (TEMPLATE_PLACEHOLDER.test(stripComments(trimmed))) {
    return { statements: [], failures: [{ index: 0, reason: 'templated migration (contains {{…}} placeholder — not SQL until rendered)' }], truncatedConflictIndices: [] };
  }
  const normalized = applyDeclaredNormalizations(trimmed, dialect);
  const parts = splitSqlStatements(normalized);
  const statements: AST[] = [];
  const failures: SqlStatementFailure[] = [];
  const truncatedConflictIndices: number[] = [];
  parts.forEach((part, index) => {
    if (recognizeNoFactsDdl && isNoTableFactsDdl(part)) {
      statements.push(NO_FACTS_MARKER);
      return;
    }
    const result = parseSingleStatement(part, dialect);
    if (result.ok) {
      if (result.conflictClauseTruncated) truncatedConflictIndices.push(statements.length);
      // A part can still parse to several statements (a `;` the splitter missed,
      // e.g. inside a comment-stripped span or a construct the splitter does not
      // model). `result.ast` is only the first of them — keep the rest, or the
      // producer silently drops every statement after the first.
      statements.push(...(result.statements ?? [result.ast]));
    } else {
      failures.push({ index, reason: result.reason });
    }
  });
  return { statements, failures, truncatedConflictIndices };
}

// ─── Relation (table) extraction ─────────────────────────────────────────────

export interface RelationRef {
  /** The relation name (a table name, or a CTE alias before filtering). */
  readonly name: string;
  /** Which clause the relation came from. */
  readonly via: 'from' | 'join' | 'into' | 'target' | 'rename' | 'drop';
}

/** The field carrying a relation name on a node-sql-parser from/table entry. */
interface NamedEntry {
  readonly table?: unknown;
  readonly db?: unknown;
  readonly join?: unknown;
  readonly addition?: unknown;
}

function relationName(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const table = (entry as NamedEntry).table;
  if (typeof table !== 'string' || table.length === 0) return null;
  return table;
}

function pushRelation(refs: RelationRef[], entry: unknown, via: RelationRef['via']): void {
  const name = relationName(entry);
  if (name !== null) refs.push({ name, via });
}

/**
 * Collect every relation referenced by a statement — the raw FROM/JOIN/INTO/
 * target/rename/drop relations, *without* the CTE-alias filter. This is the
 * AST replacement for site #1's `extractTables` plus its bolted-on alias filter:
 * the CTE names are subtracted in {@link extractTableNames}, because a CTE name
 * is a named result set, not a stored table.
 *
 * The walk descends into CTE bodies (`WITH x AS (SELECT … FROM orders)`) and
 * into `FROM (SELECT …)` subqueries, so a real table referenced only inside a
 * CTE or subquery is still collected — the flat text scan saw those, and an AST
 * walk that did not would silently under-count.
 * @param ast The parsed statement (or program) to walk.
 * @returns Every relation referenced, with the clause it came from, before CTE filtering.
 */
export function collectRelations(ast: AST): RelationRef[] {
  const refs: RelationRef[] = [];
  collectRelationsInto(ast, refs);
  return refs;
}

function collectRelationsInto(ast: AST, refs: RelationRef[]): void {
  switch (ast.type) {
    case 'select': {
      // CTE bodies reference real tables; walk them before the outer FROM.
      if (Array.isArray(ast.with)) {
        for (const cte of ast.with) {
          const inner = cte?.stmt?.ast;
          if (inner && typeof inner === 'object') collectRelationsInto(inner as AST, refs);
        }
      }
      const from = ast.from;
      if (Array.isArray(from)) for (const entry of from) collectFromEntry(entry, refs);
      else collectFromEntry(from, refs);
      break;
    }
    case 'insert':
    case 'replace':
    case 'update':
    case 'alter': {
      const table = ast.table;
      if (Array.isArray(table)) for (const entry of table) pushRelation(refs, entry, 'target');
      else pushRelation(refs, table, 'target');
      break;
    }
    case 'delete': {
      const table = ast.table;
      if (Array.isArray(table)) for (const entry of table) pushRelation(refs, entry, 'target');
      else pushRelation(refs, table, 'target');
      if (Array.isArray(ast.from)) for (const entry of ast.from) pushRelation(refs, entry, 'from');
      break;
    }
    case 'create': {
      const table = ast.table;
      if (Array.isArray(table)) for (const entry of table) pushRelation(refs, entry, 'target');
      else pushRelation(refs, table, 'target');
      break;
    }
    case 'drop': {
      if (Array.isArray(ast.name)) for (const entry of ast.name) pushRelation(refs, entry, 'drop');
      break;
    }
    default:
      break;
  }
}

function collectFromEntry(entry: unknown, refs: RelationRef[]): void {
  if (entry === null || typeof entry !== 'object') return;
  const e = entry as Record<string, unknown>;
  if (e.type === 'dual') return;
  // A subquery in FROM (`FROM (SELECT …)`) has no relation name of its own; its
  // inner SELECT references the real tables.
  if ('expr' in e && e.expr && typeof e.expr === 'object') {
    const inner = (e.expr as { ast?: unknown }).ast;
    if (inner && typeof inner === 'object') collectRelationsInto(inner as AST, refs);
    return;
  }
  const via: RelationRef['via'] = 'join' in e ? 'join' : 'from';
  pushRelation(refs, entry, via);
}

/** The names of the CTEs declared by a `WITH` clause, lowercased.
 * @param ast The parsed statement.
 * @returns The lowercased CTE names. */
export function cteNames(ast: AST): Set<string> {
  const names = new Set<string>();
  if (ast.type !== 'select' || !Array.isArray(ast.with)) return names;
  for (const cte of ast.with) {
    const value = cte?.name?.value;
    if (typeof value === 'string' && value.length > 0) names.add(value.toLowerCase());
  }
  return names;
}

/**
 * The set of table names a statement references, CTE aliases excluded. This is
 * the AST replacement for `extractTables`: walk FROM/JOIN/INTO/target clauses,
 * collect relation nodes, then drop the CTE names declared in `WITH`. A CTE
 * name and a stored table of the same name resolve to the CTE, so a CTE
 * declaration wins.
 * @param ast The parsed statement.
 * @returns The referenced table names, de-duplicated, with CTE aliases excluded.
 */
export function extractTableNames(ast: AST): string[] {
  const cte = cteNames(ast);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const ref of collectRelations(ast)) {
    const lower = ref.name.toLowerCase();
    if (cte.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    names.push(ref.name);
  }
  return names;
}

// ─── Typed relation extraction (schema family, §13) ─────────────────────────
//
// The schema family's `parseSqlTables` used regex to read table names out of
// SQL strings. §13 replaces that regex with a walk over the parsed AST: each
// relation carries the statement's verb (select / insert / update / delete /
// create) so the schema-usage, unknown-table, and lifecycle rules read the same
// AST facts as the data-access family — one grammar, no second scanner. The walk
// descends into nested statements (CTE bodies, FROM/WHERE/HAVING/column/values/
// set subqueries) so a table referenced only inside a subquery is still
// collected, and it subtracts CTE names and ALTER RENAME targets (named result
// sets and transient names, not stored tables).

export type SchemaRefType = 'select' | 'insert' | 'update' | 'delete' | 'create';

export interface TypedRelation {
  readonly table: string;
  /** Schema qualifier (`db` in `db.table`), null when unqualified. */
  readonly db: string | null;
  readonly type: SchemaRefType;
  /**
   * True when this relation's statement carried a top-level `ON CONFLICT` clause
   * that was truncated before parsing (see {@link truncateConflictClause}). The
   * write facts (target table, write status) are answered by the prefix; this
   * flag records that an upsert action was present but unread.
   */
  readonly conflictClauseTruncated?: boolean;
}

/** node-sql-parser statement `type` values (AST nodes that are statements, not
 *  expressions). A nested statement is any object carrying one of these. */
const STATEMENT_TYPES: ReadonlySet<string> = new Set([
  'select', 'insert', 'replace', 'update', 'delete', 'create', 'alter', 'drop', 'use',
]);

function isStatementNode(node: unknown): node is AST {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  const type = (node as Record<string, unknown>).type;
  return typeof type === 'string' && STATEMENT_TYPES.has(type);
}

/** Yield every statement reachable from `node`, excluding `node` itself. */
function* nestedStatements(node: unknown): Generator<AST> {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) yield* nestedStatements(item);
    return;
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    if (isStatementNode(value)) yield value;
    else yield* nestedStatements(value);
  }
}

/** Read a relation entry's bare table name and schema qualifier. */
function relationParts(entry: unknown): { table: string; db: string | null } | null {
  if (entry === null || typeof entry !== 'object') return null;
  const table = (entry as NamedEntry).table;
  if (typeof table !== 'string' || table.length === 0) return null;
  const db = (entry as NamedEntry).db;
  return { table, db: typeof db === 'string' && db.length > 0 ? db : null };
}

function pushTypedRelation(out: TypedRelation[], entry: unknown, type: SchemaRefType, conflictClauseTruncated = false): void {
  const parts = relationParts(entry);
  if (parts !== null) {
    out.push({ table: parts.table, db: parts.db, type, ...(conflictClauseTruncated ? { conflictClauseTruncated: true } : {}) });
  }
}

/** Collect CTE names across a statement and its nested statements into `names`
 *  (lowercased). */
function collectCteNamesRecursive(node: AST, names: Set<string>): void {
  if (node.type === 'select' && Array.isArray(node.with)) {
    for (const cte of node.with) {
      const value = (cte as { name?: { value?: unknown } } | undefined)?.name?.value;
      if (typeof value === 'string' && value.length > 0) names.add(value.toLowerCase());
    }
  }
  for (const nested of nestedStatements(node)) collectCteNamesRecursive(nested, names);
}

/** Collect `ALTER TABLE … RENAME TO` targets (transient names, not stored
 *  tables) across a statement and its nested statements. */
function collectRenameTargetsRecursive(node: AST, names: Set<string>): void {
  if (node.type === 'alter') {
    const expr = (node as { expr?: unknown }).expr;
    if (Array.isArray(expr)) {
      for (const op of expr) {
        if (op && typeof op === 'object' && (op as { action?: unknown }).action === 'rename') {
          const target = (op as { table?: unknown }).table;
          if (typeof target === 'string' && target.length > 0) names.add(target.toLowerCase());
        }
      }
    }
  }
  for (const nested of nestedStatements(node)) collectRenameTargetsRecursive(nested, names);
}

/** Emit the relations a statement names directly, with the statement's verb. A
 *  DELETE's `from` duplicates its `table` (node-sql-parser carries both), so only
 *  `table` is emitted as the write; a `CREATE` is emitted only for `CREATE TABLE`
 *  (a `CREATE INDEX`/`CREATE VIEW` names no stored table the rules track). */
function emitDirectRelations(ast: AST, out: TypedRelation[], conflictClauseTruncated: boolean): void {
  const table = (ast as { table?: unknown }).table;
  switch (ast.type) {
    case 'select': {
      const from = (ast as { from?: unknown }).from;
      if (Array.isArray(from)) for (const entry of from) pushTypedRelation(out, entry, 'select', conflictClauseTruncated);
      else pushTypedRelation(out, from, 'select', conflictClauseTruncated);
      break;
    }
    case 'insert':
    case 'replace': {
      if (Array.isArray(table)) for (const entry of table) pushTypedRelation(out, entry, 'insert', conflictClauseTruncated);
      else pushTypedRelation(out, table, 'insert', conflictClauseTruncated);
      break;
    }
    case 'update': {
      if (Array.isArray(table)) for (const entry of table) pushTypedRelation(out, entry, 'update', conflictClauseTruncated);
      else pushTypedRelation(out, table, 'update', conflictClauseTruncated);
      break;
    }
    case 'delete': {
      if (Array.isArray(table)) for (const entry of table) pushTypedRelation(out, entry, 'delete', conflictClauseTruncated);
      else pushTypedRelation(out, table, 'delete', conflictClauseTruncated);
      break;
    }
    case 'create': {
      if ((ast as { keyword?: unknown }).keyword === 'table') {
        if (Array.isArray(table)) for (const entry of table) pushTypedRelation(out, entry, 'create', conflictClauseTruncated);
        else pushTypedRelation(out, table, 'create', conflictClauseTruncated);
      }
      break;
    }
    default:
      break;
  }
}

function walkTyped(ast: AST, out: TypedRelation[], conflictClauseTruncated: boolean): void {
  // The truncation flag applies to the *top-level* statement only — a nested
  // statement (CTE body, subquery) carries no `ON CONFLICT` of its own.
  emitDirectRelations(ast, out, conflictClauseTruncated);
  for (const nested of nestedStatements(ast)) walkTyped(nested, out, false);
}

/** The typed relations of a parsed SQL program (one or more statements), with
 *  CTE names and ALTER RENAME targets subtracted and nested statements descended.
 *  `truncatedConflictIndices` names the statements whose text carried a top-level
 *  `ON CONFLICT` clause (truncated before parsing); their relations are flagged
 *  `conflictClauseTruncated` so a write is recorded as "upsert present but
 *  unread" rather than a plain INSERT.
 * @param statements The parsed statements of the program.
 * @param truncatedConflictIndices Indices into `statements` whose `ON CONFLICT` clause was truncated.
 * @returns The typed relations, with CTE names and ALTER RENAME targets subtracted. */
export function collectTypedRelations(
  statements: AST[],
  truncatedConflictIndices: ReadonlySet<number> = new Set(),
): TypedRelation[] {
  const cte = new Set<string>();
  const rename = new Set<string>();
  for (const stmt of statements) {
    collectCteNamesRecursive(stmt, cte);
    collectRenameTargetsRecursive(stmt, rename);
  }
  const out: TypedRelation[] = [];
  statements.forEach((stmt, index) => {
    walkTyped(stmt, out, truncatedConflictIndices.has(index));
  });
  return out.filter((r) => !cte.has(r.table.toLowerCase()) && !rename.has(r.table.toLowerCase()));
}

// ─── Where facts ─────────────────────────────────────────────────────────────

export interface WhereFacts {
  readonly hasWhere: boolean;
  readonly hasHaving: boolean;
  readonly hasLimit: boolean;
  /** The WHERE clause is entirely tautology (`WHERE 1=1` / `WHERE TRUE`), limiting nothing. */
  readonly whereIsTautology: boolean;
}

interface BinaryExprLike {
  readonly type?: unknown;
  readonly operator?: unknown;
  readonly left?: unknown;
  readonly right?: unknown;
  readonly value?: unknown;
}

/** True when an expression is a literal `1` (the `1=1` tautology operand). */
function isLiteralOne(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const n = node as BinaryExprLike;
  return n.type === 'number' && n.value === 1;
}

/** True when a WHERE expression reduces to "always true" (nothing is limited). */
function isTautologyExpr(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const n = node as BinaryExprLike;
  if (n.type === 'bool') return n.value === true;
  if (n.type !== 'binary_expr') return false;
  const op = typeof n.operator === 'string' ? n.operator.toUpperCase() : '';
  if (op === 'AND') return isTautologyExpr(n.left) && isTautologyExpr(n.right);
  if (op === '=') return isLiteralOne(n.left) && isLiteralOne(n.right);
  return false;
}

/**
 * Row-limiting facts about a statement — the AST replacement for site #2's
 * `hasQueryFilter` + `whereClauseIsTautology`. A WHERE carrying a real predicate
 * (any non-tautology), a HAVING, or a LIMIT limits rows; a bare `WHERE 1=1` does
 * not.
 * @param ast The parsed statement.
 * @returns Row-limiting facts: presence of WHERE/HAVING/LIMIT and whether the WHERE is tautological.
 */
export function whereFacts(ast: AST): WhereFacts {
  const where = (ast as { where?: unknown }).where ?? null;
  const having = (ast as { having?: unknown }).having ?? null;
  const limit = (ast as { limit?: unknown }).limit ?? null;
  return {
    hasWhere: where !== null && where !== undefined,
    hasHaving: having !== null && having !== undefined,
    // node-sql-parser emits `limit: { seperator: '', value: [] }` for a SELECT
    // with no LIMIT clause — a present-but-empty object, not `null`. Reading the
    // bare `limit != null` would mark every query "limited" and silence
    // `unfiltered-query`'s filterless-read/write halves. An empty `value` array
    // is "no limit"; a non-empty one (or a scalar/array form a dialect may emit)
    // is a real LIMIT.
    hasLimit: hasLimitClause(limit),
    whereIsTautology: where !== null && where !== undefined && isTautologyExpr(where),
  };
}

/** True when a parsed statement carries a real LIMIT. node-sql-parser's
 *  `limit` is `{ seperator, value[] }`; `value.length === 0` means the SELECT
 *  has no LIMIT clause, so the object alone does not prove one. */
function hasLimitClause(limit: unknown): boolean {
  if (limit === null || limit === undefined) return false;
  if (Array.isArray(limit)) return limit.length > 0;
  if (typeof limit === 'object') {
    const value = (limit as { value?: unknown }).value;
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined;
  }
  return true;
}

// ─── Write verbs ─────────────────────────────────────────────────────────────

/**
 * True when a statement is a write (INSERT/DELETE/UPDATE/REPLACE) — the AST
 * replacement for site #3's `hasWriteVerb`, which had to regex `REPLACE INTO`
 * as a two-word clause to avoid the `REPLACE()` string function. The statement
 * kind is that distinction, structurally.
 */
export function isWriteStatement(ast: AST): boolean {
  return ast.type === 'insert' || ast.type === 'delete' || ast.type === 'update' || ast.type === 'replace';
}

/**
 * True when a statement mass-mutates existing rows (`UPDATE … SET`), the AST
 * replacement for `hasMassWriteVerb`. `DELETE` is deliberately excluded (Spec 68
 * disposition (a)); `INSERT`/`REPLACE` target specific rows.
 */
export function isMassWriteStatement(ast: AST): boolean {
  return ast.type === 'update';
}

/**
 * True when a statement is an upsert — a `REPLACE`, or an `INSERT` carrying an
 * `ON CONFLICT` / `ON DUPLICATE KEY` clause — the AST replacement for
 * `isUpsertForm`. An upsert is keyed by construction, so it never reads as an
 * "unfiltered" mass write.
 * @param ast The parsed statement.
 * @returns True when the statement is an upsert (`REPLACE`, or `INSERT` with an `OR` / `ON DUPLICATE KEY` clause).
 */
export function isUpsertStatement(ast: AST): boolean {
  if (ast.type === 'replace') return true;
  if (ast.type !== 'insert') return false;
  // SQLite upsert spelling is `INSERT OR IGNORE/REPLACE/ABORT/FAIL/ROLLBACK`,
  // carried on the `or` field; the MySQL `ON DUPLICATE KEY UPDATE` spelling lands
  // on `on_duplicate_update`. Postgres `ON CONFLICT` does not parse under the
  // sqlite dialect and is a parse failure, which is the honest result.
  const raw = ast as unknown as { or?: unknown; on_duplicate_update?: unknown };
  const hasOr = raw.or !== null && raw.or !== undefined;
  const hasOnDuplicate = raw.on_duplicate_update !== null && raw.on_duplicate_update !== undefined;
  return hasOr || hasOnDuplicate;
}

// ─── Insert columns ──────────────────────────────────────────────────────────

/**
 * The column list of an INSERT/REPLACE — the AST replacement for site #6's
 * `rawInsertColumnList`. `null` columns (an `INSERT … VALUES` with no column
 * list) yields an empty array, which is a distinct, honest result.
 * @param ast The parsed statement.
 * @returns The INSERT/REPLACE column list, or an empty array when there is none.
 */
export function insertColumns(ast: AST): string[] {
  if (ast.type !== 'insert' && ast.type !== 'replace') return [];
  const columns = (ast as { columns?: unknown }).columns;
  if (!Array.isArray(columns)) return [];
  return columns.filter((c): c is string => typeof c === 'string');
}

// ─── Tenant predicate (org filter) ───────────────────────────────────────────

/**
 * The column references that appear as *predicate operands* in a statement's
 * WHERE tree — the AST replacement for site #5's four regex families, collapsed
 * to one walk. A column name in the SELECT list, an INSERT column list, or a
 * comment is *not* an operand, so a projection can no longer masquerade as a
 * filter (the Spec 68 Thing 2 `sample_ownership` defect). A quoted identifier on
 * the left of a comparison (`"org_id" = ?`, the knex/Postgres form) is collected
 * too, because under a PostgreSQL-style dialect it is a column, not a string
 * literal.
 * @param ast The parsed statement.
 * @returns The lowercased column names that appear as WHERE-tree predicate operands.
 */
export function whereColumnRefs(ast: AST): Set<string> {
  const refs = new Set<string>();
  const where = (ast as { where?: unknown }).where;
  collectWhereColumnRefs(where, refs);
  return refs;
}

function collectWhereColumnRefs(node: unknown, refs: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectWhereColumnRefs(item, refs);
    return;
  }
  const n = node as Record<string, unknown>;
  if (n.type === 'column_ref') {
    const column = n.column;
    if (typeof column === 'string' && column.length > 0) refs.add(column.toLowerCase());
    return;
  }
  // A double-quoted identifier on the left of a comparison is a column under
  // PostgreSQL/knex; its node-sql-parser shape is `double_quote_string`.
  if (n.type === 'double_quote_string') {
    const value = n.value;
    if (typeof value === 'string' && value.length > 0) refs.add(value.toLowerCase());
    return;
  }
  // Recurse into binary/boolean/logical expressions and their operands.
  for (const key of ['left', 'right', 'expr', 'args', 'value', 'columns'] as const) {
    const child = n[key];
    if (child !== null && typeof child === 'object') collectWhereColumnRefs(child, refs);
  }
}

/**
 * True when a statement's WHERE clause applies an org/tenant-scoping predicate —
 * a `col op value` shape where `col` is in the tenant column set. This is the
 * AST form of `hasOrganizationFilter`; the tenant vocabulary is passed in (the
 * same vocabulary discovery uses), so the predicate and the tier set can never
 * read two different vocabularies.
 *
 * @param ast The parsed statement.
 * @param tenantColumns The tenant column names (lowercased) that count as scope.
 * @returns True when any WHERE predicate operand is a tenant column.
 */
export function hasTenantPredicate(ast: AST, tenantColumns: ReadonlySet<string>): boolean {
  if (tenantColumns.size === 0) return false;
  const refs = whereColumnRefs(ast);
  for (const ref of refs) {
    if (tenantColumns.has(ref)) return true;
  }
  return false;
}

// ─── DDL facts ───────────────────────────────────────────────────────────────

/** True when a statement is table DDL (`CREATE TABLE` / `DROP TABLE` / `ALTER TABLE`).
 * @param ast The parsed statement.
 * @returns True when the statement is `CREATE TABLE`, `DROP TABLE`, or `ALTER TABLE`. */
export function isDdlStatement(ast: AST): boolean {
  if (ast.type === 'drop') return (ast as { keyword?: unknown }).keyword === 'table';
  if (ast.type === 'alter') return true;
  if (ast.type === 'create') return (ast as { keyword?: unknown }).keyword === 'table';
  return false;
}

/** The table names a DDL statement names (create target, drop names, alter target + rename).
 * @param ast The parsed statement.
 * @returns The table names the DDL statement names (create target, drop names, alter target + rename). */
export function ddlTableNames(ast: AST): string[] {
  const names = new Set<string>();
  for (const ref of collectRelations(ast)) names.add(ref.name);
  if (ast.type === 'alter') {
    // `ALTER TABLE t RENAME TO newname` — the rename target is a table name.
    const expr = (ast as { expr?: unknown }).expr;
    if (Array.isArray(expr)) {
      for (const op of expr) {
        if (op && typeof op === 'object' && (op as { action?: unknown }).action === 'rename') {
          const target = (op as { table?: unknown }).table;
          if (typeof target === 'string' && target.length > 0) names.add(target);
        }
      }
    }
  }
  return Array.from(names);
}

export interface DdlColumn {
  readonly table: string;
  readonly column: string;
  readonly primaryKey: boolean;
  readonly notNull: boolean;
  readonly unique: boolean;
  readonly dataType: string | null;
}

export interface DdlForeignKey {
  readonly table: string;
  readonly columns: string[];
  readonly referencesTable: string;
  readonly referencesColumns: string[];
}

/** One ordered migration op (`CREATE` / `DROP` / `RENAME`) for a table. */
export interface DdlMigrationOp {
  readonly op: 'CREATE' | 'DROP' | 'RENAME';
  readonly table: string;
  readonly newTable?: string;
}

interface ColumnDefinitionLike {
  readonly action?: unknown;
  readonly column?: unknown;
  readonly definition?: unknown;
  readonly resource?: unknown;
  readonly primary_key?: unknown;
  readonly unique?: unknown;
  readonly nullable?: unknown;
  readonly reference_definition?: unknown;
  readonly create_definitions?: unknown;
  readonly constraint_type?: unknown;
}

interface DefinitionLike {
  readonly dataType?: unknown;
  readonly constraint_type?: unknown;
  readonly definition?: unknown;
}

/** True when a constraint-flag field (`primary_key`, `unique`) is present and on. */
function flagIsSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** The `not null` flag of a column definition — `nullable: { type: 'not null' }`
 *  (or, on some dialects, a bare string). */
function isNotNull(def: ColumnDefinitionLike): boolean {
  const nullable = def.nullable;
  if (nullable === null || nullable === undefined) return false;
  if (typeof nullable === 'string') return nullable.toLowerCase() === 'not null';
  if (typeof nullable === 'object') {
    const t = (nullable as { type?: unknown }).type;
    return typeof t === 'string' && t.toLowerCase() === 'not null';
  }
  return false;
}

/**
 * Extract every column defined by a `CREATE TABLE` (or `ALTER TABLE … ADD
 * COLUMN`) statement — the AST replacement for site #9's
 * `extractDdlTableColumns` + `leadingColumnName` + `splitColumnDefs`, which
 * hand-rolled paren-depth and quote tracking. The column name and its
 * constraints (primary-key / not-null / unique) come straight off the
 * definition nodes.
 * @param ast The parsed `CREATE TABLE` or `ALTER TABLE … ADD COLUMN` statement.
 * @returns Each column with its primary-key / not-null / unique flags and data type.
 */
export function ddlColumnDefinitions(ast: AST): DdlColumn[] {
  const result: DdlColumn[] = [];
  const tables = ddlTableNames(ast);
  const table = tables[0] ?? '';

  const emit = (d: ColumnDefinitionLike): void => {
    const column = columnNameOf(d);
    if (column === null) return;
    const definition = d.definition as DefinitionLike | undefined;
    result.push({
      table,
      column,
      primaryKey: flagIsSet(d.primary_key),
      notNull: isNotNull(d),
      unique: flagIsSet(d.unique),
      dataType: typeof definition?.dataType === 'string' ? definition.dataType : null,
    });
  };

  if (ast.type === 'create') {
    const defs = (ast as { create_definitions?: unknown }).create_definitions;
    if (Array.isArray(defs)) {
      for (const def of defs) emit(def as ColumnDefinitionLike);
    }
  } else if (ast.type === 'alter') {
    const expr = (ast as { expr?: unknown }).expr;
    if (Array.isArray(expr)) {
      for (const op of expr) {
        const d = op as ColumnDefinitionLike;
        if (d.action !== 'add') continue;
        emit(d);
      }
    }
  }
  return result;
}

function columnNameOf(def: unknown): string | null {
  if (def === null || typeof def !== 'object') return null;
  const column = (def as ColumnDefinitionLike).column;
  if (column === null || typeof column !== 'object') return null;
  const name = (column as { column?: unknown }).column;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** The column name of a `column_ref` node (`{ type: 'column_ref', column: 'a' }`). */
function columnRefNameOf(node: unknown): string | null {
  if (node === null || typeof node !== 'object') return null;
  const column = (node as { column?: unknown }).column;
  return typeof column === 'string' && column.length > 0 ? column : null;
}

/** The referenced table name of a `reference_definition`. */
function referenceTableOf(ref: unknown): string {
  if (ref === null || typeof ref !== 'object') return '';
  const table = (ref as { table?: unknown }).table;
  const entry = Array.isArray(table) ? table[0] : table;
  const name = (entry as { table?: unknown })?.table;
  return typeof name === 'string' ? name : '';
}

/** The referenced column names of a `reference_definition`. */
function referenceColumnsOf(ref: unknown): string[] {
  if (ref === null || typeof ref !== 'object') return [];
  const definition = (ref as { definition?: unknown }).definition;
  if (!Array.isArray(definition)) return [];
  const names: string[] = [];
  for (const rc of definition) {
    const name = columnRefNameOf(rc);
    if (name !== null) names.push(name);
  }
  return names;
}

/** The local column names of a table-level constraint's `definition` list. */
function constraintColumnNames(def: unknown): string[] {
  if (def === null || typeof def !== 'object') return [];
  const definition = (def as { definition?: unknown }).definition;
  if (!Array.isArray(definition)) return [];
  const names: string[] = [];
  for (const c of definition) {
    const name = columnRefNameOf(c);
    if (name !== null) names.push(name);
  }
  return names;
}

/** The normalized (`lower`) `constraint_type` of a constraint definition, or null. */
function constraintTypeOf(def: unknown): string | null {
  if (def === null || typeof def !== 'object') return null;
  const raw = (def as { constraint_type?: unknown }).constraint_type;
  return typeof raw === 'string' && raw.length > 0 ? raw.toLowerCase() : null;
}

/**
 * Extract the foreign-key constraints of a `CREATE TABLE` or `ALTER TABLE … ADD
 * CONSTRAINT … FOREIGN KEY` statement — the AST replacement for site #10's FK
 * regexes. Covers the three DDL spellings: column-level `REFERENCES`, table-level
 * `FOREIGN KEY (…) REFERENCES`, and ALTER `ADD CONSTRAINT … FOREIGN KEY`. The
 * referenced table and columns come straight off the `reference_definition` node.
 * @param ast The parsed `CREATE TABLE` or `ALTER TABLE` statement.
 * @returns The foreign-key constraints, with local columns and the referenced table/columns.
 */
export function ddlForeignKeys(ast: AST): DdlForeignKey[] {
  if (ast.type !== 'create' && ast.type !== 'alter') return [];
  const result: DdlForeignKey[] = [];
  const tables = ddlTableNames(ast);
  const table = tables[0] ?? '';

  const emit = (def: ColumnDefinitionLike): void => {
    const ref = def.reference_definition;
    if (ref === null || typeof ref !== 'object' || ref === undefined) return;
    const localColumn = columnNameOf(def);
    const localColumns = constraintColumnNames(def);
    const columns = localColumn !== null ? [localColumn] : (localColumns.length > 0 ? localColumns : []);
    result.push({
      table,
      columns,
      referencesTable: referenceTableOf(ref),
      referencesColumns: referenceColumnsOf(ref),
    });
  };

  if (ast.type === 'create') {
    const defs = (ast as { create_definitions?: unknown }).create_definitions;
    if (Array.isArray(defs)) {
      for (const def of defs) emit(def as ColumnDefinitionLike);
    }
  } else {
    const expr = (ast as { expr?: unknown }).expr;
    if (Array.isArray(expr)) {
      for (const op of expr) {
        const d = op as ColumnDefinitionLike;
        if (d.action !== 'add') continue;
        // `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY (…) REFERENCES …` carries the
        // constraint on `create_definitions` of the `add` op, not on the op itself.
        const cd = d.create_definitions;
        if (cd !== null && typeof cd === 'object' && cd !== undefined) {
          emit(cd as ColumnDefinitionLike);
        }
      }
    }
  }
  return result;
}

/**
 * The ordered CREATE / DROP / RENAME ops of a table-DDL statement — the AST
 * replacement for site #7's `DDL_RE` (which had to regex the whole
 * create/drop/alter-rename vocabulary as one alternation). The statement kind and
 * its target/rename nodes are read directly.
 * @param ast The parsed table-DDL statement.
 * @returns The ordered CREATE / DROP / RENAME ops.
 */
export function ddlMigrationOps(ast: AST): DdlMigrationOp[] {
  if (ast.type === 'create' && (ast as { keyword?: unknown }).keyword === 'table') {
    const tables = ddlTableNames(ast);
    return [{ op: 'CREATE', table: tables[0] ?? '' }];
  }
  if (ast.type === 'drop' && (ast as { keyword?: unknown }).keyword === 'table') {
    return ddlTableNames(ast).map((t) => ({ op: 'DROP' as const, table: t }));
  }
  if (ast.type === 'alter') {
    const tables = ddlTableNames(ast);
    const target = tables[0] ?? '';
    const expr = (ast as { expr?: unknown }).expr;
    if (Array.isArray(expr)) {
      for (const op of expr) {
        if (op && typeof op === 'object' && (op as { action?: unknown }).action === 'rename') {
          const newTable = (op as { table?: unknown }).table;
          if (typeof newTable === 'string' && newTable.length > 0) {
            return [{ op: 'RENAME', table: target, newTable }];
          }
        }
      }
    }
    return [];
  }
  return [];
}

/**
 * The columns of a table-level or ALTER-added UNIQUE / PRIMARY KEY constraint —
 * the AST replacement for the table-level halves of `extractDdlUniqueColumns` and
 * `extractDdlPrimaryKeyColumns`, which had to hand-roll paren matching to find
 * the column list inside `UNIQUE (…)`. Column-level `UNIQUE` / `PRIMARY KEY` is
 * already carried by {@link ddlColumnDefinitions}.
 * @param ast The parsed `CREATE TABLE` or `ALTER TABLE` statement.
 * @param constraintType `'unique'` or `'primary key'`.
 * @returns The lowercased columns of table-level / ALTER-added constraints of that kind.
 */
export function ddlConstraintColumns(ast: AST, constraintType: 'unique' | 'primary key'): string[] {
  const names: string[] = [];
  const collect = (def: unknown): void => {
    if (def === null || typeof def !== 'object') return;
    if (constraintTypeOf(def) !== constraintType) return;
    for (const name of constraintColumnNames(def)) names.push(name.toLowerCase());
  };

  if (ast.type === 'create') {
    const defs = (ast as { create_definitions?: unknown }).create_definitions;
    if (Array.isArray(defs)) for (const def of defs) collect(def);
  } else if (ast.type === 'alter') {
    const expr = (ast as { expr?: unknown }).expr;
    if (Array.isArray(expr)) {
      for (const op of expr) {
        const d = op as ColumnDefinitionLike;
        if (d.action !== 'add') continue;
        collect(d.create_definitions);
      }
    }
  }
  return names;
}

// ─── Statement kind convenience ──────────────────────────────────────────────

/** The {@link SqlStatementKind} of a parsed statement. */
export function kindOf(ast: AST): SqlStatementKind {
  return statementKind(ast.type);
}
