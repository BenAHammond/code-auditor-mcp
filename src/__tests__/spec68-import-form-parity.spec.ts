/**
 * Spec 68 §3.2 — parity: the migrated `conventions/import-form` rule reproduces
 * the old `UniversalConventionsAnalyzer`'s findings exactly.
 *
 * `import-form` is the last of the five conventions domains, and the one that
 * reads a fact (`import-form`) the other four domains never needed: the legacy
 * miner/detector ran `parseFileImports` (a regex over raw source text) over the
 * files in the `functions` table, because import form is not persisted. The
 * phase producer re-runs that same regex over `file.source`, so the fact is
 * byte-identical to what the legacy path parsed — but only for files that *have*
 * an indexed function, since the legacy miner read `SELECT DISTINCT file_path
 * FROM functions`. The pure miner therefore drives off the `function-index`
 * distinct-file set (derived in `mineConventionsFromFunctionIndex`), so a file
 * with imports but no indexed function contributes nothing on either path.
 *
 * The producer half is pinned by construction: `mineImportForm` (the legacy DB
 * miner) is now a thin wrapper over `mineImportFormFromFacts`, so the two
 * convention sets are asserted equal before the rule comparison runs. The seed
 * establishes a `named`-dominant convention for `react` in `/p/imports/` and a
 * single `default`-form deviant that must fire.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { UniversalConventionsAnalyzer } from '../analyzers/universal/UniversalConventionsAnalyzer.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { mineConventions, parseFileImports } from '../conventions/conventionMiner.js';
import { mineConventionsFromFunctionIndex } from '../phase/conventionMining.js';
import { analyzeConventions } from '../phase/runner.js';
import type { FunctionIndexFact, MinedConvention, ImportFormFact } from '../phase/types.js';
import type { Convention, ConventionMiningConfig } from '../types.js';
import type { Violation } from '../types.js';

let db: CodeIndexDB;

beforeAll(async () => {
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

/** Small thresholds so a compact fixture establishes the convention. */
const CONFIG: ConventionMiningConfig = {
  minCorpus: 2,
  pairConfidence: 0.5,
  modeShare: 0.5,
  maxConventionsPerDomain: 200,
};

function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

