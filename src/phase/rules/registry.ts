/**
 * Spec 68 §2.1 — the migrated-rules registry.
 *
 * A rule enters this array only when it satisfies all four migration
 * conditions: it is a `RuleDefinition` with `analyze(ctx)`; every fact it
 * declares has a live producer; the old analyzer path for it is deleted; and a
 * parity test pins its findings against the pre-migration output on a fixture.
 * Partial states are zero — a rule with `analyze(ctx)` written but its old path
 * still live, or with no parity test, is not listed here.
 *
 * The single failing assertion that drives the migration is the size of this
 * array against 100 (spec68-registry-size.spec.ts): it reads 0 today and goes
 * green at 100. A rule is added here in the same edit that deletes its old path
 * and pins its parity test — never before, and never as a placeholder.
 */

import type { RuleDefinition } from '../types.js';
import { solidRules } from './solid.js';
import { dataAccessRules } from './dataAccess.js';

/**
 * The 12 already-pinned rules that are parity-clean on the *full* pipeline
 * (Spec 68 §11.2): 9 SOLID + 3 data-access. Each has `analyze(ctx)`, live
 * producers for every declared fact, and a green parity test pinned on
 * `(file, line, column, rule, severity)`, and flipping it changes nothing a
 * full-pipeline audit reports (composite-fixtures pins the complete set by
 * equality, so a rule whose phase output diverges anywhere stays off this list).
 *
 * The 2 schema rules (`unknown-table`, `table-naming-convention`) are *not*
 * listed yet, despite having `analyze(ctx)` + a green tagged-template parity
 * test. Their full-pipeline parity is incomplete: the legacy schema analyzer
 * reads table references from `db.query("SELECT …")` string arguments with a
 * provenance context the provenance-free `schema-usage` producer does not have,
 * and derives the known-table catalog from `.sql` migration files the phase
 * model never parses (no adapter). Flipping them would silently drop findings
 * (composite-fixtures schema/schema-stale go red), so they stay on the legacy
 * path until the `.sql` DDL source and string-argument extraction land (§5/§9).
 *
 * The remaining 88 land one fact kind at a time (§11.3), and the size drives
 * spec68-registry-size.spec.ts (0 → … → 100).
 */
export const MIGRATED_RULES: readonly RuleDefinition<any>[] = [
  ...solidRules,
  ...dataAccessRules,
];
