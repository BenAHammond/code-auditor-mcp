/**
 * Registry ↔ ledger membership guard (4.1.0).
 *
 * Three surfaces record rules, at three different granularities, and nothing
 * used to assert they agree:
 *
 *   - `RULE_REGISTRY` (`src/analyzers/ruleRegistry.ts`) — 78 entries, the
 *     authoritative set of rule IDs the tool can emit. 22 rules were removed in
 *     Spec 68 (5 Go-subprocess, 17 schema) because they declared `facts: []` — a
 *     false declaration for rules that still read their old AST paths. They stay
 *     on the old analyzer path until their fact kinds exist and they are
 *     actually migrated into `phase/rules/` (see the Spec 68 note below).
 *   - `specs/rule-authenticity-ledger.md` — 98 rows, one per rule/check, each
 *     classified `honest`/`crude`/`dishonest`/`blocked`/`cannot-fire`.
 *   - `specs/severity-assignment-ledger.md` — 106 rule/kinds = 102 live severity
 *     rules + 4 diagnostics (off the severity ladder).
 *
 * The ten rules removed in 4.1.0 lived in the registry and both ledgers for
 * months with no implementation behind them. A bidirectional membership test is
 * the structural form of that bug: it asserts every registry id has a ledger row,
 * and every ledger row maps back to a registry id, with the *deliberate*
 * differences pinned below. Any new drift — a rule added to the registry without
 * a ledger row, or a ledger row that no longer maps to the registry — fails this
 * test with the exact set that changed.
 *
 * Notation. The registry uses `analyzer/rule` for solid/dry/conventions/styles/
 * cross-domain, bare ids for data-access/schema/react/documentation/dependency-
 * graph/security, and bare ids for the five Go-subprocess rules. The two ledgers
 * match that, except the Go-subprocess rules are recorded under Session 15's
 * `analyzer/rule` notation (`imports/…`, `errors/…`, `goroutines/…`,
 * `channels/…`) — and the two ledgers disagree on the deadlock rule's name
 * (`channels/concurrency` in the authenticity ledger, `channels/channel-deadlock`
 * in the severity ledger). `GO_ALIAS` maps both to the registry's
 * `channel-deadlock`.
 *
 * The pinned differences, in both directions:
 *
 *  1. Registry → authenticity: 16 ids have no authenticity row.
 *     - 6 are *renames* whose old name's row is still present, so the new name
 *       has no row of its own:
 *         `cross-domain/multi-table-write`      (was `cross-domain/transaction-boundary`)
 *         `cross-domain/no-validator-reachable` (was `cross-domain/validation-bypass`)
 *         `dynamic-sql-construction`            (was `sql-injection`)
 *         `function-length`                     (was `solid/single-responsibility`)
 *         `interface-size`                      (was `solid/interface-segregation`)
 *         `parameter-count`                     (was `solid/single-responsibility`)
 *     - 10 are *never-audited*: live rules added after the authenticity pass
 *       that still await a verdict (closing these is rule-track work, not this
 *       release):
 *         `dry/diverging-clone`, `dry/similar-expression`, `function-size`,
 *         `hardcoded-secret`, `liskov-substitution` (bare Go), `stale-table-reference`,
 *         `struct-size`, `switch-size`, `too-many-queries`, `unreferenced-module`.
 *     (`type-mismatch` was once in this gap; it left the registry in Spec 68 and
 *     has no authenticity row of its own, so it is no longer a registry id here.)
 *
 *  2. Authenticity → registry: 28 rows map to no registry id.
 *     - 3 are *diagnostics* (off the ladder): `config-error`, `engine-error`,
 *       `styles/undefined-class-disabled`.
 *     - 4 are *renamed old names* whose new name is in the registry:
 *       `cross-domain/transaction-boundary`, `cross-domain/validation-bypass`,
 *       `solid/interface-segregation`, `sql-injection`.
 *     - 21 are *unregistered-live*: the Spec 68 removals that still emit from
 *       their old analyzer path (5 Go-subprocess + 16 schema). Their fact kinds
 *       are not yet declared, so they were pulled from the registry but their
 *       authenticity rows remain. (`type-mismatch` is absent: never-audited, so
 *       it had no authenticity row to leave behind.)
 *
 *  3. Registry → severity: 0 — every registry id has a severity row.
 *
 *  4. Severity → registry: 27 rows map to no registry id.
 *     - 3 are *diagnostics* with a legacy severity row: `config-error`,
 *       `engine-error`, `styles/undefined-class-disabled`.
 *     - 2 are *unregistered live* emit sites: `missing-schemas`
 *       (`UniversalSchemaAnalyzer.ts`) and `reserved-word` (`schema/codeAnalysis.ts`).
 *     - 22 are *unregistered-live*: the Spec 68 removals (5 Go-subprocess +
 *       17 schema), all of which still have severity rows.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { RULE_REGISTRY } from '../ruleRegistry.js';
import { SEVERITIES } from '../../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..', '..', '..');
const AUTH_LEDGER = join(APP_ROOT, 'specs', 'rule-authenticity-ledger.md');
const SEV_LEDGER = join(APP_ROOT, 'specs', 'severity-assignment-ledger.md');

/**
 * Session 15 recorded the five Go-subprocess rules under `analyzer/rule`
 * notation; the registry uses bare ids. The two ledgers also disagree on the
 * deadlock rule's name — `channels/concurrency` (authenticity) vs
 * `channels/channel-deadlock` (severity) — both resolve to `channel-deadlock`.
 */
const GO_ALIAS: Record<string, string> = {
  'imports/import-organization': 'import-organization',
  'imports/import-style': 'import-style',
  'errors/error-handling': 'error-handling',
  'goroutines/concurrency': 'concurrency',
  'channels/concurrency': 'channel-deadlock',
  'channels/channel-deadlock': 'channel-deadlock',
};

