/**
 * Spec 68 §3.2 — the react slice, migrated to `analyze(ctx)`.
 *
 * The legacy react visitor did two things: per-file, it called
 * `scanFile` (read off disk + re-parse) and ran `analyzeComponent` over every
 * scanned component; cross-file, its `finalizeCrossComponent` ran
 * `checkCircularDependencies` / `checkErrorBoundaryUsage` / `checkRawElements`
 * over the accumulated scan results. Both halves are re-homed here over the
 * `react-component` fact, whose producer (`scanParsedFile`) already resolved the
 * projection half — the tree-sitter walk that builds the component universe —
 * and lets the tree die with the file.
 *
 * The rules re-cast the fact back to `ComponentScanResult` (structurally
 * identical) and run the existing detectors, so the classification half is
 * bit-identical to the legacy path. `extractHooks` is pinned true in the
 * producer; the legacy visitor tied it to `checkHooksRules`, but `hooks-naming`
 * gates on that flag itself, so the extraction choice has no effect on findings.
 *
 * `complexity` aggregates both of the legacy emitters that share the rule ID:
 * the per-component `checkComponentComplexity` (inside `analyzeComponent`) and
 * the cross-component `checkCircularDependencies`. `performance` likewise
 * aggregates every `analyzeComponent` finding whose `rule` is `performance`
 * (memoization, inline-`onClick`, and missing-list-keys all share it).
 *
 * `message` / `docs` / `thresholds` / `samples` are the same text the rule
 * registry carries (ruleRegistry.ts), pulled by reference. `severity` and
 * `analyze` are new here; the registry never carried `severity`.
 */

import type { RuleDefinition, Finding, ReactComponentScan, ThresholdValues } from '../types.js';
import type { ReactViolation, ReactAnalyzerConfig, ComponentScanResult } from '../../types.js';
import {
  analyzeComponent,
  checkCircularDependencies,
  checkErrorBoundaryUsage,
  checkRawElements,
  DEFAULT_REACT_CONFIG,
} from '../../analyzers/reactAnalyzer.js';
import { buildComponentTree } from '../../componentScanner.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

/** The shared declaration for every react rule in this slice. */
type ReactNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['react-component'];
};

const META = RULE_REGISTRY;

/** Merge the runtime react defaults under the resolved threshold keys — the same
 *  `{ ...DEFAULT_REACT_CONFIG, ...config }` the legacy visitor did, so a partial
 *  config still yields every required field. */
function reactConfig(t: ThresholdValues): ReactAnalyzerConfig {
  return { ...DEFAULT_REACT_CONFIG, ...(t as Partial<ReactAnalyzerConfig>) };
}

/** Re-cast the fact back to the legacy scan-result shape the detectors read. */
function scans(facts: readonly ReactComponentScan[]): ComponentScanResult[] {
  return facts as unknown as ComponentScanResult[];
}

/** One finding, in the unified shape §7 converges on. */
function toFinding(v: ReactViolation): Finding {
  return {
    ruleId: v.rule,
    severity: v.severity,
    message: v.message,
    file: v.file,
    line: v.line,
    column: v.column,
    ...(v.componentName ? { symbol: v.componentName } : {}),
    ...(v.resolution ? { resolution: v.resolution } : {}),
  };
}

/** The per-component half of the legacy visitor: `analyzeComponent` over every
 *  component in every scan. `analyzeComponent` applies the config gates itself
 *  (`checkHooksRules`, `requirePropTypes`, `checkUnnecessaryRerenders`,
 *  `checkAccessibility`, `requireKeyProps`), so a rule that filters this output
 *  to its own `rule` inherits the gate exactly. */
function perComponent(all: ComponentScanResult[], cfg: ReactAnalyzerConfig): ReactViolation[] {
  const out: ReactViolation[] = [];
  for (const sr of all) {
    for (const comp of sr.components ?? []) {
      out.push(...analyzeComponent(comp, cfg, sr));
    }
  }
  return out;
}

// ── complexity (per-component complexity + cross-component cycles) ───────────

const complexity: RuleDefinition<ReactNeeds> = {
  id: 'complexity',
  analyzer: 'react',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['react-component'] },
  severity: 'high',
  message: META['complexity'].message,
  docs: META['complexity'].docs,
  thresholds: META['complexity'].thresholds,
  thresholdRationale: META['complexity'].thresholdRationale,
  samples: META['complexity'].samples,
  analyze(ctx): Finding[] {
    const all = scans(ctx.facts['react-component']);
    const cfg = reactConfig(ctx.thresholds);
    const findings = perComponent(all, cfg)
      .filter((v) => v.rule === 'complexity')
      .map(toFinding);
    // The cross-component arm runs unconditionally in the legacy finalizer.
    findings.push(...checkCircularDependencies(buildComponentTree(all)).map(toFinding));
    return findings;
  },
};

