/**
 * Spec 68 §3.2 / Spec 70 Item 4 (step 3) — the `schema-usage` producer.
 *
 * The liveness guard (§16.1) proves the producer returns a live, shaped array;
 * this test proves the extraction is *correct* against the fields the
 * cross-domain lifecycle rules read: the resolved `tableName`, the usage verb
 * (`usageType`), and the enclosing-function identity (`functionName` +
 * coordinate). It exercises the full collapse: the `schema-usage-candidates`
 * file producer extracts the raw candidates, and the `schema-usage` corpus
 * producer re-derives `dbProvenanced`, re-applies the file gate, re-admits the
 * provenance-dependent references, and re-homes them from the projected function
 * + string-fragment spans.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { buildSchemaUsage } from '../phase/runner.js';
import type { SchemaUsageFact } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

/** Build the `schema-usage` fact through the full collapse for one file. */
async function usage(source: string, path = '/fixture/a.ts'): Promise<SchemaUsageFact[]> {
  return buildSchemaUsage([{ path, content: source }], 'sqlite');
}

describe('Spec 68 schema-usage producer', () => {
  it('resolves a tagged-template SELECT to its table with the enclosing function', async () => {
    const out = await usage([
      'export function listUsers(db) {',
      '  const q = sql`SELECT * FROM users WHERE id = 1`;',
      '  return q;',
      '}',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    const row = out[0];
    expect(row.tableName).toBe('users');
    expect(row.usageType).toBe('select');
    expect(row.functionName).toBe('listUsers');
    expect(row.filePath).toBe('/fixture/a.ts');
    // The identity is a coordinate: the enclosing function's start line is the
    // function's declaration line, never null for an in-function usage.
    expect(row.functionStartLine).toBe(1);
  });

  it('returns an empty array for a file with no table references', async () => {
    const out = await usage('export const x = 1;\n');
    expect(out).toEqual([]);
  });

  it('re-homes a top-level tagged reference to the string-fragment start', async () => {
    // A top-level (outside any function) SQL reference re-homes to the deepest
    // node containing the table name — a `string_fragment` — whose start is the
    // content start right after the backtick (column 15 here), not the table's
    // own column (29) and not the call's start.
    const out = await usage('const q = sql`SELECT * FROM users WHERE id = 1`;\n');
    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row.tableName).toBe('users');
    expect(row.functionName).toBe('top-level');
    expect(row.functionStartLine).toBe(1);
    expect(row.functionStartColumn).toBe(15);
    expect(row.line).toBe(1);
    expect(row.column).toBe(29);
  });
});
