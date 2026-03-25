import type { AuditResult, AuditRunnerOptions, AuditProgress, Severity } from '../types.js';

/**
 * Serializable audit options sent from parent process to a worker.
 * Functions/callbacks are intentionally excluded from IPC payloads.
 */
export interface SerializableAuditRunConfig {
  projectRoot: string;
  includePaths?: string[];
  excludePaths?: string[];
  fileExtensions?: string[];
  minSeverity?: Severity;
  enabledAnalyzers?: string[];
  indexFunctions?: boolean;
  analyzerConfigs?: Record<string, any>;
  analyzerConcurrency?: number;
  /** Absolute file paths; when set, glob discovery is skipped. */
  explicitFiles?: string[];
  /**
   * If the matched file set is larger than this, the runner completes one chunk and hands off the rest
   * (parent queues another worker with explicitFiles).
   */
  maxFilesPerRun?: number;
  /** Wall-clock soft limit for this worker process; aborts via AbortSignal (cooperative). */
  shardSoftBudgetMs?: number;
}

export interface WorkerRunRequest {
  kind: 'run-audit-shard';
  requestId: string;
  shardId: string;
  config: SerializableAuditRunConfig;
}

export interface WorkerCancelRequest {
  kind: 'cancel-request';
  requestId: string;
}

export interface WorkerPingRequest {
  kind: 'ping';
  requestId: string;
}

export type ParentToWorkerMessage = WorkerRunRequest | WorkerCancelRequest | WorkerPingRequest;

export interface WorkerReadyMessage {
  kind: 'worker-ready';
  pid: number;
}

export interface WorkerProgressMessage {
  kind: 'worker-progress';
  requestId: string;
  shardId: string;
  progress: Partial<AuditProgress>;
}

export interface WorkerResultMessage {
  kind: 'worker-result';
  requestId: string;
  shardId: string;
  result: AuditResult;
}

export interface WorkerErrorMessage {
  kind: 'worker-error';
  requestId: string;
  shardId: string;
  error: string;
  stack?: string;
}

/**
 * Chunk finished; more files remain. Parent should queue `continuation` as a new shard task
 * (typically another worker will pick it up).
 */
export interface WorkerHandoffMessage {
  kind: 'worker-handoff';
  requestId: string;
  shardId: string;
  partialResult: AuditResult;
  remainingFiles: string[];
  continuation: SerializableAuditRunConfig;
}

export interface WorkerPongMessage {
  kind: 'pong';
  requestId: string;
  pid: number;
}

export type WorkerToParentMessage =
  | WorkerReadyMessage
  | WorkerProgressMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerHandoffMessage
  | WorkerPongMessage;

export function toAuditRunnerOptions(config: SerializableAuditRunConfig): AuditRunnerOptions {
  return {
    projectRoot: config.projectRoot,
    includePaths: config.includePaths,
    excludePaths: config.excludePaths,
    fileExtensions: config.fileExtensions,
    minSeverity: config.minSeverity,
    enabledAnalyzers: config.enabledAnalyzers,
    indexFunctions: config.indexFunctions,
    analyzerConfigs: config.analyzerConfigs,
    analyzerConcurrency: config.analyzerConcurrency,
    explicitFiles: config.explicitFiles,
    maxFilesPerRun: config.maxFilesPerRun,
  };
}

/** Build config for the next worker after a file-chunk handoff (no includePaths; explicit list only). */
export function continuationConfigAfterHandoff(
  base: SerializableAuditRunConfig,
  remainingFiles: string[]
): SerializableAuditRunConfig {
  return {
    projectRoot: base.projectRoot,
    excludePaths: base.excludePaths,
    fileExtensions: base.fileExtensions,
    minSeverity: base.minSeverity,
    enabledAnalyzers: base.enabledAnalyzers,
    indexFunctions: base.indexFunctions,
    analyzerConfigs: base.analyzerConfigs,
    analyzerConcurrency: base.analyzerConcurrency,
    maxFilesPerRun: base.maxFilesPerRun,
    shardSoftBudgetMs: base.shardSoftBudgetMs,
    explicitFiles: remainingFiles,
  };
}
