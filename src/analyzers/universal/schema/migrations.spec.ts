/**
 * Block 2 — `stale-table-reference`: a DROP inside a test/spec file is not a
 * production table lifecycle event.
 *
 * `replayDdlDeclarations` is the shared pass both the `resolution` (known-table
 * set) and `migration-history` (drop provenance) corpus producers reduce, so a
 * test-file DROP that slips into it would mark a production table dropped and
 * turn every later reference into a `stale-table-reference` false positive. The
 * fix skips test/spec files before replay: a `DROP TABLE users` in
 * `codeIndexDB-security.spec.ts` neither removes `users` from the known set nor
 * records a drop-provenance entry. A DROP in a real migration (`migrations/`) is
 * unaffected.
 */

import { describe, it, expect } from 'vitest';
import { replayDdlDeclarations, parseMigrationOps } from './migrations.js';
import type { MigrationOp } from './types.js';

function file(filePath: string, ops: MigrationOp[]) {
  return { filePath, ops };
}

describe('replayDdlDeclarations — test/spec DROPs are not production lifecycle', () => {
  it('a DROP in a .spec.ts file does not remove the table or record drop provenance', () => {
    const { netTables, dropProvenance } = replayDdlDeclarations([
      file('migrations/001_init.sql', [{ op: 'CREATE', table: 'users' }]),
      file('src/__tests__/codeIndexDB-security.spec.ts', [{ op: 'DROP', table: 'users' }]),
    ]);
    expect(netTables.map((t) => t.name)).toContain('users');
    expect(dropProvenance.has('users')).toBe(false);
  });

  it('a DROP in a production migration still removes the table and records provenance', () => {
    const { netTables, dropProvenance } = replayDdlDeclarations([
      file('migrations/001_init.sql', [{ op: 'CREATE', table: 'users' }]),
      file('migrations/002_drop_users.sql', [{ op: 'DROP', table: 'users' }]),
    ]);
    expect(netTables.map((t) => t.name)).not.toContain('users');
    expect(dropProvenance.get('users')?.migrationFile).toBe('migrations/002_drop_users.sql');
  });

  it('a DROP in a test/ directory or __tests__/ segment is also skipped', () => {
    const { netTables, dropProvenance } = replayDdlDeclarations([
      file('migrations/001_init.sql', [{ op: 'CREATE', table: 'users' }]),
      file('tests/drop-users.test.ts', [{ op: 'DROP', table: 'users' }]),
    ]);
    expect(netTables.map((t) => t.name)).toContain('users');
    expect(dropProvenance.has('users')).toBe(false);
  });
});

describe('parseMigrationOps — FTS5 virtual tables are recovered as CREATE ops', () => {
  it('recovers a CREATE VIRTUAL TABLE header the SQL parser rejects', () => {
    const ops = parseMigrationOps(
      'CREATE VIRTUAL TABLE functions_fts USING fts5(name, body, tokenize="porter unicode61");',
      'sqlite',
    );
    expect(ops).toContainEqual({ op: 'CREATE', table: 'functions_fts' });
  });

  it('a dropped-and-recreated virtual table nets to known, not dropped', () => {
    const source = [
      'CREATE VIRTUAL TABLE functions_fts USING fts5(name, body);',
      'DROP TABLE functions_fts;',
      'CREATE VIRTUAL TABLE functions_fts USING fts5(name, body);',
    ].join('\n');
    const { netTables, dropProvenance } = replayDdlDeclarations([
      file('migrations/001_init.sql', parseMigrationOps(source, 'sqlite')),
    ]);
    expect(netTables.map((t) => t.name)).toContain('functions_fts');
    expect(dropProvenance.has('functions_fts')).toBe(false);
  });
});

describe('parseMigrationOps — a null dialect abstains, it does not guess sqlite', () => {
  it('emits no ops for an undetermined dialect, even for valid sqlite DDL', () => {
    // The DDL is valid sqlite, but the corpus named no dialect. Parsing it under
    // sqlite would be a guess that a pg+mysql-ambiguous corpus never suggested.
    const source = 'CREATE TABLE a (id INT); ALTER TABLE a RENAME TO b; DROP TABLE b;';
    expect(parseMigrationOps(source, null)).toEqual([]);
  });

  it('emits no FTS5 recovery ops for a null dialect', () => {
    expect(
      parseMigrationOps('CREATE VIRTUAL TABLE f USING fts5(name);', null),
    ).toEqual([]);
  });

  it('still extracts ops under a named dialect', () => {
    expect(parseMigrationOps('CREATE TABLE a (id INT);', 'sqlite')).toEqual([
      { op: 'CREATE', table: 'a' },
    ]);
  });
});

describe('parseMigrationOps — comments must not desynchronize statement splitting', () => {
  it('an apostrophe in a -- line comment does not swallow later DDL statements', () => {
    // The apostrophe in "don't" used to open a string literal that the splitter
    // never closed, collapsing every `;` after it into one statement — the
    // producer emitted only the first op. A comment must never affect splitting.
    const source = [
      "-- Relax the FK -- build_id values that don't map to stadium_builds.",
      'ALTER TABLE articles RENAME TO articles_old;',
      'CREATE TABLE articles (id INTEGER PRIMARY KEY);',
      'DROP TABLE legacy_articles;',
    ].join('\n');
    const ops = parseMigrationOps(source, 'sqlite');
    expect(ops).toContainEqual({ op: 'RENAME', table: 'articles', newTable: 'articles_old' });
    expect(ops).toContainEqual({ op: 'CREATE', table: 'articles' });
    expect(ops).toContainEqual({ op: 'DROP', table: 'legacy_articles' });
  });

  it('a semicolon inside a block comment is prose, not a statement boundary', () => {
    const source = [
      '/* drop it; keep it */',
      'DROP TABLE a;',
      'DROP TABLE b;',
    ].join('\n');
    const ops = parseMigrationOps(source, 'sqlite');
    expect(ops).toContainEqual({ op: 'DROP', table: 'a' });
    expect(ops).toContainEqual({ op: 'DROP', table: 'b' });
  });
});
