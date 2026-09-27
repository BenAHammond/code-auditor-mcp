/**
 * Spec 68 §11.1 — the both-paths route split.
 *
 * During migration the tool runs BOTH analysis paths side by side: the legacy
 * pipeline analyzers and the new phase model (Parse → Process → Analyze). Every
 * rule is served by exactly one path. The split is *derived*, never written:
 * `migrated` is the id set of `MIGRATED_RULES` (the rules whose `analyze(ctx)`
 * is live and whose declared facts have producers), and `legacy` is every other
 * registry rule. The two sets are disjoint by construction and their union is
 * the whole registry — the conformance tests in spec68-routing.spec.ts pin
 * exactly that, so a rule can no more be silently dropped from one path than it
 * can be served by both.
 */

import { MIGRATED_RULES } from './rules/registry.js';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';

/** The two routes a rule can take during the migration. */
export type Route = 'phase' | 'legacy';

/** The derived split: which rule ids ride which path. */
export interface RouteSplit {
  readonly migrated: ReadonlySet<string>;
  readonly legacy: ReadonlySet<string>;
}

/** Derive `{ migrated, legacy }` from MIGRATED_RULES against RULE_REGISTRY. */
export function splitRoutes(): RouteSplit {
  const migrated = new Set(MIGRATED_RULES.map((r) => r.id));
  const legacy = new Set(
    Object.keys(RULE_REGISTRY).filter((id) => !migrated.has(id)),
  );
  return { migrated, legacy };
}

/** The route a rule id takes — `'phase'` if migrated, `'legacy'` if registry-only,
 *  `undefined` if it is not a registry rule at all. */
export function routeFor(ruleId: string): Route | undefined {
  if (MIGRATED_RULES.some((r) => r.id === ruleId)) return 'phase';
  if (Object.prototype.hasOwnProperty.call(RULE_REGISTRY, ruleId)) return 'legacy';
  return undefined;
}

/** Full attribution: every registry rule mapped to its route. */
export function attributeRoutes(): ReadonlyMap<string, Route> {
  const { migrated, legacy } = splitRoutes();
  const map = new Map<string, Route>();
  for (const id of migrated) map.set(id, 'phase');
  for (const id of legacy) map.set(id, 'legacy');
  return map;
}

/**
 * The migrated rule ids the phase model runs. Spec 68 §15 deletes the analyzer
 * *selection* model — there is no `enabledAnalyzers`, so the phase path always
 * runs every migrated rule. `analyzer` now lives on `RuleDefinition` (not the
 * registry entry) and is only a re-emission bucket label; it no longer gates
 * which rules run.
 */
export function enabledMigratedRules(): ReadonlySet<string> {
  return new Set(MIGRATED_RULES.map((r) => r.id));
}
