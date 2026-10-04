/**
 * Spec 63 — fluent/builder-chain root resolution (re-anchored on the seam).
 *
 * ORM builder chains (`db.selectFrom('users').selectAll().execute()` for kysely,
 * `db.select().from(users).where(...)` for drizzle) interleave `call_expression`
 * and `member_expression` nodes. The root-receiver walk must descend *through*
 * `call_expression` receivers into the call's callee, so a fluent chain still
 * resolves to its leftmost identifier (`db`) rather than stopping mid-chain.
 *
 * The original test pinned this at the now-deleted `isDBProvenanced` /
 * `findRootReceiver` (a dead parallel of the resolution seam). Spec 70 R3 deleted
 * that method-name handle test, so the regression now pins the same walk at
 * `resolveReceiverRoot` — the seam `identifyHandle`'s declaration-resolution
 * source actually reads. A DB-rooted fluent chain resolves; a non-DB fluent chain
 * resolves to its own root (no false provenance).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter, ASTNode } from '../languages/types.js';
import { resolveReceiverRoot } from '../analyzers/receiverRoot.js';
import { getCallExpressionCallee } from '../analyzers/provenance.js';

let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

/** Root of the outermost *method* call's callee in `src`. */
function rootOf(src: string): string | null {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('/fixture/chain.ts')!;
  const ast = parseFile('/fixture/chain.ts', src)!;
  try {
    const calls = adapter.findNodes(ast, { custom: (n: ASTNode) => n.type === 'call_expression' });
    // A fluent chain is the outermost call whose callee is a `member_expression`
    // (a `.method(...)`). Factory calls like `drizzle(...)` or `createClient(...)`
    // have an identifier callee and are skipped; pre-order lists the chain's outer
    // `.where(...)` before its inner `.select()`/`.from()` members, so `[0]` here is
    // the full chain. Its callee carries every intermediate `call_expression`, so
    // resolving it exercises the descend-through-call_expression walk.
    const outer = calls.find((c) => getCallExpressionCallee(c, adapter)?.type === 'member_expression');
    if (!outer) return null;
    const callee = getCallExpressionCallee(outer, adapter)!;
    return resolveReceiverRoot(callee, adapter, src);
  } finally {
    ast.dispose?.();
  }
}

describe('builder-chain root resolution — fluent ORM chains resolve their root receiver', () => {
  it('resolves a kysely fluent chain (db.selectFrom().where().selectAll().execute())', () => {
    const code = `import { Kysely } from 'kysely';
const db = new Kysely<{ users: { id: number } }>({} as any);
export function getUser(id: string) {
  return db.selectFrom('users').where('id', '=', id).selectAll().execute();
}
`;
    expect(rootOf(code)).toBe('db');
  });

  it('resolves a drizzle fluent chain (db.select().from().where())', () => {
    const code = `import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
const db = drizzle(createClient({ url: 'file:app.db' }));
export function getUser(id: string) {
  return db.select().from('users' as any).where((s) => s\`id = \${id}\`);
}
`;
    expect(rootOf(code)).toBe('db');
  });

  it('resolves a non-DB fluent chain to its own root (no false provenance)', () => {
    const code = `const client = { items: () => ({ all: () => [] }) };
export function run() {
  return client.items().all();
}
`;
    expect(rootOf(code)).toBe('client');
  });
});
