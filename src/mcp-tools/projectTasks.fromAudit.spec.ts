import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodeIndexDB } from '../codeIndexDB.js';
import { handleProjectTasks } from './projectTasks.js';

/**
 * Build a fixture audit result object matching the shape produced by storeAuditResults.
 */
function fixtureAuditResult(overrides: Record<string, any> = {}): any {
  return {
    analyzerResults: {
      solid: {
        analyzerName: 'solid',
        violations: [
          {
            analyzer: 'solid',
            file: 'src/App.tsx',
            line: 42,
            severity: 'critical',
            message: 'Class "GiantManager" has 25 public methods',
            principle: 'single-responsibility',
            className: 'GiantManager',
            type: 'solid'
          },
          {
            analyzer: 'solid',
            file: 'src/App.tsx',
            line: 88,
            severity: 'warning',
            message: 'Class "Helper" appears to have multiple responsibilities',
            principle: 'single-responsibility',
            className: 'Helper',
            type: 'solid'
          }
        ],
        filesProcessed: 5,
        executionTime: 120
      },
      dry: {
        analyzerName: 'dry',
        violations: [
          {
            analyzer: 'dry',
            file: 'src/utils.ts',
            line: 15,
            severity: 'suggestion',
            message: 'Similar code found in 3 locations',
            type: 'similar-code',
            functionName: 'parseConfig',
            similarity: 0.85
          }
        ],
        filesProcessed: 3,
        executionTime: 80
      },
      'data-access': {
        analyzerName: 'data-access',
        violations: [
          {
            analyzer: 'data-access',
            file: 'src/api/users.ts',
            line: 10,
            severity: 'critical',
            message: 'Potential SQL injection vulnerability detected',
            type: 'data-access',
            functionName: 'getUserById'
          }
        ],
        filesProcessed: 2,
        executionTime: 50
      }
    },
    summary: {
      totalFiles: 10,
      totalViolations: 4,
      criticalIssues: 2,
      warnings: 1,
      suggestions: 1
    },
    recommendations: [],
    metadata: {
      auditDuration: 250,
      filesAnalyzed: 10,
      analyzersRun: ['solid', 'dry', 'data-access']
    },
    ...overrides
  };
}

