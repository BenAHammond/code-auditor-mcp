/**
 * Spec 68 §3.2 — the `ddl-declarations` producer.
 *
 * The liveness guard (§16.1) proves the producer returns a live, shaped array;
 * this test proves the extraction is *correct* against the per-file shape the
 * `table-catalog` / `migration-history` corpus processors read: the ordered
 * `ops` (CREATE/DROP/RENAME, verbatim from `parseMigrationOps`) and the
 * per-table `tableColumns` (`extractDdlTableColumns`, lowercased). The producer
 * is a pure projection — it does NOT net-replay, so a file whose only effect is
 * a DROP still yields one declaration carrying its DROP op (the corpus
 * processors replay it across files in migration order).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import type { ParsedFile, SchemaDeclaration } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function code(path: string, source: string): SchemaDeclaration[] {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = {
    file: path,
    format: 'typescript',
    source,
    ast,
    adapter: adapter!,
  };
  try {
    return PRODUCERS['ddl-declarations']['typescript'].process(file);
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 68 ddl-declarations producer', () => {
  it('declares one per-file entry: the CREATE op and its columns', () => {
    const out = code('/fixture/migration.ts', [
      'export const up = `',
      'CREATE TABLE users (',
      '  id TEXT PRIMARY KEY,',
      '  organization_id TEXT NOT NULL',
      ');',
      '`;',
    ].join('\n'));

    expect(out).toHaveLength(1);
    const decl = out[0];
    expect(decl.file).toBe('/fixture/migration.ts');
    expect(decl.ops).toEqual([{ op: 'CREATE', table: 'users' }]);
    // Columns are lowercased by the DDL extractor (the tenant-scoping question
    // compares case-insensitively).
    expect(decl.tableColumns).toEqual({ users: ['id', 'organization_id'] });
  });

  it('extracts natural UNIQUE columns and excludes PRIMARY KEY (bootstrap-lookup signal)', () => {
    const out = code('/fixture/unique.ts', [
      'export const up = `',
      'CREATE TABLE api_key (',
      '  id TEXT PRIMARY KEY,',
      '  prefix TEXT UNIQUE,',
      '  hashed_token TEXT UNIQUE,',
      '  workspace_id TEXT NOT NULL',
      ');',
      '`;',
    ].join('\n'));

    expect(out).toHaveLength(1);
    // `id` is a PRIMARY KEY — the IDOR surface, not a bootstrap signal — so it is
    // excluded; only the natural UNIQUE columns survive.
    expect(out[0].uniqueColumns).toEqual({ api_key: ['prefix', 'hashed_token'] });
  });

  it('excludes a table-level PRIMARY KEY (composite) from the unique set', () => {
    const out = code('/fixture/pk.ts', [
      'export const up = `',
      'CREATE TABLE line_items (invoice_id TEXT, line_no INT, sku TEXT UNIQUE, PRIMARY KEY (invoice_id, line_no));',
      '`;',
    ].join('\n'));

    expect(out).toHaveLength(1);
    expect(out[0].uniqueColumns).toEqual({ line_items: ['sku'] });
  });

  it('extracts table-level UNIQUE constraints and ALTER UNIQUE columns', () => {
    const out = code('/fixture/unique-composite.ts', [
      'export const up = `',
      'CREATE TABLE page (id TEXT, slug TEXT, workspace_id TEXT, UNIQUE (slug));',
      'ALTER TABLE page ADD CONSTRAINT page_slug_unique UNIQUE (slug);',
      '`;',
    ].join('\n'));

    expect(out).toHaveLength(1);
    expect(out[0].uniqueColumns).toEqual({ page: ['slug'] });
  });

  it('preserves a DROP-only migration — the op is carried, not netted away', () => {
    const out = code('/fixture/dropped.ts', [
      'export const up = `',
      'DROP TABLE generation_queue;',
      '`;',
    ].join('\n'));

    // The net table set is empty (the file declares no surviving table), but the
    // DROP op must survive into the corpus processors, which replay it to mark
    // `generation_queue` a stale reference in later files.
    expect(out).toHaveLength(1);
    expect(out[0].ops).toEqual([{ op: 'DROP', table: 'generation_queue' }]);
    expect(out[0].tableColumns).toEqual({});
  });

  it('preserves a scratch CREATE+DROP pair (net-set replay is the processor job)', () => {
    const out = code('/fixture/scratch.ts', [
      'export const up = `',
      'CREATE TABLE scratch (id TEXT);',
      'DROP TABLE scratch;',
      '`;',
    ].join('\n'));

    expect(out).toHaveLength(1);
    expect(out[0].ops).toEqual([
      { op: 'CREATE', table: 'scratch' },
      { op: 'DROP', table: 'scratch' },
    ]);
    expect(out[0].tableColumns).toEqual({ scratch: ['id'] });
  });

  it('extracts tenant columns declared through ADD CONSTRAINT … FOREIGN KEY', () => {
    // Drizzle's default for `organization_id → organizations.id` is an ALTER
    // TABLE … ADD CONSTRAINT … FOREIGN KEY ("organization_id") statement, not a
    // CREATE TABLE column or an ADD COLUMN. Without the FK pass these tenant
    // tables fall out of the Tier-3 DDL set and `missing-org-filter` reads a
    // fraction of the real tenant schema.
    const out = code('/fixture/fk.ts', [
      'export const up = `',
      'ALTER TABLE "certifications" ADD CONSTRAINT "certifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "certifications" ADD CONSTRAINT "certifications_certifier_id_certifiers_id_fk" FOREIGN KEY ("certifier_id") REFERENCES "public"."certifiers"("id");',
      '`;',
    ].join('\n'));

    expect(out).toHaveLength(1);
    expect(out[0].tableColumns).toEqual({
      certifications: ['organization_id', 'certifier_id'],
    });
  });

  it('extracts composite foreign-key column lists', () => {
    const out = code('/fixture/composite.ts', [
      'export const up = `',
      'ALTER TABLE "line_items" ADD CONSTRAINT "line_items_pk" FOREIGN KEY ("invoice_id", "line_no") REFERENCES "public"."invoices"("id", "line_no");',
      '`;',
    ].join('\n'));

    expect(out).toHaveLength(1);
    expect(out[0].tableColumns).toEqual({ line_items: ['invoice_id', 'line_no'] });
  });

  it('returns an empty array for a file with no DDL', () => {
    const out = code('/fixture/c.ts', 'export const x = 1;\n');
    expect(out).toEqual([]);
  });
});
