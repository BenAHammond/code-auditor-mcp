import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fork, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpus, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  AnalyzerResult,
  AuditResult,
  AuditRunnerOptions,
  AuditScope,
  FunctionMetadata,
  RuleCoverage,
  Severity,
  Violation,
} from './types.js';
import Database from 'better-sqlite3';
import { CodeIndexDB } from './codeIndexDB.js';
import { CodeMapGenerator } from './services/CodeMapGenerator.js';
import { analyzeDocumentation } from './analyzers/documentationAnalyzer.js';
import { assertAuditPathExists, ContextualError } from './mcpToolErrors.js';
import { createAuditJob, getAuditJob, patchAuditJob, setAuditJobProgress } from './services/auditJobService.js';
import {
  detectRunInput,
  evaluateStaleRunning,
  hashFileSet,
  markRunsFailed,
  patchLedgerRun,
  writeAuditToLedger,
} from './ledger.js';
import { PACKAGE_VERSION } from './constants.js';
import { mcpDebugStderr } from './mcpDiagnostics.js';
import { findFiles } from './utils/fileDiscovery.js';
import { makeVisitorStatus, getFilesProcessed, violationMatchesRule } from './pipeline.js';
import { RULE_REGISTRY } from './analyzers/ruleRegistry.js';
import type {
  ParentToWorkerMessage,
  SerializableAuditRunConfig,
  WorkerToParentMessage,
} from './workers/auditWorkerProtocol.js';
import chalk from 'chalk';

type StartAuditDefaults = {
  defaultAnalyzers: string[];
  defaultMinSeverity: Severity;
  defaultGenerateCodeMap: boolean;
};

type PartitionStrategy = 'none' | 'auto' | 'top-level';

export type PartitionPlan = {
  mode: 'none' | 'top-level';
  partitionPaths: string[];
  globalAnalyzers: string[];
  shardedAnalyzers: string[];
};

const SOURCE_FOLDERS = ['app', 'src'];
// Cross-file reducers run once over the FULL scope, never inside partition
// shards. A shard sees only its partition's files and (worse) reads shared
// index tables that other shards are still writing, so any reducer that reads
// accumulated state must be global. The set is every reducer/derived-reducer
// in the pipeline stage model:
//   dry         — cross-file duplicate detection over the function index
//   data-access — per-file, but kept global so its coverage/status is a single
//                 full-scope row (harmless to shard, but global is uniform)
//   schema      — schema_usage reducers (unknown-table, JSON validation)
//   styles      — reads style_declarations/tokens/class_usage written by the
//                 styles-css visitor + syncStyleIndex (same analyzer gate)
//   conventions — reads function_calls/conventions via updateDependencyGraph +
//                 mineAllConventions (same analyzer gate)
//   invariants  — call-constraint/module-boundary need the full file list
//   cross-domain— reads schema_usage/indexed_functions/graph_cache (stage 4)
const GLOBAL_ONLY_ANALYZERS = new Set([
  'dry',
  'data-access',
  'schema',
  'styles',
  'conventions',
  'invariants',
  'cross-domain',
]);
const RETRYABLE_ERROR_PATTERNS = [/timed out/i, /timeout/i, /econnreset/i, /eagain/i, /emfile/i];

/** Hard cap so pathological configs cannot fork unbounded processes. */
const MAX_AUDIT_WORKERS = 8;
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const ABSOLUTE_MAX_JOB_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MIN_JOB_TIMEOUT_MS = 60 * 1000;

function defaultJobTimeoutMs(): number {
  const raw = process.env.CODE_AUDITOR_JOB_TIMEOUT_MS;
  if (!raw) return DEFAULT_JOB_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_JOB_TIMEOUT_MS) return DEFAULT_JOB_TIMEOUT_MS;
  return Math.min(n, ABSOLUTE_MAX_JOB_TIMEOUT_MS);
}

// Spec 41 R5 — heartbeat-based concurrency lease. A plain `status='running'`
// count wedges the queue behind a crashed job's ghost row forever; a stale
// heartbeat is reclaimable instead.
const DEFAULT_JOB_LEASE_TTL_MS = 30 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 1;

function jobLeaseTtlMs(): number {
  const raw = process.env.CODE_AUDITOR_JOB_LEASE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_JOB_LEASE_TTL_MS;
}

function maxRunningJobs(): number {
  const raw = process.env.CODE_AUDITOR_MAX_RUNNING_JOBS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_RUNNING_JOBS;
}

/** True when a write hit better-sqlite3's busy timeout under lock contention. */
function isBusyError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: string }).code;
  return code === 'SQLITE_BUSY' || /database is locked/i.test(e.message);
}

/**
 * Claims the `running` slot for `jobId`. The reclaim-then-count-then-claim
 * sequence runs under `BEGIN IMMEDIATE` because the lease is contested by
 * separate forked processes (better-sqlite3 serializes writes per-connection,
 * not per-DB) — without the write lock two children could both see zero
 * `running` rows and both claim the slot. Stale `running` rows (killed runners)
 * are reclaimed first, so a ghost never wedges the queue.
 *
 * The polling path is deliberately read-only: while a healthy runner holds the
 * slot, a queued job evaluates the lease pool via `evaluateStaleRunning` (SELECT
 * + `kill(0)`/`ps`, no write lock) and sleeps. It only grabs `BEGIN IMMEDIATE`
 * when the pool shows a free slot or a reclaimable ghost. Grabbing the write
 * lock every poll would contend with the running job's own write transactions
 * (the long `syncFileIndex`/`updateDependencyGraph` phase) and crash it with
 * `database is locked`.
 */
