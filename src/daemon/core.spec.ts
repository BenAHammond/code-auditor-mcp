/**
 * Spec 50 — `DaemonCore` unit tests (seed-free surface).
 *
 * The seed path (`start()`) exercises WASM + the full pipeline and is covered by
 * the integration suite; these tests cover the state machine and bookkeeping
 * that do not require a parser: the initial status, connection tracking, idle
 * staleness reads with no snapshot, and idempotent shutdown.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
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

describe('DaemonCore seed ETA (phase machine)', () => {
  afterEach(() => vi.useRealTimers());

  /** Build an `indexing` core with its private ETA fields pinned to fake time 0. */
  function seededCore(fields: {
    phase?: string;
    phaseCurrent?: number;
    phaseTotal?: number;
    phaseStartedAt?: number;
    orphanStartedAt?: number;
    seedStartedAt?: number;
    progress?: { filesIndexed: number; filesTotal: number; sourceTotal: number; orphanTotal: number };
  }) {
    const core = makeCore();
    (core as any).status = 'indexing';
    (core as any).seedStartedAt = fields.seedStartedAt ?? 0;
    (core as any).phase = fields.phase ?? 'files';
    (core as any).phaseCurrent = fields.phaseCurrent ?? 0;
    (core as any).phaseTotal = fields.phaseTotal ?? 0;
    (core as any).phaseStartedAt = fields.phaseStartedAt ?? 0;
    (core as any).orphanStartedAt = fields.orphanStartedAt ?? 0;
    (core as any).progress = {
      filesIndexed: 0,
      filesTotal: 0,
      sourceTotal: 0,
      orphanTotal: 0,
      ...fields.progress,
    };
    return core;
  }

  it('reports a conservative clamp (not 250ms) when a reducer phase has not started its rate yet', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    // Stage 3 start marker: current=0, total=10 → rate unknown, work known to remain.
    const reducers = seededCore({ phase: 'reducers', phaseCurrent: 0, phaseTotal: 10, phaseStartedAt: 0 });
    expect((reducers as any).deriveRetryAfterMs()).toBe(30_000);
    // Stage 4 start marker: same contract.
    const derived = seededCore({ phase: 'derived', phaseCurrent: 0, phaseTotal: 3, phaseStartedAt: 0 });
    expect((derived as any).deriveRetryAfterMs()).toBe(30_000);
  });

  it('reports a conservative clamp for the unpriced finalize tail (stage4-complete)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const core = seededCore({ phase: 'finalize', phaseCurrent: 0, phaseTotal: 0, phaseStartedAt: 0 });
    expect((core as any).deriveRetryAfterMs()).toBe(30_000);
  });

  it('never collapses to the 250ms floor while a later phase has not started', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    // Reducers phase complete (4/4) — derived + finalize still ahead → conservative.
    const reducersDone = seededCore({ phase: 'reducers', phaseCurrent: 4, phaseTotal: 4, phaseStartedAt: -4000 });
    expect((reducersDone as any).deriveRetryAfterMs()).toBe(30_000);
    // Derived phase one step in at a very fast rate — finalize still ahead → conservative.
    const derivedFast = seededCore({ phase: 'derived', phaseCurrent: 1, phaseTotal: 4, phaseStartedAt: -1 });
    expect((derivedFast as any).deriveRetryAfterMs()).toBe(30_000);
  });

  it('allows the 250ms floor only in the final phase (nothing left after it)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    // finalize is the last phase: nearly done may legitimately floor to "almost ready".
    const finalizeFast = seededCore({ phase: 'finalize', phaseCurrent: 99, phaseTotal: 100, phaseStartedAt: -100 });
    expect((finalizeFast as any).deriveRetryAfterMs()).toBe(250);
  });

  it('returns null (throughput unknown) before the first file is indexed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const core = seededCore({
      phase: 'files',
      seedStartedAt: -1000,
      progress: { filesIndexed: 0, filesTotal: 100, sourceTotal: 50, orphanTotal: 50 },
    });
    expect((core as any).deriveRetryAfterMs()).toBe(null);
  });

  it('prices the source phase at the source rate, orphans at the source-rate fallback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    // 20 source files in 2s → 10 files/s; 80 remaining (30 source + 50 orphan)
    // priced at that same rate → 8s.
    const core = seededCore({
      phase: 'files',
      seedStartedAt: -2000,
      progress: { filesIndexed: 20, filesTotal: 100, sourceTotal: 50, orphanTotal: 50 },
    });
    expect((core as any).deriveRetryAfterMs()).toBe(8000);
  });

  it('prices the orphan tail on its own (faster) rate once source is done', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    // Source done at t=-2s; 10 orphans done since then (2s → 5 files/s); 40 remain.
    const core = seededCore({
      phase: 'files',
      seedStartedAt: -12_000,
      orphanStartedAt: -2000,
      progress: { filesIndexed: 60, filesTotal: 100, sourceTotal: 50, orphanTotal: 50 },
    });
    expect((core as any).deriveRetryAfterMs()).toBe(8000);
  });

  it('clamps the orphan tail to the minimum when it is nearly done', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const core = seededCore({
      phase: 'files',
      seedStartedAt: -12_000,
      orphanStartedAt: -1000,
      progress: { filesIndexed: 99, filesTotal: 100, sourceTotal: 50, orphanTotal: 50 },
    });
    expect((core as any).deriveRetryAfterMs()).toBe(250);
  });

  it('throws loudly when a source file is reported after an orphan (ordering invariant)', () => {
    const core = makeCore();
    (core as any).seenOrphan = false;
    (core as any).assertSourceBeforeOrphan({ current: 0, total: 1, analyzer: 'pipeline', phase: 'stage2', file: 'a.json' });
    expect((core as any).seenOrphan).toBe(true);
    expect(() =>
      (core as any).assertSourceBeforeOrphan({ current: 1, total: 1, analyzer: 'pipeline', phase: 'stage2', file: 'a.ts' }),
    ).toThrow(/ordering violated/);
  });

  it('exposes the current phase in the progress payload (reducer phase visible)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const core = seededCore({ phase: 'reducers', phaseCurrent: 2, phaseTotal: 4, phaseStartedAt: 0 });
    const state = core.getState();
    expect(state.progress?.phase).toBe('reducers');
    expect(state.progress?.phaseCurrent).toBe(2);
    expect(state.progress?.phaseTotal).toBe(4);
    // The estimate during a reducer phase is a conservative clamp, never the 250ms floor.
    expect(state.retryAfterMs).toBeGreaterThan(250);
  });

  it('maps stage3/stage4/stage4-complete events onto the phase machine (wiring)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const core = makeCore();
    (core as any).status = 'indexing';
    (core as any).seedStartedAt = 0;
    (core as any).progress = { filesIndexed: 0, filesTotal: 100, sourceTotal: 50, orphanTotal: 50 };
    (core as any).phase = 'files';
    (core as any).phaseTotal = 100;
    (core as any).phaseStartedAt = 0;

    (core as any).onSeedProgress({ current: 1, total: 5, analyzer: 'x', phase: 'stage3' });
    expect((core as any).phase).toBe('reducers');

    (core as any).onSeedProgress({ current: 0, total: 3, analyzer: 'y', phase: 'stage4' });
    expect((core as any).phase).toBe('derived');

    (core as any).onSeedProgress({ current: 3, total: 3, analyzer: 'pipeline', phase: 'stage4-complete' });
    expect((core as any).phase).toBe('finalize');
    // Unpriced finalize tail → conservative clamp, never a "done" 250ms.
    expect((core as any).deriveRetryAfterMs()).toBe(30_000);
  });
});
