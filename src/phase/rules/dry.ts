/**
 * Spec 68 §3.2 — the two string/import-servable DRY rules, migrated to
 * `analyze(ctx)`.
 *
 * `duplicate-import` re-homes `UniversalDRYAnalyzer.checkDuplicateImports`:
 * group the `imports` fact by `(file, source)` and flag any source imported more
 * than once within a single file, anchored at the first import's location. The
 * legacy detector ran per AST, so the `(file, …)` grouping is load-bearing — two
 * files importing the same module once are not duplicates. The message and the
 * first-import anchoring are verbatim from `checkDuplicateImports`; `symbol`
 * carries the module source exactly as the legacy `createViolation` set
 * `functionName` to it.
 *
 * `duplicate-string-literal` re-homes `checkDuplicateStrings`: group the
 * `string-literals` fact by `(file, value)` and flag any raw string text that
 * appears more than twice within a single file, anchored at the first
 * occurrence. The same per-file grouping holds here (the legacy detector ran
 * per AST), and `value` is the raw `getNodeText` (quotes included) so a
 * `'…'` and `"…"` literal are distinct values — the same key the legacy code
 * compared.
 *
 * The other four DRY rules (`dry/duplicate`, `dry/structural-similarity`,
 * `dry/similar-expression`, `dry/diverging-clone`) read code blocks / shape
 * fragments the `imports` and `string-literals` facts cannot serve, so they
 * stay on the legacy path.
 */

import type { RuleDefinition, Finding, ImportFact, StringLiteralFact } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

const META = RULE_REGISTRY['duplicate-import'];
const STRING_META = RULE_REGISTRY['duplicate-string-literal'];

/** The shared declaration for the one import-servable DRY rule. */
type DryNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['imports'];
};

/** The declaration for the string-literal-servable DRY rule. */
type StringLiteralNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['string-literals'];
};

/** Re-homes `checkDuplicateImports`, grouping per file. */
function detectDuplicateImport(facts: readonly ImportFact[]): Finding[] {
  const byFile = new Map<string, Map<string, { line: number; column: number }[]>>();
  for (const imp of facts) {
    let fileMap = byFile.get(imp.file);
    if (!fileMap) {
      fileMap = new Map();
      byFile.set(imp.file, fileMap);
    }
    const locs = fileMap.get(imp.source) ?? [];
    locs.push({ line: imp.line, column: imp.column });
    fileMap.set(imp.source, locs);
  }

  const findings: Finding[] = [];
  for (const [file, fileMap] of byFile) {
    for (const [source, locs] of fileMap) {
      if (locs.length <= 1) continue;
      findings.push({
        ruleId: 'duplicate-import',
        severity: 'high',
        message: `Module "${source}" is imported ${locs.length} times`,
        file,
        line: locs[0].line,
        column: locs[0].column,
        symbol: source,
      });
    }
  }
  return findings;
}

/** Re-homes `checkDuplicateStrings`, grouping per `(file, value)`. */
function detectDuplicateStringLiteral(facts: readonly StringLiteralFact[]): Finding[] {
  const byFile = new Map<string, Map<string, { line: number; column: number }[]>>();
  for (const lit of facts) {
    if (lit.value.length <= 10) continue; // non-trivial strings only
    let fileMap = byFile.get(lit.file);
    if (!fileMap) {
      fileMap = new Map();
      byFile.set(lit.file, fileMap);
    }
    const locs = fileMap.get(lit.value) ?? [];
    locs.push({ line: lit.line, column: lit.column });
    fileMap.set(lit.value, locs);
  }

  const findings: Finding[] = [];
  for (const [file, fileMap] of byFile) {
    for (const [value, locs] of fileMap) {
      if (locs.length <= 2) continue; // more than 2 occurrences
      findings.push({
        ruleId: 'duplicate-string-literal',
        severity: 'high',
        message: `String literal "${value.substring(0, 30)}..." is duplicated ${locs.length} times`,
        file,
        line: locs[0].line,
        column: locs[0].column,
        symbol: value.substring(0, 50),
        fix: { oldText: value, newText: '// Consider extracting to a constant' },
      });
    }
  }
  return findings;
}

const duplicateImport: RuleDefinition<DryNeeds> = {
  id: 'duplicate-import',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['imports'] },
  severity: 'high',
  message: META.message,
  docs: META.docs,
  thresholds: META.thresholds,
  samples: META.samples,
  analyze(ctx): Finding[] {
    return detectDuplicateImport(ctx.facts['imports']);
  },
};

const duplicateStringLiteral: RuleDefinition<StringLiteralNeeds> = {
  id: 'duplicate-string-literal',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['string-literals'] },
  severity: 'high',
  message: STRING_META.message,
  docs: STRING_META.docs,
  thresholds: STRING_META.thresholds,
  samples: STRING_META.samples,
  analyze(ctx): Finding[] {
    return detectDuplicateStringLiteral(ctx.facts['string-literals']);
  },
};

/** The string/import-servable DRY rules, in registry order. */
export const dryRules: readonly RuleDefinition<DryNeeds | StringLiteralNeeds>[] = [
  duplicateImport,
  duplicateStringLiteral,
];
