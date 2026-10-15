import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';

/**
 * The `CODE_AUDITOR_DATA_DIR` override, trimmed and normalized to `undefined`
 * when unset/blank. Single read site — the path resolver and the two display
 * surfaces (MCP startup + auto-index log) all consume this, so they can never
 * disagree on whether a data dir was configured.
 */
export function dataDirEnv(): string | undefined {
  const raw = process.env.CODE_AUDITOR_DATA_DIR?.trim();
  return raw ? raw : undefined;
}

/**
 * Default on-disk path for the code index database.
 *
 * When CODE_AUDITOR_DATA_DIR is set and projectRoot is provided, the DB is
 * scoped by project root to prevent cross-project data leakage (Bug #4 / Item 1).
 *   <data_dir>/projects/<sha256(root)[:16]>/index.db
 *
 * When CODE_AUDITOR_DATA_DIR is set but no projectRoot: legacy flat path
 *   <data_dir>/index.db
 *
 * Otherwise the index is a **user-level cache**, keyed by project hash — never
 * a path inside the audited project. The index is tool state, not a file the
 * consuming repository owns; a consuming repo may only receive a file when the
 * developer named a path on the command line (via CODE_AUDITOR_DATA_DIR /
 * `--data-dir`). The earlier defaults — project-local `.code-index/`, then
 * `<root>/node_modules/.cache/code-auditor` — wrote into the audited tree on
 * every run, dirtying read-only corpora with tool scratch and making the
 * measured tree itself non-reproducible. Both are gone.
 *
 *   <os_cache>/code-auditor/projects/<sha256(root)[:16]>/index.db
 *
 * @param projectRoot - Optional project root used to scope the path (and hash) per project.
 * @returns The on-disk path to the index database.
 */
export function resolvePersistedIndexPath(projectRoot?: string): string {
  const raw = dataDirEnv();
  if (raw) {
    if (projectRoot) {
      return path.join(path.resolve(raw), 'projects', projectHash(discoverProjectRoot(projectRoot)), 'index.db');
    }
    return path.join(path.resolve(raw), 'index.db');
  }

  // Key on the project's own identity (its git root / package.json dir), never
  // on where the process happened to start. Two invocations started from
  // different directories inside one project must land on the same DB.
  const root = discoverProjectRoot(projectRoot || process.cwd());
  return path.join(getFallbackCacheRoot(), 'projects', projectHash(root), 'index.db');
}

/** Directory that contains `index.db`. Optionally accepts projectRoot for scoped paths. */
export function getPersistedStorageRoot(projectRoot?: string): string {
  return path.dirname(resolvePersistedIndexPath(projectRoot));
}

/**
 * Path of the per-project daemon Unix-domain socket (Spec 50 R5).
 *
 * Derived from the realpath'd project root using the *same* `projectHash` the
 * data directory uses, so the daemon and every read surface (CLI, hook, agent)
 * derive an identical socket path for the same physical project regardless of
 * how it was spelled (`/tmp/foo` vs `/private/tmp/foo`). The socket lives under
 * the OS cache dir rather than next to `index.db` for two reasons: it sidesteps
 * the Unix socket path-length limit (`~104` bytes on macOS, `~108` on Linux) that
 * a deeply nested `node_modules` cache path could exceed, and it avoids the
 * still-lexical local-`node_modules` branch of `resolvePersistedIndexPath`.
 */
export function resolveDaemonSocketPath(projectRoot: string): string {
  const dir = path.join(getFallbackCacheRoot(), 'sockets');
  return path.join(dir, `code-auditor-${projectHash(projectRoot)}.sock`);
}

/**
 * Log file for a detached daemon (Spec 50 R5). A detached daemon's stderr is
 * redirected here (mirroring the Spec 41 `--detach` job log) so a background
 * failure is diagnosable rather than silently lost to `/dev/null`. Lives under
 * the OS cache's `logs/` sibling of the socket directory, keyed by the same
 * `projectHash`.
 */
