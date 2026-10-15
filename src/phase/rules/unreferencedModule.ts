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
import { isTestFile, isEntryPointFile, hasUnresolvedDynamicImports } from '../reachability.js';

type UnreferencedModuleNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript', 'go'];
  readonly facts: readonly ['file-imports', 'reachability'];
};

const META = RULE_REGISTRY['unreferenced-module'];

/** The finding's claim is what the analysis proves: no importer was resolved from
 *  this tree. "Dead" would overclaim — a module reachable only via a computed
 *  specifier or an external entry the tree cannot see would be reported dead when
 *  it is merely unresolved. */
const MESSAGE = 'Module is exported but has no importer resolved from this tree and is not a framework entry point — unreferenced within this tree.';

export const unreferencedModuleRule: RuleDefinition<UnreferencedModuleNeeds> = {
  id: 'unreferenced-module',
  analyzer: 'dependency-graph',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['file-imports', 'reachability'] },
  severity: 'high',
  message: MESSAGE,
  docs: META.docs,
  thresholds: META.thresholds,
  samples: META.samples,
  dispositions: [
    { key: 'clean', description: 'The module is referenced (or is a test/entry point), so it is not unreferenced within this tree.' },
    { key: 'unreferenced', description: 'The module is exported but has no importer resolved from this tree and is not a framework entry point.' },
  ],
  analyze(ctx): Finding[] {
    const imports: readonly FileImportsFact[] = ctx.facts['file-imports'];
    const reachability: ReachabilityFact = ctx.facts['reachability'];

    // A computed-specifier dynamic import (`import(someVar)` / `require(filepath)`)
    // cannot be resolved into an edge, so "imported by nothing" is unsound for
    // every module while one exists. The corpus-side `computeUnprovenModules`
    // (reachability.ts) surfaces those modules as `unproven` coverage diagnostics;
    // the rule's half is to withhold the dead-code finding so it is never reported
    // as a definite defect alongside that uncertainty.
    if (hasUnresolvedDynamicImports(imports)) return [];

    const entrySet = new Set(reachability.packageEntryPoints);
    const importersOf = reachability.importersOf;

    const out: Finding[] = [];
    for (const info of imports) {
      if (!info.hasExports) continue;
      const unreferenced =
        !isTestFile(info.file) &&
        !(isEntryPointFile(info.file) || entrySet.has(info.file)) &&
        (importersOf[info.file]?.length ?? 0) === 0;
      // Directive H — emit the candidate with the disposition the classifier
      // assigns, including `clean` for an exported module that is referenced.
      ctx.emitCandidate?.({
        ruleId: 'unreferenced-module',
        file: info.file,
        span: { line: 1 },
        disposition: unreferenced ? 'unreferenced' : 'clean',
      });
      if (!unreferenced) continue;
      out.push({
        ruleId: 'unreferenced-module',
        severity: 'high',
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
