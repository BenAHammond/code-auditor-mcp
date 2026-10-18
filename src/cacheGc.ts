/**
 * Cache GC — bounds the growth of the tool's own fallback OS cache (Directive K10).
 *
 * Two unbounded growth sources accumulate under the user cache:
 *
 *   1. `cli/<version>/` — pinned-CLI runtime copies. `warmPinnedCli` and the
 *      marketplace hook's last-resort install (`hook-common.sh`) each write a full
 *      `node_modules` for the version they pin, and a version bump leaves the
 *      superseded copies behind forever.
 *
 *   2. `projects/<hash>/` — the per-project code index (`index.db`). A project
 *      audited once and then abandoned keeps its index (and its SQLite `-wal` /
 *      `-shm` siblings) indefinitely.
 *
 * The discriminants are computed from each dir's own semantics, not hand-listed
 * exemptions:
 *   - a `cli/<version>/` dir is stale iff its name differs from the running
 *     `PACKAGE_VERSION` (a superseded runtime copy);
 *   - a `projects/<hash>/` dir is stale iff its newest file mtime is older than a
 *     fixed age threshold (not audited recently — an actively used project never
 *     ages out, and an abandoned index is rebuilt on the next audit anyway).
 *
 * Two layers keep the destructive half out of the wrong places:
 *   - `gcStaleCacheDirs` is pure: it prunes ONLY the roots it is handed, so a
 *     caller that passes nothing deletes nothing. This is what the unit tests
 *     exercise against a temp dir.
 *   - `gcStaleCacheDirsOnce` is the production entry: process-scoped (an MCP server
 *     auditing many projects reaps once, not per audit), suppressed under a test
 *     harness (a delete of real operator cache must never leak into a test run),
 *     and never a user `CODE_AUDITOR_DATA_DIR` (the project index only lives in the
 *     fallback cache when no data dir is configured — when one is, `projects/` is
 *     left alone and only superseded CLI copies are reaped).
 *
 * Fire-and-forget and non-fatal: a failure (read-only home, a race) means the
 * cache keeps growing, which is strictly better than breaking an audit over a
 * cleanup nicety.
 */

import path from 'node:path';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { PACKAGE_VERSION } from './constants.js';
import { dataDirEnv, getFallbackCacheRoot, getPinnedCliRoot } from './dataPaths.js';

/** A project index untouched this long is considered abandoned and GC-eligible. */
export const PROJECT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface CacheGcOptions {
  /** Parent of the pinned-CLI copies (`<cliRoot>/<version>`). Omit to skip. */
  cliRoot?: string;
  /** Cache root whose `projects/` subdir is pruned. Omit to skip. */
  cacheRoot?: string;
  /** Age after which an untouched project dir is stale. Default 30 days. */
  projectMaxAgeMs?: number;
  /** Clock override (tests). Defaults to `Date.now()`. */
  now?: number;
}

export interface CacheGcResult {
  /** Names of superseded `cli/<version>` dirs removed. */
  removedCliVersions: string[];
  /** Names of stale `projects/<hash>` dirs removed. */
  removedProjects: string[];
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Newest mtime across a dir and its direct children. A project dir's own mtime is
 * not bumped when an existing `index.db` is rewritten (only the file's mtime is),
 * so the dir mtime alone would make a freshly-written index look abandoned.
 * Taking the max over the dir and its children (`index.db`, `-wal`, `-shm`)
 * reflects the last actual write.
 */
function newestMtime(dir: string): number | undefined {
  let best: number | undefined;
  try {
    best = statSync(dir).mtimeMs;
    for (const entry of readdirSync(dir)) {
      const mtime = statSync(path.join(dir, entry)).mtimeMs;
      if (mtime > best) best = mtime;
    }
  } catch {
    // A dir removed mid-scan is treated as absent — the caller skips it.
  }
  return best;
}

function gcSupersededCliVersions(cliRoot: string): string[] {
  if (!isDirectory(cliRoot)) return [];
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(cliRoot);
  } catch {
    return [];
  }
  for (const name of names) {
    // Keep the running version; a different name under `cli/` is a superseded
    // copy written by an older plugin. A non-directory entry (partial download)
    // is also safe to drop.
    if (name === PACKAGE_VERSION) continue;
    const full = path.join(cliRoot, name);
    try {
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Non-fatal: leave it for the next run.
    }
  }
  return removed;
}

function gcStaleProjectDirs(cacheRoot: string, cutoffMs: number): string[] {
  const projectsRoot = path.join(cacheRoot, 'projects');
  if (!isDirectory(projectsRoot)) return [];
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(projectsRoot);
  } catch {
    return [];
  }
  for (const name of names) {
    const full = path.join(projectsRoot, name);
    if (!isDirectory(full)) continue;
    const mtime = newestMtime(full);
    if (mtime === undefined || mtime >= cutoffMs) continue; // active or unreadable — keep
    try {
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Non-fatal: leave it for the next run.
    }
  }
  return removed;
}

