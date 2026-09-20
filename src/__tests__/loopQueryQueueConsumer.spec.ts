/**
 * loop-query queue-consumer discriminator.
 *
 * `loop-query` was firing on queue consumers: loops over a `MessageBatch` where
 * each message is an independent job that must ack/retry in isolation. The
 * per-iteration query is the contract, not a batchable N+1 — batching or joining
 * would break the retry semantics, so the finding is unfixable and the `severe`
 * tier is noise.
 *
 * The discriminator: a loop whose body contains a message-lifecycle call
 * (`msg.ack()`, `msg.retry()`, `msg.nack()`, `msg.acknowledge()`,
 * `msg.deleteMessage()`) is a queue consumer, not a batchable N+1 — suppress the
 * finding. A loop with only DB calls and no lifecycle call remains a batchable
 * N+1 and still fires.
 *
 * Negative controls pin that a plain query-in-loop (no lifecycle) and an
 * unrelated member call (`item.markSeen()`) still fire — the discriminator is
 * scoped to the queue-lifecycle vocabulary, not "any member call in a loop".
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
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-loop-queue-'));
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

describe('loop-query queue-consumer discriminator', () => {
  it('suppresses a MessageBatch consumer that acks and retries per message', async () => {
    const code = `import { db } from './db';

type Job = { jobId: string };

async function queue(batch: MessageBatch<Job>, env: Env) {
  for (const msg of batch.messages) {
    try {
      await db.prepare('UPDATE jobs SET status = ? WHERE id = ?').bind('done', msg.body.jobId).run();
      msg.ack();
    } catch (e) {
      msg.retry();
    }
  }
}
`;
    expect((await loopQueryViolations(code, 'ack-retry-consumer')).length).toBe(0);
  });

  it('suppresses an SQS-style consumer that acknowledges each message', async () => {
    const code = `import { db } from './db';

async function handler(records: { id: string }[]) {
  for (const record of records) {
    await db.prepare('INSERT INTO processed (id) VALUES (?)').bind(record.id).run();
    record.acknowledge();
  }
}
`;
    expect((await loopQueryViolations(code, 'sqs-acknowledge')).length).toBe(0);
  });

  it('suppresses a consumer that nacks failed messages', async () => {
    const code = `import { db } from './db';

async function drain(queue: MessageBatch<{ id: string }>) {
  for (const msg of queue.messages) {
    try {
      await db.prepare('DELETE FROM pending WHERE id = ?').bind(msg.body.id).run();
      msg.ack();
    } catch (e) {
      msg.nack();
    }
  }
}
`;
    expect((await loopQueryViolations(code, 'nack-consumer')).length).toBe(0);
  });

  it('still fires a batchable N+1 with no lifecycle call (plain query-in-loop)', async () => {
    const code = `import { db } from './db';

async function getUserOrders(ids: string[]) {
  for (const id of ids) {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    const orders = await db.prepare('SELECT * FROM orders WHERE user_id = ?').bind(id).all();
  }
}
`;
    expect((await loopQueryViolations(code, 'plain-n-plus-one')).length).toBeGreaterThanOrEqual(1);
  });

  it('still fires a query-in-loop whose body has an unrelated member call', async () => {
    // `markSeen` is not a queue-lifecycle method — the discriminator must be
    // scoped to ack/nack/acknowledge/deleteMessage/retry, not any member call.
    const code = `import { db } from './db';

async function migrate(items: { id: string }[]) {
  for (const item of items) {
    await db.prepare('UPDATE rows SET migrated = 1 WHERE id = ?').bind(item.id).run();
    item.markSeen();
  }
}
`;
    expect((await loopQueryViolations(code, 'unrelated-member-call')).length).toBeGreaterThanOrEqual(1);
  });
});
