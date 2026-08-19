/**
 * DB-backed audit job model.
 *
 * A job is a view over a `findings_ledger_runs` row: `jobId` IS `run_id`, and
 * lifecycle state (`queued → running → completed/failed`, progress, error,
 * resultId) lives on the run row. There is no second job model and no
 * in-memory Map — this delegates to `ledger.ts`, so synchronous and detached
 * audits share one write path.
 *
 * The database handle is passed in explicitly (matching `ledger.ts`); callers
 * resolve the per-project DB via `CodeIndexDB.getInstance(undefined, projectRoot)`.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import {
  createLedgerRun,
  detectRunInput,
  getLedgerRun,
  patchLedgerRun,
} from '../ledger.js';
import type {
  LedgerRunDetail,
  LedgerRunInput,
  LedgerRunPatch,
  LedgerRunStatus,
} from '../ledger.js';

export type AuditJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AuditJobProgress {
  phase?: string;
  message?: string;
  current?: number;
  total?: number;
}

export interface AuditJobRecord {
  jobId: string;
  status: AuditJobStatus;
  /** Resolved project path passed to audit.start */
  path: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Same value as stored audit row id — use with `audit` tool as auditId */
  resultId?: string;
  error?: string;
  progress?: AuditJobProgress;
}

/** Optional creation metadata that maps onto the ledger run's input columns. */
export interface CreateAuditJobMeta {
  surface?: LedgerRunInput['surface'];
  scope?: string;
  command?: string;
}

// Package version — read once at module load (mirrors auditRunner.ts).
const __svcDirname = path.dirname(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(readFileSync(path.join(__svcDirname, '..', '..', 'package.json'), 'utf-8'));
const TOOL_VERSION = String(_pkg.version || '0.0.0');

function toAuditJobRecord(detail: LedgerRunDetail): AuditJobRecord {
  let progress: AuditJobProgress | undefined;
  if (detail.progressJson) {
    try {
      progress = JSON.parse(detail.progressJson) as AuditJobProgress;
    } catch {
      progress = undefined;
    }
  }
  return {
    jobId: detail.runId,
    status: detail.status as AuditJobStatus,
    path: detail.projectRoot ?? detail.target ?? '',
    createdAt: detail.timestamp,
    ...(detail.startedAt ? { startedAt: detail.startedAt } : {}),
    ...(detail.finishedAt ? { finishedAt: detail.finishedAt } : {}),
    ...(detail.resultId ? { resultId: detail.resultId } : {}),
    ...(detail.error ? { error: detail.error } : {}),
    ...(progress ? { progress } : {}),
  };
}

export function createAuditJob(
  db: Database.Database,
  projectRoot: string,
  meta: CreateAuditJobMeta = {},
): AuditJobRecord {
  const runInput = detectRunInput(
    meta.command ?? 'audit.start',
    meta.surface ?? 'mcp',
    meta.scope ?? 'all',
    projectRoot,
    TOOL_VERSION,
  );
  const runId = createLedgerRun(db, runInput, { status: 'queued', projectRoot });
  // getLedgerRun cannot miss a row we just created; the non-null assertion is safe.
  return toAuditJobRecord(getLedgerRun(db, runId)!);
}

export function getAuditJob(db: Database.Database, jobId: string): AuditJobRecord | undefined {
  const detail = getLedgerRun(db, jobId);
  return detail ? toAuditJobRecord(detail) : undefined;
}

export function patchAuditJob(
  db: Database.Database,
  jobId: string,
  patch: Partial<AuditJobRecord>,
): AuditJobRecord | undefined {
  if (!getLedgerRun(db, jobId)) return undefined;

  const ledgerPatch: LedgerRunPatch = {};
  if (patch.status !== undefined) ledgerPatch.status = patch.status as LedgerRunStatus;
  if (patch.startedAt !== undefined) ledgerPatch.startedAt = patch.startedAt ?? null;
  if (patch.finishedAt !== undefined) ledgerPatch.finishedAt = patch.finishedAt ?? null;
  if (patch.error !== undefined) ledgerPatch.error = patch.error ?? null;
  if (patch.resultId !== undefined) ledgerPatch.resultId = patch.resultId ?? null;
  if (patch.progress !== undefined) ledgerPatch.progressJson = JSON.stringify(patch.progress);

  patchLedgerRun(db, jobId, ledgerPatch);
  return getAuditJob(db, jobId);
}

export function setAuditJobProgress(db: Database.Database, jobId: string, progress: AuditJobProgress): void {
  if (!getLedgerRun(db, jobId)) return;
  patchLedgerRun(db, jobId, { progressJson: JSON.stringify(progress) });
}
