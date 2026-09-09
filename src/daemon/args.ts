/**
 * Spec 50 — daemon argument parsing.
 *
 * Extracted from `main.ts` so the `--help` / `--version` early-exit contract is
 * unit-testable. `code-auditor-daemon --help` must print usage and exit — never
 * launch the daemon (which holds ~800 MB and blocks). The parse result feeds
 * `main()`'s early exits *before* `runDaemonForeground` is ever reached.
 */

import path from 'node:path';

export const USAGE = `code-auditor-daemon — code-auditor daemon process

Usage:
  code-auditor-daemon [options] [projectRoot]

Spawned by 'code-audit daemon start' (detached, socket face) or run in the
foreground. The VS Code client spawns 'code-auditor-daemon --lsp <root>'.

Options:
  <projectRoot>              project root to serve (default: cwd)
  --config <name>            config name
  --idle-timeout-ms <n>      idle timeout override (ms)
  --foreground               log state transitions to stderr
  --lsp                      also serve the LSP face over stdio
  -h, --help                 print this help and exit
  -v, --version              print the version and exit
`;

export interface DaemonArgs {
  projectRoot: string;
  configName?: string;
  idleTimeoutMs?: number;
  foreground: boolean;
  lsp: boolean;
  help: boolean;
  version: boolean;
}

/**
 * Parse daemon argv. `cwd` is injectable for tests; the daemon resolves the
 * default project root against it.
 */
export function parseArgs(argv: string[], cwd: string = process.cwd()): DaemonArgs {
  let projectRoot = cwd;
  let configName: string | undefined;
  let idleTimeoutMs: number | undefined;
  let foreground = false;
  let lsp = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `-h`/`-v` are checked before the `--` positional fallback so a bare
    // `--help` is never mistaken for (or silently swallowed as) a project root.
    if (a === '-h' || a === '--help') help = true;
    else if (a === '-v' || a === '--version') version = true;
    else if (a === '--config') configName = argv[++i];
    else if (a === '--idle-timeout-ms') idleTimeoutMs = Number(argv[++i]);
    else if (a === '--foreground') foreground = true;
    else if (a === '--lsp') lsp = true;
    else if (!a.startsWith('--')) projectRoot = a;
  }
  return { projectRoot: path.resolve(projectRoot), configName, idleTimeoutMs, foreground, lsp, help, version };
}
