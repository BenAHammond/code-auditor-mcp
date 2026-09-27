/**
 * Spec 68 §8 — the `unreferenced-module` rule, migrated to `analyze(ctx)`.
 *
 * The ninth dependency-graph rule, and the first to read the §8 file-level
 * facts. The legacy emission lived inside `createDependencyGraphReducer`'s
 * file-reachability block: a file that exports symbols yet is imported by
 * nothing and is not a framework/package entry point is a dead module. This
 * rule re-homes that exact filter over two facts:
 *
 *   - `file-imports` — the per-file `hasExports` (and its file path, so the
 *     test/entry filename heuristics run here);
 *   - `reachability` — the reverse import adjacency and the package.json
 *     entry-point set, both reduced by the corpus processor.
 *
 * The filename heuristics (`isTestFile`, `isEntryPointFile`) are the rule's own
 * re-homed pure functions; the classification "exported + no importers + not an
 * entry point" is the rule's, matching the legacy filter order exactly.
 */

import type { RuleDefinition, Finding, FileImportsFact, ReachabilityFact } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import { isTestFile, isEntryPointFile } from '../reachability.js';

type UnreferencedModuleNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript', 'go'];
  readonly facts: readonly ['file-imports', 'reachability'];
};

const META = RULE_REGISTRY['unreferenced-module'];

/** The legacy finding's exact anchor and message, re-homed verbatim. */
const MESSAGE = 'Module is not imported by any other file and is not a framework entry point — dead code candidate.';

export const unreferencedModuleRule: RuleDefinition<UnreferencedModuleNeeds> = {
  id: 'unreferenced-module',
  analyzer: 'dependency-graph',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['file-imports', 'reachability'] },
  severity: 'severe',
  message: MESSAGE,
  docs: META.docs,
  thresholds: META.thresholds,
  samples: META.samples,
  analyze(ctx): Finding[] {
    const imports: readonly FileImportsFact[] = ctx.facts['file-imports'];
    const reachability: ReachabilityFact = ctx.facts['reachability'];
    const entrySet = new Set(reachability.packageEntryPoints);
    const importersOf = reachability.importersOf;

    const out: Finding[] = [];
    for (const info of imports) {
      if (!info.hasExports) continue;
      if (isTestFile(info.file)) continue;
      if (isEntryPointFile(info.file) || entrySet.has(info.file)) continue;
      if ((importersOf[info.file]?.length ?? 0) > 0) continue;
      out.push({
        ruleId: 'unreferenced-module',
        severity: 'severe',
        message: MESSAGE,
        file: info.file,
        line: 1,
        // §7 — file-level finding; the module path is the symbol that located it.
        symbol: info.file,
      });
    }
    return out;
  },
};
