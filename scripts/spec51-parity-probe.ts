/**
 * Spec 51 parity probe — prove, don't assume, that the two SQLite backends
 * behave identically through the shared `SqliteDatabase` interface.
 *
 * Drives `NodeSqliteDatabase` and `BetterSqlite3Database` through the same
 * battery and asserts the serialized results are byte-identical on everything
 * the codebase can actually produce. Two known, unreachable divergences are
 * probed separately and printed as DOCUMENTED notes rather than failures:
 *
 *   - reading an INTEGER column > 2^53 (node:sqlite throws RangeError; the
 *     schema never stores such a value — no nanosecond timestamps, no BigInt
 *     producers, all ids are AUTOINCREMENT)
 *   - error-`code` specificity (node:sqlite maps primary codes, e.g.
 *     SQLITE_CONSTRAINT; better-sqlite3 uses extended codes like
 *     SQLITE_CONSTRAINT_FOREIGNKEY — no code branches on anything but BUSY)
 *
 * Usage: npx tsx scripts/spec51-parity-probe.ts   (exit 0 iff reachable parity holds)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDatabase } from '../src/sqlite/nodeSqlite.js';
import { BetterSqlite3Database } from '../src/sqlite/betterSqlite3.js';
import type { OpenSqliteOptions, SqliteDatabase } from '../src/sqlite/types.js';

const opts: OpenSqliteOptions = { timeoutMs: 5000 };

const ser = (v: unknown): string =>
  JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? `${val.toString()}n` : val));

// Reachable battery — small integers only.
function battery(db: SqliteDatabase): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, count INTEGER)');
  db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT)');
  db.exec('CREATE TABLE child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))');

  // 1. @name leading-object bind.
  out.named = db.prepare('SELECT @name AS n, @count AS c').get({ name: 'x', count: 5 });

  // 2. subset binding: full-row object with keys the SQL never references.
  const r1 = db
    .prepare('INSERT INTO t(name, count) VALUES (@name, @count)')
    .run({ name: 'a', count: 1, extra: 'unused', another: 99 });
  out.smallLastIdType = typeof r1.lastInsertRowid;
  out.smallLastId = r1.lastInsertRowid;
  out.smallChanges = r1.changes;

  // 3. deferred transaction commits and returns fn's return value.
  const txn = db.transaction((n: number) => {
    db.prepare('INSERT INTO t(name, count) VALUES (?, ?)').run('tx', n);
    return 'ret:' + n;
  });
  out.txnReturn = txn(7);

  // 4. immediate transaction: `.immediate` runs (not a factory).
  const txnImm = db.transaction((n: number) => {
    db.prepare('INSERT INTO t(name, count) VALUES (?, ?)').run('imm', n);
    return 'imm:' + n;
  });
  out.txnImmReturn = txnImm.immediate(8);

  // 5. rollback on throw.
  const before = Number(db.prepare('SELECT COUNT(*) AS c FROM t').get().c);
  const txnBoom = db.transaction(() => {
    db.prepare('INSERT INTO t(name, count) VALUES (?, ?)').run('boom', 1);
    throw new Error('boom');
  });
  let threw = false;
  try {
    txnBoom();
  } catch {
    threw = true;
  }
  const after = Number(db.prepare('SELECT COUNT(*) AS c FROM t').get().c);
  out.rollback = { threw, before, after };

  // 6. pragma SET effectiveness.
  db.pragma('journal_mode = WAL');
  out.journalMode = db.prepare('PRAGMA journal_mode').get();

  // 7. pragma foreign_keys=ON + normalized constraint code.
  db.pragma('foreign_keys = ON');
  let fkCode: unknown;
  try {
    db.prepare('INSERT INTO child(pid) VALUES (999)').run();
  } catch (e) {
    fkCode = (e as { code?: unknown }).code;
  }
  out.fkCode = fkCode;

  // 8. all() with named + subset bind (name only — avoids the big-int probe row).
  const rows = db.prepare('SELECT name FROM t WHERE count >= @min ORDER BY name').all({ min: 1, extra: true });
  out.allCount = rows.length;
  out.allFirst = (rows as unknown[])[0];

  return out;
}

// lastInsertRowid type at the >2^53 boundary (unreachable via AUTOINCREMENT,
// probed only to prove the call sites' `Number()` wrap is safe).
function lastIdBoundary(Ctor: (p: string, o: OpenSqliteOptions) => SqliteDatabase, path: string): Record<string, unknown> {
  const db = Ctor(path, opts);
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, x INTEGER)');
  const small = db.prepare('INSERT INTO t(x) VALUES (?)').run(1);
  const big = db.prepare('INSERT INTO t(id, x) VALUES (?, ?)').run(9007199254740993n, 2);
  db.close();
  return {
    smallType: typeof small.lastInsertRowid,
    small: small.lastInsertRowid,
    bigType: typeof big.lastInsertRowid,
    big: big.lastInsertRowid,
    bigViaNumber: Number(big.lastInsertRowid), // what the call sites actually do
  };
}

// Busy-error normalization: two connections, zero busy timeout.
function busyProbe(Ctor: (p: string, o: OpenSqliteOptions) => SqliteDatabase, path: string): Record<string, unknown> {
  const a = Ctor(path, { timeoutMs: 0 });
  const b = Ctor(path, { timeoutMs: 0 });
  a.exec('CREATE TABLE IF NOT EXISTS t(x)');
  a.exec('BEGIN IMMEDIATE');
  let code: unknown;
  let name: unknown;
  try {
    b.exec('BEGIN IMMEDIATE');
  } catch (e) {
    code = (e as { code?: unknown }).code;
    name = (e as { name?: unknown }).name;
  }
  a.close();
  b.close();
  return { busyCode: code, busyName: name };
}

// >2^53 INTEGER column READ — the one divergence, characterized explicitly.
function bigColumnRead(Ctor: (p: string, o: OpenSqliteOptions) => SqliteDatabase, path: string): Record<string, unknown> {
  const db = Ctor(path, opts);
  db.exec('CREATE TABLE t(id INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(9007199254740993n);
  let result: unknown;
  let error: unknown;
  try {
    const r = db.prepare('SELECT id FROM t').get();
    result = { type: typeof (r as { id: unknown }).id, value: (r as { id: unknown }).id };
  } catch (e) {
    error = `${(e as { code?: string }).code}: ${(e as Error).message.slice(0, 55)}`;
  }
  db.close();
  return { result, error };
}

const dir = mkdtempSync(join(tmpdir(), 'ca-spec51-parity-'));
const na = battery(new NodeSqliteDatabase(join(dir, 'a.db'), opts));
const ba = battery(new BetterSqlite3Database(join(dir, 'b.db'), opts));
const nBusy = busyProbe((p, o) => new NodeSqliteDatabase(p, o), join(dir, 'busy-a.db'));
const bBusy = busyProbe((p, o) => new BetterSqlite3Database(p, o), join(dir, 'busy-b.db'));

let ok = true;
console.log('Reachable behavior parity (must be SAME):');
const COSMETIC = new Set(['fkCode']); // primary vs extended error code string — unbranched
for (const key of Object.keys(na)) {
  const n = ser(na[key]);
  const b = ser(ba[key]);
  const same = n === b;
  if (!same && !COSMETIC.has(key)) ok = false;
  console.log(`  ${same ? 'SAME' : COSMETIC.has(key) ? 'COSMETIC' : 'DIFF'}  ${key}`);
  if (!same) {
    console.log(`       node-sqlite    : ${n}`);
    console.log(`       better-sqlite3 : ${b}`);
  }
}
const nb = ser(nBusy);
const bb = ser(bBusy);
const busySame = nb === bb;
if (!busySame) ok = false;
console.log(`  ${busySame ? 'SAME' : 'DIFF'}  busy-error normalization`);
if (!busySame) {
  console.log(`       node-sqlite    : ${nb}`);
  console.log(`       better-sqlite3 : ${bb}`);
}

console.log('\nDocumented divergences (unreachable in the schema):');
const nBig = bigColumnRead((p, o) => new NodeSqliteDatabase(p, o), join(dir, 'big-a.db'));
const bBig = bigColumnRead((p, o) => new BetterSqlite3Database(p, o), join(dir, 'big-b.db'));
console.log(`  >2^53 INTEGER column read`);
console.log(`       node-sqlite    : ${ser(nBig)}`);
console.log(`       better-sqlite3 : ${ser(bBig)}`);

console.log('\nlastInsertRowid boundary (call sites wrap in Number()):');
console.log(`  node-sqlite    : ${ser(lastIdBoundary((p, o) => new NodeSqliteDatabase(p, o), join(dir, 'lid-a.db')))}`);
console.log(`  better-sqlite3 : ${ser(lastIdBoundary((p, o) => new BetterSqlite3Database(p, o), join(dir, 'lid-b.db')))}`);

rmSync(dir, { recursive: true, force: true });

console.log(ok ? '\nPARITY: reachable behavior identical' : '\nPARITY: REACHABLE DIVERGENCE DETECTED');
process.exit(ok ? 0 : 1);
