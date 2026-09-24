/**
 * Spec 63 R3 — `await` in a DB initializer must not drop provenance.
 *
 * `const x = await factory()` is *the* async-init idiom in the wild (mysql2's
 * `createConnection`, `pg`/`kysely` async pool factories, `@libsql/client`'s
 * `createClient`, …). The provenance seam had two functions that disagreed on
 * `await_expression`: `getCallExpressionCallee` recursed through it, but
 * `tryPropagateFromExpression` did not — so a connection built via `await` was
 * never seeded into the provenance map, and every downstream call on it
 * (`connection.execute(...)`, `connection.query(...)`) silently lost DB
 * provenance. That is a false clean: the same code with the `await` removed
 * fired, with it present did not.
 *
 * These tests run the real `UniversalDataAccessAnalyzer` via `analyzeAST` and
 * assert that the `await` operand — a call or a `new` — propagates provenance
 * exactly as its non-await twin would.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tsAdapter: LanguageAdapter;
let analyzer: UniversalDataAccessAnalyzer;
let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDataAccessAnalyzer();
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-await-provenance-'));
}, 30_000);

async function dataAccessViolations(code: string, name: string): Promise<any[]> {
  const filePath = join(tmpDir, `${name}.ts`);
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  return (await (analyzer as any).analyzeAST(
    ast, tsAdapter, DEFAULT_DATA_ACCESS_CONFIG, sourceCode,
  )) as any[];
}

describe('await-provenance — const x = await factory() keeps DB provenance', () => {
  it('resolves provenance through await-call: mysql2 createConnection then an injectable execute', async () => {
    const code = `import mysql from 'mysql2/promise';
const connection = await mysql.createConnection({ host: 'localhost', user: 'root' });
export async function getUserById(id: string): Promise<unknown> {
  const [rows] = await connection.execute(\`SELECT * FROM users WHERE id = '\${id}'\`);
  return rows;
}
`;
    const vs = await dataAccessViolations(code, 'await-call');
    const injection = vs.filter((v) => v.rule === 'sql-injection-risk');
    expect(injection.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves provenance through await-new: await new Database(...) then a prepared injectable query', async () => {
    const code = `import Database from 'better-sqlite3';
const db = await new Database('app.db');
export function getUserById(id: string): unknown {
  return db.prepare(\`SELECT * FROM users WHERE id = '\${id}'\`).get();
}
`;
    const vs = await dataAccessViolations(code, 'await-new');
    const injection = vs.filter((v) => v.rule === 'sql-injection-risk');
    expect(injection.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT attribute provenance from an await on a non-DB factory (no false positive)', async () => {
    const code = `const client = await makeHttpClient({ baseUrl: 'https://example.com' });
export function fetch(id: string) {
  return client.execute(\`SELECT * FROM users WHERE id = '\${id}'\`);
}
`;
    const vs = await dataAccessViolations(code, 'await-nondb');
    const injection = vs.filter((v) => v.rule === 'sql-injection-risk');
    expect(injection).toHaveLength(0);
  });
});