async function acquireLease(db: Database.Database, projectRoot: string, jobId: string): Promise<void> {
  const ttl = jobLeaseTtlMs();
  const limit = maxRunningJobs();
  const now = () => new Date().toISOString();

  // The transaction only performs the *write* half of reclaim — `reclaimable`
  // and `cutoff` are computed read-only outside the lock (see below), so the
  // `ps` liveness check never runs while holding the write lock.
  const claim = db.transaction((reclaimable: Parameters<typeof markRunsFailed>[1], cutoff: string): boolean => {
    markRunsFailed(db, reclaimable, cutoff);
    const row = db
      .prepare('SELECT COUNT(*) AS cnt FROM findings_ledger_runs WHERE project_root = ? AND status = ?')
      .get(projectRoot, 'running') as { cnt: number };
    if (row.cnt < limit) {
      // Record PID-based liveness at claim (Spec 41 Amendment B): the child's
      // PID + process start time (defeats PID reuse) + hostname (foreign hosts
      // fall back to the heartbeat). `process.uptime()` in the forked child is
      // measured from the child's start, so `now - uptime` is its true start.
      patchLedgerRun(db, jobId, {
        status: 'running',
        startedAt: now(),
        heartbeatAt: now(),
        runnerPid: process.pid,
        runnerPidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        runnerHost: hostname(),
      });
      return true;
    }
    return false;
  });

  for (;;) {
    // Read-only evaluation — no write lock, so it never contends with the
    // running job's write transactions (the `ps` spawn for a stale-heartbeat
    // candidate happens here, outside the lock).
    const evaluation = evaluateStaleRunning(db, projectRoot, ttl);
    const mightClaim = evaluation.runningCount < limit || evaluation.reclaimable.length > 0;
    if (mightClaim) {
      try {
        if (claim.immediate(evaluation.reclaimable, evaluation.cutoff)) return;
      } catch (e) {
        // The lease is contested by separate forked processes. A running job can
        // hold the write lock longer than the busy timeout (e.g. the long
        // `writeAuditToLedger` completion transaction), surfacing as SQLITE_BUSY.
        // That is contention, not failure — wait and retry rather than failing
        // the queued job (which would cascade into failing the running job too).
        if (isBusyError(e)) {
          await new Promise((resolve) => setTimeout(resolve, Math.max(250, Math.floor(ttl / 4))));
          continue;
        }
        throw e;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, Math.floor(ttl / 4))));
  }
}

type WorkerShardTask = {
  shardId: string;
  config: SerializableAuditRunConfig;
  attempts: number;
};

function resolveWorkerEntrypoint(): string {
  const current = fileURLToPath(import.meta.url);
  const ext = path.extname(current);
  const dir = path.dirname(current);
  const filename = ext === '.ts' ? 'auditWorker.ts' : 'auditWorker.js';
  return path.join(dir, 'workers', filename);
}

/** Entrypoint for the detached CLI runner (Spec 41 `--detach`). */
export function resolveJobRunnerEntrypoint(): string {
  const current = fileURLToPath(import.meta.url);
  const ext = path.extname(current);
  const dir = path.dirname(current);
  const filename = ext === '.ts' ? 'auditJobRunner.ts' : 'auditJobRunner.js';
  return path.join(dir, 'workers', filename);
}

function asSerializableConfig(options: AuditRunnerOptions): SerializableAuditRunConfig {
  return {
    projectRoot: options.projectRoot || process.cwd(),
    includePaths: options.includePaths,
    excludePaths: options.excludePaths,
    fileExtensions: options.fileExtensions,
    minSeverity: options.minSeverity as Severity | undefined,
    enabledAnalyzers: options.enabledAnalyzers,
    indexFunctions: options.indexFunctions,
    analyzerConfigs: options.analyzerConfigs,
    analyzerConcurrency: options.analyzerConcurrency,
    explicitFiles: options.explicitFiles,
    maxFilesPerRun: options.maxFilesPerRun,
    shardSoftBudgetMs: options.shardSoftBudgetMs,
  };
}

function isRetryableShardError(error: string): boolean {
  return RETRYABLE_ERROR_PATTERNS.some((p) => p.test(error));
}

