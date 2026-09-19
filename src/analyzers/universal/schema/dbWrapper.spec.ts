/**
 * Defect #52 — follow custom SQL helper wrappers for table rules.
 *
 * A bare helper like `d1(sql)` (a function whose body `fetch`es the Cloudflare
 * D1 HTTP query API) was invisible to the schema analyzer: `d1` isn't a receiver
 * name, a call method, or a configured wrapper, so `isDBProvenanced` returned
 * false and the SQL it carried never reached `unknown-table` /
 * `stale-table-reference`. `repend-skipped-build-slots.ts`'s dropped
 * `generation_queue` reference was therefore never flagged.
 *
 * The fix learns wrapper names structurally: a named function whose own body
 * performs a DB operation (a D1 REST fetch, or delegation to an already
 * DB-provenanced receiver) is added to `dbProvenanced` as `reason: 'wrapper'`,
 * so calls to it resolve as DB-provenanced and their SQL is extracted.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../../../languages/index.js';
import { parseFile } from '../../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../../languages/types.js';
import { buildProvenanceContext } from '../../provenance.js';
import { findTableReferences } from './codeAnalysis.js';
import { DEFAULT_SCHEMA_CONFIG } from './config.js';

let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

function analyze(code: string): {
  provenanced: string[];
  tables: string[];
} {
  const ast = parseFile('test.ts', code);
  if (!ast) throw new Error('Failed to parse test.ts');

  const provenanceContext = buildProvenanceContext(ast, tsAdapter, code, {
    mode: 'hybrid',
    dbReceiverNames: DEFAULT_SCHEMA_CONFIG.dbReceiverNames,
    dbBindingNames: DEFAULT_SCHEMA_CONFIG.dbBindingNames,
    dbWrapperNames: DEFAULT_SCHEMA_CONFIG.dbWrapperNames,
  });

  const refs = findTableReferences(ast, tsAdapter, code, {
    config: DEFAULT_SCHEMA_CONFIG,
    provenanceContext,
  });

  return {
    provenanced: [...provenanceContext.dbProvenanced.keys()].filter(
      (k) => provenanceContext.dbProvenanced.get(k)?.reason === 'wrapper',
    ),
    tables: refs.references.map((r) => r.table),
  };
}

describe('DB-wrapper function detection (defect #52)', () => {
  it('marks a D1 REST-fetch helper as a wrapper and extracts its SQL tables', () => {
    const code = `const ACCOUNT_ID = "x"; const DB_ID = "y";
async function d1<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await fetch(\`https://api.cloudflare.com/client/v4/accounts/\${ACCOUNT_ID}/d1/database/\${DB_ID}/query\`, {
    method: "POST", body: JSON.stringify({ sql, params }),
  });
  const j = await r.json() as { success: boolean; result: Array<{ results: T[] }>; errors: unknown[] };
  if (!j.success) throw new Error(String(j.errors));
  return j.result[0]?.results ?? [];
}
const skipped = await d1(\`SELECT dedup_key FROM generation_queue WHERE state='skipped'\`, []);
`;
    const { provenanced, tables } = analyze(code);
    expect(provenanced).toContain('d1');
    expect(tables).toContain('generation_queue');
  });

  it('marks a helper that delegates to a provenanced receiver (db.prepare) as a wrapper', () => {
    const code = `import Database from 'better-sqlite3';
const db = new Database(':memory:');
function q<T>(sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).bind(...params).all() as T[];
}
const rows = q('SELECT * FROM dropped_table');
`;
    const { provenanced, tables } = analyze(code);
    expect(provenanced).toContain('q');
    expect(tables).toContain('dropped_table');
  });

  it('does not mark an ordinary helper with no DB operation as a wrapper', () => {
    const code = `function d1<T>(value: string): string {
  return value.trim();
}
const out = d1('SELECT * FROM not_a_table');
`;
    const { provenanced, tables } = analyze(code);
    expect(provenanced).toEqual([]);
    expect(tables).toEqual([]);
  });

  it('does not attribute a nested function DB op to the outer (non-wrapper) function', () => {
    const code = `import Database from 'better-sqlite3';
const db = new Database(':memory:');
function outer(items: string[]) {
  const inner = (sql: string) => db.prepare(sql).all();
  return items.map((i) => inner(i));
}
`;
    const { provenanced } = analyze(code);
    // `inner` is DB-provenanced; `outer` only *contains* `inner` — its own body
    // does not perform a DB op, so it must not be learned as a wrapper.
    expect(provenanced).not.toContain('outer');
  });
});
