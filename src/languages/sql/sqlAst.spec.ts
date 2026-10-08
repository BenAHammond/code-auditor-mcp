/**
 * Spec 70 R1 — the SQL AST seam. Pins the parse contract (`ok`/`fail`, no regex
 * fallback), the declared input normalization (`?n` → `?`, multi-statement split,
 * transaction-control recognition, template classification), the relation
 * extraction (CTE-alias exclusion), the where facts, the tenant predicate
 * (projection vs predicate), the write/upsert classification, insert columns, and
 * DDL column/FK extraction. Each is an AST walk, not a text scan.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSql,
  parseSqlProgram,
  parseSqlProgramTolerant,
  collectTypedRelations,
  truncateConflictClause,
  normalizePositionalParams,
  normalizeSqliteTextLength,
  normalizeEscapeClause,
  normalizeLimitOffsetPlaceholders,
  normalizeVirtualTable,
  splitSqlStatements,
  extractTableNames,
  cteNames,
  whereFacts,
  isWriteStatement,
  isMassWriteStatement,
  isUpsertStatement,
  insertColumns,
  hasTenantPredicate,
  whereColumnRefs,
  isDdlStatement,
  ddlTableNames,
  ddlColumnDefinitions,
  ddlForeignKeys,
} from './sqlAst.js';

const TENANT = new Set(['org_id', 'organization_id', 'tenant_id', 'workspace_id']);

// The dialect is a required parameter now (there is no default to lean on), so
// every fixture below names sqlite explicitly through these shims rather than
// calling parseSql/parseSqlProgram with a bare string.
function sql(text: string): ReturnType<typeof parseSql> {
  return parseSql(text, 'sqlite');
}
function program(text: string): ReturnType<typeof parseSqlProgram> {
  return parseSqlProgram(text, 'sqlite');
}

describe('parseSql — dialect and the parse-or-nothing contract', () => {
  it('parses a select statement', () => {
    const r = sql('SELECT * FROM users WHERE id = ?');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe('select');
  });

  it('fails on an empty string, not silently', () => {
    const r = sql('   ');
    expect(r.ok).toBe(false);
  });

  it('fails on a non-statement fragment with no regex fallback', () => {
    const r = sql('FROM users');
    expect(r.ok).toBe(false);
  });

  it('parses a multi-statement .sql program via parseSqlProgram', () => {
    const r = program('CREATE TABLE a(x int); CREATE TABLE b(y int)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.statements).toHaveLength(2);
  });
});

describe('declared input normalization (Spec 70 R1 step 2)', () => {
  it('rewrites a D1 numbered param to a bare ? before parsing', () => {
    const r = sql('SELECT * FROM users WHERE organization_id = ?1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(hasTenantPredicate(r.ast, TENANT)).toBe(true);
  });

  it('rewrites a multi-numbered param list', () => {
    const r = sql('INSERT INTO t (a, b) VALUES (?1, ?2)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(insertColumns(r.ast)).toEqual(['a', 'b']);
  });

  it('does not rewrite a ? inside a string literal', () => {
    expect(normalizePositionalParams("SELECT * FROM t WHERE note = 'a?1b'")).toBe(
      "SELECT * FROM t WHERE note = 'a?1b'",
    );
  });

  it('does not rewrite a ? inside a quoted identifier', () => {
    expect(normalizePositionalParams('SELECT * FROM "t?1"')).toBe('SELECT * FROM "t?1"');
  });

  it('rewrites a length-qualified text(N) to varchar(N) for the sqlite grammar', () => {
    expect(normalizeSqliteTextLength('CREATE TABLE t (name text(256))')).toBe(
      'CREATE TABLE t (name varchar(256))',
    );
    expect(normalizeSqliteTextLength('CREATE TABLE t (name TEXT(2))')).toBe(
      'CREATE TABLE t (name varchar(2))',
    );
  });

  it('leaves a bare text and other length-qualified types untouched', () => {
    expect(normalizeSqliteTextLength('CREATE TABLE t (name text)')).toBe('CREATE TABLE t (name text)');
    expect(normalizeSqliteTextLength('CREATE TABLE t (x varchar(255))')).toBe(
      'CREATE TABLE t (x varchar(255))',
    );
    // `textual` is a whole word on its own, not `text` + a suffix.
    expect(normalizeSqliteTextLength('CREATE TABLE t (x textual)')).toBe('CREATE TABLE t (x textual)');
  });

  it('does not rewrite text( inside a string literal or quoted identifier', () => {
    expect(normalizeSqliteTextLength("SELECT 'text(256)'")).toBe("SELECT 'text(256)'");
    expect(normalizeSqliteTextLength('SELECT "text(256)"')).toBe('SELECT "text(256)"');
  });

  it('parses a text(N) column type under sqlite once normalized', () => {
    const r = sql('CREATE TABLE t (name text(256))');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(ddlColumnDefinitions(r.ast)[0].dataType).toMatch(/varchar/i);
    }
  });

  it('rewrites a lone-backslash string literal to a doubled backslash', () => {
    expect(normalizeEscapeClause("SELECT * FROM t WHERE c LIKE 'a%' ESCAPE '\\'")).toBe(
      "SELECT * FROM t WHERE c LIKE 'a%' ESCAPE '\\\\'",
    );
  });

  it('does not rewrite a backslash inside a longer string or an escaped quote', () => {
    // `'it\\'s'` is a string with an escaped quote, not a lone-backslash string.
    expect(normalizeEscapeClause("SELECT 'it\\'s'")).toBe("SELECT 'it\\'s'");
    // A double-quoted identifier carrying `'\'` is left intact.
    expect(normalizeEscapeClause(`SELECT "a'\\'b"`)).toBe(`SELECT "a'\\'b"`);
  });

  it('parses an ESCAPE \'\\\' clause once normalized', () => {
    const r = sql("SELECT * FROM t WHERE name LIKE 'x%' ESCAPE '\\'");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe('select');
  });

  it('rewrites LIMIT ? and OFFSET ? to concrete literals', () => {
    expect(normalizeLimitOffsetPlaceholders('SELECT * FROM t LIMIT ?')).toBe('SELECT * FROM t LIMIT 1');
    expect(normalizeLimitOffsetPlaceholders('SELECT * FROM t LIMIT ? OFFSET ?')).toBe(
      'SELECT * FROM t LIMIT 1 OFFSET 0',
    );
    expect(normalizeLimitOffsetPlaceholders('SELECT * FROM t OFFSET ?')).toBe('SELECT * FROM t OFFSET 0');
  });

  it('does not rewrite a bare ? outside a LIMIT/OFFSET clause', () => {
    expect(normalizeLimitOffsetPlaceholders('SELECT * FROM t WHERE id = ?')).toBe(
      'SELECT * FROM t WHERE id = ?',
    );
  });

  it('parses a LIMIT ? OFFSET ? query once normalized', () => {
    const r = sql('SELECT * FROM t LIMIT ? OFFSET ?');
    expect(r.ok).toBe(true);
    if (r.ok) expect(whereFacts(r.ast)).toHaveProperty('hasLimit', true);
  });

  it('rewrites CREATE VIRTUAL TABLE … USING fts5(…) to a CREATE TABLE the grammar parses', () => {
    const r = sql(
      "CREATE VIRTUAL TABLE strategies_fts USING fts5(strategy_id UNINDEXED, hero_slug UNINDEXED, body, grounding_quote, tokenize = 'porter unicode61')",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(extractTableNames(r.ast)).toEqual(['strategies_fts']);
      expect(ddlColumnDefinitions(r.ast).map((c) => c.column)).toEqual([
        'strategy_id',
        'hero_slug',
        'body',
        'grounding_quote',
      ]);
    }
  });

  it('leaves a CREATE VIRTUAL TABLE with no bare columns untouched', () => {
    // An FTS5 declaration that pulls columns from an external table (no bare
    // column names) is not rewritten — the honest parse failure, not a fabricated
    // empty table.
    expect(normalizeVirtualTable("CREATE VIRTUAL TABLE t USING fts5(content = 'x')")).toBe(
      "CREATE VIRTUAL TABLE t USING fts5(content = 'x')",
    );
  });

  it('normalizes a text(N) column after a comment with an apostrophe (comment-quote bug)', () => {
    // A `don't` in the header block comment must not open a quote that disables
    // the text(N) → varchar(N) rewrite for the CREATE TABLE that follows.
    const r = sql("/* we don't do this manually */\nCREATE TABLE t (`c` text(3) DEFAULT 'x')");
    expect(r.ok).toBe(true);
    if (r.ok) expect(ddlColumnDefinitions(r.ast)).toHaveLength(1);
  });

  it('recognizes PRAGMA / DROP INDEX / DROP VIEW / DROP TRIGGER / CREATE VIEW / CREATE TRIGGER as no-fact SQL in the DDL path', () => {
    for (const stmt of [
      'PRAGMA foreign_keys = OFF',
      'PRAGMA foreign_keys=OFF',
      'DROP INDEX IF EXISTS idx_x',
      'DROP INDEX foo',
      'DROP VIEW IF EXISTS v_x',
      'DROP TRIGGER tr_x',
      'CREATE VIEW v AS SELECT 1 AS a UNION ALL SELECT 2 AS a',
      'CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW BEGIN UPDATE s SET c = c + 1; END',
    ]) {
      const program = parseSqlProgramTolerant(stmt, 'sqlite');
      expect(program.failures).toEqual([]);
      expect(program.statements).toHaveLength(1);
      expect(extractTableNames(program.statements[0])).toEqual([]);
      expect(isWriteStatement(program.statements[0])).toBe(false);
    }
  });

  it('does NOT recognize PRAGMA / DROP INDEX / DROP TRIGGER as no-fact on the per-call-site path', () => {
    for (const stmt of [
      'PRAGMA table_info(x)',
      'PRAGMA foreign_keys=OFF',
      'DROP INDEX foo',
      'DROP TRIGGER tr_x',
    ]) {
      expect(sql(stmt).ok).toBe(false);
    }
  });

  it('still parses DROP TABLE (it names a stored table) rather than recognizing it away', () => {
    const r = sql('DROP TABLE IF EXISTS foo');
    expect(r.ok).toBe(true);
    if (r.ok) expect(extractTableNames(r.ast)).toEqual(['foo']);
  });

  it('fails cleanly on a literal with only a statement separator, not a crash', () => {
    // A `.raw(';')` site: the semicolon is a separator, so nothing survives to
    // parse. `splitSqlStatements` returns [] and the seam must report a failure,
    // not pass `statements[0]` (undefined) into the parser.
    const r = sql(';');
    expect(r.ok).toBe(false);
  });

  it('parses a multi-statement string at the seam, one AST per statement', () => {
    const r = sql('DROP TABLE a; DROP TABLE b');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.statements).toHaveLength(2);
      expect(ddlTableNames(r.ast)).toEqual(['a']);
    }
  });

  it('keeps a multi-statement string a failure if any statement fails', () => {
    const r = sql('SELECT 1; BOGUS 2');
    expect(r.ok).toBe(false);
  });

  it('recognizes standalone transaction control as SQL with no facts', () => {
    for (const stmt of ['BEGIN TRANSACTION;', 'COMMIT;', 'ROLLBACK', 'BEGIN', 'END']) {
      const r = sql(stmt);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(extractTableNames(r.ast)).toEqual([]);
        expect(isWriteStatement(r.ast)).toBe(false);
        expect(hasTenantPredicate(r.ast, TENANT)).toBe(false);
      }
    }
  });

  it('truncates ON CONFLICT … DO UPDATE and flags it, parsing the prefix (Spec 70 disposition)', () => {
    const r = sql('INSERT INTO t (a) VALUES (1) ON CONFLICT(a) DO UPDATE SET a = 2');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe('insert');
      expect(r.conflictClauseTruncated).toBe(true);
      // The prefix answers the write facts even though the clause is dropped.
      expect(isWriteStatement(r.ast)).toBe(true);
      expect(extractTableNames(r.ast)).toEqual(['t']);
      expect(insertColumns(r.ast)).toEqual(['a']);
    }
  });

  it('does not truncate when ON CONFLICT is absent', () => {
    const r = sql('INSERT INTO t (a) VALUES (1)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.conflictClauseTruncated).toBeUndefined();
  });

  it('does not truncate ON CONFLICT inside a string literal', () => {
    const r = sql("INSERT INTO t (a) VALUES ('ON CONFLICT(x)')");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.conflictClauseTruncated).toBeUndefined();
  });

  it('still fails on a genuine Postgres cast (::type)', () => {
    const r = parseSql('UPDATE t SET c = x::integer WHERE id = ?', 'postgresql');
    expect(r.ok).toBe(false);
  });

  it('classifies a templated .sql migration as not-SQL, not unparseable', () => {
    const r = program('CREATE TABLE individual_samples_{{VERSION}} (v TEXT);');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('templated migration');
  });

  it('does not classify a {{…}} in a comment as a template', () => {
    // A comment naming a placeholder is prose; the SQL itself is parseable.
    const r = program('CREATE TABLE t (v TEXT); -- target is t_{{VERSION}}');
    expect(r.ok).toBe(true);
  });
});

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons only', () => {
    expect(splitSqlStatements("SELECT 'a;b' FROM t; DELETE FROM u")).toEqual([
      "SELECT 'a;b' FROM t",
      'DELETE FROM u',
    ]);
  });

  it('drops empty fragments from a trailing semicolon', () => {
    expect(splitSqlStatements('SELECT 1;')).toEqual(['SELECT 1']);
  });

  it('returns one part when there is no semicolon', () => {
    expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('an apostrophe in a line comment does not swallow later semicolons', () => {
    expect(splitSqlStatements("-- don't do this\nALTER TABLE x RENAME TO y; CREATE TABLE z (id int);")).toEqual([
      'ALTER TABLE x RENAME TO y',
      'CREATE TABLE z (id int)',
    ]);
  });

  it('a semicolon inside a block comment is not a statement boundary', () => {
    expect(splitSqlStatements('/* drop it; keep it */ DROP TABLE a; DROP TABLE b;')).toEqual([
      'DROP TABLE a',
      'DROP TABLE b',
    ]);
  });

  it('keeps a CREATE TRIGGER body (its internal ;) as one statement', () => {
    expect(
      splitSqlStatements(
        'CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW BEGIN UPDATE s SET c = c + 1 WHERE id = NEW.id; END; CREATE TABLE z (id int);',
      ),
    ).toEqual([
      'CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW BEGIN UPDATE s SET c = c + 1 WHERE id = NEW.id; END',
      'CREATE TABLE z (id int)',
    ]);
  });

  it('keeps a multi-statement trigger body with a nested CASE … END intact', () => {
    expect(
      splitSqlStatements(
        'CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW BEGIN UPDATE s SET a = CASE WHEN x THEN 1 ELSE 0 END WHERE id = NEW.id; UPDATE s SET b = 2; END; SELECT 1;',
      ),
    ).toEqual([
      'CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW BEGIN UPDATE s SET a = CASE WHEN x THEN 1 ELSE 0 END WHERE id = NEW.id; UPDATE s SET b = 2; END',
      'SELECT 1',
    ]);
  });

  it('does not treat a transaction BEGIN; as a trigger body', () => {
    expect(splitSqlStatements('BEGIN; INSERT INTO t (a) VALUES (1); COMMIT;')).toEqual([
      'BEGIN',
      'INSERT INTO t (a) VALUES (1)',
      'COMMIT',
    ]);
  });
});