async function runShardTasksWithWorkerPool(
  getDb: () => Database.Database,
  jobId: string,
  tasks: WorkerShardTask[],
  options: {
    maxWorkers: number;
    maxRetries: number;
    shardTimeoutMs: number;
    retryBackoffMs: number;
    signal?: AbortSignal;
  }
): Promise<AuditResult[]> {
  if (tasks.length === 0) return [];

  const queue: WorkerShardTask[] = [...tasks];
  const completedResults: AuditResult[] = [];
  const pending = new Map<string, { worker: ChildProcess; task: WorkerShardTask; timer: NodeJS.Timeout }>();
  const workers = new Set<ChildProcess>();
  let runningShards = 0;
  let retryCount = 0;
  let aborted = false;
  let settled = false;

  const spawnCount = Math.max(1, Math.min(options.maxWorkers, tasks.length));
  const workerEntry = resolveWorkerEntrypoint();

  const cleanupWorker = (worker: ChildProcess): void => {
    workers.delete(worker);
    try {
      worker.removeAllListeners();
    } catch {
      // ignore
    }
    try {
      if (worker.connected) worker.disconnect();
    } catch {
      // ignore
    }
    const safeKill = (signal?: NodeJS.Signals): void => {
      try {
        if (signal) worker.kill(signal);
        else worker.kill();
      } catch {
        // ignore
      }
    };
    if (!worker.killed) {
      safeKill('SIGTERM');
      setTimeout(() => {
        if (!worker.killed) {
          safeKill('SIGKILL');
          safeKill();
        }
      }, 750);
    }
  };

  const post = (worker: ChildProcess, message: ParentToWorkerMessage): void => {
    try {
      if (worker.connected && !worker.killed) {
        worker.send(message);
      }
    } catch (e) {
      mcpDebugStderr(chalk.yellow('[WARN]'), 'Failed to send to audit worker (IPC):', e);
    }
  };

  const disposeAllWorkers = (): void => {
    for (const [rid, { worker, timer }] of [...pending.entries()]) {
      clearTimeout(timer);
      post(worker, { kind: 'cancel-request', requestId: rid });
    }
    pending.clear();
    for (const w of [...workers]) {
      cleanupWorker(w);
    }
    workers.clear();
  };

  return await new Promise<AuditResult[]>((resolve, reject) => {
    const finish = (ok: boolean, value: AuditResult[] | Error): void => {
      if (settled) return;
      settled = true;
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      disposeAllWorkers();
      if (ok) resolve(value as AuditResult[]);
      else reject(value);
    };

    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      const reason = options.signal?.reason;
      const msg =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'Audit job was cancelled or exceeded the maximum duration';
      finish(false, new Error(msg));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const progressTotal = (): number =>
      Math.max(tasks.length, completedResults.length + queue.length + runningShards);

    const maybeDispatch = (): void => {
      if (aborted || settled) return;
      if (queue.length === 0 && runningShards === 0 && pending.size === 0) {
        finish(true, completedResults);
        return;
      }

      for (const worker of [...workers]) {
        const hasAssigned = [...pending.values()].some((p) => p.worker === worker);
        if (hasAssigned) continue;
        const next = queue.shift();
        if (!next) continue;
        runningShards++;
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          if (settled || aborted) return;
          const entry = pending.get(requestId);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(requestId);
          runningShards--;

          const timedOutWorker = entry.worker;
          post(timedOutWorker, { kind: 'cancel-request', requestId });
          cleanupWorker(timedOutWorker);
          if (!spawnOneWorker()) {
            aborted = true;
            finish(
              false,
              new Error(
                `Shard '${next.shardId}' timed out after ${options.shardTimeoutMs}ms and a replacement worker could not be started.`
              )
            );
            return;
          }

          const msg = `Shard '${next.shardId}' timed out after ${options.shardTimeoutMs}ms`;
          if (next.attempts < options.maxRetries) {
            next.attempts += 1;
            retryCount++;
            setTimeout(() => {
              queue.push(next);
              setAuditJobProgress(getDb(), jobId, {
                phase: 'analysis',
                message: `Retrying shard ${next.shardId} (${next.attempts}/${options.maxRetries}) after worker recycle`,
                current: completedResults.length,
                total: progressTotal(),
              });
              maybeDispatch();
            }, options.retryBackoffMs * next.attempts);
            maybeDispatch();
            return;
          }
          aborted = true;
          finish(false, new Error(`${msg}. Retries exhausted (${options.maxRetries}).`));
        }, options.shardTimeoutMs);

        pending.set(requestId, { worker, task: next, timer });
        post(worker, {
          kind: 'run-audit-shard',
          requestId,
          shardId: next.shardId,
          config: next.config,
        });
      }
    };

    const workerEndHandled = new WeakSet<ChildProcess>();

    const handleWorkerProcessEnd = (
      proc: ChildProcess,
      code: number | null,
      signal: NodeJS.Signals | null,
      procErr?: Error
    ): void => {
      if (settled || aborted) return;
      if (workerEndHandled.has(proc)) return;
      workerEndHandled.add(proc);

      const wasTracked = workers.has(proc);
      if (wasTracked) {
        workers.delete(proc);
      }
      try {
        proc.removeAllListeners();
      } catch {
        // ignore
      }

      const detail = procErr
        ? `Worker process error: ${procErr.message}`
        : `Worker exited (code=${code}, signal=${signal ?? 'none'})`;

      const orphaned = [...pending.entries()].find(([, v]) => v.worker === proc);
      if (orphaned) {
        clearTimeout(orphaned[1].timer);
        pending.delete(orphaned[0]);
        runningShards--;
        if (!spawnOneWorker()) {
          aborted = true;
          finish(false, new Error(`${detail}; could not spawn replacement worker`));
          return;
        }
        const task = orphaned[1].task;
        if (task.attempts < options.maxRetries) {
          task.attempts += 1;
          retryCount++;
          setTimeout(() => {
            queue.push(task);
            maybeDispatch();
          }, options.retryBackoffMs * task.attempts);
          maybeDispatch();
          return;
        }
        aborted = true;
        finish(false, new Error(`${detail} while running shard '${task.shardId}'`));
        return;
      }

      if (wasTracked && (code !== 0 || signal || procErr)) {
        if (!spawnOneWorker()) {
          mcpDebugStderr(chalk.yellow('[WARN]'), 'Could not replenish audit worker after unexpected exit');
        } else {
          maybeDispatch();
        }
      }
    };

    const handleWorkerMessage = (worker: ChildProcess, raw: unknown): void => {
      if (aborted || settled) return;
      const message = raw as WorkerToParentMessage;
      if (!message || typeof message !== 'object' || !('kind' in message)) return;

      if (message.kind === 'worker-progress') {
        const entry = pending.get(message.requestId);
        if (!entry) return;
        const overallCurrent =
          completedResults.length +
          Math.min(1, (message.progress.current ?? 0) / Math.max(1, message.progress.total ?? 1));
        setAuditJobProgress(getDb(), jobId, {
          phase: message.progress.phase ?? 'analysis',
          message: `${message.shardId}: ${message.progress.message ?? 'running'} (retries=${retryCount})`,
          current: Math.floor(overallCurrent),
          total: progressTotal(),
        });
        return;
      }

      if (message.kind === 'worker-handoff') {
        const entry = pending.get(message.requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(message.requestId);
        runningShards--;
        completedResults.push(message.partialResult);
        queue.push({
          shardId: `${entry.task.shardId}>cont`,
          attempts: 0,
          config: message.continuation,
        });
        setAuditJobProgress(getDb(), jobId, {
          phase: 'analysis',
          message: `Chunk done for ${entry.task.shardId}; queued ${message.remainingFiles.length} remaining file(s) (retries=${retryCount})`,
          current: completedResults.length,
          total: progressTotal(),
        });
        maybeDispatch();
        return;
      }

      if (message.kind === 'worker-result' || message.kind === 'worker-error') {
        const entry = pending.get(message.requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(message.requestId);
        runningShards--;

        if (message.kind === 'worker-result') {
          completedResults.push(message.result);
          setAuditJobProgress(getDb(), jobId, {
            phase: 'analysis',
            message: `Completed shard ${entry.task.shardId} (${completedResults.length} chunk(s), retries=${retryCount})`,
            current: completedResults.length,
            total: progressTotal(),
          });
          maybeDispatch();
          return;
        }

        const errText = message.error || `Shard '${entry.task.shardId}' failed`;
        if (entry.task.attempts < options.maxRetries && isRetryableShardError(errText)) {
          entry.task.attempts += 1;
          retryCount++;
          setTimeout(() => {
            queue.push(entry.task);
            maybeDispatch();
          }, options.retryBackoffMs * entry.task.attempts);
          maybeDispatch();
          return;
        }

        aborted = true;
        finish(false, new Error(`${errText}${message.stack ? `\n${message.stack}` : ''}`));
      }
    };

    const spawnOneWorker = (): boolean => {
      try {
        const proc = fork(workerEntry, [], {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        workers.add(proc);
        proc.on('message', (msg) => handleWorkerMessage(proc, msg));
        proc.on('error', (err) => {
          mcpDebugStderr(chalk.yellow('[WARN]'), 'Audit worker process error:', err);
          handleWorkerProcessEnd(proc, null, null, err instanceof Error ? err : new Error(String(err)));
        });
        proc.on('exit', (code, signal) => {
          handleWorkerProcessEnd(proc, code, signal);
        });
        return true;
      } catch (e) {
        mcpDebugStderr(chalk.red('[ERROR]'), 'fork() failed for audit worker:', e);
        return false;
      }
    };

    for (let i = 0; i < spawnCount; i++) {
      if (!spawnOneWorker()) {
        aborted = true;
        finish(false, new Error('Failed to start audit worker processes'));
        return;
      }
    }

    maybeDispatch();
  });
}

function getAllViolations(result: { analyzerResults?: Record<string, { violations: Violation[] }> }): Violation[] {
  const violations: Violation[] = [];
  for (const [analyzerName, analyzerResult] of Object.entries(result.analyzerResults ?? {})) {
    for (const violation of analyzerResult.violations) {
      violations.push({
        ...violation,
        analyzer: analyzerName,
      });
    }
  }
  return violations;
}

function calculateHealthScore(result: {
  metadata?: { filesAnalyzed?: number };
  summary?: { criticalIssues?: number; warnings?: number; suggestions?: number };
}): number {
  const filesAnalyzed = result.metadata?.filesAnalyzed || 1;
  const critical = result.summary?.criticalIssues || 0;
  const warnings = result.summary?.warnings || 0;
  const suggestions = result.summary?.suggestions || 0;

  const weightedViolations = critical * 10 + warnings * 3 + suggestions * 0.5;
  let score = 100 - (weightedViolations / filesAnalyzed) * 2;
  return Math.max(0, Math.round(Math.min(100, score)));
}

function summarizeAnalyzerResults(analyzerResults: Record<string, AnalyzerResult>, filesAnalyzed: number) {
  let totalViolations = 0;
  let criticalIssues = 0;
  let warnings = 0;
  let suggestions = 0;
  const violationsByCategory: Record<string, number> = {};

  for (const [analyzer, result] of Object.entries(analyzerResults)) {
    for (const violation of result.violations) {
      totalViolations++;
      if (violation.severity === 'critical') criticalIssues++;
      else if (violation.severity === 'warning') warnings++;
      else suggestions++;
      const category = violation.type || analyzer;
      violationsByCategory[category] = (violationsByCategory[category] || 0) + 1;
    }
  }

  // Compute top issues from violationsByCategory
  const topIssues = Object.entries(violationsByCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  return {
    totalFiles: filesAnalyzed,
    totalViolations,
    criticalIssues,
    warnings,
    suggestions,
    violationsByCategory,
    topIssues,
  };
}

function mergeAnalyzerResult(base: AnalyzerResult | undefined, next: AnalyzerResult): AnalyzerResult {
  if (!base) return { ...next, violations: [...next.violations], errors: [...(next.errors || [])] };
  const dedupeKey = (v: Violation): string =>
    `${v.file ?? ''}:${v.line ?? ''}:${v.column ?? ''}:${v.rule ?? ''}:${v.message ?? ''}:${v.severity ?? ''}`;
  const seen = new Set(base.violations.map(dedupeKey));
  const mergedViolations = [...base.violations];
  for (const v of next.violations) {
    const key = dedupeKey(v);
    if (!seen.has(key)) {
      seen.add(key);
      mergedViolations.push(v);
    }
  }
  const baseFP = getFilesProcessed(base.status);
  const nextFP = getFilesProcessed(next.status);
  return {
    ...base,
    violations: mergedViolations,
    status: makeVisitorStatus(baseFP + nextFP),
    executionTime: (base.executionTime || 0) + (next.executionTime || 0),
    errors: [...(base.errors || []), ...(next.errors || [])],
  };
}

/**
 * Merge per-shard coverage rows into the project-wide coverage a synchronous
 * (non-sharded) run would have produced. Every shard's `buildCoverageReport`
 * iterates the full rule registry and emits, for rules whose analyzer that
 * shard did not run, a placeholder `notApplicable` row with reason
 * `analyzer "<name>" not in results`. Those placeholders are filtered out so a
 * rule's real state comes only from the shards that actually ran its analyzer.
 *
 * Precedence across the remaining rows: `fired` wins (its count re-derived from
 * the merged deduped violations — never the summed per-shard counts, which
 * over-count DB-based analyzers that emit full-project findings in every
 * shard), then `clean` (ran somewhere with input present and found nothing)
 * over `unassessed`, over `notApplicable` (only when every shard that ran the
 * rule reported no input). Global-only analyzers (GLOBAL_ONLY_ANALYZERS) run
 * in a single shard over the full scope, so their rows — including Spec 39
 * applicability predicates like `missing-org-filter` — pass through untouched.
 */
function mergeCoverage(
  results: AuditResult[],
  ordered: Record<string, AnalyzerResult>,
): RuleCoverage[] | undefined {
  const rows = results.flatMap((r) => r.metadata?.coverage ?? []);
  if (rows.length === 0) return undefined;

  const byRule = new Map<string, RuleCoverage[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.analyzer, row.ruleId]);
    const group = byRule.get(key);
    if (group) group.push(row);
    else byRule.set(key, [row]);
  }

  const merged: RuleCoverage[] = [];
  for (const [key, group] of byRule) {
    const [analyzer, ruleId] = JSON.parse(key) as [string, string];
    // Rows from shards that did not run this analyzer are placeholders, not a
    // real state. Prefer the shards that ran it; fall back to placeholders only
    // if the analyzer ran nowhere (then the placeholder's reason is truthful).
    const real = group.filter((r) => r.reason !== `analyzer "${analyzer}" not in results`);
    const src = real.length > 0 ? real : group;

    const fired = src.filter((r) => r.state === 'fired');
    if (fired.length > 0) {
      // Derive the fired count from the merged (deduped) violations, exactly as
      // the synchronous path's buildCoverageReport does. Summing per-shard
      // counts would over-count if a DB-based analyzer ever ran in multiple
      // shards (it no longer does — reducers are global-only), but deduping
      // from the merged set stays correct regardless and keeps coverage.count
      // in agreement with the ledger findings count.
      const field = RULE_REGISTRY[ruleId]?.field;
      const dedupedCount = (ordered[analyzer]?.violations ?? []).filter((v) =>
        violationMatchesRule(v, ruleId, field),
      ).length;
      merged.push({
        ruleId,
        analyzer,
        state: 'fired',
        count: dedupedCount,
      });
      continue;
    }
    const clean = src.find((r) => r.state === 'clean');
    if (clean) {
      merged.push({ ruleId, analyzer, state: 'clean', count: 0 });
      continue;
    }
    // Spec 44 bucket 2 — a `cannot-fire` rule is broken in the tool (same verdict
    // every shard), so it outranks a per-shard `unassessed`/`notApplicable`.
    const cannotFire = src.find((r) => r.state === 'cannot-fire');
    if (cannotFire) {
      merged.push({
        ruleId,
        analyzer,
        state: 'cannot-fire',
        count: 0,
        reason: cannotFire.reason,
      });
      continue;
    }
    const unassessed = src.find((r) => r.state === 'unassessed');
    if (unassessed) {
      merged.push({ ruleId, analyzer, state: 'unassessed', count: 0 });
      continue;
    }
    const notApplicable = src.find((r) => r.state === 'notApplicable');
    if (notApplicable) {
      merged.push({
        ruleId,
        analyzer,
        state: 'notApplicable',
        count: 0,
        reason: notApplicable.reason,
      });
      continue;
    }
    merged.push({ ruleId, analyzer, state: src[0].state, count: src[0].count, reason: src[0].reason });
  }

  return merged;
}

function mergeAuditResults(results: AuditResult[], orderedAnalyzers: string[]): AuditResult {
  const analyzerResults: Record<string, AnalyzerResult> = {};
  const fileToFunctionsMap: Record<string, FunctionMetadata[]> = {};
  const collectedFunctions: FunctionMetadata[] = [];
  const recommendations: any[] = [];
  const skippedFiles: NonNullable<AuditResult['metadata']['skippedFiles']> = [];
  const unparsedFiles: NonNullable<AuditResult['metadata']['unparsedFiles']> = [];
  const diagnostics: NonNullable<AuditResult['metadata']['diagnostics']> = [];
  let filesAnalyzed = 0;
  let auditDuration = 0;
  let provenanceResolutionMs = 0;
  let tableCatalog: NonNullable<AuditResult['metadata']['tableCatalog']> | undefined;

  for (const result of results) {
    for (const [analyzerName, analyzerResult] of Object.entries(result.analyzerResults || {})) {
      analyzerResults[analyzerName] = mergeAnalyzerResult(analyzerResults[analyzerName], analyzerResult);
    }
    for (const [fp, funcs] of Object.entries(result.metadata?.fileToFunctionsMap || {})) {
      fileToFunctionsMap[fp] = funcs;
    }
    if (result.metadata?.collectedFunctions) {
      collectedFunctions.push(...result.metadata.collectedFunctions);
    }
    if (result.metadata?.skippedFiles) skippedFiles.push(...result.metadata.skippedFiles);
    if (result.metadata?.unparsedFiles) unparsedFiles.push(...result.metadata.unparsedFiles);
    if (result.metadata?.diagnostics) diagnostics.push(...result.metadata.diagnostics);
    // tableCatalog is produced by the schema analyzer, which is global-only and
    // therefore runs in a single shard over the full scope — first non-undefined
    // is the whole catalog, never a fragment.
    if (result.metadata?.tableCatalog && tableCatalog === undefined) {
      tableCatalog = result.metadata.tableCatalog;
    }
    filesAnalyzed += result.metadata?.filesAnalyzed || 0;
    auditDuration += result.metadata?.auditDuration || 0;
    provenanceResolutionMs += result.metadata?.provenanceResolutionMs || 0;
    if (result.recommendations?.length) recommendations.push(...result.recommendations);
  }

  const ordered: Record<string, AnalyzerResult> = {};
  for (const name of orderedAnalyzers) {
    if (analyzerResults[name]) ordered[name] = analyzerResults[name];
  }

  const coverage = mergeCoverage(results, ordered);

  return {
    timestamp: new Date(),
    summary: summarizeAnalyzerResults(ordered, filesAnalyzed),
    analyzerResults: ordered,
    recommendations,
    metadata: {
      auditDuration,
      filesAnalyzed,
      analyzersRun: orderedAnalyzers,
      provenanceResolutionMs,
      ...(collectedFunctions.length > 0 && { collectedFunctions }),
      ...(Object.keys(fileToFunctionsMap).length > 0 && { fileToFunctionsMap }),
      ...(coverage !== undefined && { coverage }),
      ...(tableCatalog !== undefined && { tableCatalog }),
      ...(skippedFiles.length > 0 && { skippedFiles }),
      ...(unparsedFiles.length > 0 && { unparsedFiles }),
      ...(diagnostics.length > 0 && { diagnostics }),
    },
  };
}

export async function derivePartitionPlan(
  args: any,
  projectRoot: string,
  isFile: boolean,
  enabledAnalyzers: string[]
): Promise<PartitionPlan> {
  const strategy = ((args.partitionStrategy as string) || 'auto') as PartitionStrategy;
  if (isFile || strategy === 'none') {
    return { mode: 'none', partitionPaths: [], globalAnalyzers: enabledAnalyzers, shardedAnalyzers: [] };
  }

  const allFiles = await findFiles(projectRoot);
  const threshold = Math.max(1, Number(args.partitionThresholdFiles) || 250);
  if (strategy === 'auto' && allFiles.length < threshold) {
    return { mode: 'none', partitionPaths: [], globalAnalyzers: enabledAnalyzers, shardedAnalyzers: [] };
  }

  const byTop = new Map<string, number>();
  for (const file of allFiles) {
    const rel = path.relative(projectRoot, file);
    if (!rel || rel.startsWith('..')) continue;
    const seg = rel.split(path.sep)[0];
    byTop.set(seg, (byTop.get(seg) || 0) + 1);
  }

  const preferred = SOURCE_FOLDERS.filter((name) => byTop.has(name));
  const others = [...byTop.entries()]
    .filter(([name]) => !preferred.includes(name))
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  const maxPartitions = Math.max(1, Number(args.maxPartitions) || 4);
  let selected = [...preferred, ...others].slice(0, maxPartitions);

  if (selected.length < 2 && preferred.length > 0) {
    const focus = preferred[0];
    const focusDir = path.join(projectRoot, focus);
    try {
      const entries = await fs.readdir(focusDir, { withFileTypes: true });
      const subdirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(focus, e.name))
        .slice(0, maxPartitions);
      if (subdirs.length >= 2) {
        selected = subdirs;
      }
    } catch {
      // Ignore fallback partitioning errors
    }
  }

  const shardedAnalyzers = enabledAnalyzers.filter((a) => !GLOBAL_ONLY_ANALYZERS.has(a));
  const globalAnalyzers = enabledAnalyzers.filter((a) => GLOBAL_ONLY_ANALYZERS.has(a));

  if (selected.length < 2 || shardedAnalyzers.length === 0) {
    return { mode: 'none', partitionPaths: [], globalAnalyzers: enabledAnalyzers, shardedAnalyzers: [] };
  }

  return {
    mode: 'top-level',
    partitionPaths: selected.map((seg) => path.join(projectRoot, seg)),
    globalAnalyzers,
    shardedAnalyzers,
  };
}

