/**
 * Spec 51 fork test — prove, don't assume, that a backend's database fds carry
 * O_CLOEXEC and therefore do NOT leak into an exec'd child.
 *
 * The shard worker (`mcpAuditJobs.ts` `fork()`) and `--detach` (`cli.ts`
 * `spawn(process.execPath, …)`) both exec a fresh node process. If a driver
 * opened its db / -wal / -shm files without close-on-exec, every forked shard
 * would inherit a live duplicate of the parent's database fds — holding SQLite
 * locks across processes and failing intermittently under concurrency, exactly
 * the class of bug reading alone cannot confirm or deny. This script confirms
 * the fds are closed at the exec() boundary for BOTH backends.
 *
 * Exit 0 iff neither backend's db/-wal/-shm fd is visible in the exec'd child.
 *
 * Usage: node scripts/spec51-fork-test.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import BetterSqlite3 from 'better-sqlite3';

// The child, exec'd with its own argv, prints every open path it can see.
// macOS: lsof (readlink on /dev/fd fails with EINVAL — its entries aren't
// symlinks). Linux: readlink of /proc/self/fd. Either way the child returns the
// set of paths its process has open, which is where a leaked O_CLOEXEC-less db
// fd would appear.
const CHILD = `
const { execFileSync } = require('node:child_process');
const { readdirSync, readlinkSync } = require('node:fs');
const { join } = require('node:path');
let out = [];
try {
  if (process.platform === 'linux') {
    for (const n of readdirSync('/proc/self/fd')) {
      try { out.push(readlinkSync(join('/proc/self/fd', n))); } catch {}
    }
  } else {
    const r = execFileSync('lsof', ['-p', String(process.pid), '-Fn'], { encoding: 'utf8' });
    for (const line of r.split('\\n')) if (line.startsWith('n/')) out.push(line.slice(1));
  }
} catch (e) { out.push('ENUM_ERR:' + e.message); }
console.log(JSON.stringify(out));
`;

function childFdTargets() {
  return JSON.parse(execFileSync(process.execPath, ['-e', CHILD], { encoding: 'utf8' }));
}

function openAndUse(Db, path, opts) {
  const db = new Db(path, opts);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS t(x INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(42);
  db.prepare('SELECT x FROM t').get();
  return db;
}

const dir = mkdtempSync(join(tmpdir(), 'ca-spec51-fork-'));
const nodePath = join(dir, 'node.db');
const bsPath = join(dir, 'bs.db');

const nodeDb = openAndUse(DatabaseSync, nodePath, {});
const bsDb = openAndUse(BetterSqlite3, bsPath, {});

const inherited = childFdTargets();

// Sensitivity guard: the child always inherits its own stdio pipes (fd 0/1/2 are
// exec'd without O_CLOEXEC by design), so an empty enumeration means the probe is
// broken, not that there is nothing to see. A leaked db fd is only meaningful to
// assert absent against a non-empty fd table.
const childFdCount = inherited.length;

// A leaked fd resolves to the db file itself, its -wal, or its -shm sibling.
const base = (p) => {
  const t = inherited.filter((f) => f === p || f === p + '-wal' || f === p + '-shm');
  return t;
};

const nodeLeak = base(nodePath);
const bsLeak = base(bsPath);

nodeDb.close();
bsDb.close();
rmSync(dir, { recursive: true, force: true });

let ok = true;
console.log('Exec-boundary fd inheritance (must be NONE):');
if (childFdCount === 0) {
  ok = false;
  console.log('  BROKEN  child enumerated zero fds — probe failed to read /dev/fd');
}
console.log(`  (child inherited ${childFdCount} fd(s): its own stdio pipes)`);
for (const [label, leak, path] of [
  ['node:sqlite   ', nodeLeak, nodePath],
  ['better-sqlite3', bsLeak, bsPath],
]) {
  if (leak.length === 0) {
    console.log(`  NONE  ${label} (db/-wal/-shm closed at exec)`);
  } else {
    ok = false;
    console.log(`  LEAK  ${label} → ${leak.join(', ')}`);
  }
}

console.log(ok ? '\nFORK: no fd leaks across exec for either backend' : '\nFORK: FD LEAK DETECTED');
process.exit(ok ? 0 : 1);
