/**
 * Churn Extractor — Spec 13 R1.
 *
 * Extracts git churn data (file-level and function-level) from a repository
 * and writes it into the code index database. All git access is read-only and
 * degrades gracefully when no repository exists.
 *
 * File churn: `git log --numstat` aggregates commit counts, line adds/deletes,
 * and author stats per file.
 *
 * Function churn: `git log -p` hunks are mapped to function line spans stored
 * in the `functions` table. A function is attributed churn when a hunk overlaps
 * its line range.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import type { ChurnConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ChurnResult {
  fileCount: number;
  functionCount: number;
  durationMs: number;
}

export const DEFAULT_CHURN_CONFIG: ChurnConfig = {
  churnWindowMonths: 12,
};

/**
 * Extract git churn data and write it into the database.
 * Degrades gracefully when no git repo exists — writes empty tables.
 *
 * @param rawDb  The underlying better-sqlite3 database handle.
 * @param targetPath  Absolute path to the repository root.
 * @param config  Optional churn config (window, etc.).
 * @returns  Counts and timing for evidence bundles.
 */
export function extractChurn(
  rawDb: any,
  targetPath: string,
  config: ChurnConfig = DEFAULT_CHURN_CONFIG,
): ChurnResult {
  const startTime = Date.now();
  const windowMonths = config.churnWindowMonths ?? 12;

  // ── Check git availability ──────────────────────────────────────────
  if (!hasGitRepo(targetPath)) {
    return { fileCount: 0, functionCount: 0, durationMs: Date.now() - startTime };
  }

  // ── Meta-hash: skip if HEAD + window haven't changed ────────────────
  let headSha: string;
  try {
    headSha = execSync('git rev-parse HEAD', { cwd: targetPath, stdio: 'pipe', timeout: 5000 })
      .toString()
      .trim();
  } catch {
    headSha = '';
  }
  const churnKey = `${headSha}|${windowMonths}`;

  const oldHash = rawDb
    .prepare("SELECT value FROM meta WHERE key = 'churn_hash'")
    .get() as { value: string } | undefined;

  if (oldHash && oldHash.value === churnKey) {
    // Churn data is still fresh — no-op
    const fileCount = (rawDb.prepare('SELECT COUNT(*) as cnt FROM file_churn').get() as any).cnt;
    const funcCount = (rawDb.prepare('SELECT COUNT(*) as cnt FROM function_churn').get() as any).cnt;
    return { fileCount, functionCount: funcCount, durationMs: Date.now() - startTime };
  }

  // ── Clear existing churn data ───────────────────────────────────────
  rawDb.prepare('DELETE FROM file_churn').run();
  rawDb.prepare('DELETE FROM function_churn').run();

  // ── Extract file-level churn ────────────────────────────────────────
  const fileChurn = extractFileChurn(targetPath, windowMonths);
  writeFileChurn(rawDb, fileChurn);
  const fileCount = fileChurn.size;

  // ── Extract function-level churn ────────────────────────────────────
  const functions = rawDb
    .prepare('SELECT id, name, file_path, start_line, end_line FROM functions WHERE start_line IS NOT NULL AND end_line IS NOT NULL')
    .all() as Array<{ id: number; name: string; file_path: string; start_line: number; end_line: number }>;

  const funcChurnCount = extractAndWriteFunctionChurn(rawDb, targetPath, windowMonths, functions);

  // ── Record meta hash for next skip ──────────────────────────────────
  rawDb.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('churn_hash', ?)"
  ).run(churnKey);

  return { fileCount, functionCount: funcChurnCount, durationMs: Date.now() - startTime };
}

// ---------------------------------------------------------------------------
// Git checks
// ---------------------------------------------------------------------------

function hasGitRepo(targetPath: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd: targetPath, stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// File-level churn
// ---------------------------------------------------------------------------

interface FileChurnEntry {
  file_path: string;
  commit_count: number;
  lines_added: number;
  lines_deleted: number;
  authors: Map<string, number>;
  last_touched: string;
}

function extractFileChurn(targetPath: string, windowMonths: number): Map<string, FileChurnEntry> {
  const result = new Map<string, FileChurnEntry>();
  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - windowMonths);
  const sinceStr = sinceDate.toISOString().split('T')[0];

  try {
    // --numstat gives: <added>\t<deleted>\t<file>
    // Separator between commits is the commit header line
    const output = execSync(
      `git log --numstat --format='%H|%an|%at' --since='${sinceStr}'`,
      { cwd: targetPath, stdio: 'pipe', timeout: 30000, maxBuffer: 50 * 1024 * 1024 },
    ).toString();

    let currentAuthor = '';
    let currentDate = '';

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Commit header: HASH|AUTHOR|TIMESTAMP
      if (trimmed.includes('|') && !trimmed.includes('\t')) {
        const parts = trimmed.split('|');
        if (parts.length >= 3) {
          currentAuthor = parts[1];
          // Convert unix timestamp to ISO
          const ts = parseInt(parts[2], 10);
          currentDate = ts > 0 ? new Date(ts * 1000).toISOString() : '';
        }
        continue;
      }

      // Numstat line: <added>\t<deleted>\t<file>
      // Binary files show '-' for added/deleted
      const parts = trimmed.split('\t');
      if (parts.length < 3) continue;

      const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
      const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
      const file = parts[2];

      let entry = result.get(file);
      if (!entry) {
        entry = {
          file_path: file,
          commit_count: 0,
          lines_added: 0,
          lines_deleted: 0,
          authors: new Map(),
          last_touched: currentDate,
        };
        result.set(file, entry);
      }

      entry.commit_count += 1;
      entry.lines_added += added;
      entry.lines_deleted += deleted;
      entry.authors.set(currentAuthor, (entry.authors.get(currentAuthor) ?? 0) + 1);
      if (currentDate > entry.last_touched) {
        entry.last_touched = currentDate;
      }
    }
  } catch (err) {
    // Graceful: no git, empty result
    if ((err as any)?.code === 'ENOENT') return result;
    // Non-zero exit (e.g. no commits in window) is fine
  }

  return result;
}

