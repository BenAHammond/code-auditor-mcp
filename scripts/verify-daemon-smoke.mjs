#!/usr/bin/env node
/**
 * verify-daemon-smoke.mjs — the 14th release gate: a live daemon up against a
 * fixture, every command the hook and skill invoke, exit codes and real
 * summaries asserted.
 *
 * The specific defect this gate pins shut: `code-audit changed` against a *ready*
 * daemon used to
 * crash (exit 1 — "broken hook" by the hook's own contract) because the daemon
 * fast-path returned a result with no `summary`, so `result.summary.dismissed`
 * threw on every `.ts` edit. `verify:dist` proves the tarball installs; it never
 * started a daemon and ran the shipped commands, which is how that crash sat
 * undetected in the hook's primary path.
 *
 * Shape of this gate:
 *   1. copy `tests/fixtures/corpus/d1-workers` to a throwaway temp project (the
 *      same corpus the Spec 52 report audited — SQL + data access + a sqlite
 *      dialect, the exact surface where the fast-path crash lived);
 *   2. start the real daemon (`dist/daemon/main.js --foreground`) against it,
 *      scoped to a throwaway cache dir so nothing touches the user's cache;
 *   3. wait for the daemon to reach `ready`;
 *   4. run every command the hook and skill invoke, asserting the exit code is
 *      the contract's value (0 clean / 2 blocking for `changed`, never 1) and
 *      that a real summary comes back (parseable JSON with the expected shape,
 *      or the command's summary header on the terminal path);
 *   5. shut the daemon down and clean up.
 *
 * The daemon's socket and index are both keyed by project root via
 * `XDG_CACHE_HOME` (the single env knob `getFallbackCacheRoot` honours), so a
 * fresh `mkdtemp` project + a fresh cache dir isolates the whole run from any
 * real daemon or index on this machine. `CODE_AUDITOR_DATA_DIR` is deliberately
 * left unset: with it set, the scoped-vs-flat `resolvePersistedIndexPath` split
 * would make the index-reading commands (`search`, `hotspots`, `risk`,
 * `conventions`) read a different DB than the daemon seeds.
 *
 * Exit code: 0 iff every command ran with its contract exit code and a real
 * summary came back; 1 otherwise (a crash, an unexpected exit code, or an empty
 * / unparseable summary).
 *
 * Usage (from app/):
 *   npm run build && node scripts/verify-daemon-smoke.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLI = resolve(process.cwd(), 'dist/cli.js');
const DAEMON_ENTRY = resolve(process.cwd(), 'dist/daemon/main.js');
const FIXTURE = resolve(process.cwd(), 'tests/fixtures/corpus/d1-workers');
// package.json is the single source of truth for the version. Read it rather
// than hardcoding, so a patch bump cannot strand this assertion on a stale value.
const PKG_VERSION = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')).version;
const READY_TIMEOUT_MS = Number(process.env.VERIFY_DAEMON_SMOKE_READY_MS ?? 90_000);

if (!existsSync(CLI)) {
  console.error('verify:daemon-smoke: dist/cli.js not found — run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(DAEMON_ENTRY)) {
  console.error('verify:daemon-smoke: dist/daemon/main.js not found — run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(FIXTURE)) {
  console.error(`verify:daemon-smoke: fixture missing at ${FIXTURE}.`);
  process.exit(1);
}

// ── throwaway isolation: a temp project copy + a temp cache root ──────────────
// The base is `/tmp`, not `os.tmpdir()`: macOS caps Unix-domain-socket paths at
// ~104 bytes, and `os.tmpdir()` (a per-user `/var/folders/…/T`) plus the
// `code-auditor/sockets/code-auditor-<hash>.sock` suffix overflows it — the
// exact `EINVAL: invalid argument` the daemon otherwise dies on before it ever
// serves. A short `/tmp` base keeps the whole socket path under the cap.
const TMP_BASE = '/tmp';
const projectRoot = mkdtempSync(join(TMP_BASE, 'ca-smoke-project-'));
const cacheRoot = mkdtempSync(join(TMP_BASE, 'ca-smoke-cache-'));
const genConfigDir = mkdtempSync(join(TMP_BASE, 'ca-smoke-gen-'));
cpSync(FIXTURE, projectRoot, { recursive: true });

const env = {
  ...process.env,
  // The single knob getFallbackCacheRoot honours — moves the daemon socket, the
  // index DB, the detached log, and the Go-analyzer cache into the throwaway
  // cache dir so this run cannot collide with (or litter) the user's cache.
  XDG_CACHE_HOME: cacheRoot,
  // chalk disables colour on a non-TTY anyway; belt-and-suspenders for the
  // summary-header substring assertions below.
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  // Spec 51 / release directive 5 — the daemon (and every command below) must
  // run on Node's built-in node:sqlite, never on better-sqlite3. Forcing the
  // backend proves no runtime path silently requires the optional native module:
  // if any path hard-depended on better-sqlite3 it would fail here rather than
  // quietly fall back. `--version` reports the forced backend, so the assertion
  // below also documents which backend the run exercised.
  CODE_AUDITOR_SQLITE_BACKEND: 'node-sqlite',
};
delete env.CODE_AUDITOR_DATA_DIR;

// ── helpers ───────────────────────────────────────────────────────────────────
const failures = [];
const passed = [];

function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? projectRoot,
    env,
    input: options.stdin,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function record(name, result, validStatuses, validator) {
  const statusOk = validStatuses.includes(result.status);
  let summaryOk = true;
  let summaryDetail = '';
  try {
    summaryOk = validator(result);
  } catch (e) {
    summaryOk = false;
    summaryDetail = e instanceof Error ? e.message : String(e);
  }
  if (statusOk && summaryOk) {
    passed.push(name);
    console.log(`  PASS  ${name} (exit ${result.status})`);
  } else {
    const why = [];
    if (!statusOk) why.push(`exit ${result.status ?? 'CRASH'} not in [${validStatuses.join(', ')}]`);
    if (!summaryOk) why.push(`summary: ${summaryDetail || 'empty / unparseable'}`);
    failures.push({ name, result, why });
    console.log(`  FAIL  ${name} — ${why.join('; ')}`);
  }
  return result;
}

/** Assert stdout is valid JSON and hand it back (throws with detail on parse failure). */
function jsonOf(result) {
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `stdout is not JSON (first 200 chars: ${JSON.stringify((result.stdout ?? '').slice(0, 200))})`,
    );
  }
  if (parsed === null || parsed === undefined) throw new Error('stdout is JSON null');
  return parsed;
}

