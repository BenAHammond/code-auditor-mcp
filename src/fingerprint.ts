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
 */
import { createHash } from 'node:crypto';

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
