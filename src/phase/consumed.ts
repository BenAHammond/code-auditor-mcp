/**
 * Spec 68 §2.3 residue check #2 — the fact kinds that are actually *read*.
 *
 * A fact kind is "consumed" when at least one rule declares it in `needs.facts`,
 * or at least one corpus processor declares it in `needs` (upstream facts).
 * `ConsumedFactKind` is derived from those two real sources — never a
 * hand-written list — so a produced kind that nothing reads fails the
 * `_allConsumed` assertion in checks.ts rather than being found by hand a week
 * later (the Spec 63 class: `crossLanguageViolations`, `importersOf`,
 * `getContentHashesForFiles` were all computed and never read).
 */

import type { RegistryLiteral } from '../analyzers/ruleRegistry.js';
import { PRODUCERS } from './producers.js';

/**
 * Fact kinds declared by the rule registry's `needs.facts`.
 *
 * Derived from `RegistryLiteral` — the `satisfies`-typed registry whose
 * `needs.facts` arrays keep their literal tuple types — NOT from `RULE_REGISTRY`
 * (the `Record<string, RuleRegistryEntry>` view), which widens every entry to
 * `FactKind[]` and would make residue check #2 vacuous. One object, two type
 * views: the indexable view for consumers, the literal view for this check.
 */
type RuleConsumedFactKind = {
  [K in keyof RegistryLiteral]: RegistryLiteral[K] extends {
    needs: { facts: readonly (infer F)[] };
  }
    ? F
    : never;
}[keyof RegistryLiteral];

/** Fact kinds a corpus processor consumes as upstream `needs`. */
type ProcessorConsumedFactKind = {
  [K in keyof typeof PRODUCERS]: (typeof PRODUCERS)[K] extends { needs: readonly (infer N)[] }
    ? N
    : never;
}[keyof typeof PRODUCERS];

/** Every fact kind read by at least one rule or corpus processor. */
export type ConsumedFactKind = RuleConsumedFactKind | ProcessorConsumedFactKind;
