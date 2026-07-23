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
import type { Violation } from './types.js';
import { extractSymbol } from './symbols.js';

export interface FingerprintInput {
  analyzer: string;
  rule: string;
  file: string;
  symbol: string;
}

/**
 * Produce a stable hex SHA-256 digest from the canonical four-tuple.
 *
 * The components are JSON-serialized in a fixed-order array so that a colon
 * or any other character inside a component cannot create an ambiguous
 * boundary.
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
 * This is the ONE place rule-id resolution happens. If a violation stores its
 * rule identifier in a field not listed here, that violation fingerprints
 * with an empty rule — add the missing field to the chain below.
 *
 * Precedence (first populated wins):
 *   1. `violation.rule`       — universal analyzers, invariants, react (hooks)
 *   2. `violation.principle`   — CrossLanguageSOLID
 *   3. `violation.violationType` — SchemaValidator, reactAnalyzer
 *   4. `violation.contractType` — APIContractAnalyzer
 *   5. `violation.type`         — structural type (rarely a rule id; last-resort)
 *   6. `violation.details?.rule` — nested rule (react)
 */
export function buildFingerprintInput(violation: Violation): FingerprintInput {
  const rule =
    (typeof violation.rule === 'string' ? violation.rule : undefined) ??
    (typeof violation.principle === 'string' ? violation.principle : undefined) ??
    (typeof violation.violationType === 'string' ? violation.violationType : undefined) ??
    (typeof violation.contractType === 'string' ? violation.contractType : undefined) ??
    (typeof violation.type === 'string' ? violation.type : undefined) ??
    (violation.details &&
     typeof violation.details === 'object' &&
     !Array.isArray(violation.details) &&
     typeof violation.details.rule === 'string'
      ? violation.details.rule
      : undefined) ??
    '';

  return {
    analyzer: violation.analyzer ?? '',
    rule,
    file: violation.file ?? '',
    symbol: extractSymbol(violation),
  };
}
