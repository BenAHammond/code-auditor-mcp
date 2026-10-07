/**
 * Defect #46 — loop-query sequential-pipeline discriminator.
 *
 * `loop-query` was firing on intentional sequential pipelines: loops whose body
 * invokes an LLM/agent (embedding, model completion, corpus extraction) and then
 * persists the result per item. Batching or joining those loops would regress
 * rate-limit and per-item crash-recovery semantics, so the finding is unfixable
 * and the `severe` tier is noise.
 *
 * The discriminator: a loop whose body contains an LLM call is an intentional
 * *sequential pipeline*, not a batchable N+1 — suppress the finding. A loop with
 * only DB calls and no LLM call remains a batchable N+1 and still fires.
 *
 * Three LLM signals are pinned:
 *   1. a model-client identifier passed as a call argument (`…(db, model, …)`),
 *   2. an LLM action verb in a callee name (`aiEmbed(…)`),
 *   3. a member callee whose object is a model client (`model.chat(…)`).
 *
 * Negative controls pin that ordinary helper names (`extractRows`) do NOT trip
 * the discriminator, so a real N+1 behind a generic helper still fires.
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

describe('loop-query LLM-pipeline discriminator', () => {
  it('suppresses a loop that passes a model client to a per-item extractor (syncBuildsForHeroes shape)', async () => {
    const code = `const db: D1Database = getDb();

async function syncBuilds(targets: string[]) {
  const model = gatewayDeepseekModel('deepseek-v4-flash');
  for (const slug of targets) {
    const result = await extractBuildsFromCorpus(db, model, slug);
    await db.prepare('UPDATE jobs SET status = ? WHERE slug = ?').bind('done', slug).run();
    if (result.length === 0) {
      await db.prepare('DELETE FROM builds WHERE slug = ?').bind(slug).run();
    }
  }
}
`;
    expect((await loopQueryViolations(code, 'model-arg-pipeline')).length).toBe(0);
  });

  it('suppresses a loop whose body calls an LLM action helper by name (aiEmbed shape)', async () => {
    const code = `const db: D1Database = getDb();

async function reembed(rows: Array<{ id: string; body: string }>) {
  for (const row of rows) {
    const vectors = await aiEmbed(row.body);
    for (const v of vectors) {
      await db.prepare('UPDATE rows SET embedding = ? WHERE id = ?').bind(v, row.id).run();
    }
  }
}
`;
    expect((await loopQueryViolations(code, 'ai-embed-pipeline')).length).toBe(0);
  });

  it('suppresses a loop whose body invokes a member model call (model.chat shape)', async () => {
    const code = `const db: D1Database = getDb();

async function summarize(items: string[]) {
  const model = new ChatModel();
  for (const item of items) {
    const text = await model.chat('summarize ' + item);
    await db.prepare('INSERT INTO summaries (id, text) VALUES (?, ?)').bind(item, text).run();
  }
}
`;
    expect((await loopQueryViolations(code, 'model-chat-pipeline')).length).toBe(0);
  });

  it('still fires a batchable N+1 with no LLM call (plain query-in-loop)', async () => {
    const code = `const db: D1Database = getDb();

async function getUserOrders(ids: string[]) {
  for (const id of ids) {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    const orders = await db.prepare('SELECT * FROM orders WHERE user_id = ?').bind(id).all();
  }
}
`;
    expect((await loopQueryViolations(code, 'plain-n-plus-one')).length).toBeGreaterThanOrEqual(1);
  });

  it('still fires a query-in-loop behind a generic (non-LLM) helper name', async () => {
    // `extractRows` contains "extract", which is deliberately NOT an LLM signal —
    // a real N+1 must not be suppressed because its helper name looks extraction-ish.
    const code = `const db: D1Database = getDb();

async function migrate(ids: string[]) {
  for (const id of ids) {
    const rows = await extractRows(db, id);
    await db.prepare('UPDATE rows SET migrated = 1 WHERE id = ?').bind(id).run();
  }
}
`;
    expect((await loopQueryViolations(code, 'generic-extract-helper')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('loop-query per-loop dedup (defect #51)', () => {
  it('collapses multiple queries in one loop to a single finding', async () => {
    const code = `const db: D1Database = getDb();

async function getUserOrders(ids: string[]) {
  for (const id of ids) {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    const orders = await db.prepare('SELECT * FROM orders WHERE user_id = ?').bind(id).all();
  }
}
`;
    // Two eager queries in one loop body is one N+1, not two findings.
    expect(await loopQueryViolations(code, 'two-queries-one-loop')).toHaveLength(1);
  });

  it('still reports each distinct loop (two separate loops → two findings)', async () => {
    const code = `const db: D1Database = getDb();

async function run(ids: string[]) {
  for (const id of ids) {
    await db.prepare('SELECT * FROM a WHERE id = ?').bind(id).first();
  }
  for (const id of ids) {
    await db.prepare('SELECT * FROM b WHERE id = ?').bind(id).first();
  }
}
`;
    expect(await loopQueryViolations(code, 'two-separate-loops')).toHaveLength(2);
  });
});
