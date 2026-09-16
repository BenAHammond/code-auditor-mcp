/**
 * Spec 59 — npx cache-warm fix contract for `warmNpxCache`.
 *
 *   - **positive** — `warmNpxCache(v)` spawns `npx -y -p code-auditor-mcp@<v>
 *     code-audit --version`, i.e. the exact command the hook's last-resort path
 *     runs, so the first edit after install hits a warm npx cache.
 *   - **guard**     — a spawn that errors or exits non-zero still resolves the
 *     promise (never rejects, never leaves a dangling waiter): a failed warm must
 *     not fail the install over a warm-the-cache nicety.
 *   - **absence**   — (by construction) the warm is awaited before the install
 *     summary, so a blocking warm is one that actually finished, not a fire-and-
 *     forget race.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { warmNpxCache } from './installer.js';

function fakeChild(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn();
  return child;
}

describe('warmNpxCache — npx cache warm at install (Spec 59)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('positive: spawns the exact pinned command for the package version', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = warmNpxCache('3.9.11');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['-y', '-p', 'code-auditor-mcp@3.9.11', 'code-audit', '--version'],
      { stdio: 'ignore' },
    );

    child.emit('exit', 0);
    await p; // resolves, never rejects
  });

  it('guard: a spawn error still resolves (never fails the install)', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = warmNpxCache('3.9.11');
    child.emit('error', new Error('npx not found'));
    await p; // resolves despite the error
  });

  it('guard: a non-zero exit still resolves (never fails the install)', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = warmNpxCache('3.9.11');
    child.emit('exit', 1);
    await p; // resolves despite exit 1
  });
});
