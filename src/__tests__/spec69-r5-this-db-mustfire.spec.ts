/**
 * Spec 69 §10 S5c — pin the five queue-worker `this.db.query(…)` IDOR surfaces
 * as must-fire fixtures.
 *
 * The deleted `DB_RECEIVER_NAMES` name list used to prove `this.db` by the bare
 * field name `db`; the cross-file resolution did not, so §10 dropped the five
 * `queue-worker/src/queue-worker.ts` `this.db.query(…)` findings silently (68 →
 * 63 on hhra-org's `missing-org-filter`). S5b closes that gap with the
 * class-field type-annotation binding form: `private db: Database` is identical
 * evidence to `constructor(db: Database)` (Rule 8b). This spec pins the shape so
 * a future change that over-quiets a `this.<field>` receiver — e.g. reverting the
 * field-annotation rule or narrowing the `this`-member resolution — fails a test
 * rather than a corpus.
 *
 * The five real sites, all `UPDATE upload_jobs … WHERE id = $1` (a row-id-keyed
 * mutation on a tenant table, no org predicate):
 *
 *   - `claimNextJob`      queue-worker.ts:58  (FOR UPDATE SKIP LOCKED claim)
 *   - `updateJobProgress` queue-worker.ts:162 (dynamic SET clause)
 *   - `completeJob`       queue-worker.ts:171
 *   - `handleJobError`    queue-worker.ts:205 (retry branch)
 *   - `handleJobError`    queue-worker.ts:228 (dead-letter branch)
 *
 * The pin asserts the *receiver* resolution, not the tenant-predicate logic: the
 * fixture's five `this.db.query(…)` calls must all resolve to DB calls through
 * the `private db: Database` field annotation, so `missing-org-filter` fires five
 * times on the tenant table `upload_jobs`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { buildDataAccessCalls } from '../phase/runner.js';
import { dataAccessRules } from '../phase/rules/dataAccess.js';
import type {
  ResolvedQuery,
  ThresholdValues,
  ResolutionFact,
  Finding,
} from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function calls(path: string, source: string): Promise<ResolvedQuery[]> {
  return buildDataAccessCalls([{ path, content: source }], 'sqlite');
}

function analyze(
  ruleId: string,
  produced: ResolvedQuery[],
  thresholds: ThresholdValues = {},
  catalog?: ResolutionFact,
): Finding[] {
  const rule = dataAccessRules.find((r) => r.id === ruleId)!;
  const ctx = {
    facts: {
      'data-access-calls': produced,
      'resolution': catalog ?? { tables: [], aliases: {}, classes: [], interfaces: [] },
    },
    formats: ['typescript', 'tsx', 'javascript', 'go'] as const,
    thresholds,
  };
  return [...rule.analyze(ctx)];
}

/** The queue-worker tenant table (mirroring the corpus's `upload_jobs` tenancy). */
const TENANT = { orgFilterTables: ['upload_jobs'] };

const source = [
  'export class UploadQueueWorker {',
  '  private db: Database;',
  '  constructor() {',
  '    this.db = new Database();',
  '  }',
  '',
  '  async claimNextJob() {',
  '    const result = await this.db.query(`',
  '      UPDATE upload_jobs',
  '      SET status = \'processing\'',
  '      WHERE id = (SELECT id FROM upload_jobs ORDER BY created_at ASC LIMIT 1)',
  '      RETURNING *',
  '    `);',
  '    return result.rows[0];',
  '  }',
  '',
  '  async updateJobProgress(jobId: string, progress: any) {',
  '    await this.db.query(`',
  '      UPDATE upload_jobs',
  '      SET processed_rows = $2',
  '      WHERE id = $1',
  '    `, [jobId, progress.processedRows]);',
  '  }',
  '',
  '  async completeJob(jobId: string) {',
  '    await this.db.query(`',
  '      UPDATE upload_jobs',
  '      SET status = \'completed\'',
  '      WHERE id = $1',
  '    `, [jobId]);',
  '  }',
  '',
  '  async handleJobError(job: any, error: Error) {',
  '    if (job.attempts < job.max_attempts) {',
  '      await this.db.query(`',
  '        UPDATE upload_jobs',
  '        SET status = \'retrying\'',
  '        WHERE id = $1',
  '      `, [job.id]);',
  '    } else {',
  '      await this.db.query(`',
  '        UPDATE upload_jobs',
  '        SET status = \'failed\'',
  '        WHERE id = $1',
  '      `, [job.id]);',
  '    }',
  '  }',
  '}',
].join('\n');

describe('Spec 69 §10 S5c — five queue-worker `this.db.query(…)` surfaces stay firing', () => {
  it('the producer resolves all five `this.db.query(…)` calls through the field annotation', async () => {
    const out = await calls('/fixture/queue-worker.ts', source);
    expect(out).toHaveLength(5);
    for (const call of out) {
      expect(call.method).toBe('query');
      expect(call.tables).toContain('upload_jobs');
    }
  });

  it('missing-org-filter fires five times on the tenant table', async () => {
    const out = analyze('missing-org-filter', await calls('/fixture/queue-worker.ts', source), TENANT);
    expect(out).toHaveLength(5);
    for (const f of out) {
      expect(f.ruleId).toBe('missing-org-filter');
      expect(f.severity).toBe('critical');
      expect(f.message).toContain('upload_jobs');
    }
    // One per site, by enclosing function: claimNextJob / updateJobProgress /
    // completeJob / handleJobError (×2).
    const symbols = out.map((f) => f.symbol).sort();
    expect(symbols).toEqual([
      'claimNextJob:query',
      'completeJob:query',
      'handleJobError:query',
      'handleJobError:query',
      'updateJobProgress:query',
    ]);
  });
});
