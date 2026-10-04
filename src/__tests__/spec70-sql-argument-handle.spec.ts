/**
 * Spec 70 R3 criterion #8 — a call whose argument parses as SQL makes its
 * receiver a handle, in TypeScript and in Go.
 *
 * The sql-argument evidence source proves `handle` when the call's first
 * argument is a string/template literal that {@link parseSql} accepts. It is the
 * only evidence source that can prove `handle` *without* a declaration (a
 * package import, a type annotation, or a within-file binding), so it closes the
 * gap the declaration resolution cannot reach — `env.DB`, `knex.raw(…)`,
 * `this.ctx.storage.sql.exec(…)`.
 *
 * The boundary this spec pins, at the enumerator (`collectUnprovenQueryReceivers`):
 *
 *   - a literal SQL argument        → `handle`, NOT surfaced as unproven.
 *   - a non-parseable literal       → `unproven` with "SQL argument does not parse".
 *   - a non-literal (bound) argument → `unproven` on the declaration cause.
 *
 * The last two are the criterion #3 guarantee: an unparseable string is a
 * `cannot-fire`, never a silent `clean`; and the source abstains rather than
 * mis-prove a receiver whose argument is not a literal at all.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { AST, LanguageAdapter } from '../languages/types.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';
import { collectUnprovenQueryReceivers } from '../analyzers/receiverResolution.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function parse(path: string, source: string): { ast: AST; adapter: LanguageAdapter; source: string } {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path)!;
  const ast = parseFile(path, source)!;
  return { ast, adapter, source };
}

function unproven(
  path: string,
  source: string,
  provenance: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
) {
  const { ast, adapter, source: sourceCode } = parse(path, source);
  try {
    return collectUnprovenQueryReceivers(
      { filePath: path, sourceCode, ast, adapter },
      provenance,
      { sqlDialect: 'sqlite' },
    );
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 70 R3 — a parsed SQL argument makes the receiver a handle', () => {
  describe('TypeScript', () => {
    it('a literal SQL argument on an otherwise-unproven receiver is a handle (not unproven)', () => {
      const src = [
        'const dataSource = getConnection();',
        'dataSource.query("SELECT * FROM users WHERE org_id = ?");',
      ].join('\n');
      expect(unproven('/fixture/ts-sql.ts', src)).toEqual([]);
    });

    it('a template-literal SQL argument on an unproven receiver is a handle', () => {
      const src = [
        'const db = getDb();',
        'db.query(`SELECT * FROM users`);',
      ].join('\n');
      expect(unproven('/fixture/ts-template.ts', src)).toEqual([]);
    });

    it('a non-parseable literal stays unproven with the parse reason (never clean)', () => {
      const src = [
        'const dataSource = getConnection();',
        'dataSource.query("not sql at all");',
      ].join('\n');
      const out = unproven('/fixture/ts-unparseable.ts', src);
      expect(out).toHaveLength(1);
      expect(out[0].receiver).toBe('dataSource');
      expect(out[0].reason).toContain('SQL argument does not parse');
    });

    it('a non-literal (bound) argument abstains — unproven on the declaration cause', () => {
      const src = [
        'const dataSource = getConnection();',
        'dataSource.query(sql);',
      ].join('\n');
      const out = unproven('/fixture/ts-bound.ts', src);
      expect(out).toHaveLength(1);
      expect(out[0].receiver).toBe('dataSource');
      expect(out[0].reason).not.toContain('SQL argument does not parse');
    });
  });

  describe('Go', () => {
    it('a literal SQL argument on an unproven receiver is a handle (not unproven)', () => {
      const src = [
        'package main',
        '',
        'func getUser() {',
        '	db := getDB()',
        '	db.Query("SELECT * FROM users WHERE org_id = ?")',
        '}',
      ].join('\n');
      expect(unproven('/fixture/go-sql.go', src)).toEqual([]);
    });

    it('a raw-string SQL argument on an unproven receiver is a handle', () => {
      const src = [
        'package main',
        '',
        'func getUser() {',
        '	db := getDB()',
        '	db.Query(`SELECT * FROM users`)',
        '}',
      ].join('\n');
      expect(unproven('/fixture/go-raw.go', src)).toEqual([]);
    });

    it('a non-parseable literal stays unproven with the parse reason (never clean)', () => {
      const src = [
        'package main',
        '',
        'func getUser() {',
        '	db := getDB()',
        '	db.Query("not sql at all")',
        '}',
      ].join('\n');
      const out = unproven('/fixture/go-unparseable.go', src);
      expect(out).toHaveLength(1);
      expect(out[0].reason).toContain('SQL argument does not parse');
    });

    it('a non-literal argument abstains — unproven on the declaration cause', () => {
      const src = [
        'package main',
        '',
        'func getUser(query string) {',
        '	db := getDB()',
        '	db.Query(query)',
        '}',
      ].join('\n');
      const out = unproven('/fixture/go-bound.go', src);
      expect(out).toHaveLength(1);
      expect(out[0].reason).not.toContain('SQL argument does not parse');
    });
  });
});
