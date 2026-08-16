/**
 * Spec 36 R5 — threshold changes require a written rationale.
 *
 * The historical failure this guards: Spec 33's item 15 was closed by moving
 * `maxLinesPerMethod` 50→100 (and `maxParametersPerMethod` 4→6) while chasing a
 * zero, which silently dropped 660 of recall-protocol's `single-responsibility`
 * findings. A threshold change must be an explicit, justified decision — not a
 * side effect of making one file pass.
 *
 * This module enumerates every tunable threshold named by the rule registry
 * (`RuleRegistryEntry.thresholds`), compares the user's effective value against
 * the analyzer's runtime default (`RUNTIME_DEFAULT_CONFIGS`), and:
 *   - records the change (default → effective) for the run's threshold report;
 *   - errors when a change has no non-empty `rationales["<analyzer>.<key>"]`.
 *
 * Presets are deliberately out of scope: they are curated, shareable layers
 * (Spec 38 R4), not a project's committed decision. The caller checks the
 * user-facing `analyzerConfigs` layer *before* presets are applied.
 */

import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';
import { RUNTIME_DEFAULT_CONFIGS, flatten } from './effectiveConfig.js';

export interface ThresholdChange {
  /** Dot-notation key within the analyzer namespace, e.g. `solid.maxLinesPerMethod`. */
  key: string;
  /** The analyzer's runtime default. */
  defaultValue: unknown;
  /** The user's effective value (differs from default). */
  effectiveValue: unknown;
  /** Whether a non-empty rationale was provided. */
  hasRationale: boolean;
}

export interface ThresholdCheckResult {
  /** Config errors — one per changed threshold with no rationale. */
  errors: string[];
  /** Every threshold change detected, whether or not a rationale was provided. */
  changes: ThresholdChange[];
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare the user's `analyzerConfigs` layer against the analyzer defaults and
 * require a rationale for every threshold it changes.
 *
 * @param analyzerConfigs The user-facing config layer (project config file +
 *   inline options), BEFORE presets are applied.
 * @param rationales      Optional `rationales` map from the project config.
 */
export function checkThresholdRationales(
  analyzerConfigs: Record<string, unknown> | undefined,
  rationales: Record<string, string> | undefined,
): ThresholdCheckResult {
  const changes: ThresholdChange[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const entry of Object.values(RULE_REGISTRY)) {
    const analyzer = entry.analyzer;
    const defaults = RUNTIME_DEFAULT_CONFIGS[analyzer];
    if (!defaults) continue;

    const flatDefaults = flatten(defaults, analyzer);
    const flatEffective = flatten(
      (analyzerConfigs?.[analyzer] as Record<string, unknown>) ?? {},
      analyzer,
    );

    for (const threshold of entry.thresholds) {
      const fullKey = `${analyzer}.${threshold}`;
      if (seen.has(fullKey)) continue;
      seen.add(fullKey);

      const defaultValue = flatDefaults[fullKey];
      if (defaultValue === undefined) continue; // key not present in defaults — nothing to compare

      const effectiveValue = flatEffective[fullKey];
      if (effectiveValue === undefined) continue; // user did not set this key
      if (valuesEqual(effectiveValue, defaultValue)) continue; // unchanged

      const rationale = rationales?.[fullKey];
      const hasRationale = typeof rationale === 'string' && rationale.trim().length > 0;

      changes.push({ key: fullKey, defaultValue, effectiveValue, hasRationale });

      if (!hasRationale) {
        errors.push(
          `Threshold "${fullKey}" changed from default ${JSON.stringify(defaultValue)} to ${JSON.stringify(effectiveValue)} but no rationale is provided. Add "rationales": { "${fullKey}": "<why>" } to the project config (Spec 36 R5).`,
        );
      }
    }
  }

  return { errors, changes };
}
