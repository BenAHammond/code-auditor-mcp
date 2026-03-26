/**
 * MCP handlers for persistent project tasks (survive code index reset).
 */

import path from 'node:path';
import { CodeIndexDB } from '../codeIndexDB.js';
import type {
  ListProjectTasksOptions,
  ProjectTaskDeleteMode,
  ProjectTaskPriority,
  ProjectTaskSource,
  ProjectTaskStatus
} from '../types/projectTask.js';

const inFlightReadOps = new Map<string, Promise<unknown>>();

function buildReadDedupKey(
  action: string,
  args: Record<string, unknown>,
  projectPath?: string
): string {
  const normalized: Record<string, unknown> = { action };
  if (projectPath) {
    normalized.projectPath = projectPath;
  }
  const keyFields = [
    'taskId',
    'status',
    'source',
    'priority',
    'label',
    'parentTaskId',
    'hasChildren',
    'blockedByTaskId',
    'query',
    'overdueOnly',
    'actionableOnly',
    'limit'
  ] as const;
  for (const field of keyFields) {
    if (Object.prototype.hasOwnProperty.call(args, field)) {
      normalized[field] = args[field];
    }
  }
  return JSON.stringify(normalized);
}

async function withReadDedup<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlightReadOps.get(key);
  if (existing) {
    return (await existing) as T;
  }
  const promise = run();
  inFlightReadOps.set(key, promise as Promise<unknown>);
  try {
    return await promise;
  } finally {
    inFlightReadOps.delete(key);
  }
}

/**
 * Resolve project root for list/create. If omitted, uses `process.cwd()` (MCP server working directory),
 * same idea as the audit tool's default path. Prefer passing an absolute project path when cwd may differ
 * from the repo you mean (common with MCP hosts).
 */
export function resolveProjectPathForTasks(args: Record<string, unknown>): {
  projectPath: string;
  projectPathDefaulted: boolean;
} {
  const raw = args.projectPath;
  if (typeof raw === 'string' && raw.trim() !== '') {
    return { projectPath: path.resolve(raw.trim()), projectPathDefaulted: false };
  }
  return { projectPath: path.resolve(process.cwd()), projectPathDefaulted: true };
}

function parseListTaskOptions(
  args: Record<string, unknown>
): ListProjectTasksOptions {
  return {
    status: args.status as ProjectTaskStatus | undefined,
    source: args.source as ProjectTaskSource | undefined,
    priority: args.priority as ProjectTaskPriority | undefined,
    label: typeof args.label === 'string' ? args.label : undefined,
    parentTaskId:
      args.parentTaskId === null
        ? null
        : typeof args.parentTaskId === 'string'
          ? args.parentTaskId
          : undefined,
    hasChildren:
      typeof args.hasChildren === 'boolean' ? args.hasChildren : undefined,
    blockedByTaskId:
      typeof args.blockedByTaskId === 'string' ? args.blockedByTaskId : undefined,
    query: typeof args.query === 'string' ? args.query : undefined,
    overdueOnly:
      typeof args.overdueOnly === 'boolean' ? args.overdueOnly : undefined,
    actionableOnly:
      typeof args.actionableOnly === 'boolean' ? args.actionableOnly : undefined,
    limit: typeof args.limit === 'number' ? args.limit : undefined
  };
}