export async function startAuditJob(args: any, defaults: StartAuditDefaults): Promise<{
  jobId: string;
  status: 'queued';
  path: string;
}> {
  const auditPath = path.resolve((args.path as string) || process.cwd());
  const { isFile } = await assertAuditPathExists(auditPath);
  const projectRoot = isFile ? path.dirname(auditPath) : auditPath;

  const db = CodeIndexDB.getInstance(undefined, projectRoot);
  await db.initialize();
  const job = createAuditJob(db.rawDb, projectRoot, { surface: 'mcp', command: 'audit.start' });

  setTimeout(() => {
    void runAuditJob(job.jobId, args, defaults).catch((err) => {
      try {
        patchAuditJob(db.rawDb, job.jobId, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
          progress: { phase: 'failed', message: 'Audit failed' },
        });
      } catch {
        // ignore secondary failures — never let an audit rejection crash the MCP process
      }
    });
  }, 0);

  return {
    jobId: job.jobId,
    status: 'queued',
    path: auditPath,
  };
}

export async function runAuditJob(jobId: string, args: any, defaults: StartAuditDefaults): Promise<void> {
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Declared as `| undefined` so a failure thrown before the DB handle resolves
  // is still catchable; getJobDb() asserts it via `!` and the catch block
  // swallows the resulting throw rather than masking the original error.
  let db: CodeIndexDB | undefined;
  const ac = new AbortController();

  // All progress/heartbeat writes go through the singleton connection — there is
  // no transient second connection. A detached run forks shard workers, each of
  // which opens its own SQLite connection to the shared per-project DB;
  // better-sqlite3 opens its fd O_CLOEXEC, so forked children never inherit this
  // parent's fd. A second open connection to the same WAL database left open
  // into the indexing loop participates in the shared -shm state and makes the
  // parent's deferred read→write transactions fail with "database is locked" —
  // the defect that originally motivated a separate progress connection, so this
  // stays a single connection throughout.
  const getJobDb = (): Database.Database => db!.rawDb;

  try {
    const auditPath = path.resolve((args.path as string) || process.cwd());
    const { isFile } = await assertAuditPathExists(auditPath);
    const projectRoot = isFile ? path.dirname(auditPath) : auditPath;

    // Open the per-project DB so a detached child resolves the same DB as the
    // parent, not the child's cwd.
    db = CodeIndexDB.getInstance(undefined, projectRoot);
    await db.initialize();

    // Spec 41 R5 — heartbeat lease in the prologue, before queued→running.
    await acquireLease(db.rawDb, projectRoot, jobId);

    patchAuditJob(db.rawDb, jobId, {
      progress: { phase: 'queued', message: 'Audit queued' },
    });

    const startedMs = Date.now();
    const heartbeatMs = Math.max(1000, Math.floor(jobLeaseTtlMs() / 2));
    heartbeat = setInterval(() => {
      try {
        patchLedgerRun(getJobDb(), jobId, { heartbeatAt: new Date().toISOString() });
      } catch (e) {
        // best-effort — a lost beat only matters after the lease TTL expires
      }
    }, heartbeatMs);

    const indexFunctions = (args.indexFunctions as boolean) !== false;
    const generateCodeMap = (args.generateCodeMap as boolean) ?? defaults.defaultGenerateCodeMap;

    const jobTimeoutMs = Math.min(
      ABSOLUTE_MAX_JOB_TIMEOUT_MS,
      Math.max(MIN_JOB_TIMEOUT_MS, Number(args.jobTimeoutMs) || defaultJobTimeoutMs())
    );
    jobTimer = setTimeout(() => {
      try {
        ac.abort(new Error(`Audit job exceeded maximum duration (${jobTimeoutMs}ms)`));
      } catch {
        ac.abort();
      }
    }, jobTimeoutMs);

    const storedConfigs = await db.getAllAnalyzerConfigs(auditPath);
    const analyzerConfigs = {
      ...storedConfigs,
      ...(args.analyzerConfigs as Record<string, unknown> || {}),
    };

    const enabledAnalyzers = (args.analyzers as string[]) || defaults.defaultAnalyzers;
    const maxWorkers = Math.max(
      1,
      Math.min(
        MAX_AUDIT_WORKERS,
        Number(args.workerCount) || Math.max(1, Math.min(4, cpus().length - 1 || 1)),
        Number(args.maxPartitions) || 4
      )
    );
    const maxRetries = Math.max(0, Number(args.maxRetries) || 1);
    const shardTimeoutMs = Math.max(5_000, Number(args.shardTimeoutMs) || 180_000);
    const retryBackoffMs = Math.max(100, Number(args.retryBackoffMs) || 500);

    const maxFilesPerRun =
      typeof args.maxFilesPerRun === 'number' && args.maxFilesPerRun > 0
        ? Math.floor(args.maxFilesPerRun)
        : undefined;
    const shardSoftBudgetMs =
      typeof args.shardSoftBudgetMs === 'number' && args.shardSoftBudgetMs > 0
        ? Math.max(1_000, Math.floor(args.shardSoftBudgetMs))
        : undefined;

    const baseOptions: AuditRunnerOptions = {
      projectRoot,
      enabledAnalyzers,
      minSeverity: ((args.minSeverity as string) || defaults.defaultMinSeverity) as Severity,
      verbose: false,
      indexFunctions,
      analyzerConcurrency:
        typeof args.analyzerConcurrency === 'number'
          ? Math.max(1, Math.floor(args.analyzerConcurrency))
          : undefined,
      ...(maxFilesPerRun !== undefined && { maxFilesPerRun }),
      ...(shardSoftBudgetMs !== undefined && { shardSoftBudgetMs }),
      ...(isFile && { includePaths: [auditPath] }),
      ...(Object.keys(analyzerConfigs).length > 0 && { analyzerConfigs }),
      ...(args.scope && args.scope !== 'all' && { scope: args.scope as AuditScope }),
      progressCallback: (p) => {
        setAuditJobProgress(getJobDb(), jobId, {
          phase: p.phase ?? 'analysis',
          message: p.message ?? p.phase ?? 'running',
          current: typeof p.current === 'number' ? p.current : undefined,
          total: typeof p.total === 'number' ? p.total : undefined,
        });
      },
    };

    const plan = await derivePartitionPlan(args, projectRoot, isFile, enabledAnalyzers);

    // Spec 41 R3 — provenance: capture an aggregate content hash + per-file
    // manifest so `result`/`status` can report staleness cheaply.
    const fileHash = hashFileSet(await findFiles(projectRoot), projectRoot);
    patchLedgerRun(db.rawDb, jobId, {
      contentHash: fileHash.contentHash,
      filesCount: fileHash.filesCount,
      fileManifestJson: JSON.stringify(fileHash.manifest),
    });

    const partitionTasks: WorkerShardTask[] = [];
    const globalTasks: WorkerShardTask[] = [];
    if (plan.mode === 'none') {
      partitionTasks.push({
        shardId: 'full-scope',
        attempts: 0,
        config: asSerializableConfig(baseOptions),
      });
    } else {
      setAuditJobProgress(getJobDb(), jobId, {
        phase: 'partitioning',
        message: `Planning ${plan.partitionPaths.length} shard(s) + ${plan.globalAnalyzers.length > 0 ? 'global' : 'no-global'} analyzers`,
      });
      if (plan.globalAnalyzers.length > 0) {
        globalTasks.push({
          shardId: 'global-analyzers',
          attempts: 0,
          config: asSerializableConfig({
            ...baseOptions,
            enabledAnalyzers: plan.globalAnalyzers,
            includePaths: undefined,
          }),
        });
      }
      for (const partitionPath of plan.partitionPaths) {
        partitionTasks.push({
          shardId: `shard:${path.basename(partitionPath)}`,
          attempts: 0,
          config: asSerializableConfig({
            ...baseOptions,
            enabledAnalyzers: plan.shardedAnalyzers,
            includePaths: [`${partitionPath}/**/*`],
          }),
        });
      }
    }

    const totalTasks = partitionTasks.length + globalTasks.length;
    setAuditJobProgress(getJobDb(), jobId, {
      phase: 'analysis',
      message: `Running ${totalTasks} shard task(s) with ${maxWorkers} worker(s)`,
      current: 0,
      total: totalTasks,
    });

    const poolOptions = {
      maxWorkers,
      maxRetries,
      shardTimeoutMs,
      retryBackoffMs,
      signal: ac.signal,
    };

    // Partition shards run first; the global-analyzers shard is scheduled only
    // after every partition shard has completed. The global shard's full-scope
    // reducers (conventions, cross-domain, styles) read cross-file index tables
    // (`functions`, `function_calls`, `style_*`) that the always-on function-index
    // visitor writes from *every* shard. Running it concurrently — even pushed
    // "first" — left a `functions`-table write/read race in principle. Serializing
    // it after the partitions closes that last multi-writer window structurally.
    const resultParts: AuditResult[] = [];
    resultParts.push(
      ...(await runShardTasksWithWorkerPool(getJobDb, jobId, partitionTasks, poolOptions))
    );
    if (globalTasks.length > 0) {
      resultParts.push(
        ...(await runShardTasksWithWorkerPool(getJobDb, jobId, globalTasks, poolOptions))
      );
    }

    if (ac.signal.aborted) {
      throw ac.signal.reason instanceof Error
        ? ac.signal.reason
        : new Error(String(ac.signal.reason || 'Audit job was cancelled or timed out'));
    }

    const auditResult =
      resultParts.length === 1 ? resultParts[0] : mergeAuditResults(resultParts, enabledAnalyzers);

    let indexingResult: any = null;
    if (indexFunctions && auditResult.metadata.fileToFunctionsMap) {
      if (ac.signal.aborted) {
        throw ac.signal.reason instanceof Error
          ? ac.signal.reason
          : new Error(String(ac.signal.reason || 'Audit job was cancelled during indexing'));
      }
      // Batch all per-file upserts into a single transaction (Amendment B2).
      const entries = Object.entries(auditResult.metadata.fileToFunctionsMap).map(
        ([filePath, functions]) => ({ filePath, currentFunctions: functions as FunctionMetadata[] })
      );
      const syncStats = await db.syncFileIndexBatch(entries);
      indexingResult = {
        success: true,
        registered: syncStats.added + syncStats.updated,
        failed: 0,
        syncStats,
      };
    }

    let codeMapResult: any = null;
    if (generateCodeMap && indexingResult && indexingResult.success) {
      if (ac.signal.aborted) {
        throw ac.signal.reason instanceof Error
          ? ac.signal.reason
          : new Error(String(ac.signal.reason || 'Audit job was cancelled before code map generation'));
      }
      try {
        const mapGenerator = new CodeMapGenerator();
        const files = Object.keys(auditResult.metadata.fileToFunctionsMap || {});
        let documentation: any = undefined;
        if (files.length > 0) {
          const docResult = await analyzeDocumentation(files);
          documentation = docResult.metrics;
        }

        const paginatedResult = await mapGenerator.generatePaginatedCodeMap(
          isFile ? path.dirname(auditPath) : auditPath,
          {
            includeComplexity: true,
            includeDocumentation: !!documentation,
            includeDependencies: true,
            includeUsage: false,
            groupByDirectory: true,
            maxDepth: 10,
            showUnusedImports: true,
            minComplexity: 7,
          }
        );

        codeMapResult = {
          success: true,
          mapId: paginatedResult.mapId,
          summary: paginatedResult.summary,
          quickPreview: paginatedResult.quickPreview,
          sections: paginatedResult.summary.sectionsAvailable,
          documentationCoverage: documentation?.coverageScore,
        };
      } catch (e) {
        mcpDebugStderr(chalk.yellow('[WARN]'), 'Code map generation failed in background audit:', e);
      }
    }

    const projectRootForStore = projectRoot;
    const persisted = {
      ...auditResult,
      ...(indexingResult && { functionIndexing: indexingResult }),
      ...(codeMapResult && { codeMap: codeMapResult }),
    };
    const resultId = await db.storeAuditResults(persisted, projectRootForStore);

    // Spec 41 R2 — converge on the one ledger write path: attach findings +
    // coverage to the pre-existing run, then close the lifecycle.
    const runInput = detectRunInput(
      'audit.start',
      'mcp',
      (args.scope as string) || 'all',
      projectRoot,
      PACKAGE_VERSION
    );
    writeAuditToLedger(
      db.rawDb,
      runInput,
      getAllViolations(auditResult),
      Date.now() - startedMs,
      0,
      { runId: jobId, coverage: auditResult.metadata.coverage }
    );

    patchAuditJob(db.rawDb, jobId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      progress: { phase: 'completed', message: 'Audit completed' },
      resultId,
    });
  } catch (e) {
    // Write the full trace to stderr (the detached child's per-run log) so a
    // failure is diagnosable without re-running — the error row alone drops the
    // stack that says *where* the run died.
    try {
      process.stderr.write(
        `[code-auditor] job ${jobId} failed: ${e instanceof Error ? (e.stack || e.message) : String(e)}\n`
      );
    } catch {
      // ignore — the log write is best-effort
    }
    // Record the failure through the singleton connection (best-effort — never
    // mask the original error, and the run already failed). If the error was
    // thrown before the DB handle resolved, getJobDb() itself throws and is
    // swallowed here.
    try {
      patchAuditJob(getJobDb(), jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
        progress: { phase: 'failed', message: 'Audit failed' },
      });
    } catch {
      // best-effort — the run already failed; never mask the original error
    }
  } finally {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
    if (jobTimer !== undefined) {
      clearTimeout(jobTimer);
    }
  }
}

