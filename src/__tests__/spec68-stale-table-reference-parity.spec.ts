/**
 * Spec 68 §3.2 — parity: the migrated `stale-table-reference` rule reproduces
 * the old Stage-3 schema reducer's findings exactly.
 *
 * `stale-table-reference` is the one schema rule whose old path was the
 * cross-file Stage-3 reducer (`createSchemaReducer`), not `analyzeAST`: it needs
 * the migration-history — which migration dropped a table and what that
 * migration introduced — which is only visible across files. This test runs BOTH
 * paths — the legacy reducer over reshaped facts and the new `analyze(ctx)` over
 * the same `schema-usage` + `table-catalog` + `migration-history` facts — and
 * asserts the identity multiset (file, line, column, rule, severity) is equal and
 * non-empty.
 *
 * The producer half is pinned by construction: `buildDropProvenance` is the
 * identical pure function the legacy reducer's inline drop-provenance replay
 * used, and `extractSchemaUsage` reproduces `findTableReferences`. Feeding the
 * reducer the SAME extracted facts (reshaped into its `Record<visitor,
 * {filePath: {ddlOps | tableRefs}}>` input shape) isolates the *rule* half — the
 * partition that sends a dropped-table reference to `stale-table-reference` and
 * not `unknown-table`, and the exact message/resolution — which is what §15
 * deletes when the reducer goes away.
 *
 * Two message shapes are pinned because the legacy message branches on whether
 * the dropping migration introduced successor tables:
 *   - `createdInSameMigration` non-empty → "creates a and b";
 *   - empty → "was not recreated".
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { createSchemaReducer } from '../pipelineAdapters.js';
import {
  buildSchemaUsage,
  buildDdlDeclarations,
  analyzeSchemaRules,
} from '../phase/runner.js';
import { CORPUS_PRODUCERS } from '../phase/producers.js';
import type { SchemaUsageFact, SchemaDeclaration } from '../phase/types.js';
import type { MigrationOp } from '../analyzers/universal/schema/types.js';
import type { Violation } from '../types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** A file to parse, with its source already read. */
type File = { path: string; content: string };

/** Reshape the phase facts into the legacy reducer's `allFacts` input shape. */
function reshapeToReducerFacts(
  usages: SchemaUsageFact[],
  declarations: SchemaDeclaration[],
): Record<string, Record<string, unknown>> {
  const ddlByFile: Record<string, { ddlOps: MigrationOp[] }> = {};
  for (const decl of declarations) {
    ddlByFile[decl.file] = { ddlOps: [...decl.ops] };
  }
  const tableRefsByFile: Record<string, { tableRefs: Array<{ table: string; type: string; line: number; column: number; context: string }> }> = {};
  for (const u of usages) {
    if (u.origin === 'query-builder') continue;
    (tableRefsByFile[u.filePath] ??= { tableRefs: [] }).tableRefs.push({
      table: u.tableName,
      type: u.usageType,
      line: u.line,
      column: u.column ?? 0,
      context: u.rawQuery ?? '',
    });
  }
  return { 'schema-sql': ddlByFile, 'schema-code': tableRefsByFile };
}

/** Run the old Stage-3 reducer and the new schema rules, return the
 *  `stale-table-reference` identity multisets. */
async function parity(files: File[]) {
  const usages = await buildSchemaUsage(files);
  const declarations = await buildDdlDeclarations(files);
  const allFacts = reshapeToReducerFacts(usages, declarations);

  // Old path — the legacy schema reducer over the same reshaped facts.
  const reducer = createSchemaReducer();
  const { violations } = await reducer.reduce(allFacts, { projectRoot: '/test', config: {} } as never);
  const old = (violations as Violation[])
    .filter((v) => v.rule === 'stale-table-reference')
    .map((v) => key(v))
    .sort();

  // New path — the migrated rules over the same facts.
  const catalog = CORPUS_PRODUCERS['table-catalog'].process({ 'ddl-declarations': declarations });
  const migrationHistory = CORPUS_PRODUCERS['migration-history'].process({ 'ddl-declarations': declarations });
  const fresh = await analyzeSchemaRules(usages, catalog, migrationHistory);
  const nu = fresh
    .filter((f) => f.ruleId === 'stale-table-reference')
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();

  return { old, nu, fresh, violations: violations as Violation[] };
}

describe('Spec 68 stale-table-reference parity (new analyze(ctx) === old Stage-3 reducer)', () => {
  it('a reference to a dropped table with successor tables fires once, naming them', async () => {
    const files: File[] = [
      { path: 'migrations/001_init.sql', content: 'CREATE TABLE generation_queue (id INT);\n' },
      {
        path: 'migrations/002_drop_genqueue.sql',
        content: 'DROP TABLE generation_queue; CREATE TABLE generation_jobs (id INT); CREATE TABLE reads_jobs (id INT);\n',
      },
      {
        path: 'src/rewind.ts',
        content:
          'import { sql } from "./db";\n' +
          'export function rewind() {\n' +
          '  return sql`SELECT * FROM generation_queue`;\n' +
          '}\n',
      },
    ];
    const { old, nu, fresh } = await parity(files);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);

    const f = fresh.filter((x) => x.ruleId === 'stale-table-reference')[0];
    expect(f).toMatchObject({
      ruleId: 'stale-table-reference',
      severity: 'critical',
      message: 'generation_queue was dropped in 002_drop_genqueue.sql; that migration creates generation_jobs and reads_jobs.',
      symbol: 'generation_queue',
    });
    expect(f.resolution).toMatchObject({
      action: 'update-stale-reference',
      symbols: ['generation_jobs', 'reads_jobs'],
    });
    expect(f.resolution?.summary).toContain('review this reference and update or remove it');
  });

  it('a dropped table with no successor names the drop and is not recreated', async () => {
    const files: File[] = [
      { path: 'migrations/001_init.sql', content: 'CREATE TABLE generation_queue (id INT); CREATE TABLE users (id INT);\n' },
      { path: 'migrations/002_drop_genqueue.sql', content: 'DROP TABLE generation_queue;\n' },
      {
        path: 'src/rewind.ts',
        content:
          'import { sql } from "./db";\n' +
          'export function rewind() {\n' +
          '  return sql`SELECT * FROM generation_queue`;\n' +
          '}\n',
      },
    ];
    const { old, nu, fresh } = await parity(files);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);

    const f = fresh.filter((x) => x.ruleId === 'stale-table-reference')[0];
    expect(f.message).toBe('generation_queue was dropped in 002_drop_genqueue.sql and was not recreated.');
    expect(f.resolution?.symbols).toEqual(['generation_queue']);
  });

  it('a reference to a still-present table does not fire (not dropped)', async () => {
    const files: File[] = [
      { path: 'migrations/001_init.sql', content: 'CREATE TABLE users (id INT);\n' },
      {
        path: 'src/rewind.ts',
        content:
          'import { sql } from "./db";\n' +
          'export function rewind() {\n' +
          '  return sql`SELECT * FROM users`;\n' +
          '}\n',
      },
    ];
    const { old, nu } = await parity(files);
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });
});
