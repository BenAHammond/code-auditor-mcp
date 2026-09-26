/**
 * Spec 68 §2.3 residue check #2 — every produced fact kind is *consumed*.
 *
 * The runtime form of a guard that was once a compile-time `const` and cannot
 * stay one: while the migration runs, `MIGRATED_RULES` reads 0 of 100, so the
 * only consumed kind is `ddl-declarations` (via the `table-catalog` corpus
 * processor) and the other seven produced kinds read as unconsumed. A compile
 * error for that state would block every other test, so the guard is a test
 * that is red for the whole migration and goes green only when every produced
 * kind is read by at least one migrated rule or corpus processor — the same
 * red-drives-the-migration shape as spec68-registry-size.spec.ts.
 *
 * The consumed set is derived from the two real sources (`PRODUCERS`'s corpus
 * `needs` and `MIGRATED_RULES`'s `needs.facts`), never a hand-written list — a
 * produced kind that nothing reads fails here rather than being found by hand a
 * week later (the Spec 63 class: `crossLanguageViolations`, `importersOf`,
 * `getContentHashesForFiles` were all computed and never read).
 */

import { describe, it, expect } from 'vitest';
import { PRODUCERS } from '../phase/producers.js';
import { MIGRATED_RULES } from '../phase/rules/registry.js';
import type { FactKind } from '../phase/types.js';

describe('Spec 68 §2.3 residue #2 — every produced kind is consumed', () => {
  it('no fact kind is produced but never read by a migrated rule or corpus processor', () => {
    const produced = new Set<FactKind>(Object.keys(PRODUCERS) as FactKind[]);
    const consumed = new Set<FactKind>();

    // Corpus processors declare their upstream facts in `needs` (the DAG edge
    // ddl-declarations → table-catalog).
    for (const producer of Object.values(PRODUCERS)) {
      if ('needs' in producer) {
        for (const need of producer.needs) consumed.add(need);
      }
    }

    // Migrated rules declare the facts their `analyze(ctx)` reads.
    for (const rule of MIGRATED_RULES) {
      for (const fact of rule.needs.facts) consumed.add(fact);
    }

    const unconsumed = [...produced].filter((kind) => !consumed.has(kind)).sort();
    expect(
      unconsumed,
      'a produced fact kind is read by nothing — migrate the rule that declares it',
    ).toEqual([]);
  });
});
