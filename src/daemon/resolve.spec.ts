/**
 * Spec 50 — R2/R3 resolution layer tests.
 *
 * The resolution contract is the load-bearing part of the whole feature: every
 * read surface must answer "ready / not-ready / absent" identically, and the
 * `absent` fallback (run in-process) must be the outcome for every failure mode
 * so there is no "half-alive daemon" to wedge on. We mock the socket client
 * boundary and assert the mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveDaemon,
  readDaemonFindings,
  readDaemonDiagnostics,
  requestDaemonShutdown,
} from './resolve.js';
import * as socketClient from './socketClient.js';

vi.mock('./socketClient.js', () => ({
  isDaemonListening: vi.fn(),
  sendSocketRequest: vi.fn(),
}));

describe('resolveDaemon', () => {
  beforeEach(() => {
    vi.mocked(socketClient.isDaemonListening).mockReset();
    vi.mocked(socketClient.sendSocketRequest).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves absent when nothing is listening', async () => {
    vi.mocked(socketClient.isDaemonListening).mockResolvedValue(false);
    const res = await resolveDaemon('/some/project');
    expect(res.mode).toBe('absent');
    expect(res.socketPath).toMatch(/code-auditor-.*\.sock$/);
    expect(res.state).toBeUndefined();
  });

  it('resolves ready when the daemon reports status ready', async () => {
    vi.mocked(socketClient.isDaemonListening).mockResolvedValue(true);
    vi.mocked(socketClient.sendSocketRequest).mockResolvedValue({
      id: 1,
      ok: true,
      result: { status: 'ready', retryAfterMs: null, throughputUnknown: false },
    });
    const res = await resolveDaemon('/some/project');
    expect(res.mode).toBe('ready');
    expect(res.state?.status).toBe('ready');
  });

  it('resolves not-ready when the daemon is still indexing (R3)', async () => {
    vi.mocked(socketClient.isDaemonListening).mockResolvedValue(true);
    vi.mocked(socketClient.sendSocketRequest).mockResolvedValue({
      id: 1,
      ok: true,
      result: {
        status: 'indexing',
        progress: { filesIndexed: 10, filesTotal: 100, phase: 'files' },
        retryAfterMs: 2500,
        throughputUnknown: false,
      },
    });
    const res = await resolveDaemon('/some/project');
    expect(res.mode).toBe('not-ready');
    expect(res.state?.status).toBe('indexing');
    expect(res.state?.retryAfterMs).toBe(2500);
  });

  it('degrades to absent when the status probe fails (daemon died mid-flight)', async () => {
    vi.mocked(socketClient.isDaemonListening).mockResolvedValue(true);
    vi.mocked(socketClient.sendSocketRequest).mockResolvedValue(null);
    const res = await resolveDaemon('/some/project');
    expect(res.mode).toBe('absent');
  });

  it('degrades to absent when the status response is not ok', async () => {
    vi.mocked(socketClient.isDaemonListening).mockResolvedValue(true);
    vi.mocked(socketClient.sendSocketRequest).mockResolvedValue({
      id: 1,
      ok: false,
      error: 'boom',
    });
    const res = await resolveDaemon('/some/project');
    expect(res.mode).toBe('absent');
  });
});

describe('read helpers', () => {
  beforeEach(() => {
    vi.mocked(socketClient.sendSocketRequest).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('readDaemonFindings returns the result on success', async () => {
    vi.mocked(socketClient.sendSocketRequest).mockResolvedValue({
      id: 2,
      ok: true,
      result: { status: 'ready', violations: [{ file: 'a.ts' }], staleFiles: [] },
    });
    const res = await readDaemonFindings('/tmp/x.sock');
    expect(res?.violations).toEqual([{ file: 'a.ts' }]);
  });

  it('readDaemonFindings returns null when unreachable', async () => {
    vi.mocked(socketClient.sendSocketRequest).mockResolvedValue(null);
    await expect(readDaemonFindings('/tmp/x.sock')).resolves.toBeNull();
  });

  it('readDaemonDiagnostics passes the file set and returns the result', async () => {
    vi.mocked(socketClient.sendSocketRequest).mockResolvedValue({
      id: 3,
      ok: true,
      result: { status: 'ready', diagnostics: [], staleFiles: [] },
    });
    const res = await readDaemonDiagnostics('/tmp/x.sock', ['/a.ts']);
    expect(socketClient.sendSocketRequest).toHaveBeenCalledWith(
      '/tmp/x.sock',
      expect.objectContaining({ method: 'diagnostics', params: { files: ['/a.ts'] } }),
    );
    expect(res?.status).toBe('ready');
  });

  it('requestDaemonShutdown is true on acknowledgement and false on failure', async () => {
    vi.mocked(socketClient.sendSocketRequest).mockResolvedValue({ id: 4, ok: true, result: { ok: true } });
    await expect(requestDaemonShutdown('/tmp/x.sock')).resolves.toBe(true);
    vi.mocked(socketClient.sendSocketRequest).mockResolvedValue(null);
    await expect(requestDaemonShutdown('/tmp/x.sock')).resolves.toBe(false);
  });
});
