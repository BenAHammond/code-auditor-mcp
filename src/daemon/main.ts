#!/usr/bin/env node

/**
 * Spec 50 — the daemon process entry point.
 *
 * Spawned by `code-audit daemon start` (detached, socket face only) or run in
 * the foreground with `--foreground`. It owns the store and the pipeline and
 * serves the Unix socket (Face B). With `--lsp` it also serves the LSP face
 * (Face A) over stdio from the same core — one daemon, two faces (R1). The
 * editor's VS Code client spawns `code-auditor-daemon --lsp <root>`.
 *
 * Arguments (internal — the CLI's `daemon` command is the public surface):
 *   <projectRoot>                 project root to serve (default: cwd)
 *   --config <name>               config name
 *   --idle-timeout-ms <n>         idle timeout override (else env/config/default)
 *   --foreground                  log state transitions to stderr instead of running silent
 *   --lsp                         also serve the LSP face over stdio
 */

import '../native-bootstrap.js';

import path from 'node:path';
import { DaemonCore } from './core.js';
import { SocketFace } from './socketServer.js';
import { LspFace } from './lspServer.js';
import { isDaemonListening } from './socketClient.js';
import { resolveDaemonSocketPath } from '../dataPaths.js';
import { findConfigFileUp, loadConfig } from '../config/configLoader.js';
import { PACKAGE_VERSION } from '../constants.js';
import { parseArgs, USAGE } from './args.js';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface DaemonRunOptions {
  projectRoot: string;
  configName?: string;
  idleTimeoutMs?: number;
  /** Log state transitions to stderr (foreground) instead of running silent. */
  foreground?: boolean;
  /** Serve the LSP face over stdio (Face A) in addition to the socket face. */
  lsp?: boolean;
}

/**
 * Run the daemon in-process, blocking until a signal / idle timeout / socket
 * `shutdown` request. Shared by the detached entry (`main.ts`'s own `main`) and
 * the CLI's `daemon start --foreground`, so the two never drift on lifecycle.
 */
export async function runDaemonForeground(options: DaemonRunOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot);
  const socketPath = resolveDaemonSocketPath(projectRoot);
  const foreground = !!options.foreground;
  const lsp = !!options.lsp;

  // R5 — one daemon per project root. If a live daemon already owns the socket,
  // a second *socket-only* daemon exits rather than stealing the socket. The LSP
  // face is the exception: the editor needs a language server even when a
  // detached daemon already owns the socket, so `--lsp` runs its own core and
  // simply skips the socket bind instead of exiting. (The lease is the durable
  // backstop; the socket bind is the immediate guard.)
  const socketOwned = await isDaemonListening(socketPath);
  if (socketOwned && !lsp) {
    if (foreground) console.error('[code-auditor-daemon] already running for this project; exiting');
    process.exit(0);
  }

  // Idle timeout resolution: CLI arg → env → config → default.
  let idleTimeoutMs = options.idleTimeoutMs;
  if (idleTimeoutMs === undefined || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    const envMs = Number(process.env.CODE_AUDITOR_DAEMON_IDLE_MS);
    if (Number.isFinite(envMs) && envMs > 0) idleTimeoutMs = envMs;
  }
  if (idleTimeoutMs === undefined || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    try {
      const configPath = await findConfigFileUp(projectRoot);
      const config = await loadConfig({ configPath: configPath ?? undefined });
      idleTimeoutMs = config.daemon?.idleTimeoutMs;
    } catch {
      // No/invalid config — fall through to the default.
    }
  }
  if (idleTimeoutMs === undefined || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  }

  const core = new DaemonCore({
    projectRoot,
    configName: options.configName,
    idleTimeoutMs,
    onState: (state) => {
      if (foreground) console.error(`[code-auditor-daemon] ${state.status}`);
    },
  });
  const face = new SocketFace({ core, socketPath });
  const lspFace = lsp ? new LspFace({ core, foreground }) : null;

  // A single exit path: whatever triggers a shutdown (SIGINT/SIGTERM, idle
  // timeout, a `shutdown` socket request, or an LSP `exit`) runs through
  // `core.shutdown`, which emits `shutdown`; that listener stops both faces and
  // exits.
  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    if (!(socketOwned && lsp)) await face.stop();
    if (lspFace) lspFace.stop();
    process.exit(0);
  };
  core.on('shutdown', () => void finish());
  process.on('SIGINT', () => void core.shutdown('SIGINT'));
  process.on('SIGTERM', () => void core.shutdown('SIGTERM'));

  // Bind the socket first so an early client gets a truthful `indexing` status
  // (R3) rather than a connection refused. In `--lsp` mode with a socket already
  // owned by a detached daemon, skip the bind and serve the editor only.
  if (!(socketOwned && lsp)) {
    await face.start();
    if (foreground) console.error(`[code-auditor-daemon] serving ${projectRoot} on ${socketPath}`);
  }
  // Start the LSP message pump (handlers registered in the constructor) before
  // seeding so `initialize` is answered immediately even on a large corpus.
  if (lspFace) lspFace.start();
  await core.start();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (opts.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    process.exit(0);
  }
  await runDaemonForeground({
    projectRoot: opts.projectRoot,
    configName: opts.configName,
    idleTimeoutMs: opts.idleTimeoutMs,
    foreground: opts.foreground,
    lsp: opts.lsp,
  });
}

main().catch((err) => {
  console.error('[code-auditor-daemon] fatal:', err);
  process.exit(1);
});
