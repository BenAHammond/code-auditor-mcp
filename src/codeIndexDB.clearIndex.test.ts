import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodeIndexDB } from './codeIndexDB.js';

describe('CodeIndexDB clearIndex', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-clear-'));
    const dbPath = join(dir, 'index.db');
    db = new CodeIndexDB(dbPath);
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('clears cached audits and preserves tasks and analyzer configs', async () => {
    const projectRoot = join(dir, 'proj');
    const auditId = await db.storeAuditResults(
      { summary: { totalViolations: 1 } },
      projectRoot
    );
    expect(await db.getAuditResults(auditId)).toBeTruthy();

    await db.storeCodeMapSection('map-1', 'overview', 'hello');
    expect((await db.listCodeMapSections('map-1')).length).toBeGreaterThan(0);

    await db.storeAnalyzerConfig('solid', { maxComplexity: 12 }, {
      isGlobal: true
    });
    expect(await db.getAnalyzerConfig('solid')).toEqual({ maxComplexity: 12 });

    const task = await db.createProjectTask({
      projectPath: projectRoot,
      title: 'Track refactor'
    });

    await db.clearIndex();

    expect(await db.getAuditResults(auditId)).toBeNull();
    expect(await db.listCodeMapSections('map-1')).toEqual([]);
    expect(await db.getAnalyzerConfig('solid')).toEqual({ maxComplexity: 12 });

    const tasks = await db.listProjectTasks(projectRoot);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe(task.taskId);
  });
});