describe('extractTableNames — CTE aliases are not tables (site #1 defect)', () => {
  it('counts the stored table, not the CTE alias', () => {
    const r = sql('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(cteNames(r.ast)).toEqual(new Set(['recent']));
      expect(extractTableNames(r.ast)).toEqual(['orders']);
    }
  });

  it('a CTE name shadowing a stored table resolves to the CTE', () => {
    const r = sql('WITH users AS (SELECT 1) SELECT * FROM users');
    expect(r.ok).toBe(true);
    if (r.ok) expect(extractTableNames(r.ast)).toEqual([]);
  });

  it('collects JOIN relations', () => {
    const r = sql('SELECT * FROM a JOIN b ON a.id = b.a_id');
    expect(r.ok).toBe(true);
    if (r.ok) expect(extractTableNames(r.ast).sort()).toEqual(['a', 'b']);
  });

  it('collects INSERT targets', () => {
    const r = sql('INSERT INTO users (id, name) VALUES (1, \'x\')');
    expect(r.ok).toBe(true);
    if (r.ok) expect(extractTableNames(r.ast)).toEqual(['users']);
  });

  it('collects DELETE and UPDATE targets', () => {
    const d = sql('DELETE FROM users WHERE id = ?');
    const u = sql('UPDATE users SET x = 1 WHERE id = ?');
    expect(d.ok && u.ok).toBe(true);
    if (d.ok) expect(extractTableNames(d.ast)).toEqual(['users']);
    if (u.ok) expect(extractTableNames(u.ast)).toEqual(['users']);
  });

  it('collects DROP and ALTER (incl. rename target) names', () => {
    const drop = sql('DROP TABLE users');
    const alter = sql('ALTER TABLE users RENAME TO people');
    expect(drop.ok && alter.ok).toBe(true);
    if (drop.ok) expect(ddlTableNames(drop.ast)).toEqual(['users']);
    if (alter.ok) expect(ddlTableNames(alter.ast).sort()).toEqual(['people', 'users']);
  });
});

