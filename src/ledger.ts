/**
 * Spec 11 R1 — Findings Ledger
 *
 * Append-only audit history stored in the SQLite index. Every audit surface
 * (CLI, MCP, library, hook) writes to the ledger unconditionally. The ledger
 * survives clearIndex like user-authored data.
 */

import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Violation } from './types.js';
import { fingerprint, type FingerprintInput } from './fingerprint.js';
import { extractSymbol } from './symbols.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface LedgerRunInput {
  gitSha?: string;
  gitDirty: boolean;
  toolVersion: string;
  command: string;
  surface: 'cli' | 'mcp' | 'library' | 'hook';
  scope: string;
  target: string;
}

export interface LedgerRunRecord {
  runId: string;
  timestamp: string;
  gitSha: string | null;
  gitDirty: boolean;
  toolVersion: string;
  command: string;
  surface: string;
  scope: string;
  target: string;
  durationMs: number;
  exitStatus: number;
}

export interface LedgerFindingRecord {
  runId: string;
  analyzer: string;
  rule: string;
  severity: string;
  message: string;
  file: string;
  line: number | null;
  symbol: string;
  fingerprint: string;
}

export interface LedgerRunSummary {
  runId: string;
  timestamp: string;
  command: string;
  surface: string;
  scope: string;
  findingCount: number;
  durationMs: number;
  exitStatus: number;
  gitSha?: string | null;
}

export interface LedgerStats {
  totalRuns: number;
  perAnalyzer: Record<string, { total: number; perRule: Record<string, number>; severityDistribution: Record<string, number> }>;
}

// ── Git helpers ───────────────────────────────────────────────────────────

function getGitInfo(target: string): { sha?: string; dirty: boolean } {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: target, stdio: 'pipe', timeout: 5000 })
      .toString()
      .trim();
    const status = execSync('git status --porcelain', { cwd: target, stdio: 'pipe', timeout: 5000 })
      .toString();
    const dirty = status.length > 0;
    return { sha: sha || undefined, dirty };
  } catch {
    return { dirty: false };
  }
}

// ── Writing ───────────────────────────────────────────────────────────────

export function writeAuditToLedger(
  db: Database.Database,
  runInput: LedgerRunInput,
  violations: Violation[],
  durationMs: number,
  exitStatus: number,
): string {
  const runId = randomUUID();
  const timestamp = new Date().toISOString();

  const insertRun = db.prepare(`
    INSERT INTO findings_ledger_runs
      (run_id, timestamp, git_sha, git_dirty, tool_version, command, surface, scope, target, duration_ms, exit_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFinding = db.prepare(`
    INSERT INTO findings_ledger_findings
      (run_id, analyzer, rule, severity, message, file, line, symbol, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insertRun.run(
      runId,
      timestamp,
      runInput.gitSha ?? null,
      runInput.gitDirty ? 1 : 0,
      runInput.toolVersion,
      runInput.command,
      runInput.surface,
      runInput.scope,
      runInput.target,
      durationMs,
      exitStatus,
    );

    for (const v of violations) {
      const symbol = extractSymbol(v);
      const fp = fingerprint({
        analyzer: (v as any).analyzer || 'unknown',
        rule: (v as any).rule || 'unknown',
        file: v.file,
        symbol,
      });
      insertFinding.run(
        runId,
        (v as any).analyzer || 'unknown',
        (v as any).rule || 'unknown',
        v.severity,
        v.message,
        v.file,
        v.line ?? null,
        symbol,
        fp,
      );
    }
  });

  tx();
  return runId;
}

/** Update the exit status of a ledger run — called by CLI/MCP after determining it. */
export function updateLedgerRunStatus(
  db: Database.Database,
  runId: string,
  exitStatus: number,
): void {
  db.prepare(
    'UPDATE findings_ledger_runs SET exit_status = ? WHERE run_id = ?',
  ).run(exitStatus, runId);
}

// ── Auto-detect git info ──────────────────────────────────────────────────

export function detectRunInput(
  command: string,
  surface: LedgerRunInput['surface'],
  scope: string,
  target: string,
  toolVersion: string,
): LedgerRunInput {
  const git = getGitInfo(target);
  return {
    gitSha: git.sha,
    gitDirty: git.dirty,
    toolVersion,
    command,
    surface,
    scope,
    target,
  };
}

// ── Reading ───────────────────────────────────────────────────────────────

export function listRuns(db: Database.Database): LedgerRunSummary[] {
  const rows = db.prepare(`
    SELECT
      r.run_id AS runId,
      r.timestamp,
      r.command,
      r.surface,
      r.scope,
      r.duration_ms AS durationMs,
      r.exit_status AS exitStatus,
      r.git_sha AS gitSha,
      COUNT(f.id) AS findingCount
    FROM findings_ledger_runs r
    LEFT JOIN findings_ledger_findings f ON f.run_id = r.run_id
    GROUP BY r.run_id
    ORDER BY r.timestamp DESC
  `).all() as any[];

  return rows.map((r) => ({
    runId: r.runId,
    timestamp: r.timestamp,
    command: r.command,
    surface: r.surface,
    scope: r.scope,
    findingCount: r.findingCount,
    durationMs: r.durationMs,
    exitStatus: r.exitStatus,
    gitSha: r.gitSha,
  }));
}

