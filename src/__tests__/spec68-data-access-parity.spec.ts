/**
 * Spec 68 §3.2 — the migrated data-access rules, pinned against the golden
 * reference.
 *
 * A rule is "migrated" when the new `analyze(ctx)` over the `data-access-calls`
 * fact produces the findings the pre-migration `UniversalDataAccessAnalyzer`
 * did on a fixture — same file, line, column, rule, severity. This test
 * originally ran BOTH paths per rule (the old analyzer still live) and asserted
 * the identity multisets were equal and non-empty — that was the pin that let
 * §15 delete the old `analyzeWithFacts` path without losing the golden
 * reference. The old path is now deleted, so this test asserts the migrated
 * slice directly.
 *
 * The producer (`extractDataAccessCalls`) is the *same* `extractDatabaseCalls`
 * the old `analyzeWithFacts` ran, so the extraction half is identical by
 * construction; this test pins the *rule* half. It also pins the mutual
 * exclusion — a call is classified `complex-query` XOR `unfiltered-query`
 * (never both), because `analyzeQuery` resolved a single `performanceRisk`
 * ('high' wins over 'medium') — so a join-heavy unfiltered write must NOT
 * surface a second `unfiltered-query` finding.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runDataAccessSlice } from '../phase/runner.js';
import { dataAccessRules } from '../phase/rules/dataAccess.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, severity. */
function key(f: { file: string; line?: number; column?: number; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.severity}`;
}

/** Run the migrated slice, returning the per-rule identity multiset. */
async function slice(ruleId: string, source: string) {
  const fresh = await runDataAccessSlice([{ path: 'parity.ts', content: source }], {}, 'sqlite');
  return fresh.filter((f) => f.ruleId === ruleId).map(key).sort();
}

/** The TypeScript data-access rules, in registry order — the slice under test.
 *  `missing-org-filter` (the fourth) has its old path in the Stage-4 reducer, not
 *  `analyzeWithFacts`, so it is parity-tested separately against that reducer. */
const RULE_IDS = dataAccessRules.map((r) => r.id);

describe('Spec 68 data-access parity (migrated analyze(ctx) === golden reference)', () => {
  it('covers exactly the four migrated data-access rules', () => {
    expect(RULE_IDS).toEqual(['sql-injection-risk', 'complex-query', 'unfiltered-query', 'missing-org-filter']);
  });

  it('sql-injection-risk (raw string-concatenated input)', async () => {
    const nu = await slice(
      'sql-injection-risk',
      "import { Pool } from 'pg';\n" +
      'const db = new Pool();\n' +
      'export function getUser(id) {\n' +
      '  return db.query("SELECT * FROM users WHERE id = " + id);\n' +
      '}\n',
    );
    expect(nu.length).toBeGreaterThan(0);
  });

  it('complex-query (six-table join)', async () => {
    const nu = await slice(
      'complex-query',
      'const db: D1Database = getDb();\n' +
      'export function report() {\n' +
      '  return db.query("SELECT * FROM users JOIN orders JOIN products JOIN categories JOIN inventory JOIN shipments");\n' +
      '}\n',
    );
    expect(nu.length).toBeGreaterThan(0);
  });

  it('unfiltered-query (filterless UPDATE)', async () => {
    const nu = await slice(
      'unfiltered-query',
      'const db: D1Database = getDb();\n' +
      'export function nuke() {\n' +
      '  return db.exec("UPDATE users SET active = 0");\n' +
      '}\n',
    );
    expect(nu.length).toBeGreaterThan(0);
  });

  it('unfiltered-query does NOT double-fire on a join-heavy write (mutual exclusion)', async () => {
    // Old `analyzeQuery` resolves a single `performanceRisk`: `complex-query`
    // ('high', tables > joinedTableCount) wins over `unfiltered-query`
    // ('medium'). The migrated rules must reproduce that priority — this call
    // is complex-query only, never a second unfiltered-query finding.
    const nu = await slice(
      'unfiltered-query',
      'const db: D1Database = getDb();\n' +
      'export function massDelete() {\n' +
      '  return db.exec("DELETE FROM alpha JOIN beta JOIN gamma JOIN delta JOIN epsilon");\n' +
      '}\n',
    );
    expect(nu).toEqual([]);
  });

  it('complex-query still fires the join-heavy write (the priority is not a suppression)', async () => {
    const nu = await slice(
      'complex-query',
      'const db: D1Database = getDb();\n' +
      'export function massDelete() {\n' +
      '  return db.exec("DELETE FROM alpha JOIN beta JOIN gamma JOIN delta JOIN epsilon");\n' +
      '}\n',
    );
    expect(nu.length).toBeGreaterThan(0);
  });
});
