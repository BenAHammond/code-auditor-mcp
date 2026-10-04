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
    const created = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Finish refactor'
    });
    expect(created.taskId).toBeTruthy();

    await db.clearIndex();

    const list = await db.projectTasks.listProjectTasks(projectPath);
    expect(list).toHaveLength(1);
    expect(list[0].taskId).toBe(created.taskId);
    expect(list[0].title).toBe('Finish refactor');
  });

  it('updates status to done and sets completedAt', async () => {
    const projectPath = join(dir, 'p2');
    const t = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'T',
      status: 'pending'
    });
    const updated = await db.projectTasks.updateProjectTask(t.taskId, { status: 'done' });
    expect(updated?.status).toBe('done');
    expect(updated?.completedAt).toBeTruthy();
  });

  it('stores rich fields and lists by sortOrder then recency', async () => {
    const projectPath = join(dir, 'p3');
    const a = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Second',
      sortOrder: 10,
      source: 'audit',
      relatedFiles: ['src/a.ts'],
      relatedSymbols: ['foo']
    });
    const b = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'First',
      sortOrder: 0,
      source: 'mcp',
      blockedBy: [a.taskId]
    });
    const list = await db.projectTasks.listProjectTasks(projectPath);
    expect(list.map((x) => x.taskId)).toEqual([b.taskId, a.taskId]);
    expect(list[0].blockedBy).toEqual([a.taskId]);
    expect(list[1].relatedFiles).toEqual(['src/a.ts']);

    const audits = await db.projectTasks.listProjectTasks(projectPath, { source: 'audit' });
    expect(audits).toHaveLength(1);
    expect(audits[0].taskId).toBe(a.taskId);
  });

  it('does not mix tasks between projectPath values in one DB (list is scoped)', async () => {
    const pathA = join(dir, 'repo-a');
    const pathB = join(dir, 'repo-b');
    await db.projectTasks.createProjectTask({
      projectPath: pathA,
      title: 'Task only in A'
    });
    await db.projectTasks.createProjectTask({
      projectPath: pathB,
      title: 'Task only in B'
    });
    const listA = await db.projectTasks.listProjectTasks(pathA);
    const listB = await db.projectTasks.listProjectTasks(pathB);
    expect(listA.map((t) => t.title)).toEqual(['Task only in A']);
    expect(listB.map((t) => t.title)).toEqual(['Task only in B']);
  });

  it('blocks marking parent done until all descendants are done', async () => {
    const projectPath = join(dir, 'hierarchy');
    const parent = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Parent'
    });
    const child = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Child',
      parentTaskId: parent.taskId,
      status: 'in_progress'
    });

    await expect(
      db.projectTasks.updateProjectTask(parent.taskId, { status: 'done' })
    ).rejects.toThrow(/Cannot mark task done until all subtasks are done/);

    await db.projectTasks.updateProjectTask(child.taskId, { status: 'done' });
    const updatedParent = await db.projectTasks.updateProjectTask(parent.taskId, {
      status: 'done'
    });
    expect(updatedParent?.status).toBe('done');
  });

  it('rejects invalid parent references and cycles', async () => {
    const projectPath = join(dir, 'cycles');
    const a = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'A'
    });
    const b = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'B',
      parentTaskId: a.taskId
    });

    await expect(
      db.projectTasks.updateProjectTask(a.taskId, { parentTaskId: b.taskId })
    ).rejects.toThrow(/create a cycle/);

    await expect(
      db.projectTasks.createProjectTask({
        projectPath,
        title: 'Bad child',
        parentTaskId: 'missing-parent'
      })
    ).rejects.toThrow(/Parent task not found/);

    const otherProjectParent = await db.projectTasks.createProjectTask({
      projectPath: join(dir, 'other-project'),
      title: 'Elsewhere'
    });
    await expect(
      db.projectTasks.updateProjectTask(b.taskId, { parentTaskId: otherProjectParent.taskId })
    ).rejects.toThrow(/same projectPath/);
  });

  it('rejects deleting a task that still has subtasks', async () => {
    const projectPath = join(dir, 'delete-guard');
    const parent = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Parent'
    });
    const child = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Child',
      parentTaskId: parent.taskId
    });

    await expect(db.projectTasks.deleteProjectTask(parent.taskId)).rejects.toThrow(
      /Cannot delete task with subtasks/
    );

    await expect(db.projectTasks.deleteProjectTask(child.taskId)).resolves.toBe(true);
    await expect(db.projectTasks.deleteProjectTask(parent.taskId)).resolves.toBe(true);
  });

  it('supports filter and text search options', async () => {
    const projectPath = join(dir, 'filters');
    await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Fix auth flow',
      description: 'Handle token refresh',
      labels: ['backend', 'urgent'],
      priority: 'high'
    });
    await db.projectTasks.createProjectTask({
      projectPath,
      title: 'UI polish',
      labels: ['frontend'],
      priority: 'low'
    });

    const high = await db.projectTasks.listProjectTasks(projectPath, { priority: 'high' });
    expect(high).toHaveLength(1);
    expect(high[0].title).toBe('Fix auth flow');

    const backend = await db.projectTasks.listProjectTasks(projectPath, { label: 'backend' });
    expect(backend).toHaveLength(1);

    const search = await db.projectTasks.listProjectTasks(projectPath, { query: 'token' });
    expect(search.map((t) => t.title)).toEqual(['Fix auth flow']);
  });

  it('supports actionable listing and complete_task guard for dependencies', async () => {
    const projectPath = join(dir, 'actionable');
    const blocker = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Ship API',
      status: 'in_progress'
    });
    const blocked = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Release docs',
      blockedBy: [blocker.taskId]
    });

    const actionableBefore = await db.projectTasks.listActionableProjectTasks(projectPath);
    expect(actionableBefore.map((t) => t.taskId)).toEqual([blocker.taskId]);

    await expect(db.projectTasks.completeProjectTask(blocked.taskId)).rejects.toThrow(
      /open dependencies/
    );

    await db.projectTasks.updateProjectTask(blocker.taskId, { status: 'done' });
    const actionableAfter = await db.projectTasks.listActionableProjectTasks(projectPath);
    expect(actionableAfter.map((t) => t.taskId)).toContain(blocked.taskId);

    const completed = await db.projectTasks.completeProjectTask(blocked.taskId);
    expect(completed?.task.status).toBe('done');
  });

  it('supports delete modes detach and cascade', async () => {
    const projectPath = join(dir, 'delete-modes');
    const parent = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Parent'
    });
    const child = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Child',
      parentTaskId: parent.taskId
    });

    await expect(db.projectTasks.deleteProjectTask(parent.taskId, 'detach')).resolves.toBe(true);
    const reloadedChild = await db.projectTasks.getProjectTask(child.taskId);
    expect(reloadedChild?.parentTaskId ?? null).toBeNull();

    const root2 = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Root2'
    });
    const child2 = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'Child2',
      parentTaskId: root2.taskId
    });
    await expect(db.projectTasks.deleteProjectTask(root2.taskId, 'cascade')).resolves.toBe(true);
    await expect(db.projectTasks.getProjectTask(root2.taskId)).resolves.toBeNull();
    await expect(db.projectTasks.getProjectTask(child2.taskId)).resolves.toBeNull();
  });

  it('rejects invalid blockedBy references and cycles', async () => {
    const projectPath = join(dir, 'deps');
    const a = await db.projectTasks.createProjectTask({ projectPath, title: 'A' });
    const b = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'B',
      blockedBy: [a.taskId]
    });

    await expect(
      db.projectTasks.createProjectTask({
        projectPath,
        title: 'Bad dep',
        blockedBy: ['missing-task']
      })
    ).rejects.toThrow(/Blocked-by task not found/);

    await expect(
      db.projectTasks.updateProjectTask(a.taskId, { blockedBy: [b.taskId] })
    ).rejects.toThrow(/dependency cycle/);
  });

  it('respects limit for list_tree responses', async () => {
    const projectPath = join(dir, 'tree-limit');
    const parent = await db.projectTasks.createProjectTask({
      projectPath,
      title: 'TL Parent'
    });
    await db.projectTasks.createProjectTask({
      projectPath,
      title: 'TL Child A',
      parentTaskId: parent.taskId
    });
    await db.projectTasks.createProjectTask({
      projectPath,
      title: 'TL Child B',
      parentTaskId: parent.taskId
    });

    const tree = await db.projectTasks.listProjectTasksTree(projectPath, { limit: 1 });
    expect(tree).toHaveLength(1);
    expect(tree[0].task.taskId).toBe(parent.taskId);
    expect(tree[0].descendantCount).toBe(2);
  });
});
