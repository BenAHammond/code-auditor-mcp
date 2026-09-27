/**
 * Spec 68 §11.1 — threshold resolution for the both-paths phase model.
 *
 * The migrated rules read *flat* threshold keys with documented fallbacks
 * (solid's `maxMethodComplexity`, data-access's `joinedTableCount`, …). The
 * legacy analyzers read the same values through their own namespace config,
 * default-merged inside `analyzeAST` / `analyzeWithFacts`. To serve a migrated
 * rule with the *identical* effective value its legacy path would have used,
 * resolve its thresholds from the same two inputs the analyzer merges — the
 * runtime default (`RUNTIME_DEFAULT_CONFIGS`) under the user's
 * `analyzerConfigs` — then flatten the one nested key the rules read flat
 * (`performanceThresholds.joinedTableCount` → `joinedTableCount`).
 *
 * This is the minimal §10 bridge for the transitional state. §10 proper replaces
 * the dot-path vocabulary and the per-analyzer namespace with the rule/threshold
 * surface; until then the bridge keeps the two paths bit-identical so the parity
 * pins and the production count hold.
 */

import { MIGRATED_RULES } from './rules/registry.js';
import { RUNTIME_DEFAULT_CONFIGS } from '../config/effectiveConfig.js';
import type { ThresholdValues } from './types.js';

/**
 * Resolve the per-rule threshold map for every migrated rule from the
 * pipeline's per-analyzer config (user overrides only — defaults come from
 * {@link RUNTIME_DEFAULT_CONFIGS}, matching the legacy analyzers' internal merge).
 */
export function resolvePhaseThresholds(
  analyzerConfigs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): ReadonlyMap<string, ThresholdValues> {
  const out = new Map<string, ThresholdValues>();

  for (const rule of MIGRATED_RULES) {
    const namespace = rule.analyzer === 'data-access-org-filter' ? 'data-access' : rule.analyzer;
    const defaults = (RUNTIME_DEFAULT_CONFIGS[namespace] ?? {}) as Record<string, unknown>;
    const user = (analyzerConfigs[namespace] ?? {}) as Record<string, unknown>;
    const merged = { ...defaults, ...user };
    out.set(rule.id, flattenForNamespace(namespace, merged));
  }

  return out;
}

/**
 * Project the analyzer's (default-merged) config onto the flat keys the migrated
 * rules read. Only `data-access` carries a nested knob the rules read flat today.
 */
function flattenForNamespace(namespace: string, config: Record<string, unknown>): ThresholdValues {
  if (namespace === 'data-access') {
    const perf = (config.performanceThresholds ?? {}) as Record<string, unknown>;
    return {
      ...config,
      joinedTableCount: typeof perf.joinedTableCount === 'number' ? perf.joinedTableCount : 4,
    };
  }
  return config as ThresholdValues;
}
