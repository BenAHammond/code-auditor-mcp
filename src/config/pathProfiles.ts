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
  /** Merged overrides (excluding gate-exclusion). */
  overrides: Record<string, unknown>;
  /**
   * Spec 36 R4 — true when the file is excluded from the blocking gate by a
   * matching path profile. Findings still report at their real severity.
   */
  excludeFromGate: boolean;
  /**
   * Spec 44 R1 reason 7 — true when a matching path profile opts the file out
   * of analysis entirely (no stage-2 visitors run). Sibling of
   * `excludeFromGate`, which only affects the gate. Defaults to false; no
   * built-in profile sets it, so reason 7 fires only when a user opts in.
   */
  excludeFromAnalysis: boolean;
  /** Names of all profiles that matched this file, in match order. */
  matchedProfileNames: string[];
}

/**
 * Resolve which profiles match a file and merge their overrides.
 *
 * @param filePath - Absolute path to the file being analyzed
 * @param projectRoot - Project root directory
 * @param profiles - Ordered array of path profiles (built-in + user)
 * @returns Merged overrides, gate exclusion, and matched profile names
 */
export function resolvePathProfile(
  filePath: string,
  projectRoot: string,
  profiles: PathProfile[]
): ResolvedProfile {
  const overrides: Record<string, unknown> = {};
  let excludeFromGate = false;
  let excludeFromAnalysis = false;
  const matchedProfileNames: string[] = [];

  const relativePath = path.relative(projectRoot, filePath);

  for (const profile of profiles) {
    const matches = profile.paths.some((glob) => picomatch.isMatch(relativePath, glob));
    if (!matches) continue;

    matchedProfileNames.push(profile.name);

    for (const [key, value] of Object.entries(profile.overrides)) {
      if (key === 'excludeFromGate') {
        // Last matching profile that mentions the key wins (consistent with
        // "later wins" override merging). A profile that doesn't mention it
        // leaves the prior value untouched.
        excludeFromGate = value === true;
      } else if (key === 'excludeFromAnalysis') {
        // Spec 44 R1 reason 7 — same last-matching-wins semantics as
        // excludeFromGate. No built-in profile sets it.
        excludeFromAnalysis = value === true;
      } else {
        overrides[key] = value;
      }
    }
  }

  return { overrides, excludeFromGate, excludeFromAnalysis, matchedProfileNames };
}
