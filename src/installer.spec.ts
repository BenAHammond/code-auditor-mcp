/**
 * Spec 59 — pinned-CLI warm fix contract for `warmPinnedCli`.
 *
 *   - **positive** — `warmPinnedCli(v)` spawns
 *     `npm install --prefer-offline --prefix <cache>/code-auditor/cli/<v>
 *     code-auditor-mcp@<v> --no-audit --no-fund --ignore-scripts --silent`, i.e.
 *     the exact install the hook's last-resort path (`resolve_pinned_bin`) runs,
 *     so the first edit after install hits a warm dir and is never shadowed by a
 *     PATH binary.
 *   - **guard**     — a spawn that errors or exits non-zero still resolves the
 *     promise (never rejects, never leaves a dangling waiter): a failed warm must
 *     not fail the install over a warm-the-cache nicety.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { warmPinnedCli, pinnedCliCommand } from './installer.js';
import { VERSION } from './version.generated.js';

const CACHE = '/tmp/ca-warm-cache';

function fakeChild(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn();
  return child;
}

describe('warmPinnedCli — pinned-CLI warm at install (Spec 59)', () => {
  const origCache = process.env.XDG_CACHE_HOME;
  beforeEach(() => {
    spawnMock.mockReset();
    process.env.XDG_CACHE_HOME = CACHE;
  });
  afterEach(() => {
    if (origCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = origCache;
  });

  it('positive: spawns the exact pinned install to the deterministic dir', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = warmPinnedCli('3.9.11');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      [
        'install', '--prefer-offline', '--prefix', '/tmp/ca-warm-cache/code-auditor/cli/3.9.11',
        'code-auditor-mcp@3.9.11',
        '--no-audit', '--no-fund', '--ignore-scripts', '--silent',
      ],
      { stdio: 'ignore' },
    );

    child.emit('exit', 0);
    await p; // resolves, never rejects
  });

  it('guard: a spawn error still resolves (never fails the install)', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = warmPinnedCli('3.9.11');
    child.emit('error', new Error('npm not found'));
    await p; // resolves despite the error
  });

  it('guard: a non-zero exit still resolves (never fails the install)', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = warmPinnedCli('3.9.11');
    child.emit('exit', 1);
    await p; // resolves despite exit 1
  });
});

describe('pinnedCliCommand (Spec 61 R5.2 pinned CLI)', () => {
  it('pins cursor-hook to the build-stamped package version', () => {
    expect(pinnedCliCommand('cursor-hook')).toBe(
      `npx -y -p code-auditor-mcp@${VERSION} code-audit cursor-hook`
    );
  });

  it('pins codex-hook to the build-stamped package version', () => {
    expect(pinnedCliCommand('codex-hook')).toBe(
      `npx -y -p code-auditor-mcp@${VERSION} code-audit codex-hook`
    );
  });
});
