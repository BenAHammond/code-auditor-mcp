/**
 * Spec 41 — Detached runs & queryable findings: ledger unit tests.
 *
 * These exercise the Spec 41 lifecycle/provenance/staleness/lease/retention
 * functions against a real CodeIndexDB (temp dir), so the migration-9 schema —
 * including `findings_ledger_coverage` and the `findings_ledger_runs` lifecycle
 * columns — is the schema under test, not an inline replica.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, unlink } from 'fs/promises';
import { rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir, hostname } from 'os';
import { spawnSync } from 'node:child_process';
import { CodeIndexDB } from '../codeIndexDB.js';
import {
  createLedgerRun,
  patchLedgerRun,
  getLedgerRun,
  listLedgerRuns,
  writeAuditToLedger,
  queryLedgerFindings,
  queryLedgerCoverage,
  hashFileSet,
  computeStaleness,
  reclaimStaleRunning,
  pruneLedgerRuns,
  type LedgerRunInput,
} from '../ledger.js';
import type { Violation, RuleCoverage } from '../types.js';

const OLD_TS = '2000-01-01T00:00:00.000Z';
const FUTURE_TS = '2999-01-01T00:00:00.000Z';

function makeRunInput(overrides: Partial<LedgerRunInput> = {}): LedgerRunInput {
  return {
    gitDirty: false,
    toolVersion: '0.0.0-test',
    command: 'audit',
    surface: 'cli',
    scope: 'all',
    target: '/tmp/project',
    ...overrides,
  };
}

function makeViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    file: 'src/foo.ts',
    line: 42,
    severity: 'warning',
    message: 'Test violation',
    analyzer: 'data-access',
    rule: 'missing-org-filter',
    ...overrides,
  };
}

function makeCoverage(overrides: Partial<RuleCoverage> = {}): RuleCoverage {
  return {
    ruleId: 'missing-org-filter',
    analyzer: 'data-access',
    state: 'fired',
    count: 1,
    ...overrides,
  };
}

describe('Spec 41 — ledger lifecycle', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-spec41-'));
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('createLedgerRun → patchLedgerRun → getLedgerRun → listLedgerRuns round-trips lifecycle', () => {
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir });
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    const created = getLedgerRun(db.rawDb, runId)!;
    expect(created.status).toBe('queued');
    expect(created.projectRoot).toBe(dir);
    expect(created.startedAt).toBeNull();
    expect(created.finishedAt).toBeNull();
    expect(created.error).toBeNull();

    patchLedgerRun(db.rawDb, runId, {
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      heartbeatAt: '2026-01-01T00:00:01.000Z',
      progressJson: JSON.stringify({ phase: 'analysis', current: 3, total: 10 }),
    });
    const running = getLedgerRun(db.rawDb, runId)!;
    expect(running.status).toBe('running');
    expect(running.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(running.heartbeatAt).toBe('2026-01-01T00:00:01.000Z');
    expect(running.progressJson).toBe('{"phase":"analysis","current":3,"total":10}');

    patchLedgerRun(db.rawDb, runId, {
      status: 'completed',
      finishedAt: '2026-01-01T00:00:02.000Z',
      resultId: 'audit_blob_1',
    });
    const done = getLedgerRun(db.rawDb, runId)!;
    expect(done.status).toBe('completed');
    expect(done.finishedAt).toBe('2026-01-01T00:00:02.000Z');
    expect(done.resultId).toBe('audit_blob_1'); // carried inside metadata_json

    const listed = listLedgerRuns(db.rawDb, dir);
    expect(listed.map((r) => r.runId)).toContain(runId);
    // unfiltered list also sees it
    expect(listLedgerRuns(db.rawDb).map((r) => r.runId)).toContain(runId);
  });

  it('listLedgerRuns filters by projectRoot', () => {
    const a = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir });
    createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: '/other/project' });
    const listed = listLedgerRuns(db.rawDb, dir);
    expect(listed.map((r) => r.runId)).toEqual([a]);
  });

  it('writeAuditToLedger attach-mode persists findings + coverage and closes the lifecycle', () => {
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir });

    const violations: Violation[] = [
      makeViolation({ file: 'src/a.ts', analyzer: 'data-access', rule: 'missing-org-filter' }),
      makeViolation({ file: 'src/b.ts', analyzer: 'react', rule: 'hooks-deps', severity: 'critical' }),
    ];
    const coverage: RuleCoverage[] = [
      makeCoverage({ analyzer: 'data-access', ruleId: 'missing-org-filter', state: 'notApplicable', count: 0, reason: 'no tenant column' }),
      makeCoverage({ analyzer: 'react', ruleId: 'hooks-deps', state: 'fired', count: 1 }),
      makeCoverage({ analyzer: 'react', ruleId: 'jsx-key', state: 'clean', count: 0 }),
    ];

    const returned = writeAuditToLedger(db.rawDb, makeRunInput(), violations, 1234, 0, {
      runId,
      coverage,
    });
    expect(returned).toBe(runId);

    const run = getLedgerRun(db.rawDb, runId)!;
    expect(run.status).toBe('completed');
    expect(run.durationMs).toBe(1234);
    expect(run.finishedAt).not.toBeNull();

    const findings = queryLedgerFindings(db.rawDb, runId) as Array<{ rule: string }>;
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.rule).sort()).toEqual(['hooks-deps', 'missing-org-filter']);

    const cov = queryLedgerCoverage(db.rawDb, runId);
    expect(cov).toHaveLength(3);
    const orgFilter = cov.find((c) => c.ruleId === 'missing-org-filter')!;
    expect(orgFilter.state).toBe('notApplicable');
    expect(orgFilter.reason).toBe('no tenant column');
  });

  it('writeAuditToLedger non-attach creates a fresh completed run', () => {
    const runId = writeAuditToLedger(db.rawDb, makeRunInput(), [makeViolation()], 10, 0);
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    const run = getLedgerRun(db.rawDb, runId)!;
    expect(run.status).toBe('completed');
    // synchronous path leaves project_root NULL → invisible to projectRoot-filtered reads
    expect(run.projectRoot).toBeNull();
    expect(queryLedgerFindings(db.rawDb, runId)).toHaveLength(1);
  });

  it('queryLedgerFindings supports rule/analyzer/file/severity filters, count, and pagination', () => {
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir });
    const violations: Violation[] = [
      makeViolation({ file: 'src/one.ts', analyzer: 'data-access', rule: 'missing-org-filter', severity: 'warning' }),
      makeViolation({ file: 'src/two.ts', analyzer: 'data-access', rule: 'missing-org-filter', severity: 'warning' }),
      makeViolation({ file: 'src/three.ts', analyzer: 'react', rule: 'hooks-deps', severity: 'critical' }),
      makeViolation({ file: 'lib/four.ts', analyzer: 'react', rule: 'jsx-key', severity: 'suggestion' }),
    ];
    writeAuditToLedger(db.rawDb, makeRunInput(), violations, 0, 0, { runId });

    const byRule = queryLedgerFindings(db.rawDb, runId, { rule: 'missing-org-filter' }) as Array<{ rule: string }>;
    expect(byRule).toHaveLength(2);

    const byAnalyzer = queryLedgerFindings(db.rawDb, runId, { analyzer: 'react' }) as Array<{ analyzer: string }>;
    expect(byAnalyzer).toHaveLength(2);

    const byFile = queryLedgerFindings(db.rawDb, runId, { file: 'src/two.ts' }) as Array<{ file: string }>;
    expect(byFile).toHaveLength(1);
    expect(byFile[0].file).toBe('src/two.ts');

    const bySeverity = queryLedgerFindings(db.rawDb, runId, { severity: 'critical' }) as Array<{ severity: string }>;
    expect(bySeverity).toHaveLength(1);
    expect(bySeverity[0].rule).toBe('hooks-deps');

    const counts = queryLedgerFindings(db.rawDb, runId, { count: true }) as Array<{ group: string; count: number }>;
    expect(counts).toEqual([
      { group: 'data-access/missing-org-filter', count: 2 },
      { group: 'react/hooks-deps', count: 1 },
      { group: 'react/jsx-key', count: 1 },
    ]);

    const page1 = queryLedgerFindings(db.rawDb, runId, { limit: 2, offset: 0 }) as Array<{ file: string }>;
    const page2 = queryLedgerFindings(db.rawDb, runId, { limit: 2, offset: 2 }) as Array<{ file: string }>;
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(new Set([...page1, ...page2].map((f) => f.file)).size).toBe(4);
  });

  it('queryLedgerCoverage filters by rule/analyzer/state', () => {
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir });
    const coverage: RuleCoverage[] = [
      makeCoverage({ analyzer: 'data-access', ruleId: 'missing-org-filter', state: 'notApplicable', count: 0 }),
      makeCoverage({ analyzer: 'react', ruleId: 'hooks-deps', state: 'fired', count: 3 }),
      makeCoverage({ analyzer: 'react', ruleId: 'jsx-key', state: 'clean', count: 0 }),
    ];
    writeAuditToLedger(db.rawDb, makeRunInput(), [], 0, 0, { runId, coverage });

    expect(queryLedgerCoverage(db.rawDb, runId, { rule: 'hooks-deps' })).toHaveLength(1);
    expect(queryLedgerCoverage(db.rawDb, runId, { analyzer: 'react' })).toHaveLength(2);
    expect(queryLedgerCoverage(db.rawDb, runId, { state: 'fired' })).toHaveLength(1);
    expect(queryLedgerCoverage(db.rawDb, runId, { state: 'fired' })[0].count).toBe(3);
  });
});

describe('Spec 41 — provenance & staleness', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-spec41-'));
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();
    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(dir, 'b.ts'), 'export const b = 2;\n');
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function recordFileSet(files: string[]): string {
    const hash = hashFileSet(files, dir);
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir });
    patchLedgerRun(db.rawDb, runId, {
      contentHash: hash.contentHash,
      filesCount: hash.filesCount,
      fileManifestJson: JSON.stringify(hash.manifest),
    });
    return runId;
  }

  it('hashFileSet produces a deterministic, order-independent aggregate and per-file manifest', async () => {
    const files = [join(dir, 'a.ts'), join(dir, 'b.ts')];
    const h1 = hashFileSet(files, dir);
    const h2 = hashFileSet([...files].reverse(), dir);

    expect(h1.filesCount).toBe(2);
    expect(h1.manifest.files['a.ts']).toMatch(/^[0-9a-f]{64}$/);
    expect(h1.manifest.files['b.ts']).toMatch(/^[0-9a-f]{64}$/);
    expect(h1.contentHash).toBe(h2.contentHash);
    expect(h1.manifest.files).toEqual(h2.manifest.files);

    // changing one file changes the aggregate
    await writeFile(join(dir, 'a.ts'), 'export const a = 2;\n');
    const h3 = hashFileSet(files, dir);
    expect(h3.contentHash).not.toBe(h1.contentHash);
    expect(h3.manifest.files['a.ts']).not.toBe(h1.manifest.files['a.ts']);
    expect(h3.manifest.files['b.ts']).toBe(h1.manifest.files['b.ts']);
  });

  it('computeStaleness is not-stale when the tree is unchanged', () => {
    const runId = recordFileSet([join(dir, 'a.ts'), join(dir, 'b.ts')]);
    const result = computeStaleness(db.rawDb, runId, dir);
    expect(result.stale).toBe(false);
    expect(result.changedFiles).toEqual([]);
    expect(result.filesCount).toEqual({ recorded: 2, current: 2 });
  });

  it('computeStaleness is content-based: a touched (mtime-only) file is not stale', () => {
    const runId = recordFileSet([join(dir, 'a.ts'), join(dir, 'b.ts')]);
    // bump mtime without changing content
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'a.ts'), past, past);
    const result = computeStaleness(db.rawDb, runId, dir);
    expect(result.stale).toBe(false);
    expect(result.changedFiles).toEqual([]);
  });

  it('computeStaleness reports stale with the changed file when content diverges', async () => {
    const runId = recordFileSet([join(dir, 'a.ts'), join(dir, 'b.ts')]);
    await writeFile(join(dir, 'a.ts'), 'export const a = 999;\n');
    const result = computeStaleness(db.rawDb, runId, dir);
    expect(result.stale).toBe(true);
    expect(result.changedFiles).toContain('a.ts');
    expect(result.changedFiles).not.toContain('b.ts');
  });

  it('computeStaleness reports stale when a recorded file is deleted', async () => {
    const runId = recordFileSet([join(dir, 'a.ts'), join(dir, 'b.ts')]);
    await unlink(join(dir, 'b.ts'));
    const result = computeStaleness(db.rawDb, runId, dir);
    expect(result.stale).toBe(true);
    expect(result.changedFiles).toContain('b.ts');
  });
});

describe('Spec 41 — lease reclaim & retention', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-spec41-'));
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reclaims a running run whose heartbeat is stale', () => {
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir, status: 'running' });
    patchLedgerRun(db.rawDb, runId, { startedAt: OLD_TS, heartbeatAt: OLD_TS });
    const reclaimed = reclaimStaleRunning(db.rawDb, dir, 30_000);
    expect(reclaimed).toBe(1);
    const run = getLedgerRun(db.rawDb, runId)!;
    expect(run.status).toBe('failed');
    expect(run.error).toBe('runner lease expired (no heartbeat)');
    expect(run.finishedAt).not.toBeNull();
  });

  it('reclaims a running run with no heartbeat but a stale start time', () => {
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir, status: 'running' });
    patchLedgerRun(db.rawDb, runId, { startedAt: OLD_TS });
    const reclaimed = reclaimStaleRunning(db.rawDb, dir, 30_000);
    expect(reclaimed).toBe(1);
    expect(getLedgerRun(db.rawDb, runId)!.status).toBe('failed');
  });

  it('does not reclaim a running run with a fresh heartbeat', () => {
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir, status: 'running' });
    patchLedgerRun(db.rawDb, runId, { startedAt: OLD_TS, heartbeatAt: FUTURE_TS });
    const reclaimed = reclaimStaleRunning(db.rawDb, dir, 30_000);
    expect(reclaimed).toBe(0);
    expect(getLedgerRun(db.rawDb, runId)!.status).toBe('running');
  });

  it('ignores non-running runs', () => {
    createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir, status: 'queued' });
    const completed = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir, status: 'completed' });
    patchLedgerRun(db.rawDb, completed, { startedAt: OLD_TS, heartbeatAt: OLD_TS });
    expect(reclaimStaleRunning(db.rawDb, dir, 30_000)).toBe(0);
  });

  // Spec 41 Amendment B — PID-based liveness: a stale heartbeat must NOT
  // reclaim a run whose runner is still alive (the common starvation case).
  it('does not reclaim a stale-heartbeat run whose PID is still the same live process', () => {
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir, status: 'running' });
    patchLedgerRun(db.rawDb, runId, {
      startedAt: OLD_TS,
      heartbeatAt: OLD_TS,
      runnerPid: process.pid,
      runnerPidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      runnerHost: hostname(),
    });
    expect(reclaimStaleRunning(db.rawDb, dir, 30_000)).toBe(0);
    expect(getLedgerRun(db.rawDb, runId)!.status).toBe('running');
  });

  it('reclaims a stale-heartbeat run whose PID is dead, naming the pid', () => {
    // A process that has already exited yields a deterministically-dead PID.
    const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir, status: 'running' });
    patchLedgerRun(db.rawDb, runId, {
      startedAt: OLD_TS,
      heartbeatAt: OLD_TS,
      runnerPid: dead.pid,
      runnerPidStartedAt: new Date(Date.now() - 5_000).toISOString(),
      runnerHost: hostname(),
    });
    expect(reclaimStaleRunning(db.rawDb, dir, 30_000)).toBe(1);
    const run = getLedgerRun(db.rawDb, runId)!;
    expect(run.status).toBe('failed');
    expect(run.error).toBe(`runner process exited (pid ${dead.pid})`);
  });

  it('reclaims a stale-heartbeat run whose PID was reused (start time mismatch)', () => {
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir, status: 'running' });
    // PID is alive (this process) but the recorded start time is ancient, i.e.
    // the PID was recycled to a different process than the one that claimed.
    patchLedgerRun(db.rawDb, runId, {
      startedAt: OLD_TS,
      heartbeatAt: OLD_TS,
      runnerPid: process.pid,
      runnerPidStartedAt: OLD_TS,
      runnerHost: hostname(),
    });
    expect(reclaimStaleRunning(db.rawDb, dir, 30_000)).toBe(1);
    expect(getLedgerRun(db.rawDb, runId)!.status).toBe('failed');
  });

  it('falls back to the heartbeat for a running row from a foreign host', () => {
    const runId = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir, status: 'running' });
    patchLedgerRun(db.rawDb, runId, {
      startedAt: OLD_TS,
      heartbeatAt: OLD_TS,
      runnerPid: process.pid, // a live PID that must NOT be trusted cross-machine
      runnerPidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      runnerHost: 'some-other-host.example',
    });
    expect(reclaimStaleRunning(db.rawDb, dir, 30_000)).toBe(1);
    const run = getLedgerRun(db.rawDb, runId)!;
    expect(run.status).toBe('failed');
    expect(run.error).toBe('runner lease expired (no heartbeat; foreign host some-other-host.example)');
  });

  it('prunes to the newest N runs and cascades findings + coverage', () => {
    // create 3 runs, oldest first; only the newest survives pruning
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = createLedgerRun(db.rawDb, makeRunInput(), { projectRoot: dir });
      ids.push(id);
      writeAuditToLedger(db.rawDb, makeRunInput(), [makeViolation({ file: `src/${i}.ts` })], 0, 0, {
        runId: id,
        coverage: [makeCoverage({ ruleId: `rule-${i}` })],
      });
    }
    // make them temporally distinct so ordering is deterministic (prune/list
    // order by the `timestamp` column, not finished_at)
    const setTs = db.rawDb.prepare('UPDATE findings_ledger_runs SET timestamp = ? WHERE run_id = ?');
    for (let i = 0; i < 3; i++) {
      setTs.run(`2026-01-0${i + 1}T00:00:00.000Z`, ids[i]);
    }

    const pruned = pruneLedgerRuns(db.rawDb, dir, 1);
    expect(pruned).toBe(2);

    const survivors = listLedgerRuns(db.rawDb, dir);
    expect(survivors.map((r) => r.runId)).toEqual([ids[2]]); // newest first

    // findings + coverage of pruned runs cascaded away
    expect(queryLedgerFindings(db.rawDb, ids[0])).toHaveLength(0);
    expect(queryLedgerCoverage(db.rawDb, ids[0])).toHaveLength(0);
    // surviving run kept its rows
    expect(queryLedgerFindings(db.rawDb, ids[2])).toHaveLength(1);
    expect(queryLedgerCoverage(db.rawDb, ids[2])).toHaveLength(1);
  });
});
