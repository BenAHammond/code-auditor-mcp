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
import { initParsers, initializeLanguages } from '../languages/index.js';
import { runLoopQueriesSlice } from '../phase/runner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

async function loopQueryViolations(code: string, name: string): Promise<any[]> {
  const fresh = await runLoopQueriesSlice([{ path: `${name}.ts`, content: code }], undefined, 'sqlite');
  return fresh.filter((f) => f.ruleId === 'loop-query');
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
