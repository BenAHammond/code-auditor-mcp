/**
 * Spec 68 §3.2 — parity: the migrated data-access rules reproduce the old
 * analyzer's findings exactly.
 *
 * A rule is "migrated" only when the new `analyze(ctx)` over the
 * `data-access-calls` fact produces the *same* findings the pre-migration
 * `UniversalDataAccessAnalyzer.analyzeWithFacts` produced on a fixture — same
 * file, line, column, rule, severity. Not a "similar count": the full multiset
 * of identity tuples. This test runs BOTH paths per rule (the old analyzer still
 * live at the time it is written) and asserts the multisets are equal and
 * non-empty. It is the pin that lets §15 delete the old analyzer path without
 * losing the golden reference.
 *
 * The producer (`extractDataAccessCalls`) is the *same* `extractDatabaseCalls`
 * the old `analyzeWithFacts` runs, so the extraction half is identical by
 * construction; this test pins the *rule* half. It also pins the old analyzer's
 * mutual exclusion — a call was classified `complex-query` XOR `unfiltered-query`
 * (never both), because `analyzeQuery` resolved a single `performanceRisk`
 * ('high' wins over 'medium') — so a join-heavy unfiltered write must NOT
 * surface a second `unfiltered-query` finding.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import {
  UniversalDataAccessAnalyzer,
  DEFAULT_DATA_ACCESS_CONFIG,
} from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { runDataAccessSlice } from '../phase/runner.js';
import { dataAccessRules } from '../phase/rules/dataAccess.js';
import type { Violation } from '../types.js';

let adapter: LanguageAdapter;
let analyzer: UniversalDataAccessAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDataAccessAnalyzer();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, severity. */
function key(f: { file: string; line?: number; column?: number; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.severity}`;
}

/** Run the old analyzer and the new slice, return the per-rule identity multisets. */
async function parity(ruleId: string, source: string) {
  const ast = parseFile('parity.ts', source);
  expect(ast, `fixture failed to parse`).not.toBeNull();
  const { violations } = await analyzer.analyzeWithFacts(ast!, adapter, DEFAULT_DATA_ACCESS_CONFIG, source);
  const old = violations.filter((v) => v.rule === ruleId).map(key).sort();

  const fresh = await runDataAccessSlice([{ path: 'parity.ts', content: source }]);
  const nu = fresh.filter((f) => f.ruleId === ruleId).map(key).sort();

  return { old, nu };
}

/** The TypeScript data-access rules, in registry order — the slice under test.
 *  `missing-org-filter` (the fourth) has its old path in the Stage-4 reducer, not
 *  `analyzeWithFacts`, so it is parity-tested separately against that reducer. */
const RULE_IDS = dataAccessRules.map((r) => r.id);

describe('Spec 68 data-access parity (new analyze(ctx) === old UniversalDataAccessAnalyzer)', () => {
  it('covers exactly the four migrated data-access rules', () => {
    expect(RULE_IDS).toEqual(['sql-injection-risk', 'complex-query', 'unfiltered-query', 'missing-org-filter']);
  });

  it('sql-injection-risk (raw string-concatenated input)', async () => {
    const { old, nu } = await parity(
      'sql-injection-risk',
      'import { db } from "./db";\n' +
      'export function getUser(id) {\n' +
      '  return db.query("SELECT * FROM users WHERE id = " + id);\n' +
      '}\n',
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('complex-query (six-table join)', async () => {
    const { old, nu } = await parity(
      'complex-query',
      'import { db } from "./db";\n' +
      'export function report() {\n' +
      '  return db.query("SELECT * FROM users JOIN orders JOIN products JOIN categories JOIN inventory JOIN shipments");\n' +
      '}\n',
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('unfiltered-query (filterless UPDATE)', async () => {
    const { old, nu } = await parity(
      'unfiltered-query',
      'import { db } from "./db";\n' +
      'export function nuke() {\n' +
      '  return db.exec("UPDATE users SET active = 0");\n' +
      '}\n',
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('unfiltered-query does NOT double-fire on a join-heavy write (mutual exclusion)', async () => {
    // Old `analyzeQuery` resolves a single `performanceRisk`: `complex-query`
    // ('high', tables > joinedTableCount) wins over `unfiltered-query`
    // ('medium'). The migrated rules must reproduce that priority — this call
    // is complex-query only, never a second unfiltered-query finding.
    const { old, nu } = await parity(
      'unfiltered-query',
      'import { db } from "./db";\n' +
      'export function massDelete() {\n' +
      '  return db.exec("DELETE FROM alpha JOIN beta JOIN gamma JOIN delta JOIN epsilon");\n' +
      '}\n',
    );
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('complex-query still fires the join-heavy write (the priority is not a suppression)', async () => {
    const { old, nu } = await parity(
      'complex-query',
      'import { db } from "./db";\n' +
      'export function massDelete() {\n' +
      '  return db.exec("DELETE FROM alpha JOIN beta JOIN gamma JOIN delta JOIN epsilon");\n' +
      '}\n',
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });
});