/** Assert stdout contains a non-empty summary header (the terminal "real summary"). */
function contains(needle) {
  return (result) => {
    if (!result.stdout || result.stdout.trim().length === 0) throw new Error('stdout is empty');
    if (!result.stdout.includes(needle)) {
      throw new Error(`stdout missing ${JSON.stringify(needle)} (first 160 chars: ${JSON.stringify(result.stdout.slice(0, 160))})`);
    }
    return true;
  };
}

// ── hook-mode assertions (Spec 68 §hook-contract) ───────────────────────────
// The hook runs the CLI with CODE_AUDITOR_HOOK=1. Two assertions gate it:
//   1. zero bytes on stderr — a successful edit is silent; the host turns hook
//      stderr into a blocking error, so any info/debug line is a defect;
//   2. a wall-time budget — the hook reads the daemon's cache (tens of ms of
//      actual work), it must not run the multi-second full audit.
// The budget is 250ms: measured ~150ms, of which ~140ms is the CLI binary's
// fixed boot (`node dist/cli.js --version` alone costs that) — the daemon
// cache-read itself is ~10ms. It is ~12× under the 3s full audit it guards.
const HOOK_WALL_BUDGET_MS = 250;

function runHook(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? projectRoot,
    env: { ...env, CODE_AUDITOR_HOOK: '1' },
    input: options.stdin,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function recordHook(name, args, options, validator) {
  const start = process.hrtime.bigint();
  const result = runHook(args, options);
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
  const statusOk = [0, 2].includes(result.status);
  const stderrOk = (result.stderr ?? '').length === 0;
  const wallOk = wallMs < HOOK_WALL_BUDGET_MS;
  let summaryOk = true;
  let summaryDetail = '';
  try {
    summaryOk = validator(result);
  } catch (e) {
    summaryOk = false;
    summaryDetail = e instanceof Error ? e.message : String(e);
  }
  if (statusOk && stderrOk && wallOk && summaryOk) {
    passed.push(name);
    console.log(`  PASS  ${name} (exit ${result.status}, ${wallMs.toFixed(0)}ms, 0B stderr)`);
  } else {
    const why = [];
    if (!statusOk) why.push(`exit ${result.status ?? 'CRASH'} not in [0, 2]`);
    if (!stderrOk) why.push(`stderr ${(result.stderr ?? '').length}B (expected 0)`);
    if (!wallOk) why.push(`wall ${wallMs.toFixed(0)}ms ≥ ${HOOK_WALL_BUDGET_MS}ms`);
    if (!summaryOk) why.push(`summary: ${summaryDetail || 'empty / unparseable'}`);
    failures.push({ name, result, why });
    console.log(`  FAIL  ${name} — ${why.join('; ')}`);
  }
  return result;
}

// ── 0. the daemon bin answers --version / --help through a symlink ───────────
// The published `code-auditor-daemon` bin is a pnpm/npm `.bin` symlink. A
// string-URL entry-point guard (not a realpath comparison) evaluates false under
// that symlink, so the daemon boots to a silent exit and `--version`/`--help`
// print nothing — the exact defect release directive 4 pins shut. Reproduce the
// symlink condition and assert the daemon answers both before anything else runs.
const daemonLinkDir = mkdtempSync(join(TMP_BASE, 'ca-smoke-dlink-'));
const daemonLink = join(daemonLinkDir, 'code-auditor-daemon');
symlinkSync(DAEMON_ENTRY, daemonLink);
const runDaemonBin = (args) =>
  spawnSync(process.execPath, [daemonLink, ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
  });

console.log('\ndaemon bin (through a .bin-style symlink):');
record(
  'code-auditor-daemon --version',
  runDaemonBin(['--version']),
  [0],
  contains(PKG_VERSION),
);
record(
  'code-auditor-daemon --help',
  runDaemonBin(['--help']),
  [0],
  contains('Usage:'),
);

// ── 1. start the daemon and wait for ready ────────────────────────────────────
console.log('verify:daemon-smoke — starting daemon against fixture copy');
console.log(`  project: ${projectRoot}`);
console.log(`  cache:   ${cacheRoot}`);

let daemonStderr = '';
const daemon = spawn(process.execPath, [DAEMON_ENTRY, projectRoot, '--foreground'], {
  cwd: projectRoot,
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
});
daemon.stderr.setEncoding('utf8');
daemon.stderr.on('data', (chunk) => {
  daemonStderr += chunk;
});

function daemonExited() {
  return daemon.exitCode !== null || daemon.signalCode !== null;
}

let ready = false;
const deadline = Date.now() + READY_TIMEOUT_MS;
while (Date.now() < deadline) {
  if (daemonExited()) {
    console.error(
      `verify:daemon-smoke: daemon exited before ready (code ${daemon.exitCode}, signal ${daemon.signalCode}).\n--- daemon stderr ---\n${daemonStderr || '(empty)'}`,
    );
    break;
  }
  const status = run(['daemon', 'status', '-p', projectRoot, '--json']);
  if (status.status === 0) {
    try {
      const s = JSON.parse(status.stdout);
      if (s.mode === 'ready') {
        ready = true;
        break;
      }
    } catch {
      // transient — a status probe during startup may interleave; retry.
    }
  }
  // `spawnSync` inside `run` already pumps the event loop, so the daemon's
  // `exit`/stderr events land between probes; the brief sleep only paces the
  // poll (the fixture seed is small — a few seconds).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
}

if (!ready) {
  console.error(
    `verify:daemon-smoke: daemon did not reach ready within ${READY_TIMEOUT_MS} ms.\n--- daemon stderr ---\n${daemonStderr || '(empty)'}`,
  );
  cleanup();
  process.exit(1);
}
console.log('  daemon ready.\n');

// ── 2. every command the hook and skill invoke ────────────────────────────────
// `statements.ts` carries the positive control (`eagerRun` → loop-query), so the
// daemon fast-path is exercised with a *real finding* — the exact surface the
// summary-less crash lived on — and `dismiss` below gets a real fingerprint.
const srcStatements = join(projectRoot, 'src', 'statements.ts');
const srcIndex = join(projectRoot, 'src', 'index.ts');

console.log('hook contract (PostToolUse Write|Edit):');
record(
  'changed --stdin --json (hook-audit)',
  run(['changed', '--stdin', '--json', '-p', projectRoot], { stdin: `${srcStatements}\n` }),
  [0, 2],
  (r) => Array.isArray(jsonOf(r).violations),
);
record(
  'self-audit --stdin --json (hook-self-audit)',
  run(['self-audit', '--stdin', '--json', '-p', projectRoot], { stdin: `${srcStatements}\n` }),
  [0],
  (r) => Array.isArray(jsonOf(r)),
);

console.log('\nhook mode (CODE_AUDITOR_HOOK=1 — Spec 68 §hook-contract):');
recordHook(
  'changed --stdin --json (hook: finding from cache, 0B stderr)',
  ['changed', '--stdin', '--json', '-p', projectRoot],
  { stdin: `${srcStatements}\n` },
  (r) => Array.isArray(jsonOf(r).violations),
);
recordHook(
  'changed --stdin --json (hook: clean file, 0B stderr)',
  ['changed', '--stdin', '--json', '-p', projectRoot],
  { stdin: `${srcIndex}\n` },
  (r) => Array.isArray(jsonOf(r).violations),
);

console.log('\nskill commands (SKILL.md):');
record('--version', run(['--version']), [0], contains(PKG_VERSION));

record('audit (terminal summary)', run(['audit', '--path', projectRoot]), [0], contains('Code Quality Audit'));

record(
  'changed (terminal summary)',
  run(['changed', srcStatements, '-p', projectRoot]),
  [0, 2],
  contains('Diff-Scoped Code Audit'),
);
record(
  'changed --json (daemon fast-path)',
  run(['changed', srcStatements, '-p', projectRoot, '--json']),
  [0, 2],
  (r) => Array.isArray(jsonOf(r).violations),
);
record(
  'changed --json (clean file)',
  run(['changed', srcIndex, '-p', projectRoot, '--json']),
  [0, 2],
  (r) => Array.isArray(jsonOf(r).violations),
);

record('next-file --json', run(['next-file', '--path', projectRoot, '--json']), [0], (r) => {
  const j = jsonOf(r);
  if (!('done' in j) && !('file' in j)) throw new Error(`missing "done" or "file" key (keys: ${Object.keys(j).join(', ')})`);
  return true;
});

record('index sync --json', run(['index', 'sync', '--path', projectRoot, '--json']), [0], (r) => {
  const j = jsonOf(r);
  if (j.success !== true) throw new Error('missing success:true');
  return true;
});

record('search --json', run(['search', 'getDB', '--json']), [0], (r) => jsonOf(r) !== undefined);

record('map -p .', run(['map', '-p', projectRoot]), [0], contains('Codebase Map'));

record(
  'config rules-list --json',
  run(['config', 'rules-list', '--config-path', join(projectRoot, '.codeauditor.json'), '--json']),
  [0],
  (r) => {
    const j = jsonOf(r);
    if (!Array.isArray(j.rules) || typeof j.count !== 'number') throw new Error(`missing rules[]/count (keys: ${Object.keys(j).join(', ')})`);
    return true;
  },
);
record(
  'config rules-check --json',
  run(['config', 'rules-check', '--config-path', join(projectRoot, '.codeauditor.json'), '--json']),
  [0],
  (r) => {
    const j = jsonOf(r);
    if (typeof j.valid !== 'boolean' || !Array.isArray(j.errors)) throw new Error('missing valid/errors shape');
    return true;
  },
);
record('config profiles --json', run(['config', 'profiles', '-p', projectRoot, '--json']), [0], (r) => jsonOf(r) !== undefined);

record('conventions list --json', run(['conventions', 'list', '--json']), [0], (r) => Array.isArray(jsonOf(r)));

record('hotspots --json', run(['hotspots', '--path', projectRoot, '--json']), [0], (r) => jsonOf(r) !== undefined);

record('risk --json', run(['risk', '--path', projectRoot, '--json']), [0], (r) => jsonOf(r) !== undefined);

record('generate-config -o', run(['generate-config', '-o', genConfigDir]), [0], (r) => {
  if (!existsSync(join(genConfigDir, '.codeauditor.json'))) throw new Error('.codeauditor.json not written');
  return true;
});

// dismiss — needs a real fingerprint from a finding. Best-effort: if the fixture
// yields no finding there is nothing to dismiss, and that is a no-op, not a gate
// failure. The temp project copy absorbs the written dismissals file.
{
  const ch = run(['changed', srcStatements, '-p', projectRoot, '--json']);
  const fp = (() => {
    if (ch.status !== 0 && ch.status !== 2) return null;
    try {
      return jsonOf(ch).violations.find((v) => v.fingerprint)?.fingerprint ?? null;
    } catch {
      return null;
    }
  })();
  if (fp) {
    record(
      'dismiss <fingerprint> --reason',
      run(['dismiss', fp, '--reason', 'smoke-test dismissal'], { cwd: projectRoot }),
      [0],
      (r) => existsSync(join(projectRoot, '.codeauditor.dismissals.json')),
    );
  } else {
    console.log('  NOTE  dismiss skipped — fixture produced no finding to dismiss (no fingerprint).');
  }
}

// ── 3. daemon lifecycle: status reflects the live daemon, stop shuts it down ──
console.log('\ndaemon lifecycle:');
record(
  'daemon status --json (ready)',
  run(['daemon', 'status', '-p', projectRoot, '--json']),
  [0],
  (r) => jsonOf(r).mode === 'ready',
);
record('daemon stop', run(['daemon', 'stop', '-p', projectRoot]), [0], contains('Shutdown requested'));

// ── 4. verdict ─────────────────────────────────────────────────────────────────
cleanup();

function cleanup() {
  if (daemon && !daemonExited()) {
    // Backstop: if stop did not reap it, SIGTERM the child (runDaemonForeground
    // handles SIGTERM → core.shutdown).
    try {
      daemon.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  for (const dir of [projectRoot, cacheRoot, genConfigDir, daemonLinkDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

console.log('\n════════════════════════════════════════════');
console.log(`verify:daemon-smoke — ${passed.length} passed, ${failures.length} failed.`);
for (const f of failures) {
  console.error(`\nFAIL ${f.name} — ${f.why.join('; ')}`);
  if (f.result.stderr) console.error(`  stderr: ${f.result.stderr.slice(0, 2000)}`);
  if (f.result.stdout) console.error(`  stdout: ${f.result.stdout.slice(0, 800)}`);
  console.error(`  daemon stderr tail: ${daemonStderr.slice(-600)}`);
}
console.log('════════════════════════════════════════════');

if (failures.length > 0) process.exit(1);
console.log('PASS: daemon served every shipped command with its contract exit code and a real summary.');
process.exit(0);
