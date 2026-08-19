/**
 * Spec 11 R1 — Findings Ledger
 *
 * Append-only audit history stored in the SQLite index. Every audit surface
 * (CLI, MCP, library, hook) writes to the ledger unconditionally. The ledger
 * survives clearIndex like user-authored data.
 */

import { randomUUID, createHash } from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hostname } from 'node:os';
import Database from 'better-sqlite3';
import type { Violation, RuleCoverage, RuleCoverageState } from './types.js';
import { fingerprint, type FingerprintInput } from './fingerprint.js';
import { extractSymbol } from './symbols.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface LedgerRunInput {
  gitSha?: string;
  gitDirty: boolean;
  toolVersion: string;
  command: string;
  surface: 'cli' | 'mcp' | 'library' | 'hook';
  scope: string;
  target: string;
}

export interface LedgerRunRecord {
  runId: string;
  timestamp: string;
  gitSha: string | null;
  gitDirty: boolean;
  toolVersion: string;
  command: string;
  surface: string;
  scope: string;
  target: string;
  durationMs: number;
  exitStatus: number;
}

export interface LedgerFindingRecord {
  runId: string;
  analyzer: string;
  rule: string;
  severity: string;
  message: string;
  file: string;
  line: number | null;
  symbol: string;
  fingerprint: string;
}

export interface LedgerRunSummary {
  runId: string;
  timestamp: string;
  command: string;
  surface: string;
  scope: string;
  findingCount: number;
  durationMs: number;
  exitStatus: number;
  gitSha?: string | null;
}

export interface LedgerStats {
  totalRuns: number;
  perAnalyzer: Record<string, { total: number; perRule: Record<string, number>; severityDistribution: Record<string, number> }>;
}

// ── Spec 41 — Detached runs & queryable findings ────────────────────────────

export type LedgerRunStatus = 'queued' | 'running' | 'completed' | 'failed';

/** Full lifecycle view of a ledger run (job). */
export interface LedgerRunDetail extends LedgerRunRecord {
  status: LedgerRunStatus;
  projectRoot: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  error: string | null;
  progressJson: string | null;
  stderrLog: string | null;
  contentHash: string | null;
  filesCount: number | null;
  fileManifestJson: string | null;
  resultId: string | null;
  runnerPid: number | null;
  runnerPidStartedAt: string | null;
  runnerHost: string | null;
}

/** Mutable lifecycle columns, applied via `patchLedgerRun`. */
export interface LedgerRunPatch {
  status?: LedgerRunStatus;
  startedAt?: string | null;
  heartbeatAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  progressJson?: string | null;
  stderrLog?: string | null;
  contentHash?: string | null;
  filesCount?: number | null;
  fileManifestJson?: string | null;
  resultId?: string | null;
  exitStatus?: number;
  runnerPid?: number | null;
  runnerPidStartedAt?: string | null;
  runnerHost?: string | null;
}

export interface LedgerFindingsQuery {
  rule?: string;
  analyzer?: string;
  file?: string; // matched with LIKE %file%
  severity?: string;
  count?: boolean;
  limit?: number;
  offset?: number;
}

export interface LedgerCoverageQuery {
  rule?: string;
  analyzer?: string;
  state?: RuleCoverageState;
}

export interface LedgerCoverageRow {
  analyzer: string;
  ruleId: string;
  state: RuleCoverageState;
  count: number;
  reason: string | null;
}

export interface FileSetManifest {
  files: Record<string, string>; // relPath -> sha256 hex
  newestMtime: number | null;
}

export interface FileSetHash {
  contentHash: string;
  filesCount: number;
  manifest: FileSetManifest;
  newestMtime: number | null;
}

export interface StalenessResult {
  stale: boolean;
  changedFiles: string[];
  recordedHash: string | null;
  currentHash: string | null;
  filesCount: { recorded: number | null; current: number };
  newestMtime: { recorded: number | null; current: number | null };
}

// ── Git helpers ───────────────────────────────────────────────────────────

function getGitInfo(target: string): { sha?: string; dirty: boolean } {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: target, stdio: 'pipe', timeout: 5000 })
      .toString()
      .trim();
    const status = execSync('git status --porcelain', { cwd: target, stdio: 'pipe', timeout: 5000 })
      .toString();
    const dirty = status.length > 0;
    return { sha: sha || undefined, dirty };
  } catch {
    return { dirty: false };
  }
}

// ── Writing ───────────────────────────────────────────────────────────────

