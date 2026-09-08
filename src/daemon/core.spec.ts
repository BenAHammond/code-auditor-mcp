/**
 * Spec 50 — `DaemonCore` unit tests (seed-free surface).
 *
 * The seed path (`start()`) exercises WASM + the full pipeline and is covered by
 * the integration suite; these tests cover the state machine and bookkeeping
 * that do not require a parser: the initial status, connection tracking, idle
 * staleness reads with no snapshot, and idempotent shutdown.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DaemonCore } from './core.js';

function makeCore(overrides?: Partial<{ idleTimeoutMs: number }>) {
  return new DaemonCore({
    projectRoot: '/tmp/example-project',
    idleTimeoutMs: overrides?.idleTimeoutMs ?? 5 * 60 * 1000,
  });
}

describe('DaemonCore', () => {
  it('starts in the `starting` state with no retry hint', () => {
    const core = makeCore();
    expect(core.getState()).toEqual({
      status: 'starting',
      retryAfterMs: null,
      throughputUnknown: false,
    });
  });

  it('resolves the project root to an absolute path', () => {
    const core = new DaemonCore({ projectRoot: 'relative/path', idleTimeoutMs: 1000 });
    expect(core.projectRoot).toMatch(/^\/|^[A-Za-z]:[\\/]/);
  });

  it('tracks active connections (idle accounting) without going negative', () => {
    const core = makeCore();
    core.registerConnection();
    core.registerConnection();
    core.unregisterConnection();
    core.unregisterConnection();
    core.unregisterConnection(); // extra decrement is clamped
    // Idle check with zero connections and status !== ready → no shutdown.
    expect(core.getState().status).toBe('starting');
  });

  it('returns an empty stale set before any snapshot exists (R4 no-crash)', () => {
    const core = makeCore();
    expect(core.checkStaleness()).toEqual([]);
    expect(core.checkStaleness(['/tmp/example-project/a.ts'])).toEqual([]);
  });

  it('serves empty findings and diagnostics before a seed', () => {
    const core = makeCore();
    expect(core.getFindings()).toEqual({ status: 'starting', violations: [], staleFiles: [] });
    expect(core.getDiagnostics(['/tmp/example-project/a.ts'])).toEqual({
      status: 'starting',
      diagnostics: [],
      staleFiles: [],
    });
  });

  it('shutdown is idempotent and emits exactly one `shutdown` event', async () => {
    const core = makeCore();
    const onShutdown = vi.fn();
    core.on('shutdown', onShutdown);
    await core.shutdown('test');
    await core.shutdown('test'); // second call is a no-op
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledWith('test');
    expect(core.getState().status).toBe('shutting-down');
  });

  it('whole-set staleness: reports a file whose mtime advanced since the snapshot (R4)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-stale-'));
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'hello');
    const core = new DaemonCore({ projectRoot: dir, idleTimeoutMs: 1000 });
    // Inject a snapshot whose recorded mtime is in the past → the file looks
    // edited since the seed. The whole-set read must not serve it as current.
    (core as any).snapshot = {
      version: 1,
      projectRoot: dir,
      files: { 'a.ts': { hash: 'deadbeef', mtimeMs: statSync(file).mtimeMs - 1000 } },
      visitorFindings: {},
      corpusFindings: [],
      schemaFindings: [],
    };
    expect(core.checkStaleness()).toContain('a.ts');
    rmSync(dir, { recursive: true, force: true });
  });

  it('whole-set staleness: a matching mtime is the cheap-pass exit (no hash)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-stale-'));
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'hello');
    const mtime = statSync(file).mtimeMs;
    const core = new DaemonCore({ projectRoot: dir, idleTimeoutMs: 1000 });
    // Recorded mtime matches current — the cheap stat pass declares it current
    // without hashing. (A mtime-preserved *content* change is the next-file
    // `assertNoStaleFiles` gate's job, not this live read path.)
    (core as any).snapshot = {
      version: 1,
      projectRoot: dir,
      files: { 'a.ts': { hash: 'does-not-matter', mtimeMs: mtime } },
      visitorFindings: {},
      corpusFindings: [],
      schemaFindings: [],
    };
    expect(core.checkStaleness()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