describe('handleProjectTasks from_audit', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-fromaudit-'));
    const dbPath = join(dir, 'index.db');
    // Set data dir so the singleton resolves to our temp location
    process.env.CODE_AUDITOR_DATA_DIR = dir;
    // Reset singleton so getInstance uses our temp path
    (CodeIndexDB as any).instance = undefined;
    db = CodeIndexDB.getInstance(dbPath);
    await db.initialize();
    projectPath = join(dir, 'test-project');
  });

  afterEach(async () => {
    await db.close();
    // Reset singleton so the next test (possibly in another file) recreates
    (CodeIndexDB as any).instance = undefined;
    // Retry cleanup: LokiJS file handles may take a moment to release
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e: any) {
        if (e.code === 'ENOTEMPTY' && attempt < 4) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        throw e;
      }
    }
  });

  // ---- Helper to store a fixture audit result ----
  async function storeFixtureAudit(
    overrides?: Record<string, any>
  ): Promise<string> {
    const auditResult = fixtureAuditResult(overrides);
    return db.storeAuditResults(auditResult, projectPath);
  }

  // ---- Tests ----

  it('creates tasks from audit results with default filters (critical + warning)', async () => {
    await storeFixtureAudit();

    const result = await handleProjectTasks({
      action: 'from_audit',
      projectPath
    });

    expect(result.success).toBe(true);
    expect(result.created).toBe(3); // 2 critical + 1 warning (suggestion excluded by default)
    expect(result.skipped).toBe(0);
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.tasks).toHaveLength(3);

    // Verify severity→priority mapping
    const priorities = result.tasks.map((t: any) => t.priority);
    expect(priorities).toContain('high'); // critical → high
    expect(priorities).toContain('medium'); // warning → medium

    // Verify source is 'audit'
    for (const task of result.tasks) {
      expect(task.source).toBe('audit');
      expect(task.fingerprint).toBeTruthy();
      expect(task.fingerprint).toHaveLength(64); // SHA-256 hex
    }
  });

  it('includes suggestion severity when explicitly requested', async () => {
    await storeFixtureAudit();

    const result = await handleProjectTasks({
      action: 'from_audit',
      projectPath,
      severities: ['critical', 'warning', 'suggestion']
    });

    expect(result.success).toBe(true);
    expect(result.created).toBe(4); // all violations
    const priorities = result.tasks.map((t: any) => t.priority);
    expect(priorities.filter((p: string) => p === 'low')).toHaveLength(1); // suggestion → low
  });

  it('filters by analyzer', async () => {
    await storeFixtureAudit();

    const result = await handleProjectTasks({
      action: 'from_audit',
      projectPath,
      analyzers: ['dry']
    });

    expect(result.success).toBe(true);
    expect(result.created).toBe(0); // dry violation is severity 'suggestion', excluded by default
    expect(result.skipped).toBe(0);
  });

  it('filters by analyzer with explicit severities', async () => {
    await storeFixtureAudit();

    const result = await handleProjectTasks({
      action: 'from_audit',
      projectPath,
      analyzers: ['dry'],
      severities: ['suggestion']
    });

    expect(result.success).toBe(true);
    expect(result.created).toBe(1);
    expect(result.tasks[0].relatedFiles).toEqual(['src/utils.ts']);
  });

  it('filters by path glob', async () => {
    await storeFixtureAudit();

    const result = await handleProjectTasks({
      action: 'from_audit',
      projectPath,
      paths: ['src/api/**']
    });

    expect(result.success).toBe(true);
    expect(result.created).toBe(1); // only data-access violation in src/api/
    expect(result.tasks[0].relatedFiles).toEqual(['src/api/users.ts']);
  });

  it('deduplicates: skips violations already covered by open tasks', async () => {
    await storeFixtureAudit();

    // First run creates all tasks
    const first = await handleProjectTasks({
      action: 'from_audit',
      projectPath
    });
    expect(first.created).toBe(3);

    // Second run with same audit should skip all
    const second = await handleProjectTasks({
      action: 'from_audit',
      projectPath
    });
    expect(second.success).toBe(true);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(3);
  });

  it('creates new task when fingerprint only matches a completed task (resurfaced violation)', async () => {
    await storeFixtureAudit();

    // First run creates tasks
    const first = await handleProjectTasks({
      action: 'from_audit',
      projectPath
    });
    expect(first.created).toBe(3);

    // Complete all created tasks
    for (const task of first.tasks) {
      await db.updateProjectTask(task.taskId, { status: 'done' });
    }

    // Second run should create new tasks (resurfaced violations)
    const second = await handleProjectTasks({
      action: 'from_audit',
      projectPath
    });
    expect(second.success).toBe(true);
    expect(second.created).toBe(3);
    expect(second.skipped).toBe(0);

    // Verify new task IDs are different from completed ones
    const completedIds = new Set(first.tasks.map((t: any) => t.taskId));
    for (const task of second.tasks) {
      expect(completedIds.has(task.taskId)).toBe(false);
    }
  });

  it('does not match fingerprints across different projects (resurfaced elsewhere)', async () => {
    await storeFixtureAudit();

    // Run from_audit for projectPath
    const first = await handleProjectTasks({
      action: 'from_audit',
      projectPath
    });
    expect(first.created).toBe(3);

    // Complete all tasks
    for (const task of first.tasks) {
      await db.updateProjectTask(task.taskId, { status: 'done' });
    }

    // Now run from_audit for a different project (but with same audit result
    // stored under that project). We need a different audit ID since the
    // stored result is under projectPath.
    const otherPath = join(dir, 'other-project');
    // Store the same fixture under the other path
    const auditResult = fixtureAuditResult();
    const otherAuditId = await db.storeAuditResults(auditResult, otherPath);

    const other = await handleProjectTasks({
      action: 'from_audit',
      projectPath: otherPath,
      auditJobId: otherAuditId
    });
    expect(other.created).toBe(3);
    // Since the completed tasks have different project paths,
    // fingerprints from the other project should NOT match because
    // the fingerprint includes the file path which is the same.
    // Actually fingerprints are file-relative, not project-scoped.
    // If the violations have the same file/analyzer/rule/symbol,
    // the fingerprint will match. The important thing is that
    // the open-task fingerprint check finds matching tasks that
    // belong to the SAME project (because they were created under different
    // project paths, the check against open tasks should find none).
  });

  it('returns error when no audit results exist', async () => {
    const result = await handleProjectTasks({
      action: 'from_audit',
      projectPath
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No audit results found/i);
  });

  it('returns error when auditJobId does not exist', async () => {
    const result = await handleProjectTasks({
      action: 'from_audit',
      projectPath,
      auditJobId: 'nonexistent-job-id'
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found or expired/i);
  });

  it('uses explicit auditJobId over most recent', async () => {
    // Store two audits. The second (most recent) should NOT be used
    // when an explicit auditJobId from the first is given.
    const firstId = await storeFixtureAudit();
    // Store a second audit with a different violation
    const secondResult = fixtureAuditResult({
      analyzerResults: {
        solid: {
          analyzerName: 'solid',
          violations: [
            {
              analyzer: 'solid',
              file: 'src/only-in-second.ts',
              line: 1,
              severity: 'critical',
              message: 'Second audit only',
              principle: 'open-closed',
              className: 'SecondClass',
              type: 'solid'
            }
          ],
          filesProcessed: 1,
          executionTime: 10
        }
      }
    });
    await db.storeAuditResults(secondResult, projectPath);

    // Use the first audit ID explicitly
    const result = await handleProjectTasks({
      action: 'from_audit',
      projectPath,
      auditJobId: firstId
    });

    expect(result.success).toBe(true);
    // Should have tasks from first audit (3 violations), not second (1 violation)
    expect(result.created).toBe(3);
    expect(result.auditJobId).toBe(firstId);
  });

  it('populates task fields correctly (title, description, relatedFiles, relatedSymbols)', async () => {
    await storeFixtureAudit();

    const result = await handleProjectTasks({
      action: 'from_audit',
      projectPath
    });

    const giantTask = result.tasks.find((t: any) =>
      t.title.includes('GiantManager')
    );
    expect(giantTask).toBeTruthy();
    expect(giantTask.priority).toBe('high');
    expect(giantTask.relatedFiles).toEqual(['src/App.tsx']);
    expect(giantTask.relatedSymbols).toEqual(['GiantManager']);
    expect(giantTask.source).toBe('audit');
    expect(giantTask.fingerprint).toBeTruthy();
    expect(giantTask.description).toContain('solid');
    expect(giantTask.description).toContain('single-responsibility');
  });

  it('fingerprint differs for different violations', async () => {
    await storeFixtureAudit();

    const result = await handleProjectTasks({
      action: 'from_audit',
      projectPath,
      severities: ['critical', 'warning', 'suggestion']
    });

    const fingerprints = result.tasks.map((t: any) => t.fingerprint);
    const unique = new Set(fingerprints);
    expect(unique.size).toBe(fingerprints.length); // All unique
  });
});
