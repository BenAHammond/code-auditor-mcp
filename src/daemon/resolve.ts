/**
 * Spec 50 — R2 resolution layer.
 *
 * Every read surface (CLI command, hook gate, editor) resolves "is a daemon
 * serving this project?" the same way, and the answer is always one of three:
 *
 *   1. **ready** — a daemon is listening and its seed finished; read live state.
 *   2. **not-ready** — a daemon is listening but still indexing; per R3 the
 *      status *is* the answer (never an empty findings list).
 *   3. **absent** — no daemon; run in-process, exactly as before (R2: the
 *      daemon is an optimisation, never a dependency).
 *
 * The socket is the only discovery mechanism: probe it, then ask for status.
 * A daemon that died between the probe and the status request (or left a stale
 * socket file with nobody listening) resolves to `absent` and the caller falls
 * back in-process — there is no "half-alive daemon" state to wedge on.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openSync, mkdirSync } from 'node:fs';

import { resolveDaemonSocketPath, resolveDaemonLogPath } from '../dataPaths.js';
import { isDaemonListening, sendSocketRequest } from './socketClient.js';
import type {
  DaemonState,
  DaemonFindingsResult,
  DaemonDiagnosticsResult,
} from './types.js';

export type ResolutionMode = 'ready' | 'not-ready' | 'absent';

export interface ResolvedDaemon {
  mode: ResolutionMode;
  socketPath: string;
  state?: DaemonState;
}

/** Entrypoint for the detached daemon process (mirrors `resolveJobRunnerEntrypoint`). */
function resolveDaemonEntrypoint(): string {
  const current = fileURLToPath(import.meta.url);
  const ext = path.extname(current);
  const dir = path.dirname(current);
  const filename = ext === '.ts' ? 'main.ts' : 'main.js';
  return path.join(dir, filename);
}

/** Probe the socket, then ask for status. Never throws; degrades to `absent`. */
export async function resolveDaemon(projectRoot: string): Promise<ResolvedDaemon> {
  const socketPath = resolveDaemonSocketPath(projectRoot);
  const listening = await isDaemonListening(socketPath);
  if (!listening) return { mode: 'absent', socketPath };

  const resp = await sendSocketRequest(socketPath, { id: 1, method: 'status', params: {} });
  if (!resp || !resp.ok) return { mode: 'absent', socketPath };
  const state = resp.result as DaemonState;
  if (state?.status === 'ready') return { mode: 'ready', state, socketPath };
  return { mode: 'not-ready', state, socketPath };
}

/** Read the daemon's full-corpus findings, or `null` if it cannot be reached. */
export async function readDaemonFindings(socketPath: string): Promise<DaemonFindingsResult | null> {
  const resp = await sendSocketRequest(socketPath, { id: 2, method: 'findings', params: {} });
  if (!resp || !resp.ok) return null;
  return resp.result as DaemonFindingsResult;
}

/** Read per-file diagnostics for a specific file set, or `null` if unreachable. */
export async function readDaemonDiagnostics(
  socketPath: string,
  files: string[],
): Promise<DaemonDiagnosticsResult | null> {
  const resp = await sendSocketRequest(socketPath, { id: 3, method: 'diagnostics', params: { files } });
  if (!resp || !resp.ok) return null;
  return resp.result as DaemonDiagnosticsResult;
}

/** Ask a daemon to shut down. Resolves true when the request was acknowledged. */
export async function requestDaemonShutdown(socketPath: string): Promise<boolean> {
  const resp = await sendSocketRequest(socketPath, { id: 4, method: 'shutdown', params: {} });
  return !!(resp && resp.ok);
}

/**
 * Start a daemon detached from the caller. Used by `daemon start` (no
 * `--foreground`) and by the `daemon.autoStart` opt-in. The child is `unref`'d
 * so the parent exits immediately; the daemon talks to the ledger, never back
 * to the parent. `spawn` + `unref` (no IPC channel) mirrors the Spec 41
 * `--detach` pattern — the child survives the parent, not the other way around.
 */
export function startDaemonDetached(projectRoot: string, configName?: string): void {
  const args = [resolveDaemonEntrypoint(), path.resolve(projectRoot)];
  if (configName) args.push('--config', configName);
  // Redirect stderr to a per-project log (mirrors the Spec 41 `--detach` job log,
  // which uses `['ignore', 'ignore', logFd]`). `stdio: 'ignore'` (stderr →
  // `/dev/null`) crashes the detached seed on macOS, and a silent daemon is
  // undiagnosable anyway — a real log makes `daemon start` failures inspectable.
  const logPath = resolveDaemonLogPath(projectRoot);
  mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', 'ignore', logFd],
    env: process.env,
  });
  child.unref();
}