function insertFunction(opts: { name: string; filePath: string; line: number }): number {
  const res = db.run(
    `INSERT INTO functions (name, file_path, line_number, body, language, entity_type, component_type, is_exported)
     VALUES (?, ?, ?, NULL, 'typescript', 'function', NULL, 0)`,
    [opts.name, opts.filePath, opts.line],
  );
  return Number(res.lastInsertRowid);
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

/** The seed: three `named` imports of `react` and one `default` deviant, each in
 *  its own `/p/imports/` file. `sources` is the raw text the legacy path reads
 *  (via `getSource`); `importForms` is the phase fact derived from the same text
 *  through `parseFileImports` — so both paths parse identical input. */
function seed(): {
  sources: Map<string, string>;
  importForms: ImportFormFact[];
  functionIndex: FunctionIndexFact[];
  deviant: string;
} {
  const named = ['i1', 'i2', 'i3'].map((n) => ({
    file: `/p/imports/${n}.ts`,
    content: "import { useState } from 'react';\n",
  }));
  const deviant = { file: '/p/imports/idev.ts', content: "import React from 'react';\n" };

  const sources = new Map<string, string>();
  for (const f of named) sources.set(f.file, f.content);
  sources.set(deviant.file, deviant.content);

  // One function per file (the import-form miner/detector read `functions`).
  const files = [...named, deviant];
  for (const f of files) {
    insertFunction({ name: f.file.split('/').pop()!.replace(/\.ts$/, ''), filePath: f.file, line: 10 });
  }

  // The phase `function-index` fact mirrors the DB rows (id order = file order).
  const functionIndex: FunctionIndexFact[] = files.map((f) => ({
    file: f.file,
    name: f.file.split('/').pop()!.replace(/\.ts$/, ''),
    line: 10,
    endLine: 10,
    entityType: 'function',
    componentType: null,
    isExported: false,
    complexity: 0,
    body: null,
    functionCalls: [],
    language: 'typescript',
  }));

  // The `import-form` fact: parse the same source text the legacy path reads.
  const importForms: ImportFormFact[] = [];
  for (const f of files) {
    for (const imp of parseFileImports(sources.get(f.file)!)) {
      importForms.push({ file: f.file, source: imp.source, form: imp.form, line: imp.line });
    }
  }

  return { sources, importForms, functionIndex, deviant: deviant.file };
}

describe('Spec 68 import-form parity (new analyze(ctx) === old UniversalConventionsAnalyzer)', () => {
  it('produces the same convention set as the DB miner', () => {
    const { sources, importForms, functionIndex } = seed();
    const getSource = (fp: string) => sources.get(fp);

    const legacyConventions = mineConventions(db.rawDb, CONFIG, undefined, getSource, undefined);
    const newConventions = mineConventionsFromFunctionIndex(functionIndex, [], importForms, CONFIG);

    // Only import-form is mined (no calls/bodies/exports in the seed).
    expect(legacyConventions.map((c) => c.domain)).toEqual(['import-form']);
    expect(newConventions.map((c) => c.domain)).toEqual(['import-form']);

    const legacyProjected = legacyConventions.map(toMinedConvention).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const newProjected = newConventions.map((c) => ({ ...c })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(newProjected).toEqual(legacyProjected);
  });

  it('fires the deviant and matches the legacy multiset exactly', async () => {
    const { sources, importForms, functionIndex, deviant } = seed();
    const getSource = (fp: string) => sources.get(fp);

    const legacyConventions = mineConventions(db.rawDb, CONFIG, undefined, getSource, undefined);
    insertConventions(legacyConventions);

    const analyzer = new UniversalConventionsAnalyzer();
    const legacy = await analyzer.analyze(['a.ts'], { indexHandle: db, readSource: getSource });

    const newConventions = mineConventionsFromFunctionIndex(functionIndex, [], importForms, CONFIG);
    const fresh = await analyzeConventions(functionIndex, newConventions, [], importForms);

    const old = legacy.violations
      .filter((v: Violation) => v.rule === 'conventions/import-form')
      .map((v: Violation) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
      .sort();
    const nu = fresh
      .filter((f) => f.ruleId === 'conventions/import-form')
      .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
      .sort();

    expect(nu).toEqual(old);
    expect(nu).toEqual([`${deviant}:1:1:conventions/import-form:high`]);
  });

  it('does not fire when every import of a source uses the dominant form', async () => {
    const { sources, importForms, functionIndex } = seed();

    // Replace the deviant with a fourth named import (no minority form).
    const namedOnly = [
      'i1', 'i2', 'i3',
    ].map((n) => ({ file: `/p/imports/${n}.ts`, content: "import { useState } from 'react';\n" }));
    namedOnly.push({ file: '/p/imports/i4.ts', content: "import { useEffect } from 'react';\n" });

    sources.clear();
    for (const f of namedOnly) sources.set(f.file, f.content);

    const getSource = (fp: string) => sources.get(fp);

    const legacyConventions = mineConventions(db.rawDb, CONFIG, undefined, getSource, undefined);
    insertConventions(legacyConventions);
    const analyzer = new UniversalConventionsAnalyzer();
    const legacy = await analyzer.analyze(['a.ts'], { indexHandle: db, readSource: getSource });

    const allFacts = namedOnly.map((f) => ({
      file: f.file,
      name: f.file.split('/').pop()!.replace(/\.ts$/, ''),
      line: 10,
      endLine: 10,
      entityType: 'function' as const,
      componentType: null,
      isExported: false,
      complexity: 0,
      body: null,
      functionCalls: [],
      language: 'typescript',
    }));
    const allImportForms: ImportFormFact[] = [];
    for (const f of namedOnly) {
      for (const imp of parseFileImports(f.content)) {
        allImportForms.push({ file: f.file, source: imp.source, form: imp.form, line: imp.line });
      }
    }
    const newConventions = mineConventionsFromFunctionIndex(allFacts, [], allImportForms, CONFIG);
    const fresh = await analyzeConventions(allFacts, newConventions, [], allImportForms);

    const old = legacy.violations.filter((v: Violation) => v.rule === 'conventions/import-form');
    const nu = fresh.filter((f) => f.ruleId === 'conventions/import-form');
    expect(nu.length).toBe(0);
    expect(old.length).toBe(0);
  });
});