describe('whereFacts — filter presence and tautology (site #2)', () => {
  it('reads a real predicate as a filter', () => {
    const r = sql('SELECT * FROM users WHERE id = ?');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(whereFacts(r.ast)).toEqual({
        hasWhere: true, hasHaving: false, hasLimit: false, whereIsTautology: false,
      });
    }
  });

  it('reads WHERE 1=1 as a tautology (no filter)', () => {
    const r = sql('SELECT * FROM users WHERE 1=1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(whereFacts(r.ast).whereIsTautology).toBe(true);
  });

  it('reads WHERE TRUE as a tautology', () => {
    const r = sql('SELECT * FROM users WHERE TRUE');
    expect(r.ok).toBe(true);
    if (r.ok) expect(whereFacts(r.ast).whereIsTautology).toBe(true);
  });

  it('does not read WHERE 1=1 AND active=? as a tautology', () => {
    const r = sql('SELECT * FROM users WHERE 1=1 AND active = ?');
    expect(r.ok).toBe(true);
    if (r.ok) expect(whereFacts(r.ast).whereIsTautology).toBe(false);
  });

  it('reads HAVING and LIMIT as filters', () => {
    const h = sql('SELECT a FROM t GROUP BY a HAVING count(*) > 1');
    const l = sql('SELECT * FROM t LIMIT 10');
    expect(h.ok && l.ok).toBe(true);
    if (h.ok) expect(whereFacts(h.ast).hasHaving).toBe(true);
    if (l.ok) expect(whereFacts(l.ast).hasLimit).toBe(true);
  });
});

