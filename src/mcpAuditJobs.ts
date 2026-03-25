import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fork, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  AnalyzerResult,
  AuditResult,
  AuditRunnerOptions,
  FunctionMetadata,
  Severity,
  Violation,
} from './types.js';
import { CodeIndexDB } from './codeIndexDB.js';
import { syncFileIndex } from './codeIndexService.js';
import { CodeMapGenerator } from './services/CodeMapGenerator.js';
import { analyzeDocumentation } from './analyzers/documentationAnalyzer.js';
import { assertAuditPathExists, ContextualError } from './mcpToolErrors.js';
import { createAuditJob, getAuditJob, patchAuditJob, setAuditJobProgress } from './services/auditJobService.js';
import { mcpDebugStderr } from './mcpDiagnostics.js';
import { findFiles } from './utils/fileDiscovery.js';
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
const GLOBAL_ONLY_ANALYZERS = new Set(['dry', 'data-access', 'schema']);
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
              setAuditJobProgress(jobId, {
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
        setAuditJobProgress(jobId, {
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
        setAuditJobProgress(jobId, {
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
          setAuditJobProgress(jobId, {
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

function summarizeAnalyzerResults(analyzerResults: Record<string, AnalyzerResult>) {
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

  return {
    totalFiles: 0,
    totalViolations,
    criticalIssues,
    warnings,
    suggestions,
    violationsByCategory,
    topIssues: [],
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
  return {
    ...base,
    violations: mergedViolations,
    filesProcessed: (base.filesProcessed || 0) + (next.filesProcessed || 0),
    executionTime: (base.executionTime || 0) + (next.executionTime || 0),
    errors: [...(base.errors || []), ...(next.errors || [])],
  };
}

function mergeAuditResults(results: AuditResult[], orderedAnalyzers: string[]): AuditResult {
  const analyzerResults: Record<string, AnalyzerResult> = {};
  const fileToFunctionsMap: Record<string, FunctionMetadata[]> = {};
  const collectedFunctions: FunctionMetadata[] = [];
  const recommendations: any[] = [];
  let filesAnalyzed = 0;
  let auditDuration = 0;

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
    filesAnalyzed += result.metadata?.filesAnalyzed || 0;
    auditDuration += result.metadata?.auditDuration || 0;
    if (result.recommendations?.length) recommendations.push(...result.recommendations);
  }

  const ordered: Record<string, AnalyzerResult> = {};
  for (const name of orderedAnalyzers) {
    if (analyzerResults[name]) ordered[name] = analyzerResults[name];
  }

  return {
    timestamp: new Date(),
    summary: summarizeAnalyzerResults(ordered),
    analyzerResults: ordered,
    recommendations,
    metadata: {
      auditDuration,
      filesAnalyzed,
      analyzersRun: orderedAnalyzers,
      ...(collectedFunctions.length > 0 && { collectedFunctions }),
      ...(Object.keys(fileToFunctionsMap).length > 0 && { fileToFunctionsMap }),
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
  await assertAuditPathExists(auditPath);

  const job = createAuditJob(auditPath);

  setTimeout(() => {
    void runAuditJob(job.jobId, args, defaults).catch((err) => {
      try {
        patchAuditJob(job.jobId, {
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

async function runAuditJob(jobId: string, args: any, defaults: StartAuditDefaults): Promise<void> {
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  const ac = new AbortController();
  try {
    patchAuditJob(jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: {
        phase: 'queued',
        message: 'Audit queued',
      },
    });

    const auditPath = path.resolve((args.path as string) || process.cwd());
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

    const { isFile } = await assertAuditPathExists(auditPath);

    const db = CodeIndexDB.getInstance();
    await db.initialize();
    const storedConfigs = await db.getAllAnalyzerConfigs(auditPath);
    const analyzerConfigs = {
      ...storedConfigs,
      ...(args.analyzerConfigs as Record<string, unknown> || {}),
    };

    const projectRoot = isFile ? path.dirname(auditPath) : auditPath;
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
      progressCallback: (p) => {
        setAuditJobProgress(jobId, {
          phase: p.phase ?? 'analysis',
          message: p.message ?? p.phase ?? 'running',
          current: typeof p.current === 'number' ? p.current : undefined,
          total: typeof p.total === 'number' ? p.total : undefined,
        });
      },
    };

    const plan = await derivePartitionPlan(args, projectRoot, isFile, enabledAnalyzers);
    const shardTasks: WorkerShardTask[] = [];
    if (plan.mode === 'none') {
      shardTasks.push({
        shardId: 'full-scope',
        attempts: 0,
        config: asSerializableConfig(baseOptions),
      });
    } else {
      setAuditJobProgress(jobId, {
        phase: 'partitioning',
        message: `Planning ${plan.partitionPaths.length} shard(s) + ${plan.globalAnalyzers.length > 0 ? 'global' : 'no-global'} analyzers`,
      });
      if (plan.globalAnalyzers.length > 0) {
        shardTasks.push({
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
        shardTasks.push({
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

    setAuditJobProgress(jobId, {
      phase: 'analysis',
      message: `Running ${shardTasks.length} shard task(s) with ${maxWorkers} worker(s)`,
      current: 0,
      total: shardTasks.length,
    });

    const resultParts = await runShardTasksWithWorkerPool(jobId, shardTasks, {
      maxWorkers,
      maxRetries,
      shardTimeoutMs,
      retryBackoffMs,
      signal: ac.signal,
    });

    if (ac.signal.aborted) {
      throw ac.signal.reason instanceof Error
        ? ac.signal.reason
        : new Error(String(ac.signal.reason || 'Audit job was cancelled or timed out'));
    }

    const auditResult =
      resultParts.length === 1 ? resultParts[0] : mergeAuditResults(resultParts, enabledAnalyzers);

    let indexingResult: any = null;
    if (indexFunctions && auditResult.metadata.fileToFunctionsMap) {
      const syncStats = { added: 0, updated: 0, removed: 0 };
      for (const [filePath, functions] of Object.entries(auditResult.metadata.fileToFunctionsMap)) {
        if (ac.signal.aborted) {
          throw ac.signal.reason instanceof Error
            ? ac.signal.reason
            : new Error(String(ac.signal.reason || 'Audit job was cancelled during indexing'));
        }
        const fileStats = await syncFileIndex(filePath, functions as FunctionMetadata[]);
        syncStats.added += fileStats.added;
        syncStats.updated += fileStats.updated;
        syncStats.removed += fileStats.removed;
      }
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

    patchAuditJob(jobId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      progress: { phase: 'completed', message: 'Audit completed' },
      resultId,
    });
  } catch (e) {
    patchAuditJob(jobId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
      progress: { phase: 'failed', message: 'Audit failed' },
    });
  } finally {
    if (jobTimer !== undefined) {
      clearTimeout(jobTimer);
    }
  }
}

export function getAuditJobStatus(jobId: string): Record<string, unknown> {
  const job = getAuditJob(jobId);
  if (!job) {
    throw new ContextualError(`Audit job not found: ${jobId}`, {
      jobId,
      hint: 'Use start_audit first, then poll audit_status with the returned jobId.',
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

export async function getAuditResultsPage(args: any): Promise<Record<string, unknown>> {
  const resultId = (args.resultId as string) || (args.auditId as string);
  if (!resultId) {
    throw new ContextualError('resultId is required to fetch audit results.', {
      hint: 'Call start_audit, poll audit_status until completed, then pass resultId to audit_results.',
    });
  }

  const limit = Math.min(Math.max(0, Number(args.limit)) || 50, 100);
  const offset = Math.max(0, Number(args.offset) || 0);

  const db = CodeIndexDB.getInstance();
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
    ...(auditResult.functionIndexing && { functionIndexing: auditResult.functionIndexing }),
    ...(auditResult.codeMap && { codeMap: auditResult.codeMap }),
  };
}

export const __testables = {
  isRetryableShardError,
  mergeAnalyzerResult,
};
