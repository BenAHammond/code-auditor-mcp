/**
 * Spec 68 §3.2 — the hardcoded-credential rules, migrated to `analyze(ctx)`.
 *
 * `hardcoded-connection` re-homes `UniversalDataAccessAnalyzer.checkGeneralPatterns`
 * (the one detector that walks raw string literals): flag any string whose text
 * matches a connection-string shape. It reads the `string-literals` fact, whose
 * producer already pre-computed the `enclosingFunction` label the legacy
 * `enclosingIdentity` returned, so the symbol (`<fn>:hardcoded-connection[:n]`)
 * is byte-identical to the pre-migration output. The message is the full legacy
 * literal, not the registry's shortened template.
 *
 * `hardcoded-secret` (UniversalSecretsAnalyzer) lives in `secrets.ts`: it
 * anchors at the enclosing `variable_declarator` / `assignment_expression` /
 * `pair` / `call_expression`, not at the string node, so it reads the
 * `secret-candidates` fact carrying that positional context.
 *
 * The other three security rules (`command-injection-risk`,
 * `dynamic-require-of-project-path`, `unescaped-html-interpolation`) read
 * call-site / expression context, another later fact kind.
 */

import type { RuleDefinition, Finding, StringLiteralFact } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

const META = RULE_REGISTRY['hardcoded-connection'];

/** The shared declaration for the hardcoded-credential rules in this slice. */
type SecurityNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['string-literals'];
};

/** Re-homes `isConnectionString` from UniversalDataAccessAnalyzer. */
function isConnectionString(text: string): boolean {
  const patterns = [
    /mongodb:\/\//i,
    /postgres:\/\//i,
    /mysql:\/\//i,
    /Server=.*;Database=/i,
    /Data Source=.*;Initial Catalog=/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/** Re-homes `checkGeneralPatterns`: flag connection-string literals, keying the
 *  symbol ordinal on `<fn>:hardcoded-connection` per file (the legacy detector
 *  ran once per AST, so two files sharing a function name do not collide). */
function detectHardcodedConnection(facts: readonly StringLiteralFact[]): Finding[] {
  const byFile = new Map<string, StringLiteralFact[]>();
  for (const lit of facts) {
    if (!isConnectionString(lit.value)) continue;
    const arr = byFile.get(lit.file) ?? [];
    arr.push(lit);
    byFile.set(lit.file, arr);
  }

  const findings: Finding[] = [];
  for (const lits of byFile.values()) {
    const ordinals = new Map<string, number>();
    for (const lit of lits) {
      const baseSym = `${lit.enclosingFunction}:hardcoded-connection`;
      const count = (ordinals.get(baseSym) ?? 0) + 1;
      ordinals.set(baseSym, count);
      const sym = count > 1 ? `${baseSym}:${count}` : baseSym;

      findings.push({
        ruleId: 'hardcoded-connection',
        severity: 'critical',
        message:
          'Hardcoded database connection string detected. Use environment variables. ' +
          '(On Cloudflare Workers/D1, connection strings are injected via bindings.)',
        file: lit.file,
        line: lit.line,
        column: lit.column,
        symbol: sym,
      });
    }
  }
  return findings;
}

const hardcodedConnection: RuleDefinition<SecurityNeeds> = {
  id: 'hardcoded-connection',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['string-literals'] },
  severity: 'critical',
  message: META.message,
  docs: META.docs,
  thresholds: META.thresholds,
  samples: META.samples,
  analyze(ctx): Finding[] {
    return detectHardcodedConnection(ctx.facts['string-literals']);
  },
};

/** The hardcoded-credential rules this slice migrates, in registry order. */
export const securityRules: readonly RuleDefinition<SecurityNeeds>[] = [
  hardcodedConnection,
];
