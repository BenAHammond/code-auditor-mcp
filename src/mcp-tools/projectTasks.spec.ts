import { describe, it, expect } from 'vitest';
import { resolveProjectPathForTasks } from './projectTasks.js';

describe('resolveProjectPathForTasks', () => {
  it('uses cwd when projectPath omitted', () => {
    const r = resolveProjectPathForTasks({});
    expect(r.projectPathDefaulted).toBe(true);
    expect(r.projectPath).toBe(resolveProjectPathForTasks({}).projectPath);
  });

  it('resolves explicit path', () => {
    const r = resolveProjectPathForTasks({ projectPath: '/tmp/foo' });
    expect(r.projectPathDefaulted).toBe(false);
    expect(r.projectPath).toMatch(/\/tmp\/foo$/);
  });

  it('treats blank string as omitted (defaults to cwd)', () => {
    const r = resolveProjectPathForTasks({ projectPath: '   ' });
    expect(r.projectPathDefaulted).toBe(true);
    expect(r.projectPath).toBe(resolveProjectPathForTasks({}).projectPath);
  });
});
