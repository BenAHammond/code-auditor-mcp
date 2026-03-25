/**
 * Loki persistence for project tasks. Keeps CodeIndexDB from owning task CRUD logic.
 */

import type { Collection } from 'lokijs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  CreateProjectTaskInput,
  ProjectTask,
  ProjectTaskDocument,
  ProjectTaskSource,
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

  create(input: CreateProjectTaskInput): ProjectTask {
    const projectPath = path.resolve(input.projectPath);
    const now = new Date().toISOString();
    const status = normalizeTaskStatus(input.status, 'pending');
    const source = normalizeTaskSource(input.source, 'manual');
    const sortOrder = coerceSortOrder(input.sortOrder);
    const blockedBy = normalizeStringList(input.blockedBy);
    const relatedFiles = normalizeStringList(input.relatedFiles);
    const relatedSymbols = normalizeStringList(input.relatedSymbols);
    const priority = normalizeTaskPriority(input.priority);
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

  list(
    projectPath: string,
    options?: {
      status?: ProjectTaskStatus;
      source?: ProjectTaskSource;
      limit?: number;
    }
  ): ProjectTask[] {
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
    rows.sort((a, b) => {
      const ao = storedSortOrder(a);
      const bo = storedSortOrder(b);
      if (ao !== bo) {
        return ao - bo;
      }
      return (
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    });
    const cap = Math.min(Math.max(options?.limit ?? 500, 1), 1000);
    return rows.slice(0, cap).map((r) => serializeProjectTask(r));
  }

  update(taskId: string, patch: unknown): ProjectTask | null {
    const doc = this.getTasksCollection().findOne({ taskId });
    if (!doc) {
      return null;
    }
    const now = new Date().toISOString();
    const safe = sanitizeUpdatePatch(patch);
    applyProjectTaskPatch(doc, safe, now);
    this.getTasksCollection().update(doc);
    this.persist();
    return serializeProjectTask(doc);
  }

  delete(taskId: string): boolean {
    const doc = this.getTasksCollection().findOne({ taskId });
    if (!doc) {
      return false;
    }
    this.getTasksCollection().remove(doc);
    this.persist();
    return true;
  }
}
