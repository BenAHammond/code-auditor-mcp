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

import type { Needs, RuleDefinition } from '../types.js';

export const MIGRATED_RULES: readonly RuleDefinition<Needs>[] = [];
