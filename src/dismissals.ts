/**
 * Spec 57 — Dismissals.
 *
 * A dismissal clears exactly one finding, scoped by its fingerprint (rule +
 * file + symbol, via the shared `buildFingerprintInput`/`fingerprint` tuple the
 * baseline, SARIF and tasks already use). It is a *decision about specific code*,
 * not configuration, so it lives in its own committed dotfile — never in
 * `.codeauditor.json`.
 *
 * What distinguishes a dismissal from a baseline (which was repeatedly rejected
 * because it accumulates and nobody revisits it):
 *
 *   - a **written reason is required** (a dismissal without one is a config error),
 *   - it is **scoped to one finding** (not the rule, not the file), and
 *   - it is **counted in every report** ("43 findings, 3 dismissed"), never
 *     silently subtracted from the total.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fingerprint, buildFingerprintInput } from './fingerprint.js';
import { canonicalRuleId } from './ruleAliases.js';
import { extractSymbol } from './symbols.js';
import type { AuditResult, Violation } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** One dismissed finding. `reason` is the product — a dismissal without one is a suppression. */
export interface DismissalEntry {
  /** SHA-256 fingerprint of [analyzer, rule, file, symbol] — the scoping key. */
  fingerprint: string;
  /** Canonical rule ID, for grouping/readability (R4) and the telemetry payload (R2). */
  rule: string;
  /** File path at dismissal time, for readability (the fingerprint is the identity). */
  file: string;
  /** Canonical symbol at dismissal time, for readability. */
  symbol: string;
  /** Why this finding was dismissed — REQUIRED. The reason is the product. */
  reason: string;
  /** ISO-8601 timestamp of the dismissal. */
  dismissedAt: string;
  /** Tool version (package.json) at dismissal time. */
  toolVersion: string;
}

/** The committed dismissals file. */
export interface DismissalsFile {
  schemaVersion: 1;
  entries: DismissalEntry[];
}

/** Result of matching a run's findings against the dismissals file. */
export interface DismissalMatch {
  /** Findings whose fingerprint is dismissed — they never gate. */
  dismissed: Violation[];
  /** Findings with no matching dismissal — they gate normally. */
  active: Violation[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const DISMISSALS_FILENAME = '.codeauditor.dismissals.json';
const SCHEMA_VERSION = 1;

// ── Load / save ──────────────────────────────────────────────────────────────

/**
 * Load the dismissals file from the project root. Returns `null` when absent.
 *
 * When the file exists but is structurally invalid (wrong schema version, or an
 * entry missing a non-empty `fingerprint`/`reason`), a config error is reported
 * to stderr and `null` is returned — the run proceeds with zero dismissals
 * rather than silently honouring a malformed suppression list.
 */
export function loadDismissals(projectRoot: string): DismissalsFile | null {
  const filePath = path.join(projectRoot, DISMISSALS_FILENAME);
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      console.error(
        `Dismissals file has an unsupported shape (expected schemaVersion ${SCHEMA_VERSION} with an "entries" array): ${filePath}`,
      );
      return null;
    }
    const invalid = parsed.entries.filter(
      (e: any) => typeof e.fingerprint !== 'string' || !e.fingerprint || typeof e.reason !== 'string' || !e.reason.trim(),
    );
    if (invalid.length > 0) {
      console.error(
        `Dismissals file has ${invalid.length} entry(ies) missing a fingerprint or a non-empty reason ` +
          `(a dismissal without a reason is a config error, not a suppression): ${filePath}`,
      );
      return null;
    }
    return parsed as DismissalsFile;
  } catch {
    return null;
  }
}

/** Write the dismissals file to the project root (committed, reviewable in a diff). */
export function saveDismissals(projectRoot: string, dismissals: DismissalsFile): void {
  const filePath = path.join(projectRoot, DISMISSALS_FILENAME);
  writeFileSync(filePath, JSON.stringify(dismissals, null, 2) + '\n', 'utf-8');
}

// ── Mutation ─────────────────────────────────────────────────────────────────

/** Build a dismissal entry from a live violation and a required reason. */
export function buildDismissalEntry(violation: Violation, reason: string, toolVersion: string): DismissalEntry {
  const input = buildFingerprintInput(violation);
  return {
    fingerprint: fingerprint(input),
    rule: canonicalRuleId(violation.rule ?? ''),
    file: violation.file ?? '',
    symbol: extractSymbol(violation),
    reason,
    dismissedAt: new Date().toISOString(),
    toolVersion,
  };
}

/**
 * Add (or replace) a dismissal entry, keyed by fingerprint. Idempotent: re-
 * dismissing an already-dismissed finding updates its reason and timestamp.
 */
export function upsertDismissal(projectRoot: string, entry: DismissalEntry): DismissalsFile {
  const dismissals = loadDismissals(projectRoot) ?? { schemaVersion: SCHEMA_VERSION as 1, entries: [] };
  const existing = dismissals.entries.find((e) => e.fingerprint === entry.fingerprint);
  if (existing) {
    Object.assign(existing, entry);
  } else {
    dismissals.entries.push(entry);
  }
  saveDismissals(projectRoot, dismissals);
  return dismissals;
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Partition a run's findings into dismissed vs active by fingerprint.
 */
export function matchDismissals(
  violations: Violation[],
  dismissals: DismissalsFile,
): DismissalMatch {
  const dismissalMap = new Map<string, DismissalEntry>();
  for (const entry of dismissals.entries) dismissalMap.set(entry.fingerprint, entry);

  const dismissed: Violation[] = [];
  const active: Violation[] = [];

  for (const v of violations) {
    const fp = fingerprint(buildFingerprintInput(v));
    if (dismissalMap.has(fp)) dismissed.push(v);
    else active.push(v);
  }

  return { dismissed, active };
}

/**
 * Apply dismissals to a completed audit result: mark dismissed findings so the
 * gate skips them, and record the dismissed count in the summary (never subtracted
 * from `totalViolations`).
 */
export function applyDismissals(result: AuditResult, projectRoot: string): void {
  const dismissals = loadDismissals(projectRoot);
  result.summary.dismissed = 0;
  if (!dismissals) return;

  const violations = Object.values(result.analyzerResults).flatMap((r) => r.violations);
  const { dismissed } = matchDismissals(violations, dismissals);

  for (const v of dismissed) {
    (v as Violation).dismissed = true;
  }
  result.summary.dismissed = dismissed.length;
}