export function resolveDaemonLogPath(projectRoot: string): string {
  const dir = path.join(getFallbackCacheRoot(), 'logs');
  return path.join(dir, `code-auditor-${projectHash(projectRoot)}.log`);
}

/**
 * Log file for the MCP server in development mode (explicit `--dev` only).
 *
 * Routed to the OS cache `logs/` dir rather than `process.cwd()`: dev mode is a
 * maintainer convenience, never a reason to drop a bare `mcp-server.log` into
 * whatever project happens to be the working directory. That was the same
 * silent-write-into-the-consumer-tree defect as the report writer's old
 * `options.output || process.cwd()` default, wearing a different hat.
 */
export function resolveMcpDevLogPath(): string {
  return path.join(getFallbackCacheRoot(), 'logs', 'mcp-server.log');
}

/** OS-specific cache root (gitignored by convention, wiped by clean installs). */
function getFallbackCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  if (xdg) {
    return path.join(path.resolve(xdg), 'code-auditor');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'code-auditor');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim();
    return path.join(local ? path.resolve(local) : os.homedir(), 'code-auditor', 'Cache');
  }
  return path.join(os.homedir(), '.cache', 'code-auditor');
}

/**
 * OS-specific per-user config root for persistent, user-scoped state (the anonymous
 * install ID and the telemetry opt-in). Deliberately NOT the cache root above: the
 * cache is wiped by clean installs, and a regenerated install ID would break source
 * grouping — this state must survive a cache wipe. This is the OS's designated
 * location for exactly this kind of config, so it adds no new `~/` dotdir.
 *
 * @returns The OS-specific per-user config directory for persistent user-scoped state.
 */
export function getUserConfigRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return path.join(path.resolve(xdg), 'code-auditor');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'code-auditor');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim();
    return path.join(local ? path.resolve(local) : os.homedir(), 'code-auditor');
  }
  return path.join(os.homedir(), '.config', 'code-auditor');
}

/**
 * Resolve symlinks (and other path aliases) so the same physical project
 * hashes identically regardless of how it was spelled. On macOS `/tmp` is a
 * symlink to `/private/tmp`, so `-p /tmp/foo` and `process.cwd()` (which
 * returns `/private/tmp/foo`) would otherwise hash to different cache keys and
 * detached jobs would not be found across the parent/child boundary.
 */
function resolveRealPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // The path may not exist yet (fresh cache dir, brand-new project) — fall
    // back to lexical resolution so we still get a stable key.
    return path.resolve(p);
  }
}

/**
 * Project-identity markers: a directory that contains any of these is treated
 * as a project root. Walked upward from the process start (or the `-p` path) so
 * the cache key reflects *what* is being audited, not *where* the process was
 * started — two invocations from different directories inside one project must
 * land on the same database.
 *
 * `.git` may be a file (git worktree / submodule) or a directory.
 */
const PROJECT_ROOT_MARKERS = ['.git', 'package.json', 'go.mod'];

/**
 * Discover the project root for a starting directory by walking up until a
 * marker (`PROJECT_ROOT_MARKERS`) is found. Returns the resolved start directory
 * when no marker is found — the caller then hashes whatever it was given, which
 * is the correct fallback for a bare directory with no project identity.
 *
 * @param startDir - Directory to begin the upward search from.
 * @returns The nearest ancestor carrying a project marker, or the resolved start.
 */
export function discoverProjectRoot(startDir: string): string {
  let current = resolveRealPath(startDir);
  for (;;) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached the filesystem root with no marker — fall back to the start dir.
      return resolveRealPath(startDir);
    }
    current = parent;
  }
}

/** Stable per-project identifier used to scope cache/data paths. */
export function projectHash(root: string): string {
  return createHash('sha256').update(resolveRealPath(root)).digest('hex').substring(0, 16);
}