export async function getAuditJobStatus(jobId: string): Promise<Record<string, unknown>> {
  // Resolve the same DB the writer opened: startAuditJob/runAuditJob set the
  // singleton to the project-scoped DB, so read from the current singleton's
  // project root rather than cwd (which would flip the singleton away).
  const db = CodeIndexDB.getInstance(undefined, CodeIndexDB.currentProject);
  await db.initialize();
  const job = getAuditJob(db.rawDb, jobId);
  if (!job) {
    throw new ContextualError(`Audit job not found: ${jobId}`, {
      jobId,
      hint: 'Use audit.start first, then poll audit.status with the returned jobId.',
    });
  }
  return {
    jobId: job.jobId,
    status: job.status,
    path: job.path,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    progress: job.progress ?? null,
    resultId: job.resultId ?? null,
    error: job.error ?? null,
  };
}

/**
 * Returns audit results as a SARIF 2.1.0 JSON string (Spec 06 R1.1 — MCP surface).
 */
export async function getAuditResultsAsSarif(args: any): Promise<string> {
  const resultId = (args.resultId as string) || (args.auditId as string);
  if (!resultId) {
    throw new ContextualError('resultId is required to fetch audit results as SARIF.', {
      hint: 'Call audit.start, poll audit.status until completed, then pass resultId to audit.results with format: "sarif".',
    });
  }

  const db = CodeIndexDB.getInstance(undefined, CodeIndexDB.currentProject);
  await db.initialize();
  const stored = await db.getAuditResults(resultId);
  if (!stored) {
    throw new ContextualError(`Audit result not found or expired: ${resultId}`, {
      resultId,
      hint: 'Results expire after 24h. Start a new audit if the result is no longer available.',
    });
  }

  const { generateSARIFReport } = await import('./reporting/sarifReportGenerator.js');

  // Reconstruct an AuditResult shape from stored data
  const auditResult = {
    timestamp: new Date(stored.timestamp || Date.now()),
    summary: {
      totalFiles: stored.metadata?.filesAnalyzed ?? 0,
      totalViolations: stored.summary?.totalViolations ?? 0,
      criticalIssues: stored.summary?.criticalIssues ?? 0,
      warnings: stored.summary?.warnings ?? 0,
      suggestions: stored.summary?.suggestions ?? 0,
      violationsByCategory: stored.summary?.violationsByCategory ?? {},
      topIssues: stored.summary?.topIssues ?? [],
    },
    analyzerResults: stored.analyzerResults || stored.analyzer_results_json
      ? (typeof stored.analyzerResults === 'string'
        ? JSON.parse(stored.analyzerResults)
        : stored.analyzerResults)
      : {},
    recommendations: stored.recommendations || [],
    metadata: {
      auditDuration: stored.metadata?.auditDuration ?? 0,
      filesAnalyzed: stored.metadata?.filesAnalyzed ?? 0,
      analyzersRun: stored.metadata?.analyzersRun ?? [],
    },
  };

  return generateSARIFReport(auditResult as any);
}

