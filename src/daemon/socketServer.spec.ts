/**
 * Spec 50 — Face B server tests.
 *
 * Drive a real `SocketFace` over a temp Unix socket with a fake `DaemonCore`,
 * asserting the request/response translation (R1: the adapter only maps method
 * names to core calls — no analysis here), the error paths (invalid JSON,
 * unknown method), and the connection bookkeeping that feeds idle tracking.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SocketFace } from './socketServer.js';
import { sendSocketRequest } from './socketClient.js';
import type { DaemonCore } from './core.js';
import type { SocketRequest } from './types.js';

describe('socketServer', () => {
  const tempDirs: string[] = [];
  const faces: SocketFace[] = [];

  function makeSocketPath(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'ca-sock-server-'));
    tempDirs.push(dir);
    return path.join(dir, 'nested', 'daemon.sock'); // nested to exercise mkdirSync
  }

  function fakeCore() {
    return {
      registerConnection: vi.fn(),
      unregisterConnection: vi.fn(),
      getState: vi.fn(() => ({ status: 'ready', retryAfterMs: null, throughputUnknown: false })),
      getDiagnostics: vi.fn((files: string[]) => ({
        status: 'ready',
        diagnostics: files.map((f) => ({ file: f, rule: 'x', severity: 'warning', message: 'm' })),
        staleFiles: [],
      })),
      getFindings: vi.fn(() => ({ status: 'ready', violations: [], staleFiles: [] })),
      shutdown: vi.fn(async () => {}),
    } as unknown as DaemonCore;
  }

  afterEach(async () => {
    for (const face of faces.splice(0)) {
      await face.stop();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function startFace(core: DaemonCore): Promise<SocketFace> {
    const face = new SocketFace({ core, socketPath: makeSocketPath() });
    await face.start();
    faces.push(face);
    return face;
  }

  /** Send a raw (possibly non-JSON) line and read one response line. */
  function rawRequest(socketPath: string, line: string): Promise<{ ok: boolean; id: number; error?: string }> {
    return new Promise((resolve) => {
      const sock = connect(socketPath);
      let buffer = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buffer += chunk;
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;
        sock.destroy();
        resolve(JSON.parse(buffer.slice(0, idx).trim()));
      });
      sock.on('connect', () => sock.write(line));
      sock.on('error', () => resolve({ ok: false, id: -1, error: 'connect failed' }));
    });
  }

  it('creates the socket file on start and removes it on stop', async () => {
    const core = fakeCore();
    const face = await startFace(core);
    expect(existsSync(face.socketPath)).toBe(true);
    await face.stop();
    faces.splice(faces.indexOf(face), 1);
    expect(existsSync(face.socketPath)).toBe(false);
  });

  it('answers status by delegating to core.getState', async () => {
    const core = fakeCore();
    const face = await startFace(core);
    const resp = await sendSocketRequest(face.socketPath, { id: 1, method: 'status', params: {} });
    expect(resp?.ok).toBe(true);
    expect(resp?.result).toEqual({ status: 'ready', retryAfterMs: null, throughputUnknown: false });
    expect(core.getState).toHaveBeenCalled();
  });

  it('answers diagnostics by passing the file set through', async () => {
    const core = fakeCore();
    const face = await startFace(core);
    const files = ['/p/a.ts', '/p/b.ts'];
    const resp = await sendSocketRequest(face.socketPath, { id: 2, method: 'diagnostics', params: { files } });
    expect(resp?.ok).toBe(true);
    expect(core.getDiagnostics).toHaveBeenCalledWith(files);
    const result = resp?.result as { diagnostics: { file: string }[] };
    expect(result.diagnostics).toHaveLength(2);
  });

  it('answers findings by delegating to core.getFindings', async () => {
    const core = fakeCore();
    const face = await startFace(core);
    const resp = await sendSocketRequest(face.socketPath, { id: 3, method: 'findings', params: {} });
    expect(resp?.ok).toBe(true);
    expect(core.getFindings).toHaveBeenCalled();
  });

  it('requests a shutdown and acknowledges', async () => {
    const core = fakeCore();
    const face = await startFace(core);
    const resp = await sendSocketRequest(face.socketPath, { id: 4, method: 'shutdown', params: {} });
    expect(resp?.ok).toBe(true);
    expect(resp?.result).toEqual({ ok: true });
    expect(core.shutdown).toHaveBeenCalledWith('socket request');
  });

  it('reports an error for invalid JSON', async () => {
    const core = fakeCore();
    const face = await startFace(core);
    const raw = await rawRequest(face.socketPath, 'this is not json\n');
    expect(raw.ok).toBe(false);
    expect(raw.id).toBe(-1);
    expect(raw.error).toMatch(/invalid JSON/);
    expect(core.getState).not.toHaveBeenCalled();
  });

  it('reports an error for an unknown method', async () => {
    const core = fakeCore();
    const face = await startFace(core);
    const resp = await sendSocketRequest(face.socketPath, {
      id: 9,
      method: 'nope' as unknown as SocketRequest['method'],
      params: {},
    });
    expect(resp?.ok).toBe(false);
    expect(resp?.error).toMatch(/unknown method/);
  });

  it('tracks connections for idle accounting', async () => {
    const core = fakeCore();
    const face = await startFace(core);
    await sendSocketRequest(face.socketPath, { id: 1, method: 'status', params: {} });
    // register/unregister fire on connect and close; give the close a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(core.registerConnection).toHaveBeenCalled();
    expect(core.unregisterConnection).toHaveBeenCalled();
  });
});
