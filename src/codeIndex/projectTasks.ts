/**
 * Project-task access — a thin holder over `ProjectTaskRepository`, backed by
 * the `project_tasks` table. Extracted from `CodeIndexDB`; owns its own
 * `SqliteCollectionAdapter` against the shared handle.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { SqliteCollectionAdapter } from './sqliteCollection.js';
import { ProjectTaskRepository } from '../services/ProjectTaskRepository.js';
import type {
  CompleteProjectTaskResult,
  CreateProjectTaskInput,
  ListProjectTasksOptions,
  ListProjectTasksTreeNode,
  ProjectTask,
  ProjectTaskDeleteMode,
} from '../types/projectTask.js';

/**
 * Project-task access over the `project_tasks` table. Holds a collection
 * adapter and lazily builds a repository on top of it, delegating create, list,
 * complete, and delete operations to the shared task logic.
 */
export class ProjectTasksIndex {
  private tasksAdapter: SqliteCollectionAdapter;
  private repository: ProjectTaskRepository | null = null;

  /**
   * Create the index over the shared SQLite handle.
   *
   * @param db The SQLite database handle.
   */
  constructor(db: SqliteDatabase) {
    this.tasksAdapter = new SqliteCollectionAdapter(db, 'project_tasks');
  }

  private getRepository(): ProjectTaskRepository {
    if (!this.repository) {
      this.repository = new ProjectTaskRepository(
        () => this.tasksAdapter,
        () => { /* SQLite is auto-persisted; no-op */ }
      );
    }
    return this.repository;
  }

  /** Create a project task via the task repository. */
  async createProjectTask(input: CreateProjectTaskInput): Promise<ProjectTask> {
    return this.getRepository().create(input);
  }

  /** Fetch a project task by ID. */
  async getProjectTask(taskId: string): Promise<ProjectTask | null> {
    return this.getRepository().getById(taskId);
  }

  /** List project tasks for a project, with optional filters. */
  async listProjectTasks(projectPath: string, options?: ListProjectTasksOptions): Promise<ProjectTask[]> {
    return this.getRepository().list(projectPath, options);
  }

  /**
   * List project tasks as a tree of nodes with descendant statistics.
   *
   * @param projectPath The project whose tasks are listed.
   * @param options List filters, excluding tree-structure-only fields.
   * @returns The tasks organized as a tree with per-node descendant stats.
   */
  async listProjectTasksTree(
    projectPath: string,
    options?: Omit<ListProjectTasksOptions, 'parentTaskId' | 'hasChildren'>
  ): Promise<ListProjectTasksTreeNode[]> {
    return this.getRepository().listTree(projectPath, options);
  }

  /**
   * List project tasks that are actionable (open dependencies resolved).
   *
   * @param projectPath The project whose tasks are listed.
   * @param options List filters, excluding the actionable-only flag.
   * @returns The tasks that are ready to be worked on.
   */
  async listActionableProjectTasks(
    projectPath: string,
    options?: Omit<ListProjectTasksOptions, 'actionableOnly'>
  ): Promise<ProjectTask[]> {
    return this.getRepository().listActionable(projectPath, options);
  }

  /** Mark a project task done after validating subtasks and dependencies. */
  async completeProjectTask(taskId: string): Promise<CompleteProjectTaskResult | null> {
    return this.getRepository().complete(taskId);
  }

  /** Update a project task from a raw patch. */
  async updateProjectTask(taskId: string, patch: unknown): Promise<ProjectTask | null> {
    return this.getRepository().update(taskId, patch);
  }

  /** Delete a project task, handling subtasks per the given mode. */
  async deleteProjectTask(taskId: string, mode?: ProjectTaskDeleteMode): Promise<boolean> {
    return this.getRepository().delete(taskId, mode);
  }

  /** Check whether any non-closed project task matches the given fingerprint. */
  hasOpenTaskByFingerprint(fingerprint: string | null | undefined): boolean {
    if (!fingerprint) return false;
    return this.getRepository().findOpenByFingerprint(fingerprint).length > 0;
  }
}
