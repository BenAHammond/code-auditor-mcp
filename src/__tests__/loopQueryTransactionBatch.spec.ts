/**
 * §13.1 — loop-query transaction-batching discriminator.
 *
 * A prepared statement executed inside a loop that a single `db.transaction(fn)`
 * callback encloses is *already batched*: better-sqlite3 defers every write in
 * the callback to one commit, which is exactly the "batch the queries"
 * remediation the finding prescribes, so flagging it as an N+1 is a false
 * positive.
 *
 * The discriminator is structural, not a name list. It suppresses only when BOTH
 * hold:
 *   (1) the transaction encloses the loop — lexically, or via a function the
 *       file invokes inside the callback (`db.transaction(insertAll)` /
 *       `db.transaction(() => insertOne(…))`);
 *   (2) the statement is prepared *outside* the loop. A loop that still calls
 *       `.prepare(...)` per iteration re-prepares every pass and remains a
 *       genuine N+1 even under the enclosing transaction, so it keeps firing.
 *
 * Must-fire controls pin that (a) prepare-inside-loop with no transaction fires,
 * and (b) a transaction-wrapped helper that re-prepares per iteration still
 * fires — the discriminator is scoped to the prepare-once-plus-transaction shape,
 * not "any loop that touches a transaction".
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tsAdapter: LanguageAdapter;
let analyzer: UniversalDataAccessAnalyzer;
let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDataAccessAnalyzer();
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-loop-txn-'));
}, 30_000);

async function loopQueryViolations(code: string, name: string): Promise<any[]> {
  const filePath = join(tmpDir, `${name}.ts`);
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  const vs = (await (analyzer as any).analyzeAST(ast, tsAdapter, { ...DEFAULT_DATA_ACCESS_CONFIG, dialect: 'sqlite' }, sourceCode)) as any[];
  return vs.filter((v) => v.rule === 'loop-query');
}

describe('loop-query transaction-batching discriminator', () => {
  it('suppresses a prepare-once statement run inside an inline transaction', async () => {
    const code = `const db: D1Database = getDb();

function sync(rows: Array<{ id: string; name: string }>) {
  const stmt = db.prepare('UPDATE t SET name = ? WHERE id = ?');
  db.transaction(() => {
    for (const row of rows) {
      stmt.run(row.name, row.id);
    }
  })();
}
`;
    expect((await loopQueryViolations(code, 'inline-prepare-once')).length).toBe(0);
  });

  it('suppresses a helper handed straight to transaction whose loop reuses one statement', async () => {
    // The `rawDb.transaction(insertAll)` reducer shape: the helper prepares once
    // (outside its loop) and is invoked as the transaction callback itself.
    const code = `const db: D1Database = getDb();

function insertAll(rows: Array<{ id: string; name: string }>) {
  const stmt = db.prepare('INSERT INTO t (id, name) VALUES (?, ?)');
  for (const row of rows) {
    stmt.run(row.id, row.name);
  }
}

function run(rows: Array<{ id: string; name: string }>) {
  db.transaction(insertAll)(rows);
}
`;
    expect((await loopQueryViolations(code, 'free-fn-ref-prepare-once')).length).toBe(0);
  });

  it('suppresses a helper called inside the transaction callback whose loop reuses one statement', async () => {
    // The `rawDb.transaction(() => insertOne(...))` shape: the helper's internal
    // loop runs a statement prepared outside it, and the call sits in the callback.
    const code = `const db: D1Database = getDb();

const stmt = db.prepare('INSERT INTO t (id, name) VALUES (?, ?)');

function insertOne(row: { id: string; name: string }) {
  for (const part of row.name.split(',')) {
    stmt.run(row.id, part);
  }
}

function run(rows: Array<{ id: string; name: string }>) {
  db.transaction(() => {
    for (const row of rows) {
      insertOne(row);
    }
  })();
}
`;
    expect((await loopQueryViolations(code, 'callback-call-prepare-once')).length).toBe(0);
  });

  it('still fires a prepare-inside-loop with no transaction (removeStaleFunctionRows shape)', async () => {
    const code = `const db: D1Database = getDb();

function removeStale(ids: number[]) {
  for (const id of ids) {
    db.prepare('DELETE FROM t WHERE id = ?').run(id);
  }
}
`;
    expect((await loopQueryViolations(code, 'prepare-inside-loop-no-txn')).length).toBeGreaterThanOrEqual(1);
  });

  it('still fires a transaction-wrapped helper that re-prepares per iteration', async () => {
    // The helper is invoked inside a transaction callback, but its statement is
    // NOT prepared outside the loop — the discriminator's second condition fails,
    // so the genuine N+1 still fires.
    const code = `const db: D1Database = getDb();

function helper(rows: Array<{ id: number }>) {
  for (const row of rows) {
    db.prepare('DELETE FROM t WHERE id = ?').run(row.id);
  }
}

function run(rows: Array<{ id: number }>) {
  db.transaction(() => { helper(rows); })();
}
`;
    expect((await loopQueryViolations(code, 'callback-call-prepare-inside')).length).toBeGreaterThanOrEqual(1);
  });

  it('still fires a helper handed straight to transaction that re-prepares per iteration', async () => {
    const code = `const db: D1Database = getDb();

function helper(rows: Array<{ id: number }>) {
  for (const row of rows) {
    db.prepare('DELETE FROM t WHERE id = ?').run(row.id);
  }
}

function run(rows: Array<{ id: number }>) {
  db.transaction(helper)(rows);
}
`;
    expect((await loopQueryViolations(code, 'free-fn-ref-prepare-inside')).length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Block 3 — loop-query: fire on prepare-in-loop, not hoisted re-run.
 *
 * A statement prepared *outside* a loop and re-run inside it (`const stmt =
 * db.prepare(…); for (…) stmt.run(x)`) is the "batch via one prepared statement"
 * remediation the loop-query finding prescribes, so flagging it is a false
 * positive — even when there is no enclosing transaction. This is the same
 * prepare-once shape the transaction discriminator suppresses, generalized: the
 * signal is the *absence of a SQL string argument* on the eager call. A direct
 * connection call (`db.exec("…")`, `db.query("…")`, `indexHandle.query("…")`)
 * carries SQL inline and still fires; a statement re-run carries only bound
 * parameters and does not.
 */