export async function handleProjectTasks(
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) {
  if (options?.signal?.aborted) {
    throw new Error('project_tasks request aborted');
  }
  const action = String(args.action ?? '')
    .toLowerCase()
    .trim();
  const db = CodeIndexDB.getInstance();
  await db.initialize();

  try {
    switch (action) {
      case 'list': {
        if (options?.signal?.aborted) {
          throw new Error('project_tasks request aborted');
        }
        const { projectPath, projectPathDefaulted } = resolveProjectPathForTasks(args);
        const dedupKey = buildReadDedupKey(action, args, projectPath);
        const tasks = await withReadDedup(dedupKey, () =>
          db.listProjectTasks(projectPath, parseListTaskOptions(args))
        );
        return {
          success: true,
          projectPath,
          projectPathDefaulted,
          count: tasks.length,
          tasks,
          note:
            'Tasks and analyzer configs persist across sync_index reset; cached audits, code maps, and schema overlays are cleared to avoid stale code references.'
        };
      }
      case 'list_tree': {
        if (options?.signal?.aborted) {
          throw new Error('project_tasks request aborted');
        }
        const { projectPath, projectPathDefaulted } = resolveProjectPathForTasks(args);
        const listOptions = parseListTaskOptions(args);
        const dedupKey = buildReadDedupKey(action, args, projectPath);
        const tree = await withReadDedup(dedupKey, () =>
          db.listProjectTasksTree(projectPath, listOptions)
        );
        return {
          success: true,
          projectPath,
          projectPathDefaulted,
          count: tree.length,
          tree
        };
      }
      case 'create': {
        if (options?.signal?.aborted) {
          throw new Error('project_tasks request aborted');
        }
        const { projectPath, projectPathDefaulted } = resolveProjectPathForTasks(args);
        const title =
          typeof args.title === 'string' ? args.title.trim() : '';
        if (!title) {
          return { success: false, error: 'title is required for create' };
        }
        const task = await db.createProjectTask({
          projectPath,
          title,
          description:
            typeof args.description === 'string' ? args.description : undefined,
          status: args.status as ProjectTaskStatus | undefined,
          priority: args.priority as 'low' | 'medium' | 'high' | undefined,
          labels: Array.isArray(args.labels) ? (args.labels as string[]) : undefined,
          metadata:
            args.metadata && typeof args.metadata === 'object'
              ? (args.metadata as Record<string, unknown>)
              : undefined,
          parentTaskId:
            typeof args.parentTaskId === 'string' ? args.parentTaskId : undefined,
          source: args.source as ProjectTaskSource | undefined,
          blockedBy: Array.isArray(args.blockedBy)
            ? (args.blockedBy as string[])
            : undefined,
          dueAt:
            args.dueAt === null
              ? null
              : typeof args.dueAt === 'string'
                ? args.dueAt
                : undefined,
          sortOrder:
            typeof args.sortOrder === 'number' ? args.sortOrder : undefined,
          relatedFiles: Array.isArray(args.relatedFiles)
            ? (args.relatedFiles as string[])
            : undefined,
          relatedSymbols: Array.isArray(args.relatedSymbols)
            ? (args.relatedSymbols as string[])
            : undefined
        });
        return { success: true, projectPathDefaulted, task };
      }
      case 'get': {
        if (options?.signal?.aborted) {
          throw new Error('project_tasks request aborted');
        }
        const taskId = args.taskId as string | undefined;
        if (!taskId) {
          return { success: false, error: 'taskId is required for get' };
        }
        const dedupKey = buildReadDedupKey(action, args);
        const task = await withReadDedup(dedupKey, () => db.getProjectTask(taskId));
        if (!task) {
          return { success: false, error: `Task not found: ${taskId}` };
        }
        return { success: true, task };
      }
      case 'update': {
        if (options?.signal?.aborted) {
          throw new Error('project_tasks request aborted');
        }
        const taskId = args.taskId as string | undefined;
        if (!taskId) {
          return { success: false, error: 'taskId is required for update' };
        }
        const task = await db.updateProjectTask(taskId, args.patch);
        if (!task) {
          return { success: false, error: `Task not found: ${taskId}` };
        }
        return { success: true, task };
      }
      case 'complete_task': {
        if (options?.signal?.aborted) {
          throw new Error('project_tasks request aborted');
        }
        const taskId = args.taskId as string | undefined;
        if (!taskId) {
          return { success: false, error: 'taskId is required for complete_task' };
        }
        const result = await db.completeProjectTask(taskId);
        if (!result) {
          return { success: false, error: `Task not found: ${taskId}` };
        }
        return { success: true, ...result };
      }
      case 'delete': {
        if (options?.signal?.aborted) {
          throw new Error('project_tasks request aborted');
        }
        const taskId = args.taskId as string | undefined;
        if (!taskId) {
          return { success: false, error: 'taskId is required for delete' };
        }
        const mode = args.mode as ProjectTaskDeleteMode | undefined;
        const deleted = await db.deleteProjectTask(taskId, mode);
        return {
          success: deleted,
          taskId,
          message: deleted ? 'Task deleted' : 'Task not found'
        };
      }
      default:
        return {
          success: false,
          error:
            `Unknown action "${action}". Use list, list_tree, create, get, update, complete_task, or delete.`
        };
    }
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Project task operation failed'
    };
  }
}
