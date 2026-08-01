import path from 'node:path';
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
 * Otherwise (default, project-local): <projectRoot|.code-index/index.db
 */
export function resolvePersistedIndexPath(projectRoot?: string): string {
  const raw = process.env.CODE_AUDITOR_DATA_DIR?.trim();
  if (raw) {
    if (projectRoot) {
      const safeName = createHash('sha256').update(path.resolve(projectRoot)).digest('hex').substring(0, 16);
      return path.join(path.resolve(raw), 'projects', safeName, 'index.db');
    }
    return path.join(path.resolve(raw), 'index.db');
  }
  // Default: project-local .code-index directory
  const root = projectRoot || process.cwd();
  return path.join(root, '.code-index', 'index.db');
}

/** Directory that contains `index.db`. Optionally accepts projectRoot for scoped paths. */
export function getPersistedStorageRoot(projectRoot?: string): string {
  return path.dirname(resolvePersistedIndexPath(projectRoot));
}
