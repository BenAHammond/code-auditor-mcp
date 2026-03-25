/**
 * Pure helpers for project tasks — normalization, serialization, patch application.
 * Keeps CodeIndexDB and MCP handlers thin (Single Responsibility).
 */

import type {
  ProjectTask,
  ProjectTaskDocument,
  ProjectTaskPriority,
  ProjectTaskSource,
  ProjectTaskStatus,
  UpdateProjectTaskPatch
} from '../types/projectTask.js';

export const PROJECT_TASK_STATUSES: readonly ProjectTaskStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'done',
  'cancelled'
] as const;

export const PROJECT_TASK_SOURCES: readonly ProjectTaskSource[] = [
  'manual',
  'audit',
  'mcp'
] as const;

const PRIORITIES: readonly ProjectTaskPriority[] = ['low', 'medium', 'high'];

export function normalizeTaskStatus(
  value: unknown,
  fallback: ProjectTaskStatus
): ProjectTaskStatus {
  if (
    typeof value === 'string' &&
    (PROJECT_TASK_STATUSES as readonly string[]).includes(value)
  ) {
    return value as ProjectTaskStatus;
  }
  return fallback;
}

export function normalizeTaskSource(
  value: unknown,
  fallback: ProjectTaskSource
): ProjectTaskSource {
  if (
    typeof value === 'string' &&
    (PROJECT_TASK_SOURCES as readonly string[]).includes(value)
  ) {
    return value as ProjectTaskSource;
  }
  return fallback;
}

export function normalizeTaskPriority(
  value: unknown
): ProjectTaskPriority | undefined {
  if (
    typeof value === 'string' &&
    (PRIORITIES as readonly string[]).includes(value)
  ) {
    return value as ProjectTaskPriority;
  }
  return undefined;
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((x): x is string => typeof x === 'string');
}

export function coerceSortOrder(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

export function storedSortOrder(doc: ProjectTaskDocument): number {
  return coerceSortOrder(doc.sortOrder);
}

/**
 * API shape for stored rows (legacy docs may omit structured fields).
 */
export function serializeProjectTask(doc: ProjectTaskDocument): ProjectTask {
  const { $loki, meta, ...rest } = doc;
  return {
    ...rest,
    source: normalizeTaskSource(rest.source, 'manual'),
    sortOrder: storedSortOrder(doc),
    blockedBy: normalizeStringList(rest.blockedBy),
    relatedFiles: normalizeStringList(rest.relatedFiles),
    relatedSymbols: normalizeStringList(rest.relatedSymbols)
  };
}

const UPDATE_PATCH_KEYS: (keyof UpdateProjectTaskPatch)[] = [
  'title',
  'description',
  'status',
  'priority',
  'labels',
  'metadata',
  'parentTaskId',
  'source',
  'blockedBy',
  'dueAt',
  'sortOrder',
  'relatedFiles',
  'relatedSymbols'
];

/**
 * Builds a typed patch from MCP/JSON input — ignores unknown keys (no arbitrary spread onto DB).
 */
export function sanitizeUpdatePatch(raw: unknown): UpdateProjectTaskPatch {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return {};
  }
  const src = raw as Record<string, unknown>;
  const out: UpdateProjectTaskPatch = {};

  for (const key of UPDATE_PATCH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) {
      continue;
    }
    const v = src[key];
    switch (key) {
      case 'title':
        if (typeof v === 'string') {
          out.title = v;
        }
        break;
      case 'description':
        if (v === undefined || v === null || typeof v === 'string') {
          out.description = v === null ? undefined : (v as string);
        }
        break;
      case 'status':
        if (
          typeof v === 'string' &&
          (PROJECT_TASK_STATUSES as readonly string[]).includes(v)
        ) {
          out.status = v as ProjectTaskStatus;
        }
        break;
      case 'priority': {
        const p = normalizeTaskPriority(v);
        if (p !== undefined) {
          out.priority = p;
        }
        break;
      }
      case 'labels':
        if (v === undefined || v === null) {
          out.labels = undefined;
        } else if (Array.isArray(v)) {
          out.labels = normalizeStringList(v);
        }
        break;
      case 'metadata':
        if (v !== undefined && typeof v === 'object' && v !== null && !Array.isArray(v)) {
          out.metadata = v as Record<string, unknown>;
        }
        break;
      case 'parentTaskId':
        if (v === undefined || v === null) {
          out.parentTaskId = null;
        } else if (typeof v === 'string') {
          out.parentTaskId = v;
        }
        break;
      case 'source':
        if (
          typeof v === 'string' &&
          (PROJECT_TASK_SOURCES as readonly string[]).includes(v)
        ) {
          out.source = v as ProjectTaskSource;
        }
        break;
      case 'blockedBy':
        if (Array.isArray(v)) {
          out.blockedBy = normalizeStringList(v);
        }
        break;
      case 'dueAt':
        if (v === undefined || v === null || v === '') {
          out.dueAt = null;
        } else if (typeof v === 'string') {
          out.dueAt = v;
        }
        break;
      case 'sortOrder':
        if (typeof v === 'number' && Number.isFinite(v)) {
          out.sortOrder = v;
        }
        break;
      case 'relatedFiles':
        if (Array.isArray(v)) {
          out.relatedFiles = normalizeStringList(v);
        }
        break;
      case 'relatedSymbols':
        if (Array.isArray(v)) {
          out.relatedSymbols = normalizeStringList(v);
        }
        break;
      default:
        break;
    }
  }

  return out;
}

export function applyProjectTaskPatch(
  doc: ProjectTaskDocument,
  patch: UpdateProjectTaskPatch,
  nowIso: string
): void {
  if (patch.title !== undefined) {
    doc.title = String(patch.title).trim();
  }
  if (patch.description !== undefined) {
    doc.description = patch.description;
  }
  if (patch.priority !== undefined) {
    const p = normalizeTaskPriority(patch.priority);
    if (p !== undefined) {
      doc.priority = p;
    }
  }
  if (patch.labels !== undefined) {
    doc.labels = patch.labels;
  }
  if (patch.metadata !== undefined) {
    doc.metadata = patch.metadata;
  }
  if (patch.parentTaskId !== undefined) {
    doc.parentTaskId = patch.parentTaskId;
  }
  if (patch.source !== undefined) {
    doc.source = normalizeTaskSource(patch.source, doc.source ?? 'manual');
  }
  if (patch.blockedBy !== undefined) {
    doc.blockedBy = normalizeStringList(patch.blockedBy);
  }
  if (patch.sortOrder !== undefined) {
    doc.sortOrder = coerceSortOrder(patch.sortOrder);
  }
  if (patch.relatedFiles !== undefined) {
    doc.relatedFiles = normalizeStringList(patch.relatedFiles);
  }
  if (patch.relatedSymbols !== undefined) {
    doc.relatedSymbols = normalizeStringList(patch.relatedSymbols);
  }
  if (patch.dueAt !== undefined) {
    doc.dueAt =
      patch.dueAt === null || patch.dueAt === ''
        ? undefined
        : String(patch.dueAt);
  }
  if (patch.status !== undefined) {
    const newStatus = normalizeTaskStatus(patch.status, doc.status);
    doc.status = newStatus;
    doc.completedAt = newStatus === 'done' ? nowIso : undefined;
  }
  doc.updatedAt = nowIso;
}
