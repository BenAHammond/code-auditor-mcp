/**
 * Spec 68 §8 — derived coverage (guard 9).
 *
 * The five coverage states are a pure function of a rule's `needs` declaration
 * plus the run's findings and fact completeness — no registry, no status
 * machine, no per-rule `input` list. This pins that function, `deriveCoverage`,
 * against a synthetic rule set so each state's trigger is observable in
 * isolation, and — critically — so the two *seeded-defect* states a real
 * registry can never reach are exercised:
 *
 *   - `cannot-fire` is a structural defect: a rule declares a fact whose
 *     producer cannot serve the format the rule declares. The real `MIGRATED_RULES`
 *     cannot express this (the `Needs` mapped type rejects a mismatched
 *     (format, fact) pair at compile time), so a synthetic rule — cast past the
 *     type — is the only way to prove the runtime state is emitted rather than
 *     silently collapsing to `clean`.
 *   - `incomplete` is a partial-run defect: a declared fact is missing for one
 *     file. The in-process model produces it only on a per-file parse/producer
 *     failure; the §6 distributed runner produces it on a lost worker shard.
 *
 * `clean` means "could have fired" (Spec 62 Amendment B): it is asserted only
 * when every declared format is present, every declared fact is servable, and
 * every declared fact is complete — the rule genuinely produced nothing over a
 * complete input, not a false negative over a silently absent one.
 */

import { describe, it, expect } from 'vitest';
import { deriveCoverage } from '../phase/coverage.js';
import type { FactKind, Format, RuleDefinition } from '../phase/types.js';

/** A minimal synthetic rule. `analyze` is never called by coverage derivation. */
function rule(id: string, formats: Format[], facts: FactKind[]): RuleDefinition<any> {
  return {
    id,
    needs: { formats, facts },
    severity: 'high',
    message: 'synthetic',
    docs: 'synthetic rule for coverage conformance',
    thresholds: [],
    samples: [],
    analyze: async () => [],
  } as unknown as RuleDefinition<any>;
}

const finding = (ruleId: string) => ({
  ruleId,
  severity: 'high' as const,
  message: 'x',
  file: '/a.ts',
});

describe('Spec 68 §8 — deriveCoverage (guard 9)', () => {
  it('fired: a rule with ≥1 finding reports fired with the count', () => {
    const r = rule('r1', ['typescript'], ['file-symbols']);
    const cov = deriveCoverage({
      rules: [r],
      findings: [finding('r1'), finding('r1')],
      presentFormats: new Set<Format>(['typescript']),
    });
    expect(cov).toEqual([{ ruleId: 'r1', analyzer: 'r1', state: 'fired', count: 2 }]);
  });

  it('notApplicable: a rule whose declared format is absent from the corpus', () => {
    const r = rule('go-only', ['go'], ['go-functions']);
    const cov = deriveCoverage({
      rules: [r],
      findings: [],
      presentFormats: new Set<Format>(['typescript']),
    });
    expect(cov[0].state).toBe('notApplicable');
    expect(cov[0].reason).toContain('go');
  });

  it('notApplicable: a rule not in the enabled set is a stated skip, not silence', () => {
    const r = rule('disabled', ['typescript'], ['file-symbols']);
    const cov = deriveCoverage({
      rules: [r],
      findings: [],
      presentFormats: new Set<Format>(['typescript']),
      enabledRules: new Set(['other']),
    });
    expect(cov[0].state).toBe('notApplicable');
    expect(cov[0].reason).toContain('not enabled');
  });

  it('cannot-fire: a declared fact with no producer for the declared format (seeded defect)', () => {
    // `file-symbols` has no `css` producer, and is not corpus-produced — a
    // rule declaring `css` + `file-symbols` can never evaluate a css file. The
    // real registry cannot express this; the synthetic rule casts past `Needs`.
    const r = rule('broken', ['css'], ['file-symbols']);
    const cov = deriveCoverage({
      rules: [r],
      findings: [],
      presentFormats: new Set<Format>(['css']),
    });
    expect(cov[0].state).toBe('cannot-fire');
    expect(cov[0].reason).toContain('file-symbols');
  });

  it('incomplete: a declared fact missing for ≥1 file reports incomplete, not clean', () => {
    const r = rule('partial', ['typescript'], ['file-symbols']);
    const cov = deriveCoverage({
      rules: [r],
      findings: [],
      presentFormats: new Set<Format>(['typescript']),
      incompleteFacts: new Map([['file-symbols', new Set(['/a.ts'])]]),
    });
    expect(cov[0].state).toBe('incomplete');
    expect(cov[0].reason).toContain('file-symbols');
  });

  it('clean: complete input, every fact servable, no findings → could have fired', () => {
    const r = rule('clean', ['typescript'], ['file-symbols']);
    const cov = deriveCoverage({
      rules: [r],
      findings: [],
      presentFormats: new Set<Format>(['typescript']),
      incompleteFacts: new Map(),
    });
    expect(cov[0].state).toBe('clean');
  });

  it('precedence: fired beats notApplicable, incomplete beats clean', () => {
    // fired wins even when the declared format would otherwise be absent.
    const firedDespiteAbsent = deriveCoverage({
      rules: [rule('f', ['go'], ['go-functions'])],
      findings: [finding('f')],
      presentFormats: new Set<Format>(['typescript']),
    });
    expect(firedDespiteAbsent[0].state).toBe('fired');

    // incomplete wins over clean: the declared fact is servable and present,
    // but one file is missing, so the rule cannot assert "could have fired".
    const incompleteOverClean = deriveCoverage({
      rules: [rule('i', ['typescript'], ['file-symbols'])],
      findings: [],
      presentFormats: new Set<Format>(['typescript']),
      incompleteFacts: new Map([['file-symbols', new Set(['/a.ts'])]]),
    });
    expect(incompleteOverClean[0].state).toBe('incomplete');
  });

  it('groupOf resolves the analyzer label; defaults to the rule id', () => {
    const r = rule('named', ['typescript'], ['file-symbols']);
    const cov = deriveCoverage({
      rules: [r],
      findings: [],
      presentFormats: new Set<Format>(['typescript']),
      groupOf: () => 'solid',
    });
    expect(cov[0].analyzer).toBe('solid');
  });
});
