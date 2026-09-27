/**
 * Spec 68 §2.3 residue check #2 — the fact kinds that are actually *read*.
 *
 * A fact kind is "consumed" when at least one migrated rule declares it in
 * `needs.facts`, or at least one corpus processor declares it in `needs`
 * (upstream facts). `ConsumedFactKind` is derived from those two real sources —
 * never a hand-written list — so a produced kind that nothing reads fails the
 * `_allConsumed` assertion in checks.ts rather than being found by hand a week
 * later (the Spec 63 class: `crossLanguageViolations`, `importersOf`,
 * `getContentHashesForFiles` were all computed and never read).
 *
 * The rule arm reads `MIGRATED_RULES` — whose element type is the *union* of
 * each rule's `RuleDefinition<N>` (not `RuleDefinition<any>`), because the
 * array is declared without an `any` annotation. `N` carries the literal tuple
 * type of `needs.facts`, so the distributive conditional below recovers each
 * declared fact kind. Widening `MIGRATED_RULES` back to `RuleDefinition<any>[]`
 * would make `RuleConsumedFactKind` infer `any` and the check vacuous — the
 * same trap the legacy `RULE_REGISTRY` `Record` view posed, which is why this
 * check reads the literal view, never an indexable one.
 */

import type { MIGRATED_RULES } from './rules/registry.js';
import { CORPUS_PRODUCERS } from './producers.js';

/**
 * Fact kinds declared by the migrated rules' `needs.facts`.
 *
 * `(typeof MIGRATED_RULES)[number]` is a union of `RuleDefinition<N>` over the
 * concrete `Needs` aliases; `infer F` distributes over that union, and `F` is
 * each rule's `needs.facts` element type. A rule whose `facts` was widened to
 * `FactKind[]` would contribute the whole vocabulary and mask a real residue —
 * the conformance test (spec68-consumed-coverage.spec.ts, deleted once this
 * check became compile-time) pinned the runtime set for exactly that reason.
 */
type RuleConsumedFactKind = (typeof MIGRATED_RULES)[number] extends {
  needs: { facts: readonly (infer F)[] };
}
  ? F
  : never;

/** Fact kinds a corpus processor consumes as upstream `needs`. */
type ProcessorConsumedFactKind = {
  [K in keyof typeof CORPUS_PRODUCERS]: (typeof CORPUS_PRODUCERS)[K] extends { needs: readonly (infer N)[] }
    ? N
    : never;
}[keyof typeof CORPUS_PRODUCERS];

/** Every fact kind read by at least one migrated rule or corpus processor. */
export type ConsumedFactKind = RuleConsumedFactKind | ProcessorConsumedFactKind;