/**
 * Parse a ledger's table into `Set<id>` — the first backtick-quoted token in
 * column 1 of each table row. `needSeverity` restricts to rows whose column 3 is
 * a severity (the severity ledger carries prose rows that are not assignments).
 * Only cells 1 and 3 are read, which is safe: `|` characters inside backtick
 * code appear only in later cells (claims/computes/gap), never in the id cell.
 */
function parseLedger(path: string, needSeverity: boolean): Set<string> {
  const src = readFileSync(path, 'utf8');
  const out = new Set<string>();
  for (const line of src.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const ruleMatch = (cells[1] ?? '').match(/`([^`]+)`/);
    if (!ruleMatch) continue;
    if (needSeverity && !SEVERITIES.includes(cells[3] as (typeof SEVERITIES)[number])) continue;
    out.add(ruleMatch[1]);
  }
  return out;
}

/** A ledger id maps to a registry id once the Go notation is folded in. */
function toRegistryId(id: string): string {
  return GO_ALIAS[id] ?? id;
}

describe('registry ↔ ledger membership', () => {
  const registry = new Set(Object.keys(RULE_REGISTRY));
  const auth = parseLedger(AUTH_LEDGER, false);
  const severity = parseLedger(SEV_LEDGER, true);

  // A registry id is "in" a ledger if the ledger has that exact id, or any Go
  // alias that resolves to it.
  function ledgerCovers(ledger: Set<string>, registryId: string): boolean {
    if (ledger.has(registryId)) return true;
    return Object.entries(GO_ALIAS).some(([alias, target]) => target === registryId && ledger.has(alias));
  }

  function regNotIn(ledger: Set<string>): string[] {
    return [...registry].filter((id) => !ledgerCovers(ledger, id)).sort();
  }

  function ledgerNotInReg(ledger: Set<string>): string[] {
    return [...ledger].filter((id) => !registry.has(toRegistryId(id))).sort();
  }

  it('parses the full registry (78) and both ledgers', () => {
    expect(registry.size).toBe(78);
    expect(auth.size).toBeGreaterThanOrEqual(90);
    expect(severity.size).toBeGreaterThanOrEqual(100);
  });

  it('every registry id has a severity row (registry → severity)', () => {
    expect(regNotIn(severity)).toEqual([]);
  });

  it('every registry id has an authenticity row, modulo the pinned gap (registry → authenticity)', () => {
    const AUTH_GAP = [
      // renames — old name's row still present, new name has no row of its own
      'cross-domain/multi-table-write',
      'cross-domain/no-validator-reachable',
      'dynamic-sql-construction',
      'function-length',
      'interface-size',
      'parameter-count',
      // never-audited — live rules awaiting an authenticity verdict
      'dry/diverging-clone',
      'dry/similar-expression',
      'function-size',
      'hardcoded-secret',
      'liskov-substitution',
      'stale-table-reference',
      'struct-size',
      'switch-size',
      'too-many-queries',
      'unreferenced-module',
    ].sort();
    expect(regNotIn(auth), 'a registry rule lost or gained an authenticity row — update AUTH_GAP').toEqual(AUTH_GAP);
  });

  it('every authenticity row maps to a registry id, modulo renames and diagnostics (authenticity → registry)', () => {
    const AUTH_EXTRANEOUS = [
      // diagnostics (off-ladder)
      'config-error',
      'engine-error',
      'styles/undefined-class-disabled',
      // renamed old names (new name in registry)
      'cross-domain/transaction-boundary',
      'cross-domain/validation-bypass',
      'solid/interface-segregation',
      'sql-injection',
      // unregistered-live — removed from the registry in Spec 68 (fact kinds not
      // yet declared); the old analyzer path still emits them. type-mismatch is
      // absent here: it was never-audited, so it had no authenticity row.
      'above-maximum',
      'below-minimum',
      'channels/concurrency',
      'enum-mismatch',
      'errors/error-handling',
      'goroutines/concurrency',
      'imports/import-organization',
      'imports/import-style',
      'invalid-format',
      'invalid-json',
      'invalid-range',
      'invalid-type',
      'missing-required-field',
      'missing-schema-declaration',
      'pattern-mismatch',
      'string-too-long',
      'string-too-short',
      'too-few-items',
      'too-many-items',
      'undefined-required-field',
      'unexpected-property',
    ].sort();
    expect(ledgerNotInReg(auth)).toEqual(AUTH_EXTRANEOUS);
  });

  it('every severity row maps to a registry id, modulo diagnostics and unregistered-live (severity → registry)', () => {
    const SEV_EXTRANEOUS = [
      // diagnostics with a legacy severity row
      'config-error',
      'engine-error',
      'styles/undefined-class-disabled',
      // unregistered live emit sites
      'missing-schemas',
      'reserved-word',
      // unregistered-live — removed from the registry in Spec 68 (fact kinds not
      // yet declared); the old analyzer path still emits them, so their severity
      // rows remain. All 22 have severity rows, including type-mismatch.
      'above-maximum',
      'below-minimum',
      'channels/channel-deadlock',
      'enum-mismatch',
      'errors/error-handling',
      'goroutines/concurrency',
      'imports/import-organization',
      'imports/import-style',
      'invalid-format',
      'invalid-json',
      'invalid-range',
      'invalid-type',
      'missing-required-field',
      'missing-schema-declaration',
      'pattern-mismatch',
      'string-too-long',
      'string-too-short',
      'too-few-items',
      'too-many-items',
      'type-mismatch',
      'undefined-required-field',
      'unexpected-property',
    ].sort();
    expect(ledgerNotInReg(severity)).toEqual(SEV_EXTRANEOUS);
  });
});
