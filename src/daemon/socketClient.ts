/**
 * Spec 50 — Face B client: connect, send one request, read one response.
 *
 * Used by the resolution layer (`resolve.ts`) to probe a daemon and, when it is
 * ready, read findings/diagnostics. A probe that cannot connect (ENOENT — no
 * socket file — or ECONNREFUSED — a half-dead daemon) returns `null`, which the
 * caller maps to "no daemon → run in-process" (R2).
 */

import { connect } from 'node:net';
import type { SocketRequest, SocketResponse } from './types.js';

export interface SocketClientOptions {
  socketPath: string;
  timeoutMs: number;
}

/** True if a live daemon is listening at `socketPath`. */
export function isDaemonListening(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/**
 * Send a single request/response exchange. Resolves with the parsed response, or
 * `null` when the daemon cannot be reached (so the caller falls back in-process).
 */
export function sendSocketRequest(
  socketPath: string,
  request: SocketRequest,
  timeoutMs = 2000,
): Promise<SocketResponse | null> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    let buffer = '';
    let settled = false;

    const finish = (res: SocketResponse | null) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(res);
    };

    sock.setEncoding('utf8');
    sock.setTimeout(timeoutMs, () => finish(null));
    sock.once('error', () => finish(null));
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      const line = buffer.slice(0, idx).trim();
      try {
        finish(JSON.parse(line) as SocketResponse);
      } catch {
        finish(null);
      }
    });
    sock.once('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
    });
  });
}