export function writeAuditToLedger(
  db: Database.Database,
  runInput: LedgerRunInput,
  violations: Violation[],
  durationMs: number,
  exitStatus: number,
  opts?: { runId?: string; coverage?: RuleCoverage[] },
): string {
  const isAttach = !!opts?.runId;
  const runId = opts?.runId ?? randomUUID();
  const timestamp = new Date().toISOString();

  const insertRun = db.prepare(`
    INSERT INTO findings_ledger_runs
      (run_id, timestamp, git_sha, git_dirty, tool_version, command, surface, scope, target, duration_ms, exit_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFinding = db.prepare(`
    INSERT INTO findings_ledger_findings
      (run_id, analyzer, rule, severity, message, file, line, symbol, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertCoverage = db.prepare(`
    INSERT OR REPLACE INTO findings_ledger_coverage
      (run_id, analyzer, rule_id, state, count, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    if (isAttach) {
      // Attach to a pre-existing run (detached lifecycle): record results and
      // close the lifecycle. The run row itself was created by createLedgerRun.
      db.prepare(`
        UPDATE findings_ledger_runs
        SET duration_ms = ?, exit_status = ?, finished_at = ?, status = 'completed'
        WHERE run_id = ?
      `).run(durationMs, exitStatus, timestamp, runId);
    } else {
      insertRun.run(
        runId,
        timestamp,
        runInput.gitSha ?? null,
        runInput.gitDirty ? 1 : 0,
        runInput.toolVersion,
        runInput.command,
        runInput.surface,
        runInput.scope,
        runInput.target,
        durationMs,
        exitStatus,
      );
    }

    for (const v of violations) {
      const symbol = extractSymbol(v);
      const fp = fingerprint({
        analyzer: (v as any).analyzer || 'unknown',
        rule: (v as any).rule || 'unknown',
        file: v.file,
        symbol,
      });
      insertFinding.run(
        runId,
        (v as any).analyzer || 'unknown',
        (v as any).rule || 'unknown',
        v.severity,
        v.message,
        v.file,
        v.line ?? null,
        symbol,
        fp,
      );
    }

    if (opts?.coverage) {
      for (const c of opts.coverage) {
        insertCoverage.run(runId, c.analyzer, c.ruleId, c.state, c.count, c.reason ?? null);
      }
    }
  });

  tx();
  return runId;
}

/**
 * Create a detached-run row in `queued` (or another initial) status without
 * findings. Returns the run id, which is the job id for `--detach`/MCP.
 */
export function createLedgerRun(
  db: Database.Database,
  runInput: LedgerRunInput,
  opts: { status?: LedgerRunStatus; projectRoot?: string } = {},
): string {
  const runId = randomUUID();
  const timestamp = new Date().toISOString();
  const status = opts.status ?? 'queued';

  db.prepare(`
    INSERT INTO findings_ledger_runs
      (run_id, timestamp, git_sha, git_dirty, tool_version, command, surface, scope, target, duration_ms, exit_status, status, project_root)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    runId,
    timestamp,
    runInput.gitSha ?? null,
    runInput.gitDirty ? 1 : 0,
    runInput.toolVersion,
    runInput.command,
    runInput.surface,
    runInput.scope,
    runInput.target,
    status,
    opts.projectRoot ?? null,
  );

  return runId;
}

/** Patch mutable lifecycle columns on a run row. */
export function patchLedgerRun(
  db: Database.Database,
  runId: string,
  patch: LedgerRunPatch,
): void {
  const sets: string[] = [];
  const values: any[] = [];

  const colMap: Array<[keyof LedgerRunPatch, string]> = [
    ['status', 'status'],
    ['startedAt', 'started_at'],
    ['heartbeatAt', 'heartbeat_at'],
    ['finishedAt', 'finished_at'],
    ['error', 'error'],
    ['progressJson', 'progress_json'],
    ['stderrLog', 'stderr_log'],
    ['contentHash', 'content_hash'],
    ['filesCount', 'files_count'],
    ['fileManifestJson', 'file_manifest_json'],
    ['exitStatus', 'exit_status'],
    ['runnerPid', 'runner_pid'],
    ['runnerPidStartedAt', 'runner_pid_started_at'],
    ['runnerHost', 'runner_host'],
  ];

  for (const [key, col] of colMap) {
    if (patch[key] !== undefined) {
      sets.push(`${col} = ?`);
      values.push(patch[key] === null ? null : patch[key]);
    }
  }

  if (patch.resultId !== undefined) {
    // resultId is carried inside metadata_json (the blob id from storeAuditResults).
    const row = db.prepare('SELECT metadata_json FROM findings_ledger_runs WHERE run_id = ?').get(runId) as
      | { metadata_json: string }
      | undefined;
    const meta = row?.metadata_json ? safeJsonParse(row.metadata_json, {}) : {};
    meta.resultId = patch.resultId;
    sets.push('metadata_json = ?');
    values.push(JSON.stringify(meta));
  }

  if (sets.length === 0) return;
  values.push(runId);
  db.prepare(`UPDATE findings_ledger_runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...values);
}

/** Update the exit status of a ledger run — called by CLI/MCP after determining it. */
export function updateLedgerRunStatus(
  db: Database.Database,
  runId: string,
  exitStatus: number,
): void {
  db.prepare(
    'UPDATE findings_ledger_runs SET exit_status = ? WHERE run_id = ?',
  ).run(exitStatus, runId);
}

// ── Spec 41 — Run lifecycle reads ──────────────────────────────────────────

function safeJsonParse(raw: string | null | undefined, fallback: any): any {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const RUN_DETAIL_SELECT = `
  run_id AS runId, timestamp, git_sha AS gitSha, git_dirty AS gitDirty,
  tool_version AS toolVersion, command, surface, scope, target,
  duration_ms AS durationMs, exit_status AS exitStatus, metadata_json AS metadataJson,
  status, project_root AS projectRoot, started_at AS startedAt, heartbeat_at AS heartbeatAt,
  finished_at AS finishedAt, error, progress_json AS progressJson, stderr_log AS stderrLog,
  content_hash AS contentHash, files_count AS filesCount, file_manifest_json AS fileManifestJson,
  runner_pid AS runnerPid, runner_pid_started_at AS runnerPidStartedAt, runner_host AS runnerHost
`;

function mapRunRow(row: any): LedgerRunDetail {
  const meta = safeJsonParse(row.metadataJson, {});
  return {
    runId: row.runId,
    timestamp: String(row.timestamp),
    gitSha: row.gitSha ?? null,
    gitDirty: !!row.gitDirty,
    toolVersion: row.toolVersion,
    command: row.command,
    surface: row.surface,
    scope: row.scope,
    target: row.target,
    durationMs: row.durationMs,
    exitStatus: row.exitStatus,
    status: row.status,
    projectRoot: row.projectRoot ?? null,
    startedAt: row.startedAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    finishedAt: row.finishedAt ?? null,
    error: row.error ?? null,
    progressJson: row.progressJson ?? null,
    stderrLog: row.stderrLog ?? null,
    contentHash: row.contentHash ?? null,
    filesCount: row.filesCount ?? null,
    fileManifestJson: row.fileManifestJson ?? null,
    resultId: meta.resultId ?? null,
    runnerPid: row.runnerPid ?? null,
    runnerPidStartedAt: row.runnerPidStartedAt ?? null,
    runnerHost: row.runnerHost ?? null,
  };
}

export function getLedgerRun(db: Database.Database, runId: string): LedgerRunDetail | null {
  const row = db.prepare(`SELECT ${RUN_DETAIL_SELECT} FROM findings_ledger_runs WHERE run_id = ?`).get(runId) as any;
  return row ? mapRunRow(row) : null;
}

export function listLedgerRuns(db: Database.Database, projectRoot?: string): LedgerRunDetail[] {
  const params: any[] = [];
  let where = '';
  if (projectRoot) {
    where = 'WHERE project_root = ?';
    params.push(projectRoot);
  }
  const rows = db.prepare(`
    SELECT ${RUN_DETAIL_SELECT} FROM findings_ledger_runs ${where}
    ORDER BY timestamp DESC
  `).all(...params) as any[];
  return rows.map(mapRunRow);
}

export function queryLedgerFindings(
  db: Database.Database,
  runId: string,
  q: LedgerFindingsQuery = {},
): LedgerFindingRecord[] | Array<{ group: string; count: number }> {
  const where: string[] = ['run_id = ?'];
  const params: any[] = [runId];
  if (q.rule) {
    where.push('rule = ?');
    params.push(q.rule);
  }
  if (q.analyzer) {
    where.push('analyzer = ?');
    params.push(q.analyzer);
  }
  if (q.file) {
    where.push('file LIKE ?');
    params.push(`%${q.file}%`);
  }
  if (q.severity) {
    where.push('severity = ?');
    params.push(q.severity);
  }

  if (q.count) {
    const rows = db.prepare(`
      SELECT analyzer || '/' || rule AS "group", COUNT(*) AS "count"
      FROM findings_ledger_findings
      WHERE ${where.join(' AND ')}
      GROUP BY analyzer, rule
      ORDER BY count DESC
    `).all(...params) as any[];
    return rows.map((r) => ({ group: r.group, count: r.count }));
  }

  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;
  let sql = `
    SELECT run_id AS runId, analyzer, rule, severity, message, file, line, symbol, fingerprint
    FROM findings_ledger_findings
    WHERE ${where.join(' AND ')}
    ORDER BY id
  `;
  if (limit > 0) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);
  }
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({
    runId: r.runId,
    analyzer: r.analyzer,
    rule: r.rule,
    severity: r.severity,
    message: r.message,
    file: r.file,
    line: r.line ?? null,
    symbol: String(r.symbol ?? ''),
    fingerprint: String(r.fingerprint ?? ''),
  }));
}

export function queryLedgerCoverage(
  db: Database.Database,
  runId: string,
  q: LedgerCoverageQuery = {},
): LedgerCoverageRow[] {
  const where: string[] = ['run_id = ?'];
  const params: any[] = [runId];
  if (q.rule) {
    where.push('rule_id = ?');
    params.push(q.rule);
  }
  if (q.analyzer) {
    where.push('analyzer = ?');
    params.push(q.analyzer);
  }
  if (q.state) {
    where.push('state = ?');
    params.push(q.state);
  }
  const rows = db.prepare(`
    SELECT analyzer, rule_id AS ruleId, state, count, reason
    FROM findings_ledger_coverage
    WHERE ${where.join(' AND ')}
    ORDER BY analyzer, rule_id
  `).all(...params) as any[];
  return rows.map((r) => ({
    analyzer: r.analyzer,
    ruleId: r.ruleId,
    state: r.state,
    count: r.count,
    reason: r.reason ?? null,
  }));
}

// ── Spec 41 — Provenance & staleness ───────────────────────────────────────

export function hashFileSet(files: string[], projectRoot?: string): FileSetHash {
  const hashes: Array<[string, string]> = [];
  let newestMtime: number | null = null;
  for (const file of files) {
    try {
      const content = readFileSync(file);
      const mtime = statSync(file).mtimeMs;
      const rel = projectRoot ? relative(projectRoot, file) : file;
      const sha = createHash('sha256').update(content).digest('hex');
      hashes.push([rel, sha]);
      if (newestMtime === null || mtime > newestMtime) newestMtime = mtime;
    } catch {
      // Unreadable file (deleted between list and hash) — excluded from the set.
    }
  }
  hashes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const manifest: FileSetManifest = { files: {}, newestMtime };
  const aggregate = createHash('sha256');
  for (const [rel, sha] of hashes) {
    manifest.files[rel] = sha;
    aggregate.update(rel + '\0' + sha + '\n');
  }

  return {
    contentHash: aggregate.digest('hex'),
    filesCount: hashes.length,
    manifest,
    newestMtime,
  };
}

/**
 * Compare a run's recorded content against the working tree. Cheap-first: a
 * stat-only pass (count + newest mtime) gates the full content re-hash; only
 * when those diverge (or `full` is requested) are file contents re-read.
 */
export function computeStaleness(
  db: Database.Database,
  runId: string,
  projectRoot: string,
  opts: { full?: boolean } = {},
): StalenessResult {
  const run = getLedgerRun(db, runId);
  const empty: StalenessResult = {
    stale: false,
    changedFiles: [],
    recordedHash: run?.contentHash ?? null,
    currentHash: null,
    filesCount: { recorded: run?.filesCount ?? null, current: 0 },
    newestMtime: { recorded: null, current: null },
  };
  if (!run || !run.fileManifestJson || !run.contentHash) return empty;

  const manifest = safeJsonParse(run.fileManifestJson, { files: {}, newestMtime: null }) as FileSetManifest;
  const relPaths = Object.keys(manifest.files);
  const recordedFilesCount = run.filesCount ?? relPaths.length;
  const recordedNewestMtime = manifest.newestMtime;

  // Cheap stat-only pass over the recorded file set.
  let currentCount = 0;
  let currentNewestMtime: number | null = null;
  const missing: string[] = [];
  for (const rel of relPaths) {
    try {
      const st = statSync(join(projectRoot, rel));
      currentCount++;
      if (currentNewestMtime === null || st.mtimeMs > currentNewestMtime) currentNewestMtime = st.mtimeMs;
    } catch {
      missing.push(rel);
    }
  }

  if (
    !opts.full &&
    missing.length === 0 &&
    currentCount === recordedFilesCount &&
    currentNewestMtime === recordedNewestMtime
  ) {
    return {
      stale: false,
      changedFiles: [],
      recordedHash: run.contentHash,
      currentHash: run.contentHash,
      filesCount: { recorded: recordedFilesCount, current: currentCount },
      newestMtime: { recorded: recordedNewestMtime, current: currentNewestMtime },
    };
  }

  // Full re-hash + diff against the recorded manifest.
  const current = hashFileSet(relPaths.map((rel) => join(projectRoot, rel)), projectRoot);
  const allRels = new Set<string>([
    ...Object.keys(manifest.files),
    ...Object.keys(current.manifest.files),
    ...missing,
  ]);
  const changedFiles: string[] = [];
  for (const rel of allRels) {
    if (manifest.files[rel] !== current.manifest.files[rel]) changedFiles.push(rel);
  }

  return {
    stale: current.contentHash !== run.contentHash || missing.length > 0,
    changedFiles,
    recordedHash: run.contentHash,
    currentHash: current.contentHash,
    filesCount: { recorded: recordedFilesCount, current: current.filesCount },
    newestMtime: { recorded: recordedNewestMtime, current: current.newestMtime },
  };
}

// ── Spec 41 — Lease reclaim & retention ────────────────────────────────────

/**
 * Tolerance for treating a recorded process start time and a live process's
 * start time as "the same process". `ps -o etime=` reports elapsed seconds
 * truncated to the whole second, so the derived live start time is within ~1s
 * of the true start; 5s of slack covers that plus clock granularity. A reused
 * PID (the real PID-reuse failure mode) starts minutes-to-hours after the
 * original process, far outside this window.
 */
const PID_REUSE_TOLERANCE_MS = 5000;

/** True if some process currently holds `pid` (reports liveness, not identity). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Parse `ps -o etime=` output (`[[dd-]hh:]mm:ss`) into elapsed seconds.
 * Returns null on any unexpected shape.
 */
function parseEtimeSeconds(etime: string): number | null {
  const trimmed = etime.trim();
  if (!trimmed) return null;
  let days = 0;
  let rest = trimmed;
  const dash = trimmed.indexOf('-');
  if (dash !== -1) {
    const d = Number.parseInt(trimmed.slice(0, dash), 10);
    if (!Number.isFinite(d)) return null;
    days = d;
    rest = trimmed.slice(dash + 1);
  }
  const parts = rest.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  let seconds: number;
  if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else return null;
  return days * 86400 + seconds;
}

/** Unix-ms start time of the live process at `pid`, or null if undeterminable. */
function getProcessStartTimeMs(pid: number): number | null {
  try {
    // `etime` is portable across BSD (macOS) and GNU (Linux) `ps`.
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    const seconds = parseEtimeSeconds(out);
    if (seconds === null) return null;
    return Date.now() - seconds * 1000;
  } catch {
    return null;
  }
}

/**
 * True only when `pid` names the *same* process that claimed the lease. PID
 * reuse is defeated by comparing the live process's start time to the one the
 * child recorded at claim; `kill(pid, 0)` alone cannot tell them apart.
 * Conservative on every uncertain branch — an undeterminable live process is
 * treated as alive so a healthy runner is never falsely reclaimed.
 */
function isSameProcessAlive(pid: number, recordedStartedAt: string | null): boolean {
  if (!isPidAlive(pid)) return false;
  if (!recordedStartedAt) return true;
  const recordedMs = Date.parse(recordedStartedAt);
  if (!Number.isFinite(recordedMs)) return true;
  const liveMs = getProcessStartTimeMs(pid);
  if (liveMs === null) return true;
  return Math.abs(liveMs - recordedMs) <= PID_REUSE_TOLERANCE_MS;
}

/** A stale `running` row whose runner is genuinely gone, safe to reclaim. */
export interface ReclaimCandidate {
  runId: string;
  reason: string;
}

/** Read-only result of evaluating the running-lease pool for a project root. */
export interface RunningLeaseEvaluation {
  /** Total rows currently in the `running` state (fresh or stale). */
  runningCount: number;
  /** Stale cutoff used to derive `reclaimable` (ISO timestamp). */
  cutoff: string;
  /** Stale rows whose runner is genuinely gone and therefore reclaimable. */
  reclaimable: ReclaimCandidate[];
}

/**
 * Evaluate the running-lease pool WITHOUT taking a write lock — the liveness
 * signals (PID, process start time, hostname, heartbeat) are read from the
 * ledger and checked against the live process table via `kill(0)`/`ps`. This is
 * the cheap, contention-free polling path `acquireLease` uses while a healthy
 * runner is busy: a queued job reads the pool and sleeps rather than grabbing
 * `BEGIN IMMEDIATE` every cycle, so it never contends with the running job's
 * write transactions. The actual reclaim/claim write happens later, under lock.
 */
export function evaluateStaleRunning(
  db: Database.Database,
  projectRoot: string,
  ttlMs: number,
): RunningLeaseEvaluation {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const rows = db.prepare(`
    SELECT run_id AS runId, runner_pid AS runnerPid,
           runner_pid_started_at AS runnerPidStartedAt, runner_host AS runnerHost,
           heartbeat_at AS heartbeatAt, started_at AS startedAt
    FROM findings_ledger_runs
    WHERE project_root = ? AND status = 'running'
  `).all(projectRoot) as Array<{
    runId: string;
    runnerPid: number | null;
    runnerPidStartedAt: string | null;
    runnerHost: string | null;
    heartbeatAt: string | null;
    startedAt: string | null;
  }>;

  const thisHost = hostname();
  const reclaimable: ReclaimCandidate[] = [];
  for (const c of rows) {
    const stale =
      (c.heartbeatAt !== null && c.heartbeatAt < cutoff) ||
      (c.heartbeatAt === null && c.startedAt !== null && c.startedAt < cutoff);
    if (!stale) continue; // a fresh heartbeat is never reclaimed, even for a dead PID
    let reason: string | null;
    if (c.runnerHost !== null && c.runnerHost !== thisHost) {
      // Foreign host: the PID names a process on another machine, so it is
      // meaningless here — fall back to the heartbeat (already stale).
      reason = `runner lease expired (no heartbeat; foreign host ${c.runnerHost})`;
    } else if (c.runnerPid === null) {
      // Pre-migration row without a recorded PID: stale heartbeat is authoritative.
      reason = 'runner lease expired (no heartbeat)';
    } else if (!isSameProcessAlive(c.runnerPid, c.runnerPidStartedAt)) {
      reason = `runner process exited (pid ${c.runnerPid})`;
    } else {
      reason = null; // same live process — a stale heartbeat alone does not reclaim
    }
    if (reason !== null) reclaimable.push({ runId: c.runId, reason });
  }
  return { runningCount: rows.length, cutoff, reclaimable };
}

/**
 * Write half of reclaim: mark already-evaluated `reclaimable` rows as `failed`.
 * The `UPDATE` re-checks `status='running'` + the stale condition under the
 * caller's transaction, so a heartbeat refreshed between evaluation and this
 * write is not wrongly reclaimed. Does not open its own transaction — callers
 * wrap it in one (or rely on it being a single implicit transaction otherwise).
 */
export function markRunsFailed(
  db: Database.Database,
  reclaimable: ReclaimCandidate[],
  cutoff: string,
): number {
  if (reclaimable.length === 0) return 0;
  const now = new Date().toISOString();
  const reclaim = db.prepare(`
    UPDATE findings_ledger_runs
    SET status = 'failed', error = ?, finished_at = ?
    WHERE run_id = ?
      AND status = 'running'
      AND (
        (heartbeat_at IS NOT NULL AND heartbeat_at < ?)
        OR
        (heartbeat_at IS NULL AND started_at IS NOT NULL AND started_at < ?)
      )
  `);
  let reclaimed = 0;
  for (const c of reclaimable) {
    reclaimed += reclaim.run(c.reason, now, c.runId, cutoff, cutoff).changes;
  }
  return reclaimed;
}

/**
 * Mark `running` runs whose heartbeat is stale (or absent with a stale start
 * time) as `failed` — but only when their runner is genuinely gone. The PID the
 * child recorded at lease claim is the primary liveness signal: a `running` row
 * whose PID is still the same live process is skipped (a healthy child whose
 * synchronous `syncFileIndex` phase starves the event loop keeps its lease
 * through a stale heartbeat). Rows with no PID (pre-migration) or from a foreign
 * host fall back to the heartbeat. Called before lease acquisition and by read
 * paths so a killed runner surfaces as failed rather than wedging the queue.
 * Returns the number of runs reclaimed.
 */
export function reclaimStaleRunning(db: Database.Database, projectRoot: string, ttlMs: number): number {
  const { cutoff, reclaimable } = evaluateStaleRunning(db, projectRoot, ttlMs);
  return markRunsFailed(db, reclaimable, cutoff);
}

/**
 * Delete all but the newest `keepN` runs for a project root. Findings and
 * coverage cascade via `ON DELETE CASCADE` (foreign_keys is ON). Returns the
 * number of runs pruned.
 */
export function pruneLedgerRuns(db: Database.Database, projectRoot: string, keepN: number): number {
  const rows = db.prepare(`
    SELECT run_id FROM findings_ledger_runs WHERE project_root = ? ORDER BY timestamp DESC, run_id DESC
  `).all(projectRoot) as Array<{ run_id: string }>;
  const toDelete = rows.slice(Math.max(0, keepN));
  const del = db.prepare('DELETE FROM findings_ledger_runs WHERE run_id = ?');
  for (const r of toDelete) del.run(r.run_id);
  return toDelete.length;
}

// ── Auto-detect git info ──────────────────────────────────────────────────

export function detectRunInput(
  command: string,
  surface: LedgerRunInput['surface'],
  scope: string,
  target: string,
  toolVersion: string,
): LedgerRunInput {
  const git = getGitInfo(target);
  return {
    gitSha: git.sha,
    gitDirty: git.dirty,
    toolVersion,
    command,
    surface,
    scope,
    target,
  };
}

// ── Reading ───────────────────────────────────────────────────────────────

export function listRuns(db: Database.Database): LedgerRunSummary[] {
  const rows = db.prepare(`
    SELECT
      r.run_id AS runId,
      r.timestamp,
      r.command,
      r.surface,
      r.scope,
      r.duration_ms AS durationMs,
      r.exit_status AS exitStatus,
      r.git_sha AS gitSha,
      COUNT(f.id) AS findingCount
    FROM findings_ledger_runs r
    LEFT JOIN findings_ledger_findings f ON f.run_id = r.run_id
    GROUP BY r.run_id
    ORDER BY r.timestamp DESC
  `).all() as any[];

  return rows.map((r) => ({
    runId: r.runId,
    timestamp: r.timestamp,
    command: r.command,
    surface: r.surface,
    scope: r.scope,
    findingCount: r.findingCount,
    durationMs: r.durationMs,
    exitStatus: r.exitStatus,
    gitSha: r.gitSha,
  }));
}

export function exportLedger(
  db: Database.Database,
  since?: string,
): { runs: LedgerRunRecord[]; findings: LedgerFindingRecord[] } {
  const runParams: any[] = [];
  let runWhere = '';
  if (since) {
    runWhere = 'WHERE timestamp >= ?';
    runParams.push(since);
  }

  const runs = db.prepare(`
    SELECT
      run_id AS runId,
      timestamp,
      git_sha AS gitSha,
      git_dirty AS gitDirty,
      tool_version AS toolVersion,
      command,
      surface,
      scope,
      target,
      duration_ms AS durationMs,
      exit_status AS exitStatus
    FROM findings_ledger_runs
    ${runWhere}
    ORDER BY timestamp DESC
  `).all(...runParams) as any[];

  const runIds = runs.map((r) => r.runId);
  let findings: any[] = [];
  if (runIds.length > 0) {
    const placeholders = runIds.map(() => '?').join(',');
    findings = db.prepare(`
      SELECT
        run_id AS runId,
        analyzer,
        rule,
        severity,
        message,
        file,
        line,
        symbol,
        fingerprint
      FROM findings_ledger_findings
      WHERE run_id IN (${placeholders})
      ORDER BY run_id, id
    `).all(...runIds) as any[];
  }

  return {
    runs: runs.map((r) => ({
      ...r,
      gitDirty: !!r.gitDirty,
      timestamp: String(r.timestamp),
    })),
    findings: findings.map((f) => ({
      ...f,
      line: f.line ?? null,
      symbol: String(f.symbol ?? ''),
      fingerprint: String(f.fingerprint ?? ''),
    })),
  };
}

// ── Trends (Spec 13 R4) ──────────────────────────────────────────────────────

export interface TrendRuleSummary {
  rule: string;
  newCount: number;
  fixedCount: number;
  net: number;
}

export interface TrendRunPair {
  previousRunId: string;
  previousTimestamp: string;
  currentRunId: string;
  currentTimestamp: string;
}

export interface TrendReport {
  target: string;
  runPairs: TrendRunPair[];
  timeRange: { start: string; end: string };
  perRule: Record<string, TrendRuleSummary>;
}

/**
 * Compare consecutive full-audit runs of the same target and report per-rule
 * new/fixed/net trends. Non-full runs are excluded. If fewer than 2 comparable
 * runs exist, returns null.
 *
 * @param db        The better-sqlite3 database handle.
 * @param sinceRunId  Only consider runs after this run ID.
 */
export function getTrends(db: Database.Database, sinceRunId?: string): TrendReport | null {
  // 1. Fetch full-scope runs, optionally filtered by sinceRunId
  let runQuery = `
    SELECT run_id, timestamp, target, scope
    FROM findings_ledger_runs
    WHERE scope = 'full'
  `;
  const params: any[] = [];

  if (sinceRunId) {
    // We need the timestamp of the sinceRunId to filter runs after it
    const sinceRow = db.prepare(
      'SELECT timestamp FROM findings_ledger_runs WHERE run_id = ?',
    ).get(sinceRunId) as { timestamp: string } | undefined;
    if (sinceRow) {
      runQuery += ' AND timestamp > ?';
      params.push(sinceRow.timestamp);
    }
  }

  runQuery += ' ORDER BY timestamp ASC';
  const runs = db.prepare(runQuery).all(...params) as Array<{
    run_id: string; timestamp: string; target: string; scope: string;
  }>;

  // 2. Group runs by target, then find consecutive pairs
  const runsByTarget = new Map<string, typeof runs>();
  for (const r of runs) {
    const list = runsByTarget.get(r.target) ?? [];
    list.push(r);
    runsByTarget.set(r.target, list);
  }

  // Pick the target with the most runs as the primary (matches common CLI usage)
  let bestRuns: typeof runs = [];
  for (const [, list] of runsByTarget) {
    if (list.length > bestRuns.length) bestRuns = list;
  }

  if (bestRuns.length < 2) return null;

  const target = bestRuns[0].target;

  // 3. For each consecutive pair, compare fingerprint sets per rule
  const runPairs: TrendRunPair[] = [];
  const ruleAccum: Map<string, { newCount: number; fixedCount: number }> = new Map();

  const getFingerprints = db.prepare(`
    SELECT analyzer || '/' || rule AS rule, fingerprint
    FROM findings_ledger_findings
    WHERE run_id = ?
  `);

  for (let i = 1; i < bestRuns.length; i++) {
    const prev = bestRuns[i - 1];
    const curr = bestRuns[i];

    const prevFindings = getFingerprints.all(prev.run_id) as Array<{ rule: string; fingerprint: string }>;
    const currFindings = getFingerprints.all(curr.run_id) as Array<{ rule: string; fingerprint: string }>;

    // Build fingerprint sets per rule
    const prevFps = new Map<string, Set<string>>();
    for (const f of prevFindings) {
      const s = prevFps.get(f.rule) ?? new Set();
      s.add(f.fingerprint);
      prevFps.set(f.rule, s);
    }

    const currFps = new Map<string, Set<string>>();
    for (const f of currFindings) {
      const s = currFps.get(f.rule) ?? new Set();
      s.add(f.fingerprint);
      currFps.set(f.rule, s);
    }

    // All rules that appear in either run
    const allRules = new Set([...prevFps.keys(), ...currFps.keys()]);

    for (const rule of allRules) {
      const prevSet = prevFps.get(rule) ?? new Set();
      const currSet = currFps.get(rule) ?? new Set();

      // New: present in current, absent in previous
      let newCount = 0;
      for (const fp of currSet) {
        if (!prevSet.has(fp)) newCount++;
      }

      // Fixed: absent in current, present in previous
      let fixedCount = 0;
      for (const fp of prevSet) {
        if (!currSet.has(fp)) fixedCount++;
      }

      if (newCount > 0 || fixedCount > 0) {
        const acc = ruleAccum.get(rule) ?? { newCount: 0, fixedCount: 0 };
        acc.newCount += newCount;
        acc.fixedCount += fixedCount;
        ruleAccum.set(rule, acc);
      }
    }

    runPairs.push({
      previousRunId: prev.run_id,
      previousTimestamp: prev.timestamp,
      currentRunId: curr.run_id,
      currentTimestamp: curr.timestamp,
    });
  }

  // 4. Build per-rule output
  const perRule: Record<string, TrendRuleSummary> = {};
  for (const [rule, acc] of ruleAccum) {
    perRule[rule] = {
      rule,
      newCount: acc.newCount,
      fixedCount: acc.fixedCount,
      net: acc.fixedCount - acc.newCount,
    };
  }

  return {
    target,
    runPairs,
    timeRange: {
      start: bestRuns[0].timestamp,
      end: bestRuns[bestRuns.length - 1].timestamp,
    },
    perRule,
  };
}

export function getLedgerStats(db: Database.Database): LedgerStats {
  const totalRuns = (db.prepare('SELECT COUNT(*) AS cnt FROM findings_ledger_runs').get() as any).cnt;

  const findingRows = db.prepare(`
    SELECT analyzer, rule, severity, COUNT(*) AS cnt
    FROM findings_ledger_findings
    GROUP BY analyzer, rule, severity
    ORDER BY analyzer, rule, severity
  `).all() as any[];

  const perAnalyzer: LedgerStats['perAnalyzer'] = {};
  for (const row of findingRows) {
    if (!perAnalyzer[row.analyzer]) {
      perAnalyzer[row.analyzer] = { total: 0, perRule: {}, severityDistribution: {} };
    }
    perAnalyzer[row.analyzer].total += row.cnt;
    perAnalyzer[row.analyzer].perRule[row.rule] =
      (perAnalyzer[row.analyzer].perRule[row.rule] || 0) + row.cnt;
    perAnalyzer[row.analyzer].severityDistribution[row.severity] =
      (perAnalyzer[row.analyzer].severityDistribution[row.severity] || 0) + row.cnt;
  }

  return { totalRuns, perAnalyzer };
}

// ── D1 Interim Import ─────────────────────────────────────────────────────

/**
 * D1 interim archive format (Directive D1): directory of JSON files per run.
 * Each file: { timestamp, command, surface, scope, violations: [...] }
 * This is a legacy bridge — D1 is retired once the interim directory is ingested.
 */
export interface D1InterimRun {
  timestamp?: string;
  command?: string;
  surface?: string;
  scope?: string;
  target?: string;
  toolVersion?: string;
  violations?: Array<{
    analyzer?: string;
    rule?: string;
    severity?: string;
    message?: string;
    file?: string;
    line?: number;
    symbol?: string;
  }>;
}

export function importLedgerFromDir(db: Database.Database, dirPath: string): { imported: number; skipped: number } {
  if (!existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const files = readdirSync(dirPath).filter((f) => f.endsWith('.json'));
  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    try {
      const raw = readFileSync(join(dirPath, file), 'utf-8');
      const data: D1InterimRun = JSON.parse(raw);

      if (!data.violations) {
        skipped++;
        continue;
      }

      const violations: Violation[] = data.violations.map((v) => ({
        file: v.file || 'unknown',
        line: v.line,
        severity: (v.severity as any) || 'suggestion',
        message: v.message || '',
        analyzer: v.analyzer || 'unknown',
        rule: v.rule || 'unknown',
        symbol: v.symbol || '',
      }));

      const runInput: LedgerRunInput = {
        gitDirty: false,
        toolVersion: data.toolVersion || 'unknown',
        command: data.command || 'imported',
        surface: (data.surface as any) || 'cli',
        scope: data.scope || 'full',
        target: data.target || dirPath,
      };

      writeAuditToLedger(db, runInput, violations, 0, 0);
      imported++;
    } catch {
      skipped++;
    }
  }

  return { imported, skipped };
}