export function exportLedger(
  db: Database.Database,
  since?: string,
): { runs: LedgerRunRecord[]; findings: LedgerFindingRecord[] } {
  const runParams: any[] = [];
  let runWhere = '';
  if (since) {
    runWhere = 'WHERE timestamp >= ?';
    runParams.push(since);
  }

  const runs = db.prepare(`
    SELECT
      run_id AS runId,
      timestamp,
      git_sha AS gitSha,
      git_dirty AS gitDirty,
      tool_version AS toolVersion,
      command,
      surface,
      scope,
      target,
      duration_ms AS durationMs,
      exit_status AS exitStatus
    FROM findings_ledger_runs
    ${runWhere}
    ORDER BY timestamp DESC
  `).all(...runParams) as any[];

  const runIds = runs.map((r) => r.runId);
  let findings: any[] = [];
  if (runIds.length > 0) {
    const placeholders = runIds.map(() => '?').join(',');
    findings = db.prepare(`
      SELECT
        run_id AS runId,
        analyzer,
        rule,
        severity,
        message,
        file,
        line,
        symbol,
        fingerprint
      FROM findings_ledger_findings
      WHERE run_id IN (${placeholders})
      ORDER BY run_id, id
    `).all(...runIds) as any[];
  }

  return {
    runs: runs.map((r) => ({
      ...r,
      gitDirty: !!r.gitDirty,
      timestamp: String(r.timestamp),
    })),
    findings: findings.map((f) => ({
      ...f,
      line: f.line ?? null,
      symbol: String(f.symbol ?? ''),
      fingerprint: String(f.fingerprint ?? ''),
    })),
  };
}

// ── Trends (Spec 13 R4) ──────────────────────────────────────────────────────

export interface TrendRuleSummary {
  rule: string;
  newCount: number;
  fixedCount: number;
  net: number;
}

export interface TrendRunPair {
  previousRunId: string;
  previousTimestamp: string;
  currentRunId: string;
  currentTimestamp: string;
}

export interface TrendReport {
  target: string;
  runPairs: TrendRunPair[];
  timeRange: { start: string; end: string };
  perRule: Record<string, TrendRuleSummary>;
}

/**
 * Compare consecutive full-audit runs of the same target and report per-rule
 * new/fixed/net trends. Non-full runs are excluded. If fewer than 2 comparable
 * runs exist, returns null.
 *
 * @param db        The better-sqlite3 database handle.
 * @param sinceRunId  Only consider runs after this run ID.
 */
export function getTrends(db: Database.Database, sinceRunId?: string): TrendReport | null {
  // 1. Fetch full-scope runs, optionally filtered by sinceRunId
  let runQuery = `
    SELECT run_id, timestamp, target, scope
    FROM findings_ledger_runs
    WHERE scope = 'full'
  `;
  const params: any[] = [];

  if (sinceRunId) {
    // We need the timestamp of the sinceRunId to filter runs after it
    const sinceRow = db.prepare(
      'SELECT timestamp FROM findings_ledger_runs WHERE run_id = ?',
    ).get(sinceRunId) as { timestamp: string } | undefined;
    if (sinceRow) {
      runQuery += ' AND timestamp > ?';
      params.push(sinceRow.timestamp);
    }
  }

  runQuery += ' ORDER BY timestamp ASC';
  const runs = db.prepare(runQuery).all(...params) as Array<{
    run_id: string; timestamp: string; target: string; scope: string;
  }>;

  // 2. Group runs by target, then find consecutive pairs
  const runsByTarget = new Map<string, typeof runs>();
  for (const r of runs) {
    const list = runsByTarget.get(r.target) ?? [];
    list.push(r);
    runsByTarget.set(r.target, list);
  }

  // Pick the target with the most runs as the primary (matches common CLI usage)
  let bestRuns: typeof runs = [];
  for (const [, list] of runsByTarget) {
    if (list.length > bestRuns.length) bestRuns = list;
  }

  if (bestRuns.length < 2) return null;

  const target = bestRuns[0].target;

  // 3. For each consecutive pair, compare fingerprint sets per rule
  const runPairs: TrendRunPair[] = [];
  const ruleAccum: Map<string, { newCount: number; fixedCount: number }> = new Map();

  const getFingerprints = db.prepare(`
    SELECT analyzer || '/' || rule AS rule, fingerprint
    FROM findings_ledger_findings
    WHERE run_id = ?
  `);

  for (let i = 1; i < bestRuns.length; i++) {
    const prev = bestRuns[i - 1];
    const curr = bestRuns[i];

    const prevFindings = getFingerprints.all(prev.run_id) as Array<{ rule: string; fingerprint: string }>;
    const currFindings = getFingerprints.all(curr.run_id) as Array<{ rule: string; fingerprint: string }>;

    // Build fingerprint sets per rule
    const prevFps = new Map<string, Set<string>>();
    for (const f of prevFindings) {
      const s = prevFps.get(f.rule) ?? new Set();
      s.add(f.fingerprint);
      prevFps.set(f.rule, s);
    }

    const currFps = new Map<string, Set<string>>();
    for (const f of currFindings) {
      const s = currFps.get(f.rule) ?? new Set();
      s.add(f.fingerprint);
      currFps.set(f.rule, s);
    }

    // All rules that appear in either run
    const allRules = new Set([...prevFps.keys(), ...currFps.keys()]);

    for (const rule of allRules) {
      const prevSet = prevFps.get(rule) ?? new Set();
      const currSet = currFps.get(rule) ?? new Set();

      // New: present in current, absent in previous
      let newCount = 0;
      for (const fp of currSet) {
        if (!prevSet.has(fp)) newCount++;
      }

      // Fixed: absent in current, present in previous
      let fixedCount = 0;
      for (const fp of prevSet) {
        if (!currSet.has(fp)) fixedCount++;
      }

      if (newCount > 0 || fixedCount > 0) {
        const acc = ruleAccum.get(rule) ?? { newCount: 0, fixedCount: 0 };
        acc.newCount += newCount;
        acc.fixedCount += fixedCount;
        ruleAccum.set(rule, acc);
      }
    }

    runPairs.push({
      previousRunId: prev.run_id,
      previousTimestamp: prev.timestamp,
      currentRunId: curr.run_id,
      currentTimestamp: curr.timestamp,
    });
  }

  // 4. Build per-rule output
  const perRule: Record<string, TrendRuleSummary> = {};
  for (const [rule, acc] of ruleAccum) {
    perRule[rule] = {
      rule,
      newCount: acc.newCount,
      fixedCount: acc.fixedCount,
      net: acc.fixedCount - acc.newCount,
    };
  }

  return {
    target,
    runPairs,
    timeRange: {
      start: bestRuns[0].timestamp,
      end: bestRuns[bestRuns.length - 1].timestamp,
    },
    perRule,
  };
}

