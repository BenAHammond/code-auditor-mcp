import path from 'node:path';

/**
 * Default on-disk Loki path for the code index.
 * When CODE_AUDITOR_DATA_DIR is set, that directory is the storage root:
 *   <resolved_dir>/index.db
 * Otherwise (default, project-local): <cwd>/.code-index/index.db
 */
export function resolvePersistedIndexPath(): string {
  const raw = process.env.CODE_AUDITOR_DATA_DIR?.trim();
  if (raw) {
    return path.join(path.resolve(raw), 'index.db');
  }
  return path.join(process.cwd(), '.code-index', 'index.db');
}

/** Directory that contains `index.db` (same logic as resolvePersistedIndexPath). */
export function getPersistedStorageRoot(): string {
  return path.dirname(resolvePersistedIndexPath());
}
