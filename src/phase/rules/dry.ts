/**
 * Spec 68 §3.2 — the one import-servable DRY rule, migrated to `analyze(ctx)`.
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
 * The other five DRY rules (`dry/*` and `duplicate-string-literal`) read code
 * blocks and string literals the `imports` fact cannot serve, so they stay on
 * the legacy path.
 */

import type { RuleDefinition, Finding, ImportFact } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

const META = RULE_REGISTRY['duplicate-import'];

/** The shared declaration for the one import-servable DRY rule. */
type DryNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['imports'];
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

/** The one import-servable DRY rule, in registry order. */
export const dryRules: readonly RuleDefinition<DryNeeds>[] = [duplicateImport];