export function getLedgerStats(db: Database.Database): LedgerStats {
  const totalRuns = (db.prepare('SELECT COUNT(*) AS cnt FROM findings_ledger_runs').get() as any).cnt;

  const findingRows = db.prepare(`
    SELECT analyzer, rule, severity, COUNT(*) AS cnt
    FROM findings_ledger_findings
    GROUP BY analyzer, rule, severity
    ORDER BY analyzer, rule, severity
  `).all() as any[];

  const perAnalyzer: LedgerStats['perAnalyzer'] = {};
  for (const row of findingRows) {
    if (!perAnalyzer[row.analyzer]) {
      perAnalyzer[row.analyzer] = { total: 0, perRule: {}, severityDistribution: {} };
    }
    perAnalyzer[row.analyzer].total += row.cnt;
    perAnalyzer[row.analyzer].perRule[row.rule] =
      (perAnalyzer[row.analyzer].perRule[row.rule] || 0) + row.cnt;
    perAnalyzer[row.analyzer].severityDistribution[row.severity] =
      (perAnalyzer[row.analyzer].severityDistribution[row.severity] || 0) + row.cnt;
  }

  return { totalRuns, perAnalyzer };
}

// ── D1 Interim Import ─────────────────────────────────────────────────────

/**
 * D1 interim archive format (Directive D1): directory of JSON files per run.
 * Each file: { timestamp, command, surface, scope, violations: [...] }
 * This is a legacy bridge — D1 is retired once the interim directory is ingested.
 */
export interface D1InterimRun {
  timestamp?: string;
  command?: string;
  surface?: string;
  scope?: string;
  target?: string;
  toolVersion?: string;
  violations?: Array<{
    analyzer?: string;
    rule?: string;
    severity?: string;
    message?: string;
    file?: string;
    line?: number;
    symbol?: string;
  }>;
}

export function importLedgerFromDir(db: Database.Database, dirPath: string): { imported: number; skipped: number } {
  if (!existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const files = readdirSync(dirPath).filter((f) => f.endsWith('.json'));
  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    try {
      const raw = readFileSync(join(dirPath, file), 'utf-8');
      const data: D1InterimRun = JSON.parse(raw);

      if (!data.violations) {
        skipped++;
        continue;
      }

      const violations: Violation[] = data.violations.map((v) => ({
        file: v.file || 'unknown',
        line: v.line,
        severity: (v.severity as any) || 'suggestion',
        message: v.message || '',
        analyzer: v.analyzer || 'unknown',
        rule: v.rule || 'unknown',
        symbol: v.symbol || '',
      }));

      const runInput: LedgerRunInput = {
        gitDirty: false,
        toolVersion: data.toolVersion || 'unknown',
        command: data.command || 'imported',
        surface: (data.surface as any) || 'cli',
        scope: data.scope || 'full',
        target: data.target || dirPath,
      };

      writeAuditToLedger(db, runInput, violations, 0, 0);
      imported++;
    } catch {
      skipped++;
    }
  }

  return { imported, skipped };
}