export async function getAuditResultsPage(args: any): Promise<Record<string, unknown>> {
  const resultId = (args.resultId as string) || (args.auditId as string);
  if (!resultId) {
    throw new ContextualError('resultId is required to fetch audit results.', {
      hint: 'Call audit.start, poll audit.status until completed, then pass resultId to audit.results.',
    });
  }

  const limit = Math.min(Math.max(0, Number(args.limit)) || 50, 100);
  const offset = Math.max(0, Number(args.offset) || 0);

  const db = CodeIndexDB.getInstance(undefined, CodeIndexDB.currentProject);
  await db.initialize();
  const auditResult = await db.getAuditResults(resultId);
  if (!auditResult) {
    throw new ContextualError(`Audit result not found or expired: ${resultId}`, {
      resultId,
      hint: 'Results expire after 24h. Start a new audit if the result is no longer available.',
    });
  }

  const allViolations = auditResult.violations || getAllViolations(auditResult);
  const paginatedViolations = allViolations.slice(offset, offset + limit);

  return {
    summary: {
      totalViolations: auditResult.summary?.totalViolations ?? allViolations.length,
      criticalIssues: auditResult.summary?.criticalIssues ?? 0,
      warnings: auditResult.summary?.warnings ?? 0,
      suggestions: auditResult.summary?.suggestions ?? 0,
      filesAnalyzed: auditResult.metadata?.filesAnalyzed ?? 0,
      executionTime: auditResult.metadata?.auditDuration ?? 0,
      healthScore: auditResult.summary?.healthScore ?? calculateHealthScore(auditResult),
    },
    violations: paginatedViolations,
    pagination: {
      total: allViolations.length,
      limit,
      offset,
      hasMore: offset + limit < allViolations.length,
      nextOffset: offset + limit < allViolations.length ? offset + limit : null,
      resultId,
      cachedPage: true,
    },
    recommendations: auditResult.recommendations || [],
    coverage: auditResult.metadata?.coverage || [],
    ...(auditResult.functionIndexing && { functionIndexing: auditResult.functionIndexing }),
    ...(auditResult.codeMap && { codeMap: auditResult.codeMap }),
  };
}

export const __testables = {
  isRetryableShardError,
  mergeAnalyzerResult,
  mergeCoverage,
};
