import { createAuditRunner } from '../auditRunner.js';
import { AuditAbortedError, AuditHandoffError } from '../types.js';
import { initParsers } from '../languages/index.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import {
  ParentToWorkerMessage,
  WorkerToParentMessage,
  continuationConfigAfterHandoff,
  toAuditRunnerOptions,
} from './auditWorkerProtocol.js';

const abortControllers = new Map<string, AbortController>();

/** One audit at a time per process so the parent can safely recycle workers on timeout. */
let runChain: Promise<void> = Promise.resolve();

function send(message: WorkerToParentMessage): void {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

async function handleRun(message: Extract<ParentToWorkerMessage, { kind: 'run-audit-shard' }>): Promise<void> {
  const { requestId, shardId } = message;
  const ac = new AbortController();
  abortControllers.set(requestId, ac);

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = message.config.shardSoftBudgetMs;
  if (typeof budget === 'number' && budget > 0) {
    budgetTimer = setTimeout(() => {
      ac.abort(new AuditAbortedError(`Shard soft budget (${budget}ms) exhausted`));
    }, budget);
  }

  try {
    const base = toAuditRunnerOptions(message.config);
    const runner = createAuditRunner({
      ...base,
      // The parent (runAuditJob) is the single ledger writer; a worker writing
      // the ledger concurrently contends with the parent's syncFileIndex
      // (SQLITE_BUSY) and pollutes listRuns with stray completed rows.
      writeToLedger: false,
      abortSignal: ac.signal,
      progressCallback: (progress) => {
        send({
          kind: 'worker-progress',
          requestId,
          shardId,
          progress,
        });
      },
    });
    const result = await runner.run();
    // Close this worker's DB connection before signaling the parent. The
    // parent (runAuditJob) proceeds straight into syncFileIndex the moment it
    // receives worker-result; if this worker is then SIGTERM'd by
    // disposeAllWorkers while its syncStyleIndex-opened connection is still
    // open, the abrupt exit leaves the shared WAL -shm in a state that makes
    // the parent's next write fail with "database is locked". Closing here —
    // before the send — guarantees the connection is gone by the time the
    // parent reads the message.
    CodeIndexDB.resetInstance();
    send({
      kind: 'worker-result',
      requestId,
      shardId,
      result,
    });
  } catch (error) {
    // Same rationale as the success path: never leave a DB connection open
    // across the worker's (imminent) SIGTERM, whichever way this shard ends.
    CodeIndexDB.resetInstance();
    if (error instanceof AuditHandoffError) {
      send({
        kind: 'worker-handoff',
        requestId,
        shardId,
        partialResult: error.partialResult,
        remainingFiles: error.remainingFiles,
        continuation: continuationConfigAfterHandoff(message.config, error.remainingFiles),
      });
      return;
    }
    if (error instanceof AuditAbortedError) {
      send({
        kind: 'worker-error',
        requestId,
        shardId,
        error: error.message,
        stack: error.stack,
      });
      return;
    }
    send({
      kind: 'worker-error',
      requestId,
      shardId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    if (budgetTimer !== undefined) {
      clearTimeout(budgetTimer);
    }
    abortControllers.delete(requestId);
  }
}

process.on('message', (raw) => {
  const message = raw as ParentToWorkerMessage;
  if (!message || typeof message !== 'object' || !('kind' in message)) {
    return;
  }

  switch (message.kind) {
    case 'run-audit-shard': {
      runChain = runChain
        .then(() => handleRun(message))
        .catch((err) => {
          send({
            kind: 'worker-error',
            requestId: message.requestId,
            shardId: message.shardId,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        });
      break;
    }
    case 'cancel-request': {
      abortControllers.get(message.requestId)?.abort(new AuditAbortedError('Cancelled by parent'));
      break;
    }
    case 'ping': {
      send({
        kind: 'pong',
        requestId: message.requestId,
        pid: process.pid,
      });
      break;
    }
    default:
      break;
  }
});

// ── Initialize parsers then signal readiness ──────────────────────────────

async function main(): Promise<void> {
  // This process is a fresh exec of a forked parent (auditJobRunner) that may
  // have left a module-level singleton on its stack before exec. The child does
  // not inherit the parent's SQLite fd (better-sqlite3 opens it O_CLOEXEC), but
  // the singleton module state — `isInitialized = true` and a stale native
  // handle — does carry over if the parent initialized the parser before
  // forking. Reset the singleton immediately so this worker drops any inherited
  // module state and the worker's own audit-runner opens a fresh per-process
  // connection.
  CodeIndexDB.resetInstance();

  await initParsers();

  send({
    kind: 'worker-ready',
    pid: process.pid,
  });
}

main().catch((err) => {
  send({
    kind: 'worker-error',
    requestId: 'init',
    shardId: 'init',
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
});
