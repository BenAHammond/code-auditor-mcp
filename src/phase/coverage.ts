/**
 * Spec 68 §8 — derived coverage.
 *
 * The legacy pipeline derived per-rule coverage by cross-referencing the
 * registry against the analyzer-results map, a visitor/reducer status machine,
 * and a per-rule `input` mapping (`buildCoverageReport` in pipeline.ts). That
 * required a hand-maintained `input` list per rule — the exact "there is a
 * list to be omitted from" defect class §0 exists to remove — and could only
 * say `unassessed` for a rule with no mapping.
 *
 * Derived coverage inverts the direction: a rule's `needs` *declaration* is the
 * whole story. Every rule already declares the formats it can evaluate and the
 * fact kinds it reads (enforced by the type), so its coverage state is a pure
 * function of (a) whether it fired, (b) whether any of its declared formats was
 * present, (c) whether every declared fact has a producer able to serve a
 * declared format, and (d) whether every declared fact was complete for every
 * file. No per-rule list, no status machine — the declaration is the input.
 *
 * Five states, resolved in precedence order (first match wins):
 *
 *   | # | State          | Trigger                                                        |
 *   |---|----------------|----------------------------------------------------------------|
 *   | 1 | `fired`        | ≥1 finding carries this rule's id                              |
 *   | 2 | `notApplicable`| rule not enabled, or no file of a declared format present      |
 *   | 3 | `cannot-fire`  | a declared fact has no producer for any declared format        |
 *   | 4 | `incomplete`   | a declared fact is missing for ≥1 file (parse/producer/worker) |
 *   | 5 | `clean`        | otherwise — could have fired, produced nothing                 |
 *
 * `incomplete` is §8's replacement for the legacy `unassessed`: it names the
 * *fact* and the *files* that went missing, so a partial run is observable
 * rather than silently recorded as either `clean` (a false negative) or
 * `unassessed` (no provenance). The precedence puts `cannot-fire` above
 * `incomplete` — a structurally broken rule is broken whether or not its input
 * was complete — and `incomplete` above `clean`, because a rule whose declared
 * fact is partially absent cannot honestly assert "could have fired".
 */

import { PRODUCERS, CORPUS_PRODUCERS } from './producers.js';
import { formatFor } from './runner.js';
import type { FactKind, Format, Finding, RuleDefinition } from './types.js';
import type { RuleCoverage } from '../types.js';

/** Producer availability: the formats each *file* fact kind can be supplied by. */
function producerFormats(kind: FactKind): ReadonlySet<Format> {
  const formats = (PRODUCERS as Partial<Record<FactKind, Record<string, unknown>>>)[kind];
  return new Set<Format>(formats ? (Object.keys(formats) as Format[]) : []);
}

/** True when `kind` is corpus-produced (format-independent), not a file fact. */
function isCorpusFact(kind: FactKind): boolean {
  return Object.prototype.hasOwnProperty.call(CORPUS_PRODUCERS, kind);
}

/** The declared fact kinds a producer can serve for a present declared format. */
function servable(kind: FactKind, presentDeclared: readonly Format[]): boolean {
  if (isCorpusFact(kind)) return true;
  const formats = producerFormats(kind);
  return presentDeclared.some((f) => formats.has(f));
}

export interface CoverageInput {
  /** The rules in scope (the migrated set, or the whole registry). */
  rules: readonly RuleDefinition<any>[];
  /** The findings produced this run. */
  findings: readonly Finding[];
  /** Formats present in the corpus (discovered files), regardless of parse success. */
  presentFormats: ReadonlySet<Format>;
  /** The enabled rule subset; undefined runs every rule. Disabled rules read
   *  `notApplicable` — a stated skip, not silence (Spec 66 R6). */
  enabledRules?: ReadonlySet<string>;
  /** Fact kind → files whose fact is incomplete (parse dropped, producer threw,
   *  or a worker shard was lost). Absent = every declared fact was complete. */
  incompleteFacts?: ReadonlyMap<FactKind, ReadonlySet<string>>;
  /** Resolve a rule's analyzer/group label for {@link RuleCoverage.analyzer}.
   *  Defaults to the rule id (the registry mapping is deleted in §15). */
  groupOf?: (ruleId: string) => string;
}

/**
 * Derive per-rule coverage from the rules' declarations and the run's findings.
 *
 * @param input - The run's rules, findings, present formats, and completeness map.
 * @returns One `RuleCoverage` per rule, in the input rule order.
 */
export function deriveCoverage(input: CoverageInput): RuleCoverage[] {
  const countByRule = new Map<string, number>();
  for (const f of input.findings) {
    countByRule.set(f.ruleId, (countByRule.get(f.ruleId) ?? 0) + 1);
  }

  return input.rules.map((rule) => {
    const group = input.groupOf?.(rule.id) ?? rule.id;

    const count = countByRule.get(rule.id) ?? 0;
    if (count > 0) return { ruleId: rule.id, analyzer: group, state: 'fired', count } as RuleCoverage;

    if (input.enabledRules && !input.enabledRules.has(rule.id)) {
      return {
        ruleId: rule.id,
        analyzer: group,
        state: 'notApplicable',
        count: 0,
        reason: `rule "${rule.id}" not enabled`,
      } as RuleCoverage;
    }

    const declared = rule.needs.formats as readonly Format[];
    const presentDeclared = declared.filter((f: Format) => input.presentFormats.has(f));
    if (presentDeclared.length === 0) {
      return {
        ruleId: rule.id,
        analyzer: group,
        state: 'notApplicable',
        count: 0,
        reason: `no file of a declared format present (declares: ${declared.join(', ')})`,
      } as RuleCoverage;
    }

    const facts = rule.needs.facts as readonly FactKind[];
    const unservable = facts.filter((fact: FactKind) => !servable(fact, presentDeclared));
    if (unservable.length > 0) {
      return {
        ruleId: rule.id,
        analyzer: group,
        state: 'cannot-fire',
        count: 0,
        reason: `fact(s) ${unservable.join(', ')} have no producer for declared format(s) ${presentDeclared.join(', ')}`,
      } as RuleCoverage;
    }

    for (const fact of facts) {
      const files = input.incompleteFacts?.get(fact);
      if (files && files.size > 0) {
        return {
          ruleId: rule.id,
          analyzer: group,
          state: 'incomplete',
          count: 0,
          reason: `fact "${fact}" incomplete for ${files.size} file(s)`,
        } as RuleCoverage;
      }
    }

    return { ruleId: rule.id, analyzer: group, state: 'clean', count: 0 } as RuleCoverage;
  });
}

/** The formats present in a discovered file list, for feeding {@link CoverageInput}. */
export function presentFormatsOf(filePaths: readonly string[]): ReadonlySet<Format> {
  return new Set<Format>(filePaths.map((p) => formatFor(p)));
}