// ── missing-props ────────────────────────────────────────────────────────────

const missingProps: RuleDefinition<ReactNeeds> = {
  id: 'missing-props',
  analyzer: 'react',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['react-component'] },
  severity: 'high',
  message: META['missing-props'].message,
  docs: META['missing-props'].docs,
  thresholds: META['missing-props'].thresholds,
  samples: META['missing-props'].samples,
  analyze(ctx): Finding[] {
    return perComponent(scans(ctx.facts['react-component']), reactConfig(ctx.thresholds))
      .filter((v) => v.rule === 'missing-props')
      .map(toFinding);
  },
};

// ── hooks-naming ─────────────────────────────────────────────────────────────

const hooksNaming: RuleDefinition<ReactNeeds> = {
  id: 'hooks-naming',
  analyzer: 'react',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['react-component'] },
  severity: 'high',
  message: META['hooks-naming'].message,
  docs: META['hooks-naming'].docs,
  thresholds: META['hooks-naming'].thresholds,
  samples: META['hooks-naming'].samples,
  analyze(ctx): Finding[] {
    return perComponent(scans(ctx.facts['react-component']), reactConfig(ctx.thresholds))
      .filter((v) => v.rule === 'hooks-naming')
      .map(toFinding);
  },
};

// ── no-error-boundary (app-level, gated by requireErrorBoundaries) ───────────

const noErrorBoundary: RuleDefinition<ReactNeeds> = {
  id: 'no-error-boundary',
  analyzer: 'react',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['react-component'] },
  severity: 'severe',
  message: META['no-error-boundary'].message,
  docs: META['no-error-boundary'].docs,
  thresholds: META['no-error-boundary'].thresholds,
  samples: META['no-error-boundary'].samples,
  analyze(ctx): Finding[] {
    const cfg = reactConfig(ctx.thresholds);
    // The legacy finalizer gated this on `requireErrorBoundaries !== false`.
    if (cfg.requireErrorBoundaries === false) return [];
    return checkErrorBoundaryUsage(scans(ctx.facts['react-component'])).map(toFinding);
  },
};

// ── performance (memoization + inline handlers + missing keys) ───────────────

const performance: RuleDefinition<ReactNeeds> = {
  id: 'performance',
  analyzer: 'react',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['react-component'] },
  severity: 'high',
  message: META['performance'].message,
  docs: META['performance'].docs,
  thresholds: META['performance'].thresholds,
  samples: META['performance'].samples,
  analyze(ctx): Finding[] {
    return perComponent(scans(ctx.facts['react-component']), reactConfig(ctx.thresholds))
      .filter((v) => v.rule === 'performance')
      .map(toFinding);
  },
};

// ── accessibility ────────────────────────────────────────────────────────────

const accessibility: RuleDefinition<ReactNeeds> = {
  id: 'accessibility',
  analyzer: 'react',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['react-component'] },
  severity: 'severe',
  message: META['accessibility'].message,
  docs: META['accessibility'].docs,
  thresholds: META['accessibility'].thresholds,
  samples: META['accessibility'].samples,
  analyze(ctx): Finding[] {
    return perComponent(scans(ctx.facts['react-component']), reactConfig(ctx.thresholds))
      .filter((v) => v.rule === 'accessibility')
      .map(toFinding);
  },
};

// ── raw-element (gated by rawElementCheck) ───────────────────────────────────

const rawElement: RuleDefinition<ReactNeeds> = {
  id: 'raw-element',
  analyzer: 'react',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['react-component'] },
  severity: 'high',
  message: META['raw-element'].message,
  docs: META['raw-element'].docs,
  thresholds: META['raw-element'].thresholds,
  samples: META['raw-element'].samples,
  analyze(ctx): Finding[] {
    const cfg = reactConfig(ctx.thresholds);
    // The legacy finalizer gated this on `rawElementCheck !== false`.
    if (cfg.rawElementCheck === false) return [];
    return checkRawElements(scans(ctx.facts['react-component']), cfg).map(toFinding);
  },
};

/** The seven react rules, in registry order. */
export const reactRules: readonly RuleDefinition<ReactNeeds>[] = [
  hooksNaming,
  complexity,
  missingProps,
  noErrorBoundary,
  performance,
  accessibility,
  rawElement,
];
