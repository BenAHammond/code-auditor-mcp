/**
 * Path Profile resolution — per-file config overrides driven by glob patterns.
 *
 * Path profiles are an ordered array in .codeauditor.json. Each profile has
 * `name`, `paths` (glob patterns), and `overrides`. Files matching multiple
 * profiles merge in order — later wins.
 *
 * Built-in profiles (e.g. scripts-and-tests) ship with the tool and can be
 * disabled via `builtin: false` in config.
 */

import picomatch from 'picomatch';
import path from 'path';

export interface PathProfile {
  /** Unique name for this profile. */
  name: string;
  /** Glob patterns matching file paths relative to project root. */
  paths: string[];
  /** Analyzer config overrides applied to files matching this profile. */
  overrides: Record<string, unknown>;
  /** Set to false to replace a built-in profile of the same name. */
  builtin?: boolean;
}

export interface ResolvedProfile {
  /** Merged overrides (excluding severityCap). */
  overrides: Record<string, unknown>;
  /** Severity cap to apply post-analysis, if any. */
  severityCap?: string;
  /** Names of all profiles that matched this file, in match order. */
  matchedProfileNames: string[];
}

const VALID_SEVERITIES = new Set(['suggestion', 'warning', 'critical']);

/**
 * Resolve which profiles match a file and merge their overrides.
 *
 * @param filePath - Absolute path to the file being analyzed
 * @param projectRoot - Project root directory
 * @param profiles - Ordered array of path profiles (built-in + user)
 * @returns Merged overrides, severity cap, and matched profile names
 */
export function resolvePathProfile(
  filePath: string,
  projectRoot: string,
  profiles: PathProfile[]
): ResolvedProfile {
  const overrides: Record<string, unknown> = {};
  let severityCap: string | undefined;
  const matchedProfileNames: string[] = [];

  const relativePath = path.relative(projectRoot, filePath);

  for (const profile of profiles) {
    const matches = profile.paths.some((glob) => picomatch.isMatch(relativePath, glob));
    if (!matches) continue;

    matchedProfileNames.push(profile.name);

    for (const [key, value] of Object.entries(profile.overrides)) {
      if (key === 'severityCap') {
        severityCap = value as string;
      } else {
        overrides[key] = value;
      }
    }
  }

  if (severityCap && !VALID_SEVERITIES.has(severityCap)) {
    // Should never reach here if validateConfig catches it, but guard anyway
    severityCap = undefined;
  }

  return { overrides, severityCap, matchedProfileNames };
}
