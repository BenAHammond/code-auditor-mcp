/**
 * Spec 50 — Face B: the Unix-domain-socket request/response server.
 *
 * Agents and the CLI are not LSP clients; they shell out to a binary and need a
 * plain request/response face. This is it: a Unix socket at
 * `resolveDaemonSocketPath(root)`, speaking newline-delimited JSON.
 *
 * This adapter contains no analysis — it only translates `SocketRequest` method
 * names to `DaemonCore` calls and serializes the result (R1: the boundary is
 * explicit so the two faces cannot drift).
 */

import { createServer, type Server, type Socket } from 'node:net';
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DaemonCore } from './core.js';
import type { SocketRequest, SocketResponse } from './types.js';

export interface SocketFaceOptions {
  core: DaemonCore;
  socketPath: string;
}

export class SocketFace {
  private server: Server | null = null;
  readonly socketPath: string;
  private readonly core: DaemonCore;

  constructor(options: SocketFaceOptions) {
    this.core = options.core;
    this.socketPath = options.socketPath;
  }

  /**
   * Remove a stale socket file left by a crashed predecessor, then listen.
   * Callers must already have confirmed no *live* daemon owns the socket
   * (via `isDaemonListening`) before binding, or the live daemon's socket is
   * stolen out from under it.
   */
  async start(): Promise<void> {
    if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
    mkdirSync(path.dirname(this.socketPath), { recursive: true });

    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    this.core.registerConnection();
    // A peer that disconnects mid-response (the client times out, or destroys
    // its socket right after reading the first newline) will EPIPE the next
    // `write`. Without an `error` listener that EPIPE surfaces as an unhandled
    // 'error' event and crashes the whole daemon. Swallow it — 'close' still
    // fires and unregisters the connection.
    socket.on('error', () => {});
    socket.on('close', () => this.core.unregisterConnection());

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void this.dispatch(line).then((res) => {
          if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(res) + '\n');
        });
      }
    });
  }

  private async dispatch(line: string): Promise<SocketResponse> {
    let req: SocketRequest;
    try {
      req = JSON.parse(line) as SocketRequest;
    } catch {
      return { id: -1, ok: false, error: 'invalid JSON request' };
    }

    const respond = (result: unknown): SocketResponse => ({ id: req.id, ok: true, result });
    const fail = (error: string): SocketResponse => ({ id: req.id, ok: false, error });

    try {
      switch (req.method) {
        case 'status':
          return respond(this.core.getState());
        case 'diagnostics':
          return respond(this.core.getDiagnostics(req.params?.files ?? []));
        case 'findings':
          return respond(this.core.getFindings());
        case 'shutdown':
          void this.core.shutdown('socket request');
          return respond({ ok: true });
        default:
          return fail(`unknown method: ${String((req as any)?.method)}`);
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
  }
}
