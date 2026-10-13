/**
 * Spec 68 §8 + item E — pin the `unreferenced-module` finding's claim.
 *
 * The rule proves only that no importer was *resolved from this tree*; it
 * cannot prove a module is dead (a computed-specifier import or an external
 * entry the tree cannot see keeps it live). E (8d3bf5d) reworded the finding
 * from the overclaim "dead code candidate" to the proven claim "unreferenced
 * within this tree", and demoted it severe → high.
 *
 * The test that pinned this wording lived in the deleted
 * `spec68-unreferenced-module-parity.spec.ts` (item C removed it together with
 * the legacy `createDependencyGraphReducer` it exercised). This standalone
 * test re-pins the live half — the phase rule's emitted claim — without any
 * reference to the legacy path, so the overclaim cannot silently return.
 *
 * It asserts on the *emitted* finding message (`unreferencedModuleRule`'s
 * `MESSAGE`), not a source-literal grep: a revert to "dead code candidate"
 * fails the `not.toContain('dead')` arm, and a drift to any wording that drops
 * the proven "no importer resolved from this tree" fails the second arm.
 */

import { describe, it, expect } from 'vitest';
import { unreferencedModuleRule } from '../phase/rules/unreferencedModule.js';
import { CORPUS_PRODUCERS } from '../phase/producers.js';
import type { FileImportsFact } from '../phase/types.js';

/** One exported-but-unimported module: a dead-code candidate under the old
 *  wording, "unreferenced within this tree" under the proven claim. */
const DEAD_MODULE_FACTS: FileImportsFact[] = [
  { file: '/fixture/lib/dead.ts', imports: [], hasExports: true, unresolvedDynamicImports: [] },
];

describe('unreferenced-module — proven claim, never "dead"', () => {
  it('emits a finding claiming "no importer resolved from this tree", not "dead", at severity high', () => {
    const reachability = CORPUS_PRODUCERS['reachability'].process({ 'file-imports': DEAD_MODULE_FACTS });
    const findings = unreferencedModuleRule.analyze({
      projectRoot: '/tmp/codeauditor-fixture',
      facts: { 'file-imports': DEAD_MODULE_FACTS, 'reachability': reachability },
      formats: ['typescript', 'tsx', 'javascript', 'go'],
      thresholds: {},
    });

    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.severity).toBe('high');
      // The overclaim must be gone: the analysis proves only absence of a
      // resolved importer, not death.
      expect(f.message).not.toContain('dead');
      expect(f.message).toContain('no importer resolved from this tree');
    }
  });
});
