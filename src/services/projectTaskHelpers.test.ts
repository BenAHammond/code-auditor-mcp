import { describe, it, expect } from 'vitest';
import {
  sanitizeUpdatePatch,
  serializeProjectTask,
  normalizeTaskPriority
} from './projectTaskHelpers.js';
import type { ProjectTaskDocument } from '../types/projectTask.js';

describe('projectTaskHelpers', () => {
  it('sanitizeUpdatePatch drops unknown keys and invalid status', () => {
    const patch = sanitizeUpdatePatch({
      title: 'x',
      status: 'not_a_real_status',
      extra: { nested: 1 }
    });
    expect(patch).toEqual({ title: 'x' });
  });

  it('sanitizeUpdatePatch accepts valid status and source', () => {
    expect(
      sanitizeUpdatePatch({ status: 'done', source: 'audit' })
    ).toEqual({ status: 'done', source: 'audit' });
  });

  it('normalizeTaskPriority rejects garbage', () => {
    expect(normalizeTaskPriority('high')).toBe('high');
    expect(normalizeTaskPriority('nope')).toBeUndefined();
  });

  it('serializeProjectTask fills defaults for legacy docs', () => {
    const doc = {
      taskId: '1',
      projectPath: '/p',
      title: 't',
      status: 'pending' as const,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z'
    } as ProjectTaskDocument;
    const s = serializeProjectTask(doc);
    expect(s.source).toBe('manual');
    expect(s.sortOrder).toBe(0);
    expect(s.blockedBy).toEqual([]);
    expect(s.relatedFiles).toEqual([]);
    expect(s.relatedSymbols).toEqual([]);
  });
});
