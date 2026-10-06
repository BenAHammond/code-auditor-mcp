/**
 * One-time notice for legacy in-repo index locations (Spec 70 item 3 follow-up).
 *
 * Before the index default moved to a user-level OS cache, code-auditor wrote its
 * persisted index *inside* the audited project: a project-local `.code-index/`
 * (4.x and earlier) and then `<root>/node_modules/.cache/code-auditor/` (5.0.0's
 * source, pre-fix). The move fixed new writes; it left every existing user with a
 * directory the tool created in their repository and never mentioned again.
 *
 * On the first run against a project whose tree still holds either legacy location,
 * the tool prints ONE message — the path, that a previous version wrote it, and
 * that it is now safe to delete. The tool never deletes anything: the "don't touch
 * a consuming repo" rule applies to removal as much as to writing. The "once" is
 * recorded in the user config dir (keyed by project hash), NOT in the repo, so it
 * survives across runs without mutating the project.
 */

import path from 'node:path';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { getUserConfigRoot, projectHash } from './dataPaths.js';

/** The legacy in-repo locations, relative to the project root, oldest first. */
const LEGACY_RELATIVE_PATHS = [
  '.code-index',
  path.join('node_modules', '.cache', 'code-auditor'),
] as const;

/** Subdirectory of the user config root holding "already told this project" markers. */
const NOTIFIED_DIR = 'legacy-index-notified';

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function markerPath(projectRoot: string, configDir: string): string {
  return path.join(configDir, NOTIFIED_DIR, projectHash(projectRoot));
}

function alreadyNotified(projectRoot: string, configDir: string): boolean {
  return existsSync(markerPath(projectRoot, configDir));
}

function recordNotified(projectRoot: string, configDir: string): void {
  try {
    mkdirSync(path.join(configDir, NOTIFIED_DIR), { recursive: true });
    // `wx` fails if the marker already exists — an idempotent "told" flag.
    writeFileSync(markerPath(projectRoot, configDir), '', { flag: 'wx' });
  } catch {
    // A config write failure (read-only home, race) means a possible repeat next
    // run — the lesser evil vs. touching the repo. Never throw from a notice.
  }
}

function formatMessage(legacyPaths: string[]): string {
  const noun = legacyPaths.length === 1 ? 'this path' : 'these paths';
  const list = legacyPaths.map((p) => `  ${p}`).join('\n');
  return (
    `A previous code-auditor version stored its code index inside this project (${noun}):\n` +
    `${list}\n` +
    `It is no longer used — the index now lives in a user-level cache — and is safe to delete.`
  );
}

/** Process-scoped guard: once per project hash per process, so a repeated
 *  `runAudit` in one process (tests, an MCP server auditing repeatedly) never
 *  spams — the persisted marker handles cross-process repetition. */
const notifiedThisProcess = new Set<string>();

export interface LegacyIndexNoticeOptions {
  /** Override the user config dir (tests). */
  configDir?: string;
  /** Override the notification sink (tests). Defaults to `console.error`. */
  notify?: (message: string) => void;
}

/**
 * Print the one-time legacy-index notice if (and only if) the project tree still
 * holds a legacy in-repo index location that has not already been reported.
 *
 * @param projectRoot the absolute project root being audited
 * @param opts test overrides for the config dir and notification sink
 * @returns the legacy paths still present (empty when none), for the caller/testing
 */
export function notifyLegacyIndexLocation(
  projectRoot: string,
  opts: LegacyIndexNoticeOptions = {},
): string[] {
  const root = path.resolve(projectRoot);
  const legacyPaths = LEGACY_RELATIVE_PATHS
    .map((rel) => path.join(root, rel))
    .filter(isDirectory);

  if (legacyPaths.length === 0) return [];

  const configDir = path.resolve(opts.configDir ?? getUserConfigRoot());
  const hash = projectHash(root);

  // Already reported for this project (this process or a prior run) — do not repeat.
  if (notifiedThisProcess.has(hash) || alreadyNotified(root, configDir)) {
    return legacyPaths;
  }

  notifiedThisProcess.add(hash);
  (opts.notify ?? ((m: string) => console.error(m)))(formatMessage(legacyPaths));
  recordNotified(root, configDir);

  return legacyPaths;
}
