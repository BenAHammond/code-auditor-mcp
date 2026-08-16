/**
 * Spec 36 R2 — the blocking gate compares against the file's prior state (git
 * HEAD), not against a stored baseline.
 *
 * A gating finding blocks only if the edit introduced it. The deterministic
 * core is the *touched line*: a finding whose line sits inside an added or
 * changed hunk of the diff was introduced by this edit. A finding on an
 * untouched line of a tracked file was already there and does not block.
 *
 * A file with no prior state (untracked/new) has every line touched — the whole
 * file is the edit, so every gating finding it carries is introduced.
 *
 * This module stays free of analyzer imports so it can be unit-tested against
 * recorded `git diff` output without booting the WASM grammars.
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

/** Per-file set of 1-based lines the edit added or changed. */
export interface DiffGate {
  /** Absolute path → set of 1-based touched line numbers. */
  touchedLines: Map<string, Set<number>>;
  /** Absolute paths with no prior state (untracked/new) — every line counts. */
  newFiles: Set<string>;
  /** Absolute paths deleted in the working tree — no findings can be introduced. */
  deletedFiles: Set<string>;
}

/**
 * Parse `git diff --unified=0` output into a map of file → touched 1-based line
 * numbers. Pure over the diff text so the parser is testable in isolation.
 *
 * Only the `+newStart,newCount` side of each `@@` hunk header is read; with
 * `--unified=0` that range is exactly the added (or changed) lines.
 */
export function parseDiffHunkLines(diffText: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let currentFile: string | null = null;

  for (const line of diffText.split('\n')) {
    // `+++ b/<path>` marks the new-side file for the following hunks.
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length);
      if (!result.has(currentFile)) result.set(currentFile, new Set());
      continue;
    }

    // Hunk header: `@@ -oldStart,oldCount +newStart,newCount @@`.
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch && currentFile) {
      const newStart = Number(hunkMatch[1]);
      const newCount = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      const lines = result.get(currentFile)!;
      // A zero-count hunk (pure deletion) covers no new lines.
      for (let i = 0; i < newCount; i++) {
        lines.add(newStart + i);
      }
    }
  }

  return result;
}

/**
 * Compute the diff gate for a set of absolute file paths under a git worktree.
 *
 * Touched lines come from `git diff --unified=0 HEAD -- <files>`. A file is
 * classified new when it has no committed state (`git ls-files --error-unmatch`
 * fails), and deleted when it exists at HEAD but not in the working tree.
 *
 * Never throws: a git failure degrades to an empty gate (nothing blocks), and
 * the caller records the diagnostic — matching Spec 36 R1's "fail loudly"
 * contract at the hook boundary, where the hook itself is responsible for the
 * loud failure rather than this pure classifier.
 */
export function computeDiffGate(projectRoot: string, files: string[]): DiffGate {
  const touchedLines = new Map<string, Set<number>>();
  const newFiles = new Set<string>();
  const deletedFiles = new Set<string>();

  if (files.length === 0) return { touchedLines, newFiles, deletedFiles };

  const relFiles = files.map((f) => path.relative(projectRoot, f));

  // Classify new vs tracked vs deleted with a single git pass per file.
  for (let i = 0; i < files.length; i++) {
    const abs = files[i];
    const rel = relFiles[i];
    const tracked = isTracked(projectRoot, rel);
    const inWorkingTree = fileExists(abs);

    if (!tracked && inWorkingTree) {
      newFiles.add(abs);
    } else if (tracked && !inWorkingTree) {
      deletedFiles.add(abs);
    }
  }

  // Tracked-and-present files: read their touched lines from the diff.
  const diffTargets = files.filter((abs) => !newFiles.has(abs) && !deletedFiles.has(abs));
  if (diffTargets.length > 0) {
    const hunks = parseDiffHunkLines(
      execFileSync('git', ['diff', '--unified=0', 'HEAD', '--', ...diffTargets], {
        cwd: projectRoot,
        encoding: 'utf-8',
      })
    );

    for (const abs of diffTargets) {
      const rel = path.relative(projectRoot, abs);
      const lines = hunks.get(rel) ?? new Set<number>();
      touchedLines.set(abs, lines);
    }
  }

  return { touchedLines, newFiles, deletedFiles };
}

/** True if `rel` is tracked at HEAD (has a committed state). */
function isTracked(projectRoot: string, rel: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** True if the absolute path exists in the working tree. */
function fileExists(abs: string): boolean {
  try {
    statSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether a single gating finding was introduced by the edit.
 * A finding is introduced when its file is new, or its 1-based line is touched.
 * Deleted files can never introduce a finding.
 */
export function isIntroducedByDiff(
  finding: { file: string; line?: number },
  gate: DiffGate,
): boolean {
  if (gate.deletedFiles.has(finding.file)) return false;
  if (gate.newFiles.has(finding.file)) return true;
  const lines = gate.touchedLines.get(finding.file);
  if (!lines) return false;
  return finding.line !== undefined && lines.has(finding.line);
}
