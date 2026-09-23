import path from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolve the directory a generated MCP config will be written into, and
 * enforce that it stays inside the working directory.
 *
 * Spec 61 R5.1: the `config.generate` tool took a caller-supplied `outputDir`
 * and wrote files there with no containment check, so a hostile `outputDir`
 * (or one using `~`) could escape `cwd` and overwrite arbitrary paths. This
 * helper centralizes the fix as a pure function of `(rawOutputDir, cwd)`:
 *
 *   1. `~` is expanded to the home dir (so a project living under `~` keeps
 *      working), then
 *   2. the path is resolved against `cwd`, and
 *   3. rejected with an error unless it is `cwd` itself or nested inside it.
 *
 * `~` expansion happens *before* the containment check, so `~` is a convenience
 * only when it still lands inside `cwd` — it is no longer an escape hatch.
 */
export function resolveConfigGenerateDir(rawOutputDir: string, cwd: string): string {
  const expandedOutputDir = rawOutputDir.replace(/^~(?=$|\/)/, homedir());
  const outputDir = path.resolve(cwd, expandedOutputDir);
  const cwdPrefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  if (outputDir !== cwd && !outputDir.startsWith(cwdPrefix)) {
    throw new Error(
      `outputDir must be within the current working directory (${cwd}), got ${outputDir}`,
    );
  }
  return outputDir;
}
