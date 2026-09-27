/**
 * Spec 68 §3.2 — the schema-code query-shape rule that is a pure reduction over
 * the `function-bodies` fact: `too-many-queries`.
 *
 * The legacy `checkQueryPatterns` walked `adapter.extractFunctions`, resolved
 * each `FunctionInfo` back to its node, took the full node text, and counted
 * query call sites with `countQueries`. That is exactly the projection the
 * `function-bodies` producer computes, so the rule re-homes only the
 * classification half: the `validateQueryPatterns` gate, the test-file skip
 * (`skipTestFiles`, Spec 55 R3), the `maxQueriesPerFunction` ceiling, and the
 * finding construction.
 *
 * `countQueries` is imported from `codeAnalysis.ts` — the Spec-34 helper module
 * that, like `orgFilterTiers.ts` and `isSystemTable`, survives §15 because it
 * imports no analyzer class and no pipeline. The rule never reaches a tree,
 * adapter, or source string.
 *
 * The other two function-body schema rules stay on the legacy path: `loop-query`
 * (data-access) discriminates loop structure and eager-vs-constructor call
 * chains, and `dynamic-sql-construction` runs a taint analysis over call sites —
 * neither reduces to a text count, so their detectors stay in the analyzers
 * until their own fact kinds land.
 */

import type { RuleDefinition, Finding, FunctionBodyFact, ThresholdValues } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import { countQueries } from '../../analyzers/universal/schema/codeAnalysis.js';
import { isTestOrSpecPath } from '../../languages/testConventions.js';

const META = RULE_REGISTRY['too-many-queries'];

/** The declaration for the one function-body-servable schema rule. */
type TooManyQueriesNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['function-bodies'];
};

/** Re-homes `checkQueryPatterns` over the `function-bodies` fact. */
function detectTooManyQueries(facts: readonly FunctionBodyFact[], thresholds: ThresholdValues): Finding[] {
  // Spec 55 R3 — skip test files unless `skipTestFiles` is explicitly false.
  const skipTest = thresholds['skipTestFiles'] !== false;
  // Resolve the ceiling once — the message must never print "undefined". Falls
  // back to DEFAULT_SCHEMA_CONFIG.maxQueriesPerFunction (5) when unset.
  const maxQueries = typeof thresholds['maxQueriesPerFunction'] === 'number'
    ? thresholds['maxQueriesPerFunction']
    : 5;

  const findings: Finding[] = [];
  for (const fn of facts) {
    if (skipTest && isTestOrSpecPath(fn.file)) continue;
    const queryCount = countQueries(fn.text);
    if (queryCount <= maxQueries) continue;

    findings.push({
      ruleId: 'too-many-queries',
      severity: 'high',
      message: `Function '${fn.name}' has ${queryCount} queries, exceeding the maximum of ${maxQueries}`,
      file: fn.file,
      line: fn.line,
      column: fn.column,
      symbol: fn.name,
    });
  }
  return findings;
}

const tooManyQueries: RuleDefinition<TooManyQueriesNeeds> = {
  id: 'too-many-queries',
  analyzer: 'schema',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['function-bodies'] },
  severity: 'high',
  message: META.message,
  docs: META.docs,
  thresholds: META.thresholds,
  samples: META.samples,
  analyze(ctx): Finding[] {
    return detectTooManyQueries(ctx.facts['function-bodies'], ctx.thresholds);
  },
};

/** The one function-body-servable schema rule this slice migrates. */
export const functionBodyRules: readonly RuleDefinition<TooManyQueriesNeeds>[] = [tooManyQueries];
