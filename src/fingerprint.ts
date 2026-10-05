/**
 * Stable violation fingerprint for deduplication.
 *
 * Excludes line numbers so edits above a violation don't change its identity.
 * JSON-array encoding prevents delimiter collisions — symbols and paths can
 * contain any character.
 *
 * Reused by:
 *   Spec 02 — tasks.from_audit bridge dedupe
 *   Spec 03 — SQLite data layer (fingerprint column on tasks)
 *   Spec 04 — diff-scoped auditing
 *   Spec 06 — SARIF partial fingerprints (same tuple underlies a SARIF
 *             partialFingerprints entry)
 *
 * buildFingerprintInput() is the SINGLE canonical source for the
 * {analyzer, rule, file, symbol} tuple. Every surface that fingerprints a
 * violation (baseline, from_audit, SARIF) calls this function — no surface
 * resolves the rule-id chain or symbol inline. If a new analyzer stores its
 * rule id in a novel field, add that field HERE.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Violation } from './types.js';
import { extractSymbol } from './symbols.js';
import { canonicalRuleId } from './ruleAliases.js';

export interface FingerprintInput {
  analyzer: string;
  rule: string;
  file: string;
  symbol: string;
}

/**
 * Canonicalize the `file` component of a fingerprint so the same physical file
 * hashes identically however it was spelled. On macOS `/tmp` is a symlink to
 * `/private/tmp`, so `changed -p /tmp/foo` (which carries the lexical path into
 * every finding's `file`) and `dismiss` run from inside the project (whose
 * `process.cwd()` is the resolved `/private/tmp/foo`) would otherwise produce
 * two different fingerprints for the *same* finding — the exact workflow
 * SKILL.md documents ("copy the fingerprint from `changed --json`, then
 * `dismiss <fingerprint>`"). Resolving symlinks makes the tuple spelling-stable,
 * mirroring `dataPaths.resolveRealPath`, which exists for the same reason.
 *
 * Only absolute paths are resolved: a relative `file` carries no symlink
 * ambiguity, and resolving it against an arbitrary cwd would make the
 * fingerprint cwd-dependent — the opposite of stable. The lookup is memoized
 * because the same file path recurs across many findings and `realpathSync` is
 * a syscall.
 */
const realpathCache = new Map<string, string>();

function normalizeFile(file: string): string {
  if (!file || !isAbsolute(file)) return file;
  const cached = realpathCache.get(file);
  if (cached !== undefined) return cached;
  let canonical: string;
  try {
    canonical = realpathSync(file);
  } catch {
    // File may not exist (deleted since discovery, or an indexed file whose
    // source is gone) — fall back to the lexical absolute path so the
    // fingerprint stays deterministic for the same input string.
    canonical = resolve(file);
  }
  realpathCache.set(file, canonical);
  return canonical;
}

/**
 * Produce a stable hex SHA-256 digest from the canonical four-tuple.
 *
 * The components are JSON-serialized in a fixed-order array so that a colon
 * or any other character inside a component cannot create an ambiguous
 * boundary.
 *
 * @param input - The canonical {analyzer, rule, file, symbol} tuple.
 * @returns A hex SHA-256 digest of the canonical tuple.
 */
export function fingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify([
    input.analyzer,
    input.rule,
    input.file,
    input.symbol,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Build the canonical {analyzer, rule, file, symbol} tuple for a violation.
 *
 * `rule` is required on Violation — it is the single source of truth for
 * rule identity. Every analyzer must set `rule` when constructing a violation.
 *
 * @param violation - The violation to derive the tuple from.
 * @returns The canonical four-tuple for fingerprinting.
 */
export function buildFingerprintInput(violation: Violation): FingerprintInput {
  // Canonicalize through the rule-alias map (Spec 38 R5) so a rename does not
  // change a violation's identity — an existing baseline survives a rename.
  const rule = canonicalRuleId(violation.rule ?? '');

  return {
    analyzer: violation.analyzer ?? '',
    rule,
    file: normalizeFile(violation.file ?? ''),
    symbol: extractSymbol(violation),
  };
}