describe('hasTenantPredicate — projection is not a filter (site #5 defect)', () => {
  it('a projected tenant column is not a filter', () => {
    const r = sql('SELECT org_id FROM users');
    expect(r.ok).toBe(true);
    if (r.ok) expect(hasTenantPredicate(r.ast, TENANT)).toBe(false);
  });

  it('an INSERT column list is not a filter', () => {
    const r = sql('INSERT INTO users (org_id) VALUES (1)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(hasTenantPredicate(r.ast, TENANT)).toBe(false);
  });

  it('a WHERE comparison on a tenant column is a filter', () => {
    const r = sql('SELECT * FROM users WHERE org_id = ?');
    expect(r.ok).toBe(true);
    if (r.ok) expect(hasTenantPredicate(r.ast, TENANT)).toBe(true);
  });

  it('a WHERE IN on a tenant column is a filter', () => {
    const r = sql('SELECT * FROM users WHERE org_id IN (?, ?)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(hasTenantPredicate(r.ast, TENANT)).toBe(true);
  });

  it('a quoted-identifier comparison (knex/Postgres form) is a filter', () => {
    const r = sql('SELECT * FROM users WHERE "org_id" = ?');
    expect(r.ok).toBe(true);
    if (r.ok) expect(hasTenantPredicate(r.ast, TENANT)).toBe(true);
  });

  it('a non-tenant predicate is not a filter', () => {
    const r = sql('SELECT * FROM users WHERE name = ?');
    expect(r.ok).toBe(true);
    if (r.ok) expect(hasTenantPredicate(r.ast, TENANT)).toBe(false);
  });

  it('collects only predicate operands, not projections', () => {
    const r = sql('SELECT org_id, name FROM users WHERE name = ?');
    expect(r.ok).toBe(true);
    if (r.ok) expect(whereColumnRefs(r.ast)).toEqual(new Set(['name']));
  });
});

describe('write / upsert classification (sites #3, #6)', () => {
  it('classifies write statements', () => {
    for (const sql of ['INSERT INTO t (x) VALUES (1)', 'DELETE FROM t', 'UPDATE t SET x = 1', 'REPLACE INTO t (x) VALUES (1)']) {
      const r = parseSql(sql);
      expect(r.ok).toBe(true);
      if (r.ok) expect(isWriteStatement(r.ast)).toBe(true);
    }
  });

  it('does not classify SELECT as a write', () => {
    const r = sql('SELECT * FROM t');
    expect(r.ok).toBe(true);
    if (r.ok) expect(isWriteStatement(r.ast)).toBe(false);
  });

  it('only UPDATE is a mass write', () => {
    const u = sql('UPDATE t SET x = 1');
    const d = sql('DELETE FROM t');
    expect(u.ok && d.ok).toBe(true);
    if (u.ok) expect(isMassWriteStatement(u.ast)).toBe(true);
    if (d.ok) expect(isMassWriteStatement(d.ast)).toBe(false);
  });

  it('recognises upsert forms', () => {
    const repl = sql('REPLACE INTO t (x) VALUES (1)');
    const conflict = sql('INSERT OR IGNORE INTO t (x) VALUES (1)');
    expect(repl.ok && conflict.ok).toBe(true);
    if (repl.ok) expect(isUpsertStatement(repl.ast)).toBe(true);
    if (conflict.ok) expect(isUpsertStatement(conflict.ast)).toBe(true);
  });

  it('extracts insert columns', () => {
    const r = sql('INSERT INTO t (id, name) VALUES (1, \'x\')');
    expect(r.ok).toBe(true);
    if (r.ok) expect(insertColumns(r.ast)).toEqual(['id', 'name']);
  });
});

describe('DDL facts (sites #7–#10)', () => {
  it('recognises table DDL', () => {
    for (const sql of ['CREATE TABLE t (id int)', 'DROP TABLE t', 'ALTER TABLE t RENAME TO x']) {
      const r = parseSql(sql);
      expect(r.ok).toBe(true);
      if (r.ok) expect(isDdlStatement(r.ast)).toBe(true);
    }
  });

  it('does not recognise non-table CREATE as table DDL', () => {
    const r = sql('CREATE INDEX idx ON t (id)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(isDdlStatement(r.ast)).toBe(false);
  });

  it('extracts create-table columns without paren/quote tracking', () => {
    const r = sql('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, org_id TEXT)');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cols = ddlColumnDefinitions(r.ast);
      expect(cols.map(c => c.column)).toEqual(['id', 'name', 'org_id']);
      expect(cols[0].primaryKey).toBe(true);
      expect(cols[0].dataType).toBe('INTEGER');
    }
  });

  it('extracts ALTER ADD COLUMN', () => {
    const r = sql('ALTER TABLE t ADD COLUMN c TEXT');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cols = ddlColumnDefinitions(r.ast);
      expect(cols.map(c => c.column)).toEqual(['c']);
    }
  });

  it('extracts foreign-key constraints', () => {
    const r = sql('CREATE TABLE t (id int, org_id TEXT REFERENCES orgs(id))');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const fks = ddlForeignKeys(r.ast);
      expect(fks).toHaveLength(1);
      expect(fks[0].columns).toEqual(['org_id']);
      expect(fks[0].referencesTable).toBe('orgs');
      expect(fks[0].referencesColumns).toEqual(['id']);
    }
  });
});

