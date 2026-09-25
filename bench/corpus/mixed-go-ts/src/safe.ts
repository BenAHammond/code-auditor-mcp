import { execFileSync } from 'child_process';

/**
 * Run a diff against a caller-supplied ref, safely.
 *
 * argv-array form: the command is a string literal and the arguments are
 * separate array elements, so no shell interprets them. Near-miss — produces
 * zero findings.
 */
export function runDiffSafe(ref: string): string {
  return execFileSync('git', ['diff', '--name-only', ref]).toString();
}
