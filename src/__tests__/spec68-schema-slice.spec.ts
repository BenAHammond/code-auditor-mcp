/**
 * Spec 68 §3.2 — the schema slice, end to end: parse → `schema-usage` +
 * `table-catalog` → schema rules → findings.
 *
 * This proves the corpus-processor path once: `unknown-table` reads a fact
 * (`table-catalog`) that is itself *derived* from `schema-code` (DDL), so the
 * slice runs the full §5 chain — per-file schema-usage and schema-code
 * extraction, the table-catalog reduction, then the rule over both facts. A
 * `ghost_table` reference against a catalog that only declares `users` fires
 * `unknown-table`; a reference to the declared table does not.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runSchemaSlice } from '../phase/runner.js';
import type { InputFile } from '../phase/runner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function ts(source: string): InputFile {
  return { path: '/fixture/sample.ts', content: source };
}

describe('Spec 68 §3.2 schema slice (parse → schema-usage + table-catalog → rules)', () => {
  it('fires unknown-table for a reference absent from the declared catalog', async () => {
    const source = [
      'const migration = `CREATE TABLE users (id INTEGER PRIMARY KEY);`;',
      'export function getGhost() {',
      "  return sql`SELECT * FROM ghost_table`;",
      '}',
    ].join('\n');
    const findings = await runSchemaSlice([ts(source)]);
    expect(findings.map((f) => f.ruleId)).toContain('unknown-table');
    const finding = findings.find((f) => f.ruleId === 'unknown-table')!;
    expect(finding.severity).toBe('critical');
    expect(finding.message).toContain("unknown table 'ghost_table'");
  });

  it('stays quiet when every referenced table is declared', async () => {
    const source = [
      'const migration = `CREATE TABLE users (id INTEGER PRIMARY KEY);`;',
      'export function getUsers() {',
      '  return sql`SELECT * FROM users`;',
      '}',
    ].join('\n');
    const findings = await runSchemaSlice([ts(source)]);
    expect(findings.map((f) => f.ruleId)).toEqual([]);
  });
});