/**
 * Pure GC: prune only the roots handed in. Pass nothing and nothing is deleted —
 * this is the shape the unit tests exercise against a temp dir, so no test ever
 * reaches a real cache.
 *
 * @param opts - The roots to prune and the age thresholds; empty by default (no-op).
 * @returns What was removed, split by CLI-version copies and project indexes.
 */
export function gcStaleCacheDirs(opts: CacheGcOptions = {}): CacheGcResult {
  const result: CacheGcResult = { removedCliVersions: [], removedProjects: [] };
  try {
    const now = opts.now ?? Date.now();
    const cutoffMs = now - (opts.projectMaxAgeMs ?? PROJECT_CACHE_MAX_AGE_MS);
    if (opts.cliRoot) {
      result.removedCliVersions = gcSupersededCliVersions(path.resolve(opts.cliRoot));
    }
    if (opts.cacheRoot) {
      result.removedProjects = gcStaleProjectDirs(path.resolve(opts.cacheRoot), cutoffMs);
    }
  } catch {
    // Cleanup must never throw into an audit.
  }
  return result;
}

function isTestRun(): boolean {
  // Vitest sets both; NODE_ENV is the conventional signal, VITEST the runner-specific
  // one. A destructive side-effect (deleting cache dirs) must never leak into a test
  // run — the subprocess-spawning tests inherit these through `{ ...process.env }`.
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

/**
 * The roots the production entry reaps. Exposed as a pure function so the "never a
 * user data dir" boundary is testable: the project index only lives in the fallback
 * cache when no `CODE_AUDITOR_DATA_DIR` is configured, so that root is omitted when
 * one is — the tool must never prune a user-configured location. CLI copies always
 * live under the fallback cache (never the data dir), so that root is always present.
 *
 * @returns The pinned-CLI root plus the fallback cache root (omitted when a
 *          user DATA_DIR is configured).
 */
export function resolveCacheGcRoots(): { cliRoot: string; cacheRoot?: string } {
  return {
    cliRoot: getPinnedCliRoot(),
    cacheRoot: dataDirEnv() ? undefined : getFallbackCacheRoot(),
  };
}

/** Process-scoped guard: reap at most once per process. */
let ranThisProcess = false;

/**
 * Production entry: process-scoped, suppressed under a test harness, and never a
 * user `CODE_AUDITOR_DATA_DIR`. Reaps superseded CLI copies and abandoned project
 * indexes from the tool's own fallback cache. Idempotent and non-fatal.
 *
 * @returns What was removed, or an empty result when already run this process or
 *          suppressed by the test harness.
 */
export function gcStaleCacheDirsOnce(): CacheGcResult {
  const empty: CacheGcResult = { removedCliVersions: [], removedProjects: [] };
  if (ranThisProcess || isTestRun()) return empty;
  ranThisProcess = true;

  const { cliRoot, cacheRoot } = resolveCacheGcRoots();
  return gcStaleCacheDirs({ cliRoot, cacheRoot });
}
