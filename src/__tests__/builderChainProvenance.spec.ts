/**
 * Spec 63 — fluent/builder-chain provenance.
 *
 * ORM builder chains (`db.selectFrom('users').selectAll().execute()` for kysely,
 * `db.select().from(users).where(...)` for drizzle) interleave `call_expression`
 * and `member_expression` nodes. The provenance seam's `findRootReceiver` (via
 * `resolveReceiverText`) stopped at the first `call_expression` receiver —
 * returning `null` for `a.b().c().d()` — so every fluent ORM chain lost DB
 * provenance the moment a method call appeared mid-chain.
 *
 * The fix descends through `call_expression` receivers into the call's *callee*,
 * so the root receiver is reached through the chain. These tests pin that at the
 * `isDBProvenanced` level: a DB-rooted fluent chain resolves, a non-DB fluent
 * chain does not (no false positive).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter, AST, ASTNode } from '../languages/types.js';
import {
  buildProvenanceContext,
  isDBProvenanced,
  DB_CALL_METHODS,
} from '../analyzers/provenance.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tsAdapter: LanguageAdapter;
let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-builder-chain-'));
}, 30_000);

function collectCalls(node: ASTNode, out: ASTNode[]): void {
  if (node.type === 'call_expression') out.push(node);
  for (const child of node.children ?? []) collectCalls(child, out);
}

async function provenancedLines(code: string, name: string): Promise<number[]> {
  const filePath = join(tmpDir, `${name}.ts`);
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast: AST = parseFile(filePath, sourceCode)!;
  const context = buildProvenanceContext(ast, tsAdapter, sourceCode, { mode: 'hybrid' });
  const calls: ASTNode[] = [];
  collectCalls(ast.root, calls);
  return calls
    .filter((c) =>
      isDBProvenanced(c, {
        adapter: tsAdapter,
        sourceCode,
        context,
        methods: DB_CALL_METHODS,
      }),
    )
    .map((c) => c.location.start.line);
}

describe('builder-chain provenance — fluent ORM chains resolve their root receiver', () => {
  it('resolves a kysely fluent chain (db.selectFrom().where().selectAll().execute())', async () => {
    const code = `import { Kysely } from 'kysely';
const db = new Kysely<{ users: { id: number } }>({} as any);
export function getUser(id: string) {
  return db.selectFrom('users').where('id', '=', id).selectAll().execute();
}
`;
    const lines = await provenancedLines(code, 'kysely');
    // The terminal .execute() call (line 4) must be DB-provenanced through the chain.
    expect(lines).toContain(4);
  });

  it('resolves a drizzle fluent chain (db.select().from().where())', async () => {
    const code = `import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
const db = drizzle(createClient({ url: 'file:app.db' }));
export function getUser(id: string) {
  return db.select().from('users' as any).where((s) => s\`id = \${id}\`);
}
`;
    const lines = await provenancedLines(code, 'drizzle');
    expect(lines).toContain(5);
  });

  it('does NOT resolve a non-DB fluent chain (no false positive)', async () => {
    const code = `const client = { items: () => ({ all: () => [] }) };
export function run() {
  return client.items().all();
}
`;
    const lines = await provenancedLines(code, 'nondb');
    expect(lines).toHaveLength(0);
  });
});
