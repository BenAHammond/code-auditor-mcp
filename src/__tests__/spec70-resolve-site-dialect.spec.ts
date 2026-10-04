/**
 * Spec 70 — per-site dialect from the resolved receiver's package.
 *
 * The dialect a call site parses its SQL under is a property of the *located
 * fact*, not the repo: `pool.query(…)` where `pool` resolves to `pg` is
 * postgres, `conn.query(…)` where `conn` resolves to `mysql2` is mysql. A repo
 * that names both drivers is therefore not "ambiguous" for a site whose
 * receiver resolves to one of them — that site names its dialect and parses
 * honestly. Repo-level detection is the *fallback*, not the first read.
 *
 * `resolveSiteDialect` returns null when the receiver carries no package (a
 * type annotation, an in-repo module, a wrapper) or when its package names no
 * single dialect (a cross-dialect ORM like `knex`). The caller
 * (`buildDatabaseCall`) then falls back to repo-level `config.dialect`, and
 * abstains (`cannot-fire`) only when that is also null.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile, findNodes } from '../languages/adapterBridge.js';
import {
  resolveSiteDialect,
  type ProvenanceContext,
  type ProvenanceEvidence,
} from '../analyzers/provenance.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function packageEvidence(packageName: string): ProvenanceEvidence {
  return {
    identifier: '',
    reason: 'package',
    source: `import from ${packageName}`,
    chain: [],
    packageName,
  };
}

describe('Spec 70 — resolveSiteDialect (per-site dialect)', () => {
  it('resolves the dialect from the resolved receiver package, not the repo', () => {
    const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
    const source = [
      'const pool = pg.Pool();',
      'const conn = mysql.createConnection();',
      'pool.query("SELECT 1");',
      'conn.query("SELECT 2");',
    ].join('\n');
    const ast = parseFile('test.ts', source)!;
    const context: ProvenanceContext = {
      dbProvenanced: new Map<string, ProvenanceEvidence>([
        ['pool', packageEvidence('pg')],
        ['conn', packageEvidence('mysql2')],
      ]),
      validatorProvenanced: new Map(),
      mode: 'provenance',
    };
    const calls = findNodes(ast.root, (n) => n.type === 'call_expression');
    const poolCall = calls.find((c) => adapter.getNodeText(c, source).startsWith('pool.query'));
    const connCall = calls.find((c) => adapter.getNodeText(c, source).startsWith('conn.query'));
    try {
      expect(poolCall).toBeDefined();
      expect(connCall).toBeDefined();
      // Two drivers in one repo — each site still names its own dialect.
      expect(resolveSiteDialect(poolCall!, adapter, source, context)).toBe('postgresql');
      expect(resolveSiteDialect(connCall!, adapter, source, context)).toBe('mysql');
    } finally {
      ast.dispose?.();
    }
  });

  it('returns null when the receiver carries no package (a type annotation), for repo-level fallback', () => {
    const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
    const source = [
      'const db: D1Database = getDb();',
      'db.prepare("SELECT 1");',
    ].join('\n');
    const ast = parseFile('test.ts', source)!;
    const context: ProvenanceContext = {
      dbProvenanced: new Map<string, ProvenanceEvidence>(), // D1Database is a type, not a package
      validatorProvenanced: new Map(),
      mode: 'provenance',
    };
    const call = findNodes(ast.root, (n) => n.type === 'call_expression').find((c) =>
      adapter.getNodeText(c, source).startsWith('db.prepare'),
    );
    try {
      expect(call).toBeDefined();
      expect(resolveSiteDialect(call!, adapter, source, context)).toBeNull();
    } finally {
      ast.dispose?.();
    }
  });

  it('returns null for a cross-dialect ORM receiver (knex names no single dialect)', () => {
    const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
    const source = [
      'const knex = require("knex")({});',
      'knex.raw("SELECT 1");',
    ].join('\n');
    const ast = parseFile('test.ts', source)!;
    const context: ProvenanceContext = {
      dbProvenanced: new Map<string, ProvenanceEvidence>([
        ['knex', packageEvidence('knex')],
      ]),
      validatorProvenanced: new Map(),
      mode: 'provenance',
    };
    const call = findNodes(ast.root, (n) => n.type === 'call_expression').find((c) =>
      adapter.getNodeText(c, source).startsWith('knex.raw'),
    );
    try {
      expect(call).toBeDefined();
      expect(resolveSiteDialect(call!, adapter, source, context)).toBeNull();
    } finally {
      ast.dispose?.();
    }
  });
});
