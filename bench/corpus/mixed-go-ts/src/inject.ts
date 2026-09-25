import { execSync } from 'child_process';

/**
 * Run a diff against a caller-supplied ref.
 *
 * The command string is built by template-literal interpolation of `ref`, so a
 * value that is not a shell command can become one. Fires command-injection-risk
 * on the TypeScript half of the mixed dispatch.
 */
export function runDiff(ref: string): string {
  return execSync(`git diff --name-only ${ref}`).toString();
}
