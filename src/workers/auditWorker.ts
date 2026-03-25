import { createAuditRunner } from '../auditRunner.js';
import { AuditAbortedError, AuditHandoffError } from '../types.js';
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
    send({
      kind: 'worker-result',
      requestId,
      shardId,
      result,
    });
  } catch (error) {
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

send({
  kind: 'worker-ready',
  pid: process.pid,
});