describe('loop-query hoisted-reuse discriminator (no transaction)', () => {
  it('suppresses a statement prepared outside the loop and re-run with bound params', async () => {
    const code = `const db: D1Database = getDb();

function sync(rows: Array<{ id: string }>) {
  const stmt = db.prepare('DELETE FROM t WHERE id = ?');
  for (const row of rows) {
    stmt.run(row.id);
  }
}
`;
    expect((await loopQueryViolations(code, 'hoisted-stmt-run')).length).toBe(0);
  });

  it('suppresses a hoisted statement re-run via .bind(x).run()', async () => {
    const code = `const db: D1Database = getDb();

function sync(rows: Array<{ id: string }>) {
  const stmt = db.prepare('DELETE FROM t WHERE id = ?');
  for (const row of rows) {
    stmt.bind(row.id).run();
  }
}
`;
    expect((await loopQueryViolations(code, 'hoisted-stmt-bind-run')).length).toBe(0);
  });

  it('still fires a direct connection call with inline SQL (db.exec)', async () => {
    const code = `const db: D1Database = getDb();

function sync(rows: Array<{ id: string }>) {
  for (const row of rows) {
    db.exec('INSERT INTO t (id) VALUES (?)', row.id);
  }
}
`;
    expect((await loopQueryViolations(code, 'direct-exec-in-loop')).length).toBeGreaterThanOrEqual(1);
  });

  it('still fires a direct connection call with inline SQL (db.query)', async () => {
    const code = `const db: D1Database = getDb();

function sync(ids: Array<number>) {
  for (const id of ids) {
    db.query('SELECT name FROM t WHERE id = ?', [id]);
  }
}
`;
    expect((await loopQueryViolations(code, 'direct-query-in-loop')).length).toBeGreaterThanOrEqual(1);
  });

  it('still fires a per-iteration prepare with no transaction', async () => {
    const code = `const db: D1Database = getDb();

function sync(rows: Array<{ id: string }>) {
  for (const row of rows) {
    db.prepare('DELETE FROM t WHERE id = ?').run(row.id);
  }
}
`;
    expect((await loopQueryViolations(code, 'prepare-in-loop-no-txn-2')).length).toBeGreaterThanOrEqual(1);
  });

  it('still fires a DB-provenanced helper function called per iteration (no hoisted statement)', async () => {
    // The discriminator suppresses only a *member-expression* statement re-run
    // (`stmt.run(x)`), not a bare helper call. `resolveHero(db, slug)` issues its
    // query inside its own body, so calling it per iteration is a genuine N+1 that
    // must keep firing — this is the regression guard for the member-expression
    // requirement (a DB-provenanced function call has no `.method` callee).
    const code = `const db: D1Database = getDb();

async function resolveHero(db: D1Database, slug: string) {
  return db.prepare('SELECT id FROM heroes WHERE slug = ?1 LIMIT 1').bind(slug).first();
}

async function sync(slugs: Array<string>) {
  for (const slug of slugs) {
    await resolveHero(db, slug);
  }
}
`;
    expect((await loopQueryViolations(code, 'helper-per-iteration')).length).toBeGreaterThanOrEqual(1);
  });
});
