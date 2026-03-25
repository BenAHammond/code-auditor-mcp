/**
 * Persistent project tasks stored in LokiJS.
 * Survives clearIndex (same DB file; clearIndex clears analysis-derived collections only).
 */

export type ProjectTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type ProjectTaskPriority = 'low' | 'medium' | 'high';

/** Who created or last logically "owns" the task row */
export type ProjectTaskSource = 'manual' | 'audit' | 'mcp';

/** Stored document (may include Loki fields) */
export interface ProjectTaskDocument {
  taskId: string;
  projectPath: string;
  title: string;
  description?: string;
  status: ProjectTaskStatus;
  priority?: ProjectTaskPriority;
  labels?: string[];
  /** Free-form: related URLs, extra notes beyond structured fields */
  metadata?: Record<string, unknown>;
  parentTaskId?: string | null;
  /** Default applied in API layer when missing (legacy rows). */
  source?: ProjectTaskSource;
  /** Task IDs that block this one (dependency / waiting-on). */
  blockedBy?: string[];
  /** ISO 8601 datetime; optional scheduling */
  dueAt?: string | null;
  /** Lower sorts earlier within the same list (default 0). */
  sortOrder?: number;
  /** Repo file paths tied to the task */
  relatedFiles?: string[];
  /** Symbols (function/class/component names) for cross-linking with the index */
  relatedSymbols?: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  $loki?: number;
  meta?: unknown;
}

/** API-facing task (no Loki internals); defaults applied for legacy stored rows */
export type ProjectTask = Omit<ProjectTaskDocument, '$loki' | 'meta'> & {
  source: ProjectTaskSource;
  sortOrder: number;
  blockedBy: string[];
  relatedFiles: string[];
  relatedSymbols: string[];
};

export interface CreateProjectTaskInput {
  projectPath: string;
  title: string;
  description?: string;
  status?: ProjectTaskStatus;
  priority?: ProjectTaskPriority;
  labels?: string[];
  metadata?: Record<string, unknown>;
  parentTaskId?: string | null;
  source?: ProjectTaskSource;
  blockedBy?: string[];
  dueAt?: string | null;
  sortOrder?: number;
  relatedFiles?: string[];
  relatedSymbols?: string[];
}

export type UpdateProjectTaskPatch = Partial<
  Pick<
    ProjectTaskDocument,
    | 'title'
    | 'description'
    | 'status'
    | 'priority'
    | 'labels'
    | 'metadata'
    | 'parentTaskId'
    | 'source'
    | 'blockedBy'
    | 'dueAt'
    | 'sortOrder'
    | 'relatedFiles'
    | 'relatedSymbols'
  >
>;
