/**
 * Spec 68 §3.2 — parity: the migrated conventions rules reproduce the old
 * `UniversalConventionsAnalyzer`'s findings exactly.
 *
 * The conventions analyzer is the third index-backed analyzer migrated (after
 * styles and cross-domain): it never walked an AST, it queried the SQLite
 * `conventions` + `functions` + `function_calls` tables. So the parity test seeds
 * those tables in an in-memory `CodeIndexDB`, mines the conventions the legacy
 * path would (`mineConventions` over the raw handle), runs the legacy
 * `analyze(files, { indexHandle })`, then re-reads the *same* rows as the
 * `function-index` fact and reduces them through `mineConventionsFromFunctionIndex`
 * into the `mined-conventions` fact. The rule half is what is pinned — same file,
 * line, column, rule, severity — on the full multiset, for the three domains the
 * `function-index` fact can serve (usage-pair / error-handling / naming).
 *
 * The producer half is pinned by construction: `mineConventions` (the legacy
 * miner) is now a thin wrapper over the same pure miners
 * `mineConventionsFromFunctionIndex` calls, so the two convention sets are
 * asserted equal before the rule comparison runs — the test fails on a mining
 * divergence, not just a detector divergence. `import-form` / `export-shape`
 * stay on the legacy path (they read source/export data the `function-index`
 * fact does not carry), so the seed produces no such rows and the domain sets
 * collapse to the three migrated domains.
 *
 * Each domain is isolated in its own directory so the miners' per-directory
 * histograms cannot bleed across domains: `/p/pairs/` (usage-pair), `/p/errors/`
 * (error-handling), `/p/names/` (naming). The seeding order (functions by id,
 * calls grouped by caller) keeps the pure miners' exemplar tiebreak identical on
 * both paths, since the array index in the phase fact is a 1:1 bijection with the
 * DB auto-increment id.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { UniversalConventionsAnalyzer } from '../analyzers/universal/UniversalConventionsAnalyzer.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { mineConventions } from '../conventions/conventionMiner.js';
import { mineConventionsFromFunctionIndex } from '../phase/conventionMining.js';
import { analyzeConventions } from '../phase/runner.js';
import type { FunctionIndexFact, MinedConvention } from '../phase/types.js';
import type { Convention, ConventionMiningConfig } from '../types.js';
import type { Violation } from '../types.js';

let db: CodeIndexDB;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  db = CodeIndexDB.getInstance(':memory:');
  await db.initialize();
}, 30_000);

beforeEach(() => {
  db.exec('DELETE FROM function_calls');
  db.exec('DELETE FROM functions');
  db.exec('DELETE FROM conventions');
});

afterAll(async () => {
  await CodeIndexDB.getInstance().close();
});

/** Small thresholds so a compact fixture establishes and fires each domain. */
const CONFIG: ConventionMiningConfig = {
  minCorpus: 2,
  pairConfidence: 0.5,
  modeShare: 0.5,
  maxConventionsPerDomain: 200,
};

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

function insertFunction(opts: {
  name: string;
  filePath: string;
  line: number;
  body?: string | null;
  entityType?: string;
  componentType?: string | null;
  isExported?: boolean;
}): number {
  const res = db.run(
    `INSERT INTO functions (name, file_path, line_number, body, language, entity_type, component_type, is_exported)
     VALUES (?, ?, ?, ?, 'typescript', ?, ?, ?)`,
    [
      opts.name,
      opts.filePath,
      opts.line,
      opts.body ?? null,
      opts.entityType ?? 'function',
      opts.componentType ?? null,
      opts.isExported ? 1 : 0,
    ],
  );
  return Number(res.lastInsertRowid);
}

function insertCall(callerId: number, calleeName: string): void {
  db.run('INSERT INTO function_calls (caller_id, callee_name) VALUES (?, ?)', [callerId, calleeName]);
}

