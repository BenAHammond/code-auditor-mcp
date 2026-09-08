/**
 * Spec 50 — Face B client tests.
 *
 * Exercise `isDaemonListening` and `sendSocketRequest` against a real
 * `node:net` Unix socket (no WASM, no core) so the wire behaviour — connect,
 * one request, one newline-delimited response, timeout, malformed reply — is
 * covered at the unit level.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDaemonListening, sendSocketRequest } from './socketClient.js';
import type { SocketRequest } from './types.js';

describe('socketClient', () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];

  function makeSocketPath(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'ca-sock-client-'));
    tempDirs.push(dir);
    return path.join(dir, 'daemon.sock');
  }

  function startServer(onRequest: (line: string) => string | null): string {
    const socketPath = makeSocketPath();
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          const res = onRequest(line);
          if (res !== null && !socket.destroyed) socket.write(res + '\n');
        }
      });
    });
    server.listen(socketPath);
    servers.push(server);
    return socketPath;
  }

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('isDaemonListening', () => {
    it('returns true when a server is listening', async () => {
      const socketPath = startServer(() => null);
      await expect(isDaemonListening(socketPath)).resolves.toBe(true);
    });

    it('returns false when nothing is listening (ENOENT)', async () => {
      const socketPath = makeSocketPath();
      await expect(isDaemonListening(socketPath)).resolves.toBe(false);
    });
  });

  describe('sendSocketRequest', () => {
    it('round-trips a request and parses the response', async () => {
      const socketPath = startServer((line) => {
        const req = JSON.parse(line);
        return JSON.stringify({ id: req.id, ok: true, result: { status: 'ready' } });
      });
      const req: SocketRequest = { id: 1, method: 'status', params: {} };
      const resp = await sendSocketRequest(socketPath, req);
      expect(resp).toEqual({ id: 1, ok: true, result: { status: 'ready' } });
    });

    it('returns null when the connection is refused (no daemon)', async () => {
      const socketPath = makeSocketPath();
      const req: SocketRequest = { id: 1, method: 'status', params: {} };
      await expect(sendSocketRequest(socketPath, req)).resolves.toBeNull();
    });

    it('returns null on a malformed (non-JSON) response line', async () => {
      const socketPath = startServer(() => 'not-json-at-all');
      const req: SocketRequest = { id: 1, method: 'status', params: {} };
      await expect(sendSocketRequest(socketPath, req)).resolves.toBeNull();
    });

    it('returns null when the server never responds (timeout)', async () => {
      const socketPath = startServer(() => null); // accepts the request, never answers
      const req: SocketRequest = { id: 1, method: 'status', params: {} };
      await expect(sendSocketRequest(socketPath, req, 100)).resolves.toBeNull();
    });
  });
});
