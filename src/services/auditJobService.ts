/**
 * In-memory audit job queue. Jobs are lost on process restart.
 */

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
  /** Resolved project path passed to start_audit */
  path: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Same value as stored audit row id — use with `audit` tool as auditId */
  resultId?: string;
  error?: string;
  progress?: AuditJobProgress;
}

const jobs = new Map<string, AuditJobRecord>();

function randomId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export function createAuditJob(resolvedPath: string): AuditJobRecord {
  const jobId = randomId();
  const rec: AuditJobRecord = {
    jobId,
    status: 'queued',
    path: resolvedPath,
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, rec);
  return rec;
}

export function getAuditJob(jobId: string): AuditJobRecord | undefined {
  return jobs.get(jobId);
}

export function patchAuditJob(jobId: string, patch: Partial<AuditJobRecord>): AuditJobRecord | undefined {
  const cur = jobs.get(jobId);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  jobs.set(jobId, next);
  return next;
}

export function setAuditJobProgress(jobId: string, progress: AuditJobProgress): void {
  const cur = jobs.get(jobId);
  if (!cur) return;
  jobs.set(jobId, { ...cur, progress });
}