/** Project a legacy `Convention` onto the serializable `MinedConvention` fact. */
function toMinedConvention(c: Convention): MinedConvention {
  return {
    domain: c.domain,
    rule_id: c.rule_id,
    antecedent: c.antecedent,
    consequent: c.consequent,
    pattern: c.pattern,
    directory: c.directory,
    file_path: c.file_path,
    line: c.line,
    support: c.support,
    total_cases: c.total_cases,
    confidence: c.confidence,
    exemplar_file: c.exemplar_file,
    exemplar_line: c.exemplar_line,
    export_kind: c.export_kind ?? null,
  };
}

/** Insert mined conventions into the table the legacy analyzer queries. */
function insertConventions(conventions: Convention[]): void {
  const insert = db.rawDb.prepare(
    `INSERT INTO conventions
     (domain, rule_id, antecedent, consequent, pattern, directory,
      file_path, line, support, total_cases, confidence,
      exemplar_file, exemplar_line, export_kind, hash)
     VALUES (@domain, @rule_id, @antecedent, @consequent, @pattern,
             @directory, @file_path, @line, @support, @total_cases,
             @confidence, @exemplar_file, @exemplar_line, @export_kind, @hash)`,
  );
  for (const c of conventions) {
    insert.run({
      domain: c.domain,
      rule_id: c.rule_id,
      antecedent: c.antecedent ?? null,
      consequent: c.consequent ?? null,
      pattern: c.pattern ?? null,
      directory: c.directory ?? null,
      file_path: c.file_path ?? null,
      line: c.line ?? null,
      support: c.support,
      total_cases: c.total_cases,
      confidence: c.confidence,
      exemplar_file: c.exemplar_file ?? null,
      exemplar_line: c.exemplar_line ?? null,
      export_kind: (c as any).export_kind ?? null,
      hash: c.hash ?? null,
    });
  }
}

/** Seed the three isolated domains and return the expected per-rule anchors. */
function seed(): Record<string, string[]> {
  // usage-pair: openDb → closeDb is the dominant pair; f3 deviates.
  const f1 = insertFunction({ name: 'f1', filePath: '/p/pairs/f1.ts', line: 10 });
  const f2 = insertFunction({ name: 'f2', filePath: '/p/pairs/f2.ts', line: 20 });
  const f3 = insertFunction({ name: 'f3', filePath: '/p/pairs/f3.ts', line: 30 });
  insertFunction({ name: 'openDb', filePath: '/p/pairs/openDb.ts', line: 40 });
  insertFunction({ name: 'closeDb', filePath: '/p/pairs/closeDb.ts', line: 50 });
  insertCall(f1, 'openDb'); insertCall(f1, 'closeDb');
  insertCall(f2, 'openDb'); insertCall(f2, 'closeDb');
  insertCall(f3, 'openDb');

  // error-handling: try-catch is dominant; e3 uses promise-catch.
  insertFunction({ name: 'e1', filePath: '/p/errors/e1.ts', line: 10, body: '{ try { a(); } catch (e) { b(); } }' });
  insertFunction({ name: 'e2', filePath: '/p/errors/e2.ts', line: 20, body: '{ try { c(); } catch (e) { d(); } }' });
  insertFunction({ name: 'e3', filePath: '/p/errors/e3.ts', line: 30, body: "{ return fetch('/x').catch((e) => null); }" });

  // naming: camelCase is dominant among function exports; GetThing deviates.
  insertFunction({ name: 'fetchUser', filePath: '/p/names/fetchUser.ts', line: 10, isExported: true });
  insertFunction({ name: 'getData', filePath: '/p/names/getData.ts', line: 20, isExported: true });
  insertFunction({ name: 'GetThing', filePath: '/p/names/GetThing.ts', line: 30, isExported: true });

  return {
    'conventions/usage-pair': ['/p/pairs/f3.ts:30:1:conventions/usage-pair:high'],
    'conventions/error-handling': ['/p/errors/e3.ts:30:1:conventions/error-handling:high'],
    'conventions/naming': ['/p/names/GetThing.ts:30:1:conventions/naming:high'],
  };
}