describe('ON CONFLICT truncation (Spec 70 disposition)', () => {
  it('cuts at a top-level ON CONFLICT and keeps the prefix', () => {
    const { text, truncated } = truncateConflictClause(
      'INSERT INTO t (a) VALUES (1) ON CONFLICT(a) DO UPDATE SET a = 2',
    );
    expect(truncated).toBe(true);
    expect(text).toBe('INSERT INTO t (a) VALUES (1)');
  });

  it('returns the input unchanged when there is no conflict clause', () => {
    const { text, truncated } = truncateConflictClause('INSERT INTO t (a) VALUES (1)');
    expect(truncated).toBe(false);
    expect(text).toBe('INSERT INTO t (a) VALUES (1)');
  });

  it('does not cut ON CONFLICT inside a string literal', () => {
    const { truncated } = truncateConflictClause("INSERT INTO t (a) VALUES ('ON CONFLICT(x)')");
    expect(truncated).toBe(false);
  });

  it('does not cut ON CONFLICT inside a comment', () => {
    const { truncated } = truncateConflictClause(
      'INSERT INTO t (a) VALUES (1) -- ON CONFLICT(a) DO UPDATE',
    );
    expect(truncated).toBe(false);
  });

  it('does not cut ON CONFLICT inside a parenthesized subexpression', () => {
    const { truncated } = truncateConflictClause(
      'INSERT INTO t (a) VALUES ((SELECT 1 FROM x WHERE y = (ON CONFLICT(x))))',
    );
    expect(truncated).toBe(false);
  });

  it('flags the relation of a truncated statement through the tolerant program path', () => {
    const program = parseSqlProgramTolerant(
      'CREATE TABLE a (x int); INSERT INTO t (a) VALUES (1) ON CONFLICT(a) DO UPDATE SET a = 2;',
      'sqlite',
    );
    expect(program.failures).toEqual([]);
    const rels = collectTypedRelations(program.statements, new Set(program.truncatedConflictIndices));
    const insert = rels.find((r) => r.type === 'insert');
    expect(insert?.table).toBe('t');
    expect(insert?.conflictClauseTruncated).toBe(true);
    const create = rels.find((r) => r.type === 'create');
    expect(create?.conflictClauseTruncated).toBeUndefined();
  });

  it('reports no truncated indices when nothing was truncated', () => {
    const program = parseSqlProgramTolerant('INSERT INTO t (a) VALUES (1)', 'sqlite');
    expect(program.truncatedConflictIndices).toEqual([]);
  });
});
