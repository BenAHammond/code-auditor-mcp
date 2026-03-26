/**
 * Loki persistence for project tasks. Keeps CodeIndexDB from owning task CRUD logic.
 */

import type { Collection } from 'lokijs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  CompleteProjectTaskResult,
  CreateProjectTaskInput,
  ListProjectTasksOptions,
  ListProjectTasksTreeNode,
  ProjectTaskDeleteMode,
  ProjectTask,
  ProjectTaskDocument,
  ProjectTaskStatus
} from '../types/projectTask.js';
import {
  applyProjectTaskPatch,
  coerceSortOrder,
  normalizeStringList,
  normalizeTaskPriority,
  normalizeTaskSource,
  normalizeTaskStatus,
  sanitizeUpdatePatch,
  serializeProjectTask,
  storedSortOrder
} from './projectTaskHelpers.js';

export class ProjectTaskRepository {
  constructor(
    private readonly getTasksCollection: () => Collection<ProjectTaskDocument>,
    private readonly persist: () => void
  ) {}

  private static isDone(status: ProjectTaskStatus): boolean {
    return status === 'done';
  }

  private static isClosed(status: ProjectTaskStatus): boolean {
    return status === 'done' || status === 'cancelled';
  }

  private getTaskById(taskId: string): ProjectTaskDocument | null {
    return this.getTasksCollection().findOne({ taskId });
  }

  private getDirectChildren(taskId: string): ProjectTaskDocument[] {
    return this.getTasksCollection().find({ parentTaskId: taskId });
  }

  private getDescendants(taskId: string): ProjectTaskDocument[] {
    const descendants: ProjectTaskDocument[] = [];
    const queue: string[] = [taskId];
    const seen = new Set<string>([taskId]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      const children = this.getDirectChildren(current);
      for (const child of children) {
        if (seen.has(child.taskId)) {
          continue;
        }
        seen.add(child.taskId);
        descendants.push(child);
        queue.push(child.taskId);
      }
    }

    return descendants;
  }

