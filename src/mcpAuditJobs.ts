import path from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  AuditResult,
  AuditRunnerOptions,
  AuditScope,
  FunctionMetadata,
  Severity,
  Violation,
} from './types.js';
import type { SqliteDatabase } from './sqlite/types.js';
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
import { runAudit } from './auditRunner.js';
import chalk from 'chalk';

type StartAuditDefaults = {
  defaultMinSeverity: Severity;
  defaultGenerateCodeMap: boolean;
};

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
async function acquireLease(db: SqliteDatabase, projectRoot: string, jobId: string): Promise<void> {
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

/**
 * Entrypoint for the detached CLI runner (Spec 41 `--detach`).
 * @returns The path to the detached runner entrypoint.
 */
export function resolveJobRunnerEntrypoint(): string {
  const current = fileURLToPath(import.meta.url);
  const ext = path.extname(current);
  const dir = path.dirname(current);
  const filename = ext === '.ts' ? 'auditJobRunner.ts' : 'auditJobRunner.js';
  return path.join(dir, 'workers', filename);
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
  summary?: { criticalIssues?: number; severe?: number; high?: number };
}): number {
  const filesAnalyzed = result.metadata?.filesAnalyzed || 1;
  const critical = result.summary?.criticalIssues || 0;
  const severe = result.summary?.severe || 0;
  const high = result.summary?.high || 0;

  const weightedViolations = critical * 10 + severe * 3 + high * 0.5;
  let score = 100 - (weightedViolations / filesAnalyzed) * 2;
  return Math.max(0, Math.round(Math.min(100, score)));
}

/**
 * Queue an audit job and return its id immediately; the audit runs in the background.
 * @param args - The tool arguments (path, scope, severities, etc.).
 * @param defaults - Default severity and code-map flags.
 * @returns The queued job id, status, and path.
 */
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

/**
 * Run a queued audit job end-to-end: lease, audit, index, code map, and persist.
 * @param jobId - The job id to run under.
 * @param args - The tool arguments for the audit.
 * @param defaults - Default severity and code-map flags.
 * @returns A promise that resolves once the job completes or fails.
 */
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
  const getJobDb = (): SqliteDatabase => db!.rawDb;

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

    const baseOptions: AuditRunnerOptions = {
      projectRoot,
      minSeverity: ((args.minSeverity as string) || defaults.defaultMinSeverity) as Severity,
      verbose: false,
      indexFunctions,
      abortSignal: ac.signal,
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

    // Spec 41 R3 — provenance: capture an aggregate content hash + per-file
    // manifest so `result`/`status` can report staleness cheaply.
    const fileHash = hashFileSet(await findFiles(projectRoot), projectRoot);
    patchLedgerRun(db.rawDb, jobId, {
      contentHash: fileHash.contentHash,
      filesCount: fileHash.filesCount,
      fileManifestJson: JSON.stringify(fileHash.manifest),
    });

    setAuditJobProgress(getJobDb(), jobId, {
      phase: 'analysis',
      message: 'Running audit',
      current: 0,
      total: 1,
    });

    const auditResult = await runAudit(baseOptions);

    if (ac.signal.aborted) {
      throw ac.signal.reason instanceof Error
        ? ac.signal.reason
        : new Error(String(ac.signal.reason || 'Audit job was cancelled or timed out'));
    }

    let indexingResult: any = null;
    if (indexFunctions && auditResult.metadata.fileToFunctionsMap) {
      indexingResult = await indexJobFunctions(auditResult, db, ac.signal);
    }

    let codeMapResult: any = null;
    if (generateCodeMap && indexingResult && indexingResult.success) {
      codeMapResult = await generateJobCodeMap(auditResult, isFile, auditPath, ac.signal);
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

/**
 * Batch the per-file function index upserts into a single transaction.
 */
async function indexJobFunctions(
  auditResult: AuditResult,
  db: CodeIndexDB,
  signal: AbortSignal,
): Promise<any> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason || 'Audit job was cancelled during indexing'));
  }
  // Batch all per-file upserts into a single transaction (Amendment B2).
  const entries = Object.entries(auditResult.metadata.fileToFunctionsMap || {}).map(
    ([filePath, functions]) => ({ filePath, currentFunctions: functions as FunctionMetadata[] })
  );
  const syncStats = await db.syncFileIndexBatch(entries);
  return {
    success: true,
    registered: syncStats.added + syncStats.updated,
    failed: 0,
    syncStats,
  };
}

/**
 * Generate a paginated code map for a completed audit job. Returns `null` when
 * code map generation fails (best-effort — the audit still completes) and
 * throws if the job was cancelled before generation ran.
 */
async function generateJobCodeMap(
  auditResult: AuditResult,
  isFile: boolean,
  auditPath: string,
  signal: AbortSignal,
): Promise<any> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason || 'Audit job was cancelled before code map generation'));
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

    return {
      success: true,
      mapId: paginatedResult.mapId,
      summary: paginatedResult.summary,
      quickPreview: paginatedResult.quickPreview,
      sections: paginatedResult.summary.sectionsAvailable,
      documentationCoverage: documentation?.coverageScore,
    };
  } catch (e) {
    mcpDebugStderr(chalk.yellow('[WARN]'), 'Code map generation failed in background audit:', e);
    return null;
  }
}

/**
 * Read the current status of an audit job.
 * @param jobId - The job id to look up.
 * @returns The job status record.
 */
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
 * @param args - The tool arguments carrying the resultId/auditId to fetch.
 * @returns The SARIF report as a JSON string.
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

  const { generateSARIFReport, readVersionControlProvenance } = await import('./reporting/sarifReportGenerator.js');

  // Reconstruct an AuditResult shape from stored data
  const auditResult = {
    timestamp: new Date(stored.timestamp || Date.now()),
    summary: {
      totalFiles: stored.metadata?.filesAnalyzed ?? 0,
      totalViolations: stored.summary?.totalViolations ?? 0,
      criticalIssues: stored.summary?.criticalIssues ?? 0,
      severe: stored.summary?.severe ?? 0,
      high: stored.summary?.high ?? 0,
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

  const projectRoot = CodeIndexDB.currentProject || process.cwd();
  return generateSARIFReport(auditResult as any, {
    rootDir: projectRoot,
    ...readVersionControlProvenance(projectRoot),
  });
}

/**
 * Return one page of audit results with a pagination summary.
 * @param args - The tool arguments (resultId, limit, offset).
 * @returns The paginated violations and summary.
 */
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
      severe: auditResult.summary?.severe ?? 0,
      high: auditResult.summary?.high ?? 0,
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

export const __testables = {};
