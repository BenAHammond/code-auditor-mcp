import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';

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
 * Otherwise the index is stored somewhere already gitignored by universal
 * convention so consumers never have to edit their own .gitignore:
 *   - If the project (or an ancestor) has a `node_modules` directory, use
 *     `<node_modules>/.cache/code-auditor/index.db`. When that node_modules is
 *     hoisted (an ancestor rather than `<root>/node_modules`, e.g. a monorepo),
 *     the path is scoped by project hash so sibling packages don't collide.
 *   - Otherwise (non-Node project), fall back to the OS cache directory keyed
 *     by project hash.
 */
export function resolvePersistedIndexPath(projectRoot?: string): string {
  const raw = process.env.CODE_AUDITOR_DATA_DIR?.trim();
  if (raw) {
    if (projectRoot) {
      return path.join(path.resolve(raw), 'projects', projectHash(projectRoot), 'index.db');
    }
    return path.join(path.resolve(raw), 'index.db');
  }

  const root = path.resolve(projectRoot || process.cwd());
  const nodeModules = findNodeModulesDir(root);
  if (nodeModules) {
    const base = path.join(nodeModules, '.cache', 'code-auditor');
    // A hoisted (ancestor) node_modules is shared across packages — scope by
    // project hash so sibling packages in a monorepo each get their own DB.
    if (nodeModules !== path.join(root, 'node_modules')) {
      return path.join(base, 'projects', projectHash(root), 'index.db');
    }
    return path.join(base, 'index.db');
  }

  // No node_modules anywhere up the tree: non-Node project. Use the OS cache.
  return path.join(getFallbackCacheRoot(), 'projects', projectHash(root), 'index.db');
}

/** Directory that contains `index.db`. Optionally accepts projectRoot for scoped paths. */
export function getPersistedStorageRoot(projectRoot?: string): string {
  return path.dirname(resolvePersistedIndexPath(projectRoot));
}

/** Walk up from `start` and return the nearest existing `node_modules` directory, or null. */
function findNodeModulesDir(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
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

/** Stable per-project identifier used to scope cache/data paths. */
function projectHash(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').substring(0, 16);
}