function writeFileChurn(rawDb: any, fileChurn: Map<string, FileChurnEntry>): void {
  const insert = rawDb.prepare(`
    INSERT OR REPLACE INTO file_churn
      (file_path, commit_count, lines_added, lines_deleted,
       distinct_authors, dominant_author, dominant_author_share, last_touched)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = rawDb.transaction(() => {
    for (const [fp, entry] of fileChurn) {
      const distinctAuthors = entry.authors.size;
      let dominantAuthor = '';
      let dominantShare = 0;
      let maxCommits = 0;

      for (const [author, commits] of entry.authors) {
        if (commits > maxCommits) {
          maxCommits = commits;
          dominantAuthor = author;
        }
      }
      if (entry.commit_count > 0) {
        dominantShare = maxCommits / entry.commit_count;
      }

      insert.run(
        fp,
        entry.commit_count,
        entry.lines_added,
        entry.lines_deleted,
        distinctAuthors,
        dominantAuthor || null,
        dominantShare,
        entry.last_touched || null,
      );
    }
  });
  txn();
}

// ---------------------------------------------------------------------------
// Function-level churn
// ---------------------------------------------------------------------------

/**
 * For each file that has changed (according to file_churn or git), parse
 * `git log -p` hunks and map them to function line spans.
 *
 * This is the expensive step — we only run it for files that actually changed.
 */
function extractAndWriteFunctionChurn(
  rawDb: any,
  targetPath: string,
  windowMonths: number,
  functions: Array<{ id: number; name: string; file_path: string; start_line: number; end_line: number }>,
): number {
  // Group functions by file for efficient hunk mapping
  const funcsByFile = new Map<string, Array<{ id: number; name: string; start_line: number; end_line: number }>>();
  for (const fn of functions) {
    const list = funcsByFile.get(fn.file_path) ?? [];
    list.push(fn);
    funcsByFile.set(fn.file_path, list);
  }

  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - windowMonths);
  const sinceStr = sinceDate.toISOString().split('T')[0];

  // Track per-function churn
  interface FuncChurnAcc {
    commit_count: number;
    authors: Map<string, number>;
  }
  const funcChurnMap = new Map<number, FuncChurnAcc>();

  // Only process files that have functions AND changed in the window
  for (const [filePath, fileFuncs] of funcsByFile) {
    try {
      const output = execSync(
        `git log -p --since='${sinceStr}' -- "${filePath}"`,
        { cwd: targetPath, stdio: 'pipe', timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
      ).toString();

      // Parse commits: @@ -a,b +c,d @@ marks a hunk
      let currentAuthor = '';
      const hunkLinePattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

      for (const line of output.split('\n')) {
        // Author line from diff header
        const authorMatch = line.match(/^Author:\s+(.+)$/);
        if (authorMatch) {
          currentAuthor = authorMatch[1].trim();
          continue;
        }

        const hunkMatch = line.match(hunkLinePattern);
        if (hunkMatch) {
          const hunkStart = parseInt(hunkMatch[1], 10);
          const hunkLen = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
          const hunkEnd = hunkStart + hunkLen - 1;

          // Find functions that overlap with this hunk
          for (const fn of fileFuncs) {
            if (fn.start_line <= hunkEnd && fn.end_line >= hunkStart) {
              let acc = funcChurnMap.get(fn.id);
              if (!acc) {
                acc = { commit_count: 0, authors: new Map() };
                funcChurnMap.set(fn.id, acc);
              }
              acc.commit_count += 1;
              if (currentAuthor) {
                acc.authors.set(currentAuthor, (acc.authors.get(currentAuthor) ?? 0) + 1);
              }
            }
          }
        }
      }
    } catch {
      // File may have been deleted or renamed — skip
    }
  }

  // Write function churn
  const insert = rawDb.prepare(`
    INSERT INTO function_churn
      (function_id, function_name, file_path, commit_count,
       distinct_authors, dominant_author, dominant_author_share, renamed, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1.0)
  `);

  const txn = rawDb.transaction(() => {
    for (const [funcId, acc] of funcChurnMap) {
      const fn = functions.find(f => f.id === funcId);
      if (!fn) continue;

      let dominantAuthor = '';
      let maxCommits = 0;
      for (const [author, commits] of acc.authors) {
        if (commits > maxCommits) {
          maxCommits = commits;
          dominantAuthor = author;
        }
      }
      const share = acc.commit_count > 0 ? maxCommits / acc.commit_count : 0;

      insert.run(
        funcId,
        fn.name,
        fn.file_path,
        acc.commit_count,
        acc.authors.size,
        dominantAuthor || null,
        share,
      );
    }
  });
  txn();

  return funcChurnMap.size;
}
