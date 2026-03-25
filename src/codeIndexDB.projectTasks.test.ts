import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodeIndexDB } from './codeIndexDB.js';

describe('CodeIndexDB project tasks', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-task-'));
    const dbPath = join(dir, 'index.db');
    db = new CodeIndexDB(dbPath);
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps tasks after clearIndex (function index reset)', async () => {
    const projectPath = join(dir, 'project');
    const created = await db.createProjectTask({
      projectPath,
      title: 'Finish refactor'
    });
    expect(created.taskId).toBeTruthy();

    await db.clearIndex();

    const list = await db.listProjectTasks(projectPath);
    expect(list).toHaveLength(1);
    expect(list[0].taskId).toBe(created.taskId);
    expect(list[0].title).toBe('Finish refactor');
  });

  it('updates status to done and sets completedAt', async () => {
    const projectPath = join(dir, 'p2');
    const t = await db.createProjectTask({
      projectPath,
      title: 'T',
      status: 'pending'
    });
    const updated = await db.updateProjectTask(t.taskId, { status: 'done' });
    expect(updated?.status).toBe('done');
    expect(updated?.completedAt).toBeTruthy();
  });

  it('stores rich fields and lists by sortOrder then recency', async () => {
    const projectPath = join(dir, 'p3');
    const a = await db.createProjectTask({
      projectPath,
      title: 'Second',
      sortOrder: 10,
      source: 'audit',
      relatedFiles: ['src/a.ts'],
      relatedSymbols: ['foo']
    });
    const b = await db.createProjectTask({
      projectPath,
      title: 'First',
      sortOrder: 0,
      source: 'mcp',
      blockedBy: [a.taskId]
    });
    const list = await db.listProjectTasks(projectPath);
    expect(list.map((x) => x.taskId)).toEqual([b.taskId, a.taskId]);
    expect(list[0].blockedBy).toEqual([a.taskId]);
    expect(list[1].relatedFiles).toEqual(['src/a.ts']);

    const audits = await db.listProjectTasks(projectPath, { source: 'audit' });
    expect(audits).toHaveLength(1);
    expect(audits[0].taskId).toBe(a.taskId);
  });

  it('does not mix tasks between projectPath values in one DB (list is scoped)', async () => {
    const pathA = join(dir, 'repo-a');
    const pathB = join(dir, 'repo-b');
    await db.createProjectTask({
      projectPath: pathA,
      title: 'Task only in A'
    });
    await db.createProjectTask({
      projectPath: pathB,
      title: 'Task only in B'
    });
    const listA = await db.listProjectTasks(pathA);
    const listB = await db.listProjectTasks(pathB);
    expect(listA.map((t) => t.title)).toEqual(['Task only in A']);
    expect(listB.map((t) => t.title)).toEqual(['Task only in B']);
  });
});
