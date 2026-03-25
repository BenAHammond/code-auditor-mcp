/**
 * MCP handlers for persistent project tasks (survive code index reset).
 */

import path from 'node:path';
import { CodeIndexDB } from '../codeIndexDB.js';
import type { ProjectTaskSource, ProjectTaskStatus } from '../types/projectTask.js';

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

export async function handleProjectTasks(args: Record<string, unknown>) {
  const action = String(args.action ?? '')
    .toLowerCase()
    .trim();
  const db = CodeIndexDB.getInstance();
  await db.initialize();

  try {
    switch (action) {
      case 'list': {
        const { projectPath, projectPathDefaulted } = resolveProjectPathForTasks(args);
        const status = args.status as ProjectTaskStatus | undefined;
        const source = args.source as ProjectTaskSource | undefined;
        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        const tasks = await db.listProjectTasks(projectPath, {
          status,
          source,
          limit
        });
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
      case 'create': {
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
        const taskId = args.taskId as string | undefined;
        if (!taskId) {
          return { success: false, error: 'taskId is required for get' };
        }
        const task = await db.getProjectTask(taskId);
        if (!task) {
          return { success: false, error: `Task not found: ${taskId}` };
        }
        return { success: true, task };
      }
      case 'update': {
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
      case 'delete': {
        const taskId = args.taskId as string | undefined;
        if (!taskId) {
          return { success: false, error: 'taskId is required for delete' };
        }
        const deleted = await db.deleteProjectTask(taskId);
        return {
          success: deleted,
          taskId,
          message: deleted ? 'Task deleted' : 'Task not found'
        };
      }
      default:
        return {
          success: false,
          error: `Unknown action "${action}". Use list, create, get, update, or delete.`
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
