/**
 * duplication.ts — the DRY family (rules 18–21) at production scale.
 *
 * Four distinct signals, each pinned by a purpose-built case:
 *
 *   - `duplicate-import` (18) — a module imported twice in one file. The
 *     `imports` fact is grouped by `(file, source)`; two imports of the same
 *     specifier are the signal, anchored at the *first* import's line.
 *   - `duplicate-string-literal` (19) — a raw string value that appears more
 *     than twice in one file. Only non-trivial (`> 10` chars) *value* strings
 *     count: an identifier-like token, a relative module path, a CLI flag, a
 *     separator, or a dotted name is a name, not a duplicated value, so a
 *     repeated `'…'` vocabulary token stays quiet.
 *   - `dry/duplicate` (20) — two code blocks whose *normalized text* hashes
 *     equal (comments and whitespace stripped). Two classes carry an identical
 *     copy-pasted `toDTO` mapper; the second one is the finding, anchored at its
 *     own start line.
 *   - `dry/structural-similarity` (21) — two blocks whose token-bigram
 *     *skeletons* (identifiers → ID, literals → LIT, keywords kept) are ≥ the
 *     `similarityThreshold` (0.85) Jaccard-similar, without being byte-equal.
 *     `validateUserFields` and `validateOrderItems` share a shape but not text.
 *
 * `dry/diverging-clone` (23) is NOT here: it reads `clone-pair-history`, a
 * cross-run ledger fact (`dry_pair_history` similarity series) that a single
 * static `runAudit` with `writeToLedger: false` can never populate. That gap is
 * documented in REPORT.md, not faked.
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires duplicate-import 35 — `./shared-models` imported twice, anchored at the first import
 *   @fires duplicate-string-literal 39 — the upstream-error string appears three times, anchored at its first occurrence
 *   @fires dry/duplicate 67 — the copy-pasted `toDTO` mapper (second occurrence)
 *   @fires dry/structural-similarity 106 — the same-shaped validator (second occurrence)
 */

import { User } from './shared-models';
import { Order } from './shared-models';

// A message worth extracting: repeated three times, verbatim.
const USER_ERR = 'Unable to reach the upstream service';
const ORDER_ERR = 'Unable to reach the upstream service';
const PAYMENT_ERR = 'Unable to reach the upstream service';

/** Maps a user row to a transport DTO — copy-pasted into `OrderRepository`. */
export class UserRepository {
  toDTO(record: Record<string, any>) {
    const id = record.id as string;
    const name = record.name as string;
    const email = record.email as string;
    const createdAt = record.created_at as string;
    const updatedAt = record.updated_at as string;
    const role = record.role as string;
    const isActive = record.is_active as boolean;
    const avatarUrl = record.avatar_url as string;
    const timezone = record.timezone as string;
    if (!name || !email) {
      throw new Error('Malformed user record');
    }
    return {
      id, name, email, createdAt, updatedAt,
      role, isActive, avatarUrl, timezone,
    };
  }
}

/** Maps an order row — an exact copy of `UserRepository.toDTO`. */
export class OrderRepository {
  toDTO(record: Record<string, any>) {
    const id = record.id as string;
    const name = record.name as string;
    const email = record.email as string;
    const createdAt = record.created_at as string;
    const updatedAt = record.updated_at as string;
    const role = record.role as string;
    const isActive = record.is_active as boolean;
    const avatarUrl = record.avatar_url as string;
    const timezone = record.timezone as string;
    if (!name || !email) {
      throw new Error('Malformed user record');
    }
    return {
      id, name, email, createdAt, updatedAt,
      role, isActive, avatarUrl, timezone,
    };
  }
}

/** A shape-similar validator — the structural twin of `validateOrderItems`. */
export function validateUserFields(fields: string[]) {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (field.length === 0) {
      problems.push('a field is empty');
    } else if (field.length > 100) {
      problems.push('a field is too long');
    } else if (seen.has(field)) {
      problems.push('a field is duplicated');
    } else {
      seen.add(field);
    }
  }
  return problems;
}

/** Same skeleton as `validateUserFields`, different identifiers and literals. */
export function validateOrderItems(items: string[]) {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.length === 0) {
      problems.push('an item is empty');
    } else if (item.length > 100) {
      problems.push('an item is too long');
    } else if (seen.has(item)) {
      problems.push('an item is duplicated');
    } else {
      seen.add(item);
    }
  }
  return problems;
}
