import { describe, it, expect } from 'vitest';
import { createAuditJob, getAuditJob, patchAuditJob, setAuditJobProgress } from './auditJobService.js';

describe('auditJobService', () => {
  it('creates, updates, and retrieves job lifecycle state', () => {
    const job = createAuditJob('/tmp/demo-project');
    expect(job.status).toBe('queued');
    expect(job.path).toBe('/tmp/demo-project');
    expect(job.jobId).toMatch(/^job_/);

    const running = patchAuditJob(job.jobId, {
      status: 'running',
      startedAt: '2026-03-26T00:00:00.000Z',
    });
    expect(running?.status).toBe('running');

    setAuditJobProgress(job.jobId, {
      phase: 'analysis',
      message: 'Running analyzer',
      current: 3,
      total: 10,
    });

    const final = patchAuditJob(job.jobId, {
      status: 'completed',
      finishedAt: '2026-03-26T00:00:01.000Z',
      resultId: 'audit_abc',
    });

    expect(final?.status).toBe('completed');
    expect(final?.resultId).toBe('audit_abc');
    expect(getAuditJob(job.jobId)?.progress?.phase).toBe('analysis');
  });
});
