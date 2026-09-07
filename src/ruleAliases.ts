/**
 * Spec 38 R5 — rule-ID alias map.
 *
 * Rule identity is baked into the baseline fingerprint
 * (`buildFingerprintInput`), so renaming or removing a rule silently
 * reshuffles "known" vs "new". This module is the migration path:
 *
 *   - A **rename** records the old ID → new ID, and `canonicalRuleId()`
 *     reverses it (new → old) so a baseline written before the rename still
 *     matches after it.
 *   - A **removal** records a *tombstone* — `to: null` with a reason — so a
 *     stale reference to the dead ID reports *why* it was removed instead of
 *     surfacing as an unexplained resolved/known finding.
 *
 * Already paid for here:
 *   - `naming-convention` → `table-naming-convention` (rename).
 *   - `direct-sql` and `unknown-column` were deleted outright (tombstones).
 * Each invalidated existing baselines with no migration path.
 */

export interface RuleAlias {
  /**
   * The current rule ID this old ID maps to, or `null` for a tombstone
   * (a genuine removal with no replacement).
   */
  to: string | null;
  /** Human-readable reason — required for tombstones, informative for renames. */
  reason: string;
}

/**
 * Retired rule IDs → their replacement or tombstone.
 *
 * This is the single source of truth for rule-identity migration. Adding an
 * alias (or a tombstone) is a required part of renaming or removing a rule —
 * the registry test fails on a prior-release rule ID absent from both
 * {@link RULE_REGISTRY} and this map.
 */
export const RULE_ALIASES: Record<string, RuleAlias> = {
  // Rename: naming-convention → table-naming-convention (schema analyzer).
  // Disambiguates the schema table-naming check from conventions/naming.
  'naming-convention': {
    to: 'table-naming-convention',
    reason:
      'Renamed to table-naming-convention to disambiguate the schema table-naming check from conventions/naming.',
  },
  // Tombstone: direct-sql — genuine removal, no replacement.
  'direct-sql': {
    to: null,
    reason:
      'Removed — superseded by sql-injection-risk (taint-aware) and unfiltered-query (raw SQL without a WHERE).',
  },
  // Tombstone: unknown-column — genuine removal, no replacement.
  'unknown-column': {
    to: null,
    reason:
      'Removed — column-level unknown detection never shipped; unknown-table (table-level) covers the same gap.',
  },
  // Rename: bare SOLID rule IDs → solid/-prefixed (task #5 — rule-ID normalization).
  // The analyzer and registry emitted 5 of 7 SOLID rules without the `solid/`
  // prefix that solid/class-size and solid/method-complexity already carried.
  'open-closed': {
    to: 'solid/open-closed',
    reason:
      'Prefixed with solid/ to match the namespace used by solid/class-size and solid/method-complexity.',
  },
  'single-responsibility': {
    to: 'solid/single-responsibility',
    reason:
      'Prefixed with solid/ to match the namespace used by solid/class-size and solid/method-complexity.',
  },
  // Rename: sql-injection → dynamic-sql-construction (Spec-49).
  // The old ID claimed "SQL injection" but the schema analyzer's regex only
  // detected dynamic SQL string construction at query()/execute() call sites
  // without establishing attacker-controlled taint. The honest name is the
  // vector it measures; taint-aware injection detection is sql-injection-risk.
  'sql-injection': {
    to: 'dynamic-sql-construction',
    reason:
      'Renamed to dynamic-sql-construction — the schema analyzer detects SQL string built via interpolation/concatenation (the injection vector), not the taint that "injection" asserts; taint-aware detection lives in sql-injection-risk.',
  },
  // Rename: interface-segregation → interface-size (Spec-49).
  // The old ID claimed to detect the Interface Segregation Principle ("clients
  // forced to depend on methods they do not use") from a raw member count.
  // Member count is a size reading, not a segregation reading; the honest ISP
  // computation (client-usage sets) needs the call graph. What remains is the
  // size signal under an honest name.
  'interface-segregation': {
    to: 'interface-size',
    reason:
      'Renamed to interface-size — a member count is a size reading, not an Interface Segregation reading (true ISP client-usage detection needs the call graph).',
  },
  'solid/interface-segregation': {
    to: 'interface-size',
    reason:
      'Renamed to interface-size — a member count is a size reading, not an Interface Segregation reading (true ISP client-usage detection needs the call graph).',
  },
  'liskov-substitution': {
    to: 'solid/liskov-substitution',
    reason:
      'Prefixed with solid/ to match the namespace used by solid/class-size and solid/method-complexity.',
  },
  'dependency-inversion': {
    to: 'solid/dependency-inversion',
    reason:
      'Prefixed with solid/ to match the namespace used by solid/class-size and solid/method-complexity.',
  },
  // Rename: cross-domain/transaction-boundary → cross-domain/multi-table-write (Spec-49).
  // The old ID asserted a transaction boundary the code never computes — it only
  // counts distinct write targets (schema_usage write rows), with no
  // BEGIN/COMMIT/savepoint/transaction-API detection. Writing to many tables is a
  // real signal; the honest name is the write fan-out it measures.
  'cross-domain/transaction-boundary': {
    to: 'cross-domain/multi-table-write',
    reason:
      'Renamed to cross-domain/multi-table-write — the detector counts distinct write targets, not a transaction boundary (no BEGIN/COMMIT/transaction-API parsing exists); "transaction boundary" was the overclaim.',
  },
};

/**
 * Canonicalize a rule ID for fingerprinting.
 *
 * Maps a **new** rule ID back to the **old** ID that a pre-rename baseline
 * recorded, so existing baselines survive a rename without reshuffling known
 * vs new. Returns the input unchanged when no reverse mapping exists (and for
 * old IDs that are already canonical).
 */
export function canonicalRuleId(rule: string): string {
  if (!rule) return rule;
  for (const [oldId, alias] of Object.entries(RULE_ALIASES)) {
    if (alias.to === rule) return oldId;
  }
  return rule;
}

/**
 * Resolve a rule ID's alias status.
 *
 * Returns `{ status: 'current' }` for a live ID, `{ status: 'renamed', to, reason }`
 * for a renamed ID, `{ status: 'removed', reason }` for a tombstone, and
 * `{ status: 'unknown' }` otherwise. Consumed by `rules-check` and
 * `print-config` so a human or agent querying a retired ID sees the reason.
 */
export function describeRuleId(rule: string):
  | { status: 'current' }
  | { status: 'renamed'; to: string; reason: string }
  | { status: 'removed'; reason: string }
  | { status: 'unknown' } {
  const alias = RULE_ALIASES[rule];
  if (!alias) return { status: 'unknown' };
  if (alias.to === null) return { status: 'removed', reason: alias.reason };
  return { status: 'renamed', to: alias.to, reason: alias.reason };
}
