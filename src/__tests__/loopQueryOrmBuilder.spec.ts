/**
 * #406.3 — loop-query ORM-builder must-fire pins.
 *
 * The Block 3 hoisted-reuse discriminator previously keyed on "no SQL string
 * argument on the eager call", which wrongly suppressed *ORM builder* N+1s: a
 * Drizzle `db.select().from(…).where(…)` chain and a Prisma
 * `prisma.user.findUnique({ where: … })` are both member-expression calls with
 * no SQL literal, so the old discriminator dropped them. These fixtures pin both
 * shapes as must-fire so that regression cannot return.
 *
 * The discriminator is now the *prepare* — a statement is hoisted re-use only
 * when the in-loop call's member-chain base identifier is bound to a
 * `.prepare()` result declared outside the loop. An ORM builder has no prepare,
 * so it always keeps firing; the receiver is never prepare-bound.
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
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-loop-orm-'));
}, 30_000);

async function loopQueryViolations(code: string, name: string): Promise<any[]> {
  const filePath = join(tmpDir, `${name}.ts`);
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  const vs = (await (analyzer as any).analyzeAST(ast, tsAdapter, DEFAULT_DATA_ACCESS_CONFIG, sourceCode)) as any[];
  return vs.filter((v) => v.rule === 'loop-query');
}

describe('loop-query ORM-builder N+1 (must-fire)', () => {
  it('fires a Drizzle db.select().from().where() chain per iteration', async () => {
    const code = `import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
const db = drizzle(createClient({ url: 'file:app.db' }));

async function sync(ids: string[]) {
  for (const id of ids) {
    await db.select().from('users' as any).where((s) => s\`id = \${id}\`);
  }
}
`;
    const vs = await loopQueryViolations(code, 'drizzle-builder-in-loop');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('fires a Prisma prisma.user.findUnique() per iteration', async () => {
    const code = `import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function sync(ids: number[]) {
  for (const id of ids) {
    await prisma.user.findUnique({ where: { id } });
  }
}
`;
    const vs = await loopQueryViolations(code, 'prisma-findUnique-in-loop');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('fires a Prisma prisma.user.findMany() per iteration', async () => {
    const code = `import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function sync(names: string[]) {
  for (const name of names) {
    await prisma.user.findMany({ where: { name } });
  }
}
`;
    const vs = await loopQueryViolations(code, 'prisma-findMany-in-loop');
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });
});
