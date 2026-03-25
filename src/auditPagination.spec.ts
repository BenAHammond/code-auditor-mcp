import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Violation } from './types.js';
import { CodeIndexDB } from './codeIndexDB.js';

/** Same violation merge as mcp.ts / mcp-standalone for paging */
function getAllViolationsFromStored(auditResult: {
  violations?: Violation[];
  analyzerResults?: Record<string, { violations: Violation[] }>;
}): Violation[] {
  if (auditResult.violations?.length) {
    return auditResult.violations;
  }
  const out: Violation[] = [];
  if (auditResult.analyzerResults) {
    for (const [name, ar] of Object.entries(auditResult.analyzerResults)) {
      for (const v of ar.violations) {
        out.push({ ...v, analyzer: name });
      }
    }
  }
  return out;
}

describe('audit pagination (cached auditId workflow)', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-page-'));
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores audit, returns auditId, and pages match total/hasMore/nextOffset', async () => {
    const projectRoot = join(dir, 'proj');
    const violations: Violation[] = Array.from({ length: 125 }, (_, i) => ({
      file: 'sample.ts',
      line: i + 1,
      severity: 'warning' as const,
      message: `issue-${i}`,
    }));

    const runResult = {
      summary: {
        totalViolations: 125,
        criticalIssues: 0,
        warnings: 125,
        suggestions: 0,
      },
      metadata: { filesAnalyzed: 3, auditDuration: 42 },
      violations,
    };

    const auditId = await db.storeAuditResults(runResult, projectRoot);
    expect(auditId).toMatch(/^audit_/);

    const page = async (offset: number, limit: number) => {
      const cached = await db.getAuditResults(auditId);
      expect(cached).not.toBeNull();
      const all = getAllViolationsFromStored(cached!);
      const slice = all.slice(offset, offset + limit);
      return {
        all,
        slice,
        pagination: {
          total: all.length,
          limit,
          offset,
          hasMore: offset + limit < all.length,
          nextOffset: offset + limit < all.length ? offset + limit : null,
          auditId,
        },
      };
    };

    const p1 = await page(0, 40);
    expect(p1.slice).toHaveLength(40);
    expect(p1.pagination.total).toBe(125);
    expect(p1.pagination.hasMore).toBe(true);
    expect(p1.pagination.nextOffset).toBe(40);
    expect(p1.slice[0].message).toBe('issue-0');
    expect(p1.slice[39].message).toBe('issue-39');

    const p2 = await page(40, 40);
    expect(p2.slice).toHaveLength(40);
    expect(p2.slice[0].message).toBe('issue-40');
    expect(p2.pagination.hasMore).toBe(true);
    expect(p2.pagination.nextOffset).toBe(80);

    const p3 = await page(120, 40);
    expect(p3.slice).toHaveLength(5);
    expect(p3.pagination.hasMore).toBe(false);
    expect(p3.pagination.nextOffset).toBeNull();
  });
});
