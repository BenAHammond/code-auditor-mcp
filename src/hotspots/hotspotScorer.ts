/**
 * Hotspot Scorer — Spec 13 R2 + R3.
 *
 * Computes hotspot scores as churn-percentile × complexity-percentile for
 * every file and function. Scores are written into the hotspot_scores table
 * and recomputed on every sync (idempotent).
 *
 * Bus-factor risk (R3): files and functions in the top quartile of hotspot
 * scores whose dominant_author_share ≥ 0.9 are flagged.
 */

import type { HotspotEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute hotspot scores and write them into the hotspot_scores table.
 * Also detects bus-factor risks.
 *
 * @param rawDb  The underlying better-sqlite3 database handle.
 * @returns  Array of HotspotEntry for external use (CLI / reporting).
 */
export function computeHotspots(rawDb: any): HotspotEntry[] {
  // Clear previous scores
  rawDb.prepare('DELETE FROM hotspot_scores').run();

  // ── Gather data ──────────────────────────────────────────────────────

  // File churn: rows from file_churn table
  const fileChurnRows = rawDb.prepare(`
    SELECT fc.file_path, fc.commit_count, fc.distinct_authors,
           fc.dominant_author, fc.dominant_author_share
    FROM file_churn fc
  `).all() as FileChurnRow[];

  // Function churn: rows from function_churn + function complexity
  const funcChurnRows = rawDb.prepare(`
    SELECT fnc.function_id, fnc.function_name, fnc.file_path,
           fnc.commit_count, fnc.distinct_authors,
           fnc.dominant_author, fnc.dominant_author_share,
           COALESCE(fn.complexity, 0) as complexity
    FROM function_churn fnc
    LEFT JOIN functions fn ON fn.id = fnc.function_id
    WHERE fn.complexity IS NOT NULL
  `).all() as FuncChurnRow[];

  // File complexity: max function complexity per file
  const fileComplexityRows = rawDb.prepare(`
    SELECT file_path, COALESCE(MAX(complexity), 0) as max_complexity
    FROM functions
    WHERE complexity IS NOT NULL
    GROUP BY file_path
  `).all() as { file_path: string; max_complexity: number }[];

  const fileComplexityMap = new Map<string, number>();
  for (const row of fileComplexityRows) {
    fileComplexityMap.set(row.file_path, row.max_complexity);
  }

  // Also gather ALL functions for files that have no churn — these get
  // complexity data but no churn data (score 0).
  const allFilePaths = rawDb.prepare(`
    SELECT DISTINCT file_path FROM functions
  `).all() as { file_path: string }[];

  // ── File-level hotspots ──────────────────────────────────────────────

  const fileChurnMap = new Map<string, FileChurnRow>();
  for (const row of fileChurnRows) {
    fileChurnMap.set(row.file_path, row);
  }

  // Build file entries: every file in functions gets an entry.
  // Files with churn: churn pct × complexity pct.
  // Files without churn (chill files): score = 0.
  const fileEntries: InternalEntry[] = [];
  for (const { file_path } of allFilePaths) {
    const churn = fileChurnMap.get(file_path);
    const complexity = fileComplexityMap.get(file_path) ?? 0;
    fileEntries.push({
      target: file_path,
      type: 'file',
      commitCount: churn?.commit_count ?? 0,
      distinctAuthors: churn?.distinct_authors ?? 0,
      dominantAuthor: churn?.dominant_author ?? '',
      dominantAuthorShare: churn?.dominant_author_share ?? 0,
      complexity,
      churnValue: churn ? churn.commit_count : 0,
      complexityValue: complexity,
      churnPct: 0,
      complexityPct: 0,
      score: 0,
      busFactorRisk: false,
    });
  }

  // ── Function-level hotspots ──────────────────────────────────────────

  const funcEntries: InternalEntry[] = funcChurnRows.map(row => ({
    target: `${row.file_path}::${row.function_name}`,
    type: 'function',
    commitCount: row.commit_count,
    distinctAuthors: row.distinct_authors,
    dominantAuthor: row.dominant_author ?? '',
    dominantAuthorShare: row.dominant_author_share ?? 0,
    complexity: row.complexity,
    churnValue: row.commit_count,
    complexityValue: row.complexity,
    churnPct: 0,
    complexityPct: 0,
    score: 0,
    busFactorRisk: false,
    functionId: row.function_id,
    functionName: row.function_name,
    filePath: row.file_path,
  }));

  // ── Percentile computation ───────────────────────────────────────────

  // File churn percentiles: rank by commit_count
  computePercentile(fileEntries.filter(e => e.type === 'file').filter(e => e.churnValue > 0), 'churnValue', 'churnPct');
  // Zero-churn files: churnPct = 0 (already default)

  // File complexity percentiles
  computePercentile(fileEntries.filter(e => e.type === 'file'), 'complexityValue', 'complexityPct');

  // Function churn percentiles
  computePercentile(funcEntries.filter(e => e.churnValue > 0), 'churnValue', 'churnPct');

  // Function complexity percentiles
  computePercentile(funcEntries, 'complexityValue', 'complexityPct');

  // ── Score computation ────────────────────────────────────────────────

  for (const entry of fileEntries) {
    entry.score = entry.churnPct * entry.complexityPct;
  }

  for (const entry of funcEntries) {
    entry.score = entry.churnPct * entry.complexityPct;
  }

  const allEntries = [...fileEntries, ...funcEntries];

  // ── Bus-factor risk: top quartile + dominant_author_share ≥ 0.9 ──────

  const scored = allEntries.filter(e => e.score > 0).sort((a, b) => b.score - a.score);
  const topQuartileCutoff = Math.max(1, Math.ceil(scored.length / 4));
  const topQuartileScore = scored.length > 0 ? scored[topQuartileCutoff - 1]?.score ?? 0 : 0;

  for (const entry of allEntries) {
    entry.busFactorRisk =
      entry.score >= topQuartileScore &&
      entry.score > 0 &&
      entry.dominantAuthorShare >= 0.9;
  }

  // ── Write to database ────────────────────────────────────────────────

  const insert = rawDb.prepare(`
    INSERT INTO hotspot_scores
      (target, type, score, churn_pct, complexity_pct, commit_count,
       distinct_authors, dominant_author, dominant_author_share,
       bus_factor_risk, complexity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = rawDb.transaction(() => {
    for (const entry of allEntries) {
      insert.run(
        entry.target,
        entry.type,
        entry.score,
        entry.churnPct,
        entry.complexityPct,
        entry.commitCount,
        entry.distinctAuthors,
        entry.dominantAuthor || null,
        entry.dominantAuthorShare,
        entry.busFactorRisk ? 1 : 0,
        entry.complexity,
      );
    }
  });
  txn();

  // ── Return HotspotEntry[] ────────────────────────────────────────────

  return allEntries
    .filter(e => e.score > 0 || e.busFactorRisk)
    .sort((a, b) => b.score - a.score)
    .map(toHotspotEntry);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FileChurnRow {
  file_path: string;
  commit_count: number;
  distinct_authors: number;
  dominant_author: string | null;
  dominant_author_share: number;
}

interface FuncChurnRow {
  function_id: number;
  function_name: string;
  file_path: string;
  commit_count: number;
  distinct_authors: number;
  dominant_author: string | null;
  dominant_author_share: number;
  complexity: number;
}

interface InternalEntry {
  target: string;
  type: 'file' | 'function';
  commitCount: number;
  distinctAuthors: number;
  dominantAuthor: string;
  dominantAuthorShare: number;
  complexity: number;
  churnValue: number;
  complexityValue: number;
  churnPct: number;
  complexityPct: number;
  score: number;
  busFactorRisk: boolean;
  functionId?: number;
  functionName?: string;
  filePath?: string;
}

/**
 * Compute percentile [0,1] for a given value field across entries.
 * Modifies entries in-place by setting the targetPctField.
 */
function computePercentile(
  entries: InternalEntry[],
  valueField: 'churnValue' | 'complexityValue',
  pctField: 'churnPct' | 'complexityPct',
): void {
  if (entries.length <= 1) {
    for (const e of entries) {
      e[pctField] = entries.length === 1 ? 1 : 0;
    }
    return;
  }

  // Sort ascending by the value field
  const sorted = [...entries].sort((a, b) => a[valueField] - b[valueField]);
  const n = sorted.length;

  // Assign ranks (1-based), handling ties with the same rank
  const rankMap = new Map<InternalEntry, number>();
  let i = 0;
  while (i < n) {
    const val = sorted[i][valueField];
    let j = i;
    while (j < n && sorted[j][valueField] === val) j++;
    // All entries with the same value get the average rank
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      rankMap.set(sorted[k], avgRank);
    }
    i = j;
  }

  // Percentile = (rank - 1) / (n - 1)
  for (const entry of entries) {
    const rank = rankMap.get(entry) ?? 1;
    entry[pctField] = (rank - 1) / (n - 1);
  }
}

function toHotspotEntry(e: InternalEntry): HotspotEntry {
  return {
    target: e.target,
    type: e.type,
    score: e.score,
    churnPercentile: e.churnPct,
    complexityPercentile: e.complexityPct,
    commitCount: e.commitCount,
    distinctAuthors: e.distinctAuthors,
    dominantAuthor: e.dominantAuthor,
    dominantAuthorShare: e.dominantAuthorShare,
    busFactorRisk: e.busFactorRisk,
    complexity: e.complexity,
  };
}
