import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodeIndexDB } from '../codeIndexDB.js';
import { createAuditJob, getAuditJob, patchAuditJob, setAuditJobProgress } from './auditJobService.js';

describe('auditJobService', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-job-'));
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates, updates, and retrieves job lifecycle state', () => {
    const job = createAuditJob(db.rawDb, '/tmp/demo-project', { surface: 'mcp' });
    expect(job.status).toBe('queued');
    expect(job.path).toBe('/tmp/demo-project');
    expect(job.jobId).toMatch(/^[0-9a-f-]{36}$/); // run_id is a UUID

    const running = patchAuditJob(db.rawDb, job.jobId, {
      status: 'running',
      startedAt: '2026-03-26T00:00:00.000Z',
    });
    expect(running?.status).toBe('running');

    setAuditJobProgress(db.rawDb, job.jobId, {
      phase: 'analysis',
      message: 'Running analyzer',
      current: 3,
      total: 10,
    });

    const final = patchAuditJob(db.rawDb, job.jobId, {
      status: 'completed',
      finishedAt: '2026-03-26T00:00:01.000Z',
      resultId: 'audit_abc',
    });

    expect(final?.status).toBe('completed');
    expect(final?.resultId).toBe('audit_abc');
    expect(getAuditJob(db.rawDb, job.jobId)?.progress?.phase).toBe('analysis');
  });

  it('returns undefined for an unknown job and does not throw on patch', () => {
    expect(getAuditJob(db.rawDb, 'missing')).toBeUndefined();
    expect(patchAuditJob(db.rawDb, 'missing', { status: 'running' })).toBeUndefined();
    // progress on an unknown job is a no-op
    expect(() => setAuditJobProgress(db.rawDb, 'missing', { phase: 'x' })).not.toThrow();
  });
});
