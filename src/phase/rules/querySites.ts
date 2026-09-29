/**
 * Spec 69 R2 — the schema-code query-shape rule that is a pure reduction over
 * the `query-sites` fact: `too-many-queries`.
 *
 * The legacy `checkQueryPatterns` walked `adapter.extractFunctions`, resolved
 * each `FunctionInfo` back to its node, took the full node text, and counted
 * query call sites with `countQueries`. Because `extractFunctions` returns the
 * full set — nested closures included — a closure's sites were counted in the
 * closure and again in every function whose text encloses it. The `query-sites`
 * producer fixes that by extracting each site once and attributing it to its
 * innermost enclosing function; the rule re-homes only the *classification* half:
 * group sites by enclosing-function coordinate, count, apply the test-file skip
 * (`skipTestFiles`, Spec 55 R3), the `maxQueriesPerFunction` ceiling, and the
 * finding construction. A site outside any function (top-level) carries a null
 * coordinate and is never counted — matching the legacy walk, which only ever
 * examined functions.
 *
 * The rule never reaches a tree, adapter, or source string.
 */

import type { RuleDefinition, Finding, QuerySiteFact, ThresholdValues } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import { isTestOrSpecPath } from '../../languages/testConventions.js';

const META = RULE_REGISTRY['too-many-queries'];

/** The declaration for the one query-site-servable schema rule. */
type TooManyQueriesNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['query-sites'];
};

/** Stable key for a site's enclosing function: file + start coordinate. */
function functionKey(site: QuerySiteFact): string {
  return `${site.file}:${site.functionLine}:${site.functionColumn}`;
}

/** Display label for a site's enclosing function: name, else a coordinate. */
function functionLabel(site: QuerySiteFact): string {
  return site.functionName ?? `fn:${site.functionLine}:${site.functionColumn}`;
}

/** Re-homes `checkQueryPatterns` over the `query-sites` fact. */
function detectTooManyQueries(facts: readonly QuerySiteFact[], thresholds: ThresholdValues): Finding[] {
  // Spec 55 R3 — skip test files unless `skipTestFiles` is explicitly false.
  const skipTest = thresholds['skipTestFiles'] !== false;
  // Resolve the ceiling once — the message must never print "undefined". Falls
  // back to DEFAULT_SCHEMA_CONFIG.maxQueriesPerFunction (5) when unset.
  const maxQueries = typeof thresholds['maxQueriesPerFunction'] === 'number'
    ? thresholds['maxQueriesPerFunction']
    : 5;

  // Group query sites by enclosing-function identity. A site's count toward a
  // function is the number of sites whose enclosing function is that function —
  // a relation, which cannot double-count a nested closure by construction.
  const byFunction = new Map<string, { label: string; file: string; line: number; column: number; count: number }>();
  for (const site of facts) {
    if (site.functionLine === null || site.functionColumn === null) continue; // top-level: not a function
    if (skipTest && isTestOrSpecPath(site.file)) continue;
    const key = functionKey(site);
    let entry = byFunction.get(key);
    if (!entry) {
      entry = {
        label: functionLabel(site),
        file: site.file,
        line: site.functionLine,
        column: site.functionColumn,
        count: 0,
      };
      byFunction.set(key, entry);
    }
    entry.count++;
  }

  const findings: Finding[] = [];
  for (const entry of byFunction.values()) {
    if (entry.count <= maxQueries) continue;
    findings.push({
      ruleId: 'too-many-queries',
      severity: 'high',
      message: `Function '${entry.label}' has ${entry.count} queries, exceeding the maximum of ${maxQueries}`,
      file: entry.file,
      line: entry.line,
      column: entry.column,
      symbol: entry.label,
    });
  }
  return findings;
}

const tooManyQueries: RuleDefinition<TooManyQueriesNeeds> = {
  id: 'too-many-queries',
  analyzer: 'schema',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['query-sites'] },
  severity: 'high',
  message: META.message,
  docs: META.docs,
  thresholds: META.thresholds,
  samples: META.samples,
  analyze(ctx): Finding[] {
    return detectTooManyQueries(ctx.facts['query-sites'], ctx.thresholds);
  },
};

/** The one query-site-servable schema rule this slice migrates. */
export const querySiteRules: readonly RuleDefinition<TooManyQueriesNeeds>[] = [tooManyQueries];