  private sortRows(rows: ProjectTaskDocument[]): ProjectTaskDocument[] {
    rows.sort((a, b) => {
      const ao = storedSortOrder(a);
      const bo = storedSortOrder(b);
      if (ao !== bo) {
        return ao - bo;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return rows;
  }

  private getOpenDependencyTaskIds(task: ProjectTaskDocument): string[] {
    return normalizeStringList(task.blockedBy).filter((depId) => {
      const dep = this.getTaskById(depId);
      if (!dep || dep.projectPath !== task.projectPath) {
        return false;
      }
      return !ProjectTaskRepository.isClosed(dep.status);
    });
  }

  private ensureDependencyCycleFree(
    taskId: string,
    blockerIds: string[],
    projectPath: string
  ): void {
    const stack = [...blockerIds];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) {
        continue;
      }
      seen.add(current);
      if (current === taskId) {
        throw new Error(
          'Invalid blockedBy: assigning these dependencies would create a dependency cycle'
        );
      }
      const doc = this.getTaskById(current);
      if (!doc || doc.projectPath !== projectPath) {
        continue;
      }
      for (const dep of normalizeStringList(doc.blockedBy)) {
        stack.push(dep);
      }
    }
  }

  private normalizeAndValidateBlockedBy(
    blockedBy: unknown,
    projectPath: string,
    selfTaskId?: string
  ): string[] {
    const ids = [...new Set(normalizeStringList(blockedBy).map((x) => x.trim()))]
      .filter((x) => x !== '');
    for (const depTaskId of ids) {
      if (selfTaskId && depTaskId === selfTaskId) {
        throw new Error('A task cannot be blocked by itself');
      }
      const dep = this.getTaskById(depTaskId);
      if (!dep) {
        throw new Error(`Blocked-by task not found: ${depTaskId}`);
      }
      if (dep.projectPath !== projectPath) {
        throw new Error('blockedBy tasks must belong to the same projectPath');
      }
    }
    if (selfTaskId) {
      this.ensureDependencyCycleFree(selfTaskId, ids, projectPath);
    }
    return ids;
  }

  private assertParentReferenceValid(
    projectPath: string,
    parentTaskId: string | null | undefined,
    selfTaskId?: string
  ): void {
    if (parentTaskId === undefined || parentTaskId === null) {
      return;
    }
    if (parentTaskId.trim() === '') {
      throw new Error('parentTaskId cannot be blank');
    }
    if (selfTaskId && parentTaskId === selfTaskId) {
      throw new Error('A task cannot be its own parent');
    }

    const parent = this.getTaskById(parentTaskId);
    if (!parent) {
      throw new Error(`Parent task not found: ${parentTaskId}`);
    }
    if (parent.projectPath !== projectPath) {
      throw new Error('Parent task must belong to the same projectPath');
    }

    if (!selfTaskId) {
      return;
    }

    let cursor: ProjectTaskDocument | null = parent;
    const visited = new Set<string>();
    while (cursor) {
      if (visited.has(cursor.taskId)) {
        throw new Error(
          `Detected parent cycle while validating task ${selfTaskId}`
        );
      }
      visited.add(cursor.taskId);
      if (cursor.taskId === selfTaskId) {
        throw new Error(
          'Invalid parentTaskId: assigning this parent would create a cycle'
        );
      }
      if (!cursor.parentTaskId) {
        break;
      }
      cursor = this.getTaskById(cursor.parentTaskId);
    }
  }

  private assertDoneAllowed(taskId: string): void {
    const unfinished = this.getDescendants(taskId).filter(
      (child) => !ProjectTaskRepository.isDone(child.status)
    );
    if (unfinished.length > 0) {
      const ids = unfinished.slice(0, 5).map((t) => t.taskId);
      throw new Error(
        `Cannot mark task done until all subtasks are done. Incomplete subtasks: ${ids.join(', ')}${unfinished.length > 5 ? ' ...' : ''}`
      );
    }
  }

  private assertNoOpenDependencies(task: ProjectTaskDocument): void {
    const openDependencies = this.getOpenDependencyTaskIds(task);
    if (openDependencies.length > 0) {
      throw new Error(
        `Cannot mark task done while dependencies are still open: ${openDependencies.join(', ')}`
      );
    }
  }

  create(input: CreateProjectTaskInput): ProjectTask {
    const projectPath = path.resolve(input.projectPath);
    const now = new Date().toISOString();
    const status = normalizeTaskStatus(input.status, 'pending');
    const source = normalizeTaskSource(input.source, 'manual');
    const sortOrder = coerceSortOrder(input.sortOrder);
    const blockedBy = this.normalizeAndValidateBlockedBy(
      input.blockedBy,
      projectPath
    );
    const relatedFiles = normalizeStringList(input.relatedFiles);
    const relatedSymbols = normalizeStringList(input.relatedSymbols);
    const priority = normalizeTaskPriority(input.priority);
    this.assertParentReferenceValid(projectPath, input.parentTaskId);
    if (status === 'done') {
      this.assertNoOpenDependencies({
        taskId: 'new-task',
        projectPath,
        title: input.title.trim(),
        status,
        blockedBy,
        createdAt: now,
        updatedAt: now
      });
    }
    const doc: ProjectTaskDocument = {
      taskId: randomUUID(),
      projectPath,
      title: input.title.trim(),
      ...(input.description !== undefined && { description: input.description }),
      status,
      source,
      sortOrder,
      blockedBy,
      ...(input.dueAt !== undefined && {
        dueAt: input.dueAt === null ? undefined : input.dueAt
      }),
      relatedFiles,
      relatedSymbols,
      ...(priority !== undefined && { priority }),
      ...(input.labels !== undefined && { labels: input.labels }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      ...(input.parentTaskId !== undefined && { parentTaskId: input.parentTaskId }),
      createdAt: now,
      updatedAt: now,
      ...(status === 'done' && { completedAt: now })
    };
    this.getTasksCollection().insert(doc);
    this.persist();
    return serializeProjectTask(doc);
  }

  getById(taskId: string): ProjectTask | null {
    const found = this.getTasksCollection().findOne({ taskId });
    return found ? serializeProjectTask(found) : null;
  }

  list(projectPath: string, options?: ListProjectTasksOptions): ProjectTask[] {
    const resolved = path.resolve(projectPath);
    let rows = this.getTasksCollection().find({ projectPath: resolved });
    if (options?.status) {
      rows = rows.filter((r) => r.status === options.status);
    }
    if (options?.source) {
      rows = rows.filter(
        (r) => normalizeTaskSource(r.source, 'manual') === options.source
      );
    }
    if (options?.priority) {
      rows = rows.filter((r) => r.priority === options.priority);
    }
    if (options?.label) {
      rows = rows.filter((r) => normalizeStringList(r.labels).includes(options.label!));
    }
    if (options?.parentTaskId !== undefined) {
      rows = rows.filter((r) => (r.parentTaskId ?? null) === options.parentTaskId);
    }
    if (options?.hasChildren !== undefined) {
      rows = rows.filter((r) => this.getDirectChildren(r.taskId).length > 0 === options.hasChildren);
    }
    if (options?.blockedByTaskId) {
      rows = rows.filter((r) =>
        normalizeStringList(r.blockedBy).includes(options.blockedByTaskId!)
      );
    }
    if (options?.query && options.query.trim() !== '') {
      const q = options.query.toLowerCase().trim();
      rows = rows.filter((r) => {
        const haystack = [
          r.title,
          r.description ?? '',
          ...normalizeStringList(r.labels),
          ...normalizeStringList(r.relatedFiles),
          ...normalizeStringList(r.relatedSymbols)
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    if (options?.overdueOnly) {
      const now = Date.now();
      rows = rows.filter((r) => {
        if (!r.dueAt || ProjectTaskRepository.isClosed(r.status)) {
          return false;
        }
        const ts = new Date(r.dueAt).getTime();
        return Number.isFinite(ts) && ts < now;
      });
    }
    if (options?.actionableOnly) {
      rows = rows.filter((r) => {
        if (ProjectTaskRepository.isClosed(r.status)) {
          return false;
        }
        if (r.status === 'blocked') {
          return false;
        }
        return this.getOpenDependencyTaskIds(r).length === 0;
      });
    }
    this.sortRows(rows);
    const cap = Math.min(Math.max(options?.limit ?? 500, 1), 1000);
    return rows.slice(0, cap).map((r) => serializeProjectTask(r));
  }

  listTree(
    projectPath: string,
    options?: Omit<ListProjectTasksOptions, 'parentTaskId' | 'hasChildren'>
  ): ListProjectTasksTreeNode[] {
    const allTasks = this.list(projectPath, { ...options, limit: 1000 });
    const byId = new Map(allTasks.map((task) => [task.taskId, task]));
    const byParent = new Map<string | null, ProjectTask[]>();
    for (const task of allTasks) {
      const parentId = task.parentTaskId ?? null;
      if (!byParent.has(parentId)) {
        byParent.set(parentId, []);
      }
      byParent.get(parentId)!.push(task);
    }
    for (const siblings of byParent.values()) {
      siblings.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
          return a.sortOrder - b.sortOrder;
        }
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
    }

    const descendantStats = new Map<
      string,
      { descendantCount: number; openDescendantCount: number }
    >();
    const computeDescendantStats = (
      taskId: string
    ): { descendantCount: number; openDescendantCount: number } => {
      const cached = descendantStats.get(taskId);
      if (cached) {
        return cached;
      }
      let descendantCount = 0;
      let openDescendantCount = 0;
      for (const child of byParent.get(taskId) ?? []) {
        const childStats = computeDescendantStats(child.taskId);
        descendantCount += 1 + childStats.descendantCount;
        if (!ProjectTaskRepository.isDone(child.status)) {
          openDescendantCount += 1;
        }
        openDescendantCount += childStats.openDescendantCount;
      }
      const out = { descendantCount, openDescendantCount };
      descendantStats.set(taskId, out);
      return out;
    };

    const out: ListProjectTasksTreeNode[] = [];
    const visited = new Set<string>();
    const pushNode = (task: ProjectTask, depth: number) => {
      if (visited.has(task.taskId)) {
        return;
      }
      visited.add(task.taskId);
      const stats = computeDescendantStats(task.taskId);
      out.push({
        task,
        depth,
        parentTaskId: task.parentTaskId ?? null,
        childCount: (byParent.get(task.taskId) ?? []).length,
        descendantCount: stats.descendantCount,
        openDescendantCount: stats.openDescendantCount
      });
      for (const child of byParent.get(task.taskId) ?? []) {
        pushNode(child, depth + 1);
      }
    };

    const roots = allTasks.filter((task) => {
      const parentId = task.parentTaskId ?? null;
      return parentId === null || !byId.has(parentId);
    });
    for (const root of roots) {
      pushNode(root, 0);
    }
    for (const task of allTasks) {
      pushNode(task, 0);
    }
    const cap = Math.min(Math.max(options?.limit ?? 500, 1), 1000);
    return out.slice(0, cap);
  }

  listActionable(
    projectPath: string,
    options?: Omit<ListProjectTasksOptions, 'actionableOnly'>
  ): ProjectTask[] {
    return this.list(projectPath, { ...options, actionableOnly: true });
  }

  complete(taskId: string): CompleteProjectTaskResult | null {
    const doc = this.getTaskById(taskId);
    if (!doc) {
      return null;
    }
    const blockedByOpenSubtaskIds = this
      .getDescendants(taskId)
      .filter((child) => !ProjectTaskRepository.isDone(child.status))
      .map((child) => child.taskId);
    const blockedByOpenDependencyTaskIds = this.getOpenDependencyTaskIds(doc);

    if (
      blockedByOpenSubtaskIds.length > 0 ||
      blockedByOpenDependencyTaskIds.length > 0
    ) {
      const reasons = [];
      if (blockedByOpenSubtaskIds.length > 0) {
        reasons.push(
          `open subtasks: ${blockedByOpenSubtaskIds.slice(0, 5).join(', ')}${blockedByOpenSubtaskIds.length > 5 ? ' ...' : ''}`
        );
      }
      if (blockedByOpenDependencyTaskIds.length > 0) {
        reasons.push(
          `open dependencies: ${blockedByOpenDependencyTaskIds.slice(0, 5).join(', ')}${blockedByOpenDependencyTaskIds.length > 5 ? ' ...' : ''}`
        );
      }
      throw new Error(`Cannot complete task: ${reasons.join('; ')}`);
    }

    const now = new Date().toISOString();
    applyProjectTaskPatch(doc, { status: 'done' }, now);
    this.getTasksCollection().update(doc);
    this.persist();
    return {
      task: serializeProjectTask(doc),
      blockedByOpenDependencyTaskIds,
      blockedByOpenSubtaskIds
    };
  }

  update(taskId: string, patch: unknown): ProjectTask | null {
    const doc = this.getTasksCollection().findOne({ taskId });
    if (!doc) {
      return null;
    }
    const now = new Date().toISOString();
    const safe = sanitizeUpdatePatch(patch);
    this.assertParentReferenceValid(
      doc.projectPath,
      safe.parentTaskId,
      doc.taskId
    );
    let nextBlockedBy = normalizeStringList(doc.blockedBy);
    if (safe.blockedBy !== undefined) {
      safe.blockedBy = this.normalizeAndValidateBlockedBy(
        safe.blockedBy,
        doc.projectPath,
        doc.taskId
      );
      nextBlockedBy = safe.blockedBy;
    }
    if (safe.status === 'done') {
      this.assertDoneAllowed(doc.taskId);
      this.assertNoOpenDependencies({
        ...doc,
        blockedBy: nextBlockedBy
      } as ProjectTaskDocument);
    }
    applyProjectTaskPatch(doc, safe, now);
    this.getTasksCollection().update(doc);
    this.persist();
    return serializeProjectTask(doc);
  }

  private removeBlockedByReferences(taskIds: Set<string>): void {
    const rows = this.getTasksCollection().find();
    const now = new Date().toISOString();
    let changed = false;
    for (const row of rows) {
      const deps = normalizeStringList(row.blockedBy);
      const filtered = deps.filter((depId) => !taskIds.has(depId));
      if (filtered.length !== deps.length) {
        row.blockedBy = filtered;
        row.updatedAt = now;
        this.getTasksCollection().update(row);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  delete(taskId: string, mode: ProjectTaskDeleteMode = 'reject'): boolean {
    const doc = this.getTasksCollection().findOne({ taskId });
    if (!doc) {
      return false;
    }
    const children = this.getDirectChildren(taskId);
    if (mode === 'reject' && children.length > 0) {
      const childIds = children.slice(0, 5).map((c) => c.taskId);
      throw new Error(
        `Cannot delete task with subtasks. Reparent or delete subtasks first: ${childIds.join(', ')}${children.length > 5 ? ' ...' : ''}`
      );
    }
    if (mode === 'detach' && children.length > 0) {
      const now = new Date().toISOString();
      for (const child of children) {
        child.parentTaskId = undefined;
        child.updatedAt = now;
        this.getTasksCollection().update(child);
      }
    }
    if (mode === 'cascade') {
      const descendants = this.getDescendants(taskId);
      for (const descendant of descendants) {
        this.getTasksCollection().remove(descendant);
      }
      this.getTasksCollection().remove(doc);
      this.removeBlockedByReferences(
        new Set([taskId, ...descendants.map((d) => d.taskId)])
      );
      this.persist();
      return true;
    }
    this.getTasksCollection().remove(doc);
    this.removeBlockedByReferences(new Set([taskId]));
    this.persist();
    return true;
  }
}