/** Run the legacy analyzer and the new `analyzeConventions`, return per-rule multisets. */
async function parity(expected: Record<string, string[]>): Promise<void> {
  // Legacy conventions, mined over the raw handle (the production path).
  const legacyConventions = mineConventions(db.rawDb, CONFIG);
  insertConventions(legacyConventions);

  const analyzer = new UniversalConventionsAnalyzer();
  const legacy = await analyzer.analyze(['a.ts'], { indexHandle: db });

  // Re-read the SAME rows as the `function-index` fact (id order), and derive the
  // call set from the function_calls table in rowid order (grouped by caller).
  const funcRows = db.query(
    'SELECT id, name, file_path, line_number, body, language, entity_type, component_type, is_exported FROM functions ORDER BY id',
  ) as Array<{
    id: number;
    name: string;
    file_path: string;
    line_number: number;
    body: string | null;
    language: string;
    entity_type: string;
    component_type: string | null;
    is_exported: number;
  }>;
  const idToIndex = new Map<number, number>(funcRows.map((r, i) => [r.id, i]));
  const facts: FunctionIndexFact[] = funcRows.map((r) => ({
    file: r.file_path,
    name: r.name,
    line: r.line_number,
    endLine: r.line_number,
    entityType: r.entity_type as FunctionIndexFact['entityType'],
    componentType: r.component_type,
    isExported: r.is_exported === 1,
    complexity: 0,
    body: r.body,
    functionCalls: [],
    language: r.language,
  }));
  const callRows = db.query('SELECT caller_id, callee_name FROM function_calls') as Array<{
    caller_id: number;
    callee_name: string;
  }>;
  for (const cr of callRows) {
    facts[idToIndex.get(cr.caller_id)!].functionCalls.push(cr.callee_name);
  }

  const newConventions = mineConventionsFromFunctionIndex(facts, CONFIG);

  // Producer parity: the two miners produce the same convention set.
  const legacyProjected = legacyConventions.map(toMinedConvention).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const newProjected = newConventions.map((c) => ({ ...c })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  expect(newProjected).toEqual(legacyProjected);

  const fresh = await analyzeConventions(facts, newConventions);

  for (const ruleId of ['conventions/usage-pair', 'conventions/error-handling', 'conventions/naming']) {
    const old = legacy.violations
      .filter((v: Violation) => v.rule === ruleId)
      .map((v: Violation) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
      .sort();
    const nu = fresh
      .filter((f) => f.ruleId === ruleId)
      .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
      .sort();
    expect(nu, `rule ${ruleId}`).toEqual(old);
    expect(nu, `rule ${ruleId} non-empty`).toEqual(expected[ruleId]);
  }
}

describe('Spec 68 conventions parity (new analyze(ctx) === old UniversalConventionsAnalyzer)', () => {
  it('covers exactly the three function-index-servable conventions rules', async () => {
    const expected = seed();
    expect(Object.keys(expected).sort()).toEqual([
      'conventions/error-handling',
      'conventions/naming',
      'conventions/usage-pair',
    ]);
  });

  it('all three rules fire on their deviants and match the legacy multiset', async () => {
    const expected = seed();
    await parity(expected);
  });

  it('usage-pair does not fire when every antecedent caller also calls the consequent', async () => {
    // No deviant: all openDb callers also call closeDb.
    const f1 = insertFunction({ name: 'f1', filePath: '/p/pairs/f1.ts', line: 10 });
    const f2 = insertFunction({ name: 'f2', filePath: '/p/pairs/f2.ts', line: 20 });
    insertFunction({ name: 'openDb', filePath: '/p/pairs/openDb.ts', line: 40 });
    insertFunction({ name: 'closeDb', filePath: '/p/pairs/closeDb.ts', line: 50 });
    insertCall(f1, 'openDb'); insertCall(f1, 'closeDb');
    insertCall(f2, 'openDb'); insertCall(f2, 'closeDb');

    await parity({ 'conventions/usage-pair': [], 'conventions/error-handling': [], 'conventions/naming': [] });
  });
});
