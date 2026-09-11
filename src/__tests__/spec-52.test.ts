/**
 * Spec-52 — Findings From a Real Project Audit (Cloudflare D1/Workers).
 *
 * First feedback from an unseen codebase. Three defects, each with a
 * false-positive/true-positive two-direction proof:
 *
 *   R1 — loop-query treated `.prepare()`/`.bind()` (statement construction) as
 *        execution. Only eager methods (.run/.all/.first/.raw/.exec/.batch)
 *        are a query-in-loop; accumulate-then-batch is not N+1.
 *   R2 — the write classifier missed the four upsert forms (INSERT OR IGNORE /
 *        OR REPLACE INTO, REPLACE INTO, INSERT ... ON CONFLICT DO UPDATE).
 *   R3 — whole-program rules (written-never-read / read-never-written /
 *        no-validator-reachable / unknown-table) unsound under a scoped run.
 *
 * This file pins R1 and R2 at the unit level. R3 is pinned in
 * coverage.test.ts / pipeline tests via the `WHOLE_PROGRAM_RULES` suppression.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDataAccessAnalyzer } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { parseSqlTables, countQueries } from '../analyzers/universal/schema/codeAnalysis.js';
import { WHOLE_PROGRAM_RULES, scopedWholeProgramApplicability } from '../analyzers/applicability.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(__dirname, 'fixtures', 'spec-52', name);

let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not found');
});

async function loopQueryCount(fileName: string): Promise<number> {
  const sourceCode = await readFile(fixture(fileName), 'utf-8');
  const ast = parseFile(fixture(fileName), sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${fileName}`);
  const analyzer = new UniversalDataAccessAnalyzer();
  const violations = await (analyzer as any).analyzeAST(ast, tsAdapter, {}, sourceCode);
  return violations.filter((v: { rule: string }) => v.rule === 'loop-query').length;
}

// ═══════════════════════════════════════════════════════════════════════════
// R1 — loop-query: prepare/bind is construction, not execution
// ═══════════════════════════════════════════════════════════════════════════

describe('Spec-52 R1 — loop-query prepare/bind false positives', () => {
  it('item 1: db.prepare() in loop, .batch() after → 0 loop-query (mod.ts shape)', async () => {
    expect(await loopQueryCount('item-01-prepare-in-loop.ts')).toBe(0);
  });

  it('item 2: accumulate-then-batch (prepare().bind() in loop, batch after) → 0 loop-query', async () => {
    expect(await loopQueryCount('item-02-prepare-bind-accumulate-batch.ts')).toBe(0);
  });

  it('item 3: db.exec() in loop → loop-query fires (eager member method, genuine N+1)', async () => {
    expect(await loopQueryCount('item-03-exec-in-loop.ts')).toBeGreaterThan(0);
  });

  it('item 4: storage.sql.exec() in loop → loop-query fires (Leaderboard.ts:113 positive)', async () => {
    expect(await loopQueryCount('item-04-storage-sql-exec-in-loop.ts')).toBeGreaterThan(0);
  });

  it('item 6: chained db.prepare().bind().run() in loop → loop-query fires (genuine N+1, eager .run() in loop)', async () => {
    expect(await loopQueryCount('item-06-chained-prepare-run-in-loop.ts')).toBeGreaterThan(0);
  });

  it('item 7: chained db.prepare().bind().first<Row>() in loop → loop-query fires (typed-read N+1, generics must not hide the eager method)', async () => {
    expect(await loopQueryCount('item-07-chained-prepare-bind-first-in-loop.ts')).toBeGreaterThan(0);
  });

  it('item 8: Promise.all([db.prepare().bind(), …]) in loop → 0 loop-query (Promise.all is not the eager D1 .all())', async () => {
    expect(await loopQueryCount('item-08-promise-all-of-statements-in-loop.ts')).toBe(0);
  });

  it('item 9: Promise.all(rows.map(r => db.prepare().bind(r))) in loop → 0 loop-query (crosses the arrow fn, still a combinator)', async () => {
    expect(await loopQueryCount('item-09-promise-all-map-of-statements-in-loop.ts')).toBe(0);
  });

  it('item 10: Promise.all(rows.map(r => db.prepare().bind(r).all())) in loop → loop-query fires (eager .all() per row is genuine N+1)', async () => {
    expect(await loopQueryCount('item-10-promise-all-map-of-eager-all-in-loop.ts')).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1 — too-many-queries: prepare() is not a query
// ═══════════════════════════════════════════════════════════════════════════

describe('Spec-52 R1 — too-many-queries no longer counts prepare()', () => {
  it('a prepare-only statement factory issues 0 queries', () => {
    const body = [
      'function makeStatements(db: any) {',
      '  return {',
      '    a: db.prepare("SELECT * FROM a"),',
      '    b: db.prepare("SELECT * FROM b"),',
      '    c: db.prepare("SELECT * FROM c"),',
      '    d: db.prepare("SELECT * FROM d"),',
      '    e: db.prepare("SELECT * FROM e"),',
      '    f: db.prepare("SELECT * FROM f"),',
      '  };',
      '}',
    ].join('\n');
    expect(countQueries(body)).toBe(0);
  });

  it('a raw .query() call still counts as one query', () => {
    expect(countQueries('db.query("SELECT * FROM users")')).toBe(1);
  });

  it('standalone SQL keywords still count (no DB call wrapper)', () => {
    expect(countQueries('const q = "SELECT * FROM users"')).toBe(1);
  });

  it('a chained prepare().run() counts one query (eager .run() executes it)', () => {
    expect(countQueries('const row = db.prepare("SELECT * FROM users").bind(1).run()')).toBe(1);
  });

  it('accumulate-then-batch counts one query (a single .batch() executes all)', () => {
    const body = [
      'const stmts = [];',
      'for (const id of ids) stmts.push(db.prepare("SELECT * FROM t WHERE id = ?").bind(id));',
      'return db.batch(stmts);',
    ].join('\n');
    expect(countQueries(body)).toBe(1);
  });

  it('Promise.all() is not counted as a query', () => {
    expect(countQueries('await Promise.all([a, b, c])')).toBe(0);
  });

  it('an eager db.all() counts one query (distinct from Promise.all)', () => {
    expect(countQueries('const rows = db.all("SELECT * FROM users")')).toBe(1);
  });

  it('regex.exec() is not counted as a query', () => {
    expect(countQueries('const m = /SELECT\\s+/.exec(text)')).toBe(0);
  });

  it('db.exec("SELECT …") still counts via its bare SQL keyword', () => {
    expect(countQueries('db.exec("SELECT * FROM users")')).toBe(1);
  });

  it('a typed .first<Row>() counts one query (D1 generic form)', () => {
    expect(countQueries('const row = db.prepare("SELECT * FROM users").first<{ id: number }>()')).toBe(1);
  });

  it('a typed .all<Row>() with a nested generic counts one query', () => {
    expect(countQueries('const rows = db.all<Pick<User, "id" | "name">>()')).toBe(1);
  });

  it('a prefixed method name (e.g. .allowing / .batchInsert) is not matched', () => {
    expect(countQueries('db.allowing("x"); db.batchInsert([a, b])')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1 — countQueries eager-method edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('Spec-52 R1 — countQueries edge cases', () => {
  it('optional chaining on the receiver (db?.all) counts one query', () => {
    expect(countQueries('const rows = db?.all("SELECT * FROM users")')).toBe(1);
  });

  it('optional chaining before an eager call (prepare()?.run()) counts one query', () => {
    expect(countQueries('db.prepare("SELECT * FROM users")?.run()')).toBe(1);
  });

  it('a nested-paren SQL body is stripped once, not double-counted', () => {
    const sql = 'db.query("SELECT count(*) FROM t WHERE id IN (SELECT id FROM u)")';
    expect(countQueries(sql)).toBe(1);
  });

  it('Promise.all wrapping eager calls counts the inner calls, not the Promise.all', () => {
    expect(countQueries('await Promise.all([db.run("SELECT a"), db.run("SELECT b")])')).toBe(2);
  });

  it('db.prepare("SQL").all() counts one query (D1 read idiom, SQL lives in prepare)', () => {
    expect(countQueries('db.prepare("SELECT * FROM users").all()')).toBe(1);
  });

  it('db.batch([db.prepare("A"), db.prepare("B")]) counts one query (nested prepares are not queries)', () => {
    expect(countQueries('db.batch([db.prepare("SELECT a"), db.prepare("SELECT b")])')).toBe(1);
  });

  it('.firstWhere() / .runner() are not matched as eager methods', () => {
    expect(countQueries('db.firstWhere({ id: 1 }); db.runner()')).toBe(0);
  });

  it('child_process.exec() is not counted as a query', () => {
    expect(countQueries('require("child_process").exec("ls -la")')).toBe(0);
  });

  it('Promise.all<T>() generic form is still excluded', () => {
    expect(countQueries('await Promise.all<Foo>([a, b])')).toBe(0);
  });

  it('.all<Array<{ id: number }>>() with a nested generic counts one query', () => {
    expect(countQueries('const rows = db.all<Array<{ id: number }>>()')).toBe(1);
  });

  it('bare SQL keywords are matched case-insensitively', () => {
    expect(countQueries('const q = "select * from users"')).toBe(1);
  });

  it('.raw("SELECT …") counts one query (SQL body stripped, not double-counted)', () => {
    expect(countQueries('db.raw("SELECT * FROM users")')).toBe(1);
  });

  it('INSERT ... ON CONFLICT ... DO UPDATE counts one query (the DO UPDATE clause is not a separate query)', () => {
    const sql = 'INSERT INTO feature_flags (key, enabled) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled';
    expect(countQueries(sql)).toBe(1);
  });

  it('INSERT ... ON CONFLICT ... DO NOTHING counts one query', () => {
    expect(countQueries('INSERT INTO feature_flags (key) VALUES (?) ON CONFLICT (key) DO NOTHING')).toBe(1);
  });

  it('a standalone UPDATE string still counts one query (lookbehind must not over-suppress)', () => {
    expect(countQueries('"UPDATE users SET name = ?"')).toBe(1);
  });

  it('INSERT ... ON DUPLICATE KEY UPDATE counts one query (the KEY UPDATE clause is not a separate query)', () => {
    const sql = 'INSERT INTO users (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)';
    expect(countQueries(sql)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R2 — the four upsert forms are classified as writes
// ═══════════════════════════════════════════════════════════════════════════

describe('Spec-52 R2 — upsert write classification', () => {
  const FORMS: Array<{ name: string; sql: string }> = [
    { name: 'INSERT OR IGNORE INTO', sql: 'INSERT OR IGNORE INTO feature_flags (key, enabled) VALUES (?, ?)' },
    { name: 'INSERT OR REPLACE INTO', sql: 'INSERT OR REPLACE INTO feature_flags (key, enabled) VALUES (?, ?)' },
    { name: 'REPLACE INTO', sql: 'REPLACE INTO feature_flags (key, enabled) VALUES (?, ?)' },
    { name: 'INSERT ... ON CONFLICT ... DO UPDATE', sql: 'INSERT INTO feature_flags (key, enabled) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled' },
  ];

  for (const form of FORMS) {
    it(`${form.name} extracts feature_flags as type 'insert'`, () => {
      const refs = parseSqlTables(form.sql, { line: 1, column: 1 }, form.sql);
      const inserts = refs.filter((r) => r.table === 'feature_flags' && r.type === 'insert');
      expect(inserts.length, `expected "${form.name}" to be an insert write`).toBe(1);
    });
  }

  it('REPLACE() string function is NOT read as a REPLACE INTO write', () => {
    const sql = 'SELECT REPLACE(name, "a", "b") AS clean FROM users';
    const refs = parseSqlTables(sql, { line: 1, column: 1 }, sql);
    const inserts = refs.filter((r) => r.type === 'insert');
    expect(inserts.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R2 — upsert classifier edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('Spec-52 R2 — upsert classifier edge cases', () => {
  const CASE_INSENSITIVE: Array<{ name: string; sql: string }> = [
    { name: 'lowercase insert or ignore into', sql: 'insert or ignore into feature_flags (key) values (?)' },
    { name: 'lowercase insert or replace into', sql: 'insert or replace into feature_flags (key) values (?)' },
    { name: 'lowercase replace into', sql: 'replace into feature_flags (key) values (?)' },
    { name: 'mixed-case INSERT Or Ignore INTO', sql: 'INSERT Or Ignore INTO feature_flags (key) values (?)' },
  ];

  for (const form of CASE_INSENSITIVE) {
    it(`${form.name} → type 'insert'`, () => {
      const refs = parseSqlTables(form.sql, { line: 1, column: 1 }, form.sql);
      expect(refs.filter((r) => r.table === 'feature_flags' && r.type === 'insert').length).toBe(1);
    });
  }

  it('backtick-quoted table in INSERT OR IGNORE → type insert', () => {
    const sql = 'INSERT OR IGNORE INTO `feature_flags` (`key`) VALUES (?)';
    const refs = parseSqlTables(sql, { line: 1, column: 1 }, sql);
    expect(refs.filter((r) => r.table === 'feature_flags' && r.type === 'insert').length).toBe(1);
  });

  it('double-quoted table in REPLACE INTO → type insert', () => {
    const sql = 'REPLACE INTO "feature_flags" (key) VALUES (?)';
    const refs = parseSqlTables(sql, { line: 1, column: 1 }, sql);
    expect(refs.filter((r) => r.table === 'feature_flags' && r.type === 'insert').length).toBe(1);
  });

  it('ON CONFLICT ... DO NOTHING is still an insert write', () => {
    const sql = 'INSERT INTO feature_flags (key) VALUES (?) ON CONFLICT (key) DO NOTHING';
    const refs = parseSqlTables(sql, { line: 1, column: 1 }, sql);
    expect(refs.filter((r) => r.table === 'feature_flags' && r.type === 'insert').length).toBe(1);
  });

  it('plain INSERT INTO (no upsert) regression → type insert', () => {
    const sql = 'INSERT INTO feature_flags (key) VALUES (?)';
    const refs = parseSqlTables(sql, { line: 1, column: 1 }, sql);
    expect(refs.filter((r) => r.table === 'feature_flags' && r.type === 'insert').length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R3 — whole-program rules unsound under a scoped run
// ═══════════════════════════════════════════════════════════════════════════

describe('Spec-52 R3 — whole-program rule suppression under scoped runs', () => {
  it('enumerates exactly the whole-program rules (dependency-graph rules short-circuit in their own reducer)', () => {
    expect([...WHOLE_PROGRAM_RULES].sort()).toEqual([
      'cross-domain/no-validator-reachable',
      'cross-domain/read-never-written',
      'cross-domain/written-never-read',
      'unknown-table',
    ]);
  });

  it('suppresses whole-program rules on a scoped run with a scope-naming reason', () => {
    const app = scopedWholeProgramApplicability(true, 7);
    expect(app.size).toBe(4);
    for (const ruleId of WHOLE_PROGRAM_RULES) {
      const verdict = app.get(ruleId)!;
      expect(verdict.applicable).toBe(false);
      expect(verdict.kind).toBe('notApplicable');
      expect(verdict.reason).toContain('scoped to 7 file(s)');
    }
  });

  it('does not suppress whole-program rules on a full run', () => {
    expect(scopedWholeProgramApplicability(false, 7).size).toBe(0);
  });
});
