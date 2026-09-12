/**
 * Spec 55 §1.4 — the three *non-test* `loop-query` shapes, pinned.
 *
 * The second external audit (endless-guessing/code-audit-false-positives.md §1.4)
 * listed three source-file `loop-query` findings it suggested suppressing:
 *
 *   1. `src/cron/sweep.ts:94` `replayFanOut`   — a loop over a constant 3-bucket
 *      target list (`hour`/`day`/`alltime`), not input-scaled.
 *   2. `src/objects/Leaderboard.ts:113` `apply` — per-delta `sql.exec` against the
 *      Durable Object's *local* SQLite, while D1 writes are accumulated and
 *      committed once via `env.DB.batch()`.
 *   3. `src/worker/routes/auth.ts:466` — a handle-uniquification probe loop
 *      (bounded by collision count on a rare signup path).
 *
 * Spec 55 R3 decided *not* to suppress them: R3 scopes test files only, and these
 * are source files. They remain in the corpus baselines deliberately
 * (corpus-baselines.md: "§1.4 has no R in the spec; flagged separately"). These
 * tests pin that the three shapes still fire, so a future change that silently
 * drops them (e.g. "don't flag constant-trip loops") is a deliberate re-pin, not
 * an accident.
 *
 * Each shape is reproduced as a minimal standalone snippet that fires the real
 * `UniversalDataAccessAnalyzer` via `analyzeAST`.
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
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-loop-shapes-'));
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

describe('Spec 55 §1.4 — non-test loop-query shapes', () => {
  it('replayFanOut — a loop over a constant bucket list (fan-out) still fires', async () => {
    // endless-guessing/src/cron/sweep.ts:94 — the trip count is a literal
    // constant (hour/day/alltime), but it is still a query-in-loop and R3 does
    // not exempt constant-trip loops.
    const code = `import { db } from './db';
const TARGETS: Array<[string, string]> = [
  ['hour', 'hour:2026-01-01T00'],
  ['day', 'day:2026-01-01'],
  ['alltime', 'alltime'],
];
export async function replayFanOut() {
  for (const [kind, key] of TARGETS) {
    const has = await db
      .prepare('SELECT 1 AS x FROM leaderboard WHERE bucket_kind = ? AND bucket_key = ? LIMIT 1')
      .bind(kind, key)
      .first();
    if (has) {
      await db.prepare('UPDATE leaderboard SET score = score + 1 WHERE bucket_kind = ? AND bucket_key = ?')
        .bind(kind, key).run();
    }
  }
}
`;
    expect((await loopQueryViolations(code, 'replay-fan-out')).length).toBeGreaterThanOrEqual(1);
  });

  it('Leaderboard.apply — per-delta write in a loop still fires (even when remote writes are batched)', async () => {
    // endless-guessing/src/objects/Leaderboard.ts:113 — a per-delta write inside
    // the loop. R3 keeps it: the loop still issues a write per iteration, and the
    // "remote batch" nuance is a project decision, not a rule exemption.
    const code = `import { db } from './db';
interface Delta { userId: string; handle: string; score: number; answers: number }
export function applyDeltas(deltas: Delta[]) {
  const stmts: any[] = [];
  for (const d of deltas) {
    db.exec(
      'INSERT INTO totals (user_id, handle, score, answers) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET score = totals.score + excluded.score',
      d.userId, d.handle, d.score, d.answers,
    );
    stmts.push(db.prepare('INSERT INTO leaderboard (bucket_kind, bucket_key, user_id) VALUES (?,?,?)')
      .bind('alltime', 'alltime', d.userId));
  }
}
`;
    expect((await loopQueryViolations(code, 'leaderboard-apply')).length).toBeGreaterThanOrEqual(1);
  });

  it('auth uniqueness probe — a while-loop existence probe still fires', async () => {
    // endless-guessing/src/worker/routes/auth.ts:466 — a sequential uniqueness
    // probe (`SELECT id … WHERE handle = ?`) inside a `while (true)` loop. It is
    // inherently un-batchable, but it is still a query-in-loop and stays.
    const code = `import { db } from './db';
export async function uniquifyHandle(base: string): Promise<string> {
  let handle = base;
  let i = 0;
  while (true) {
    const taken = await db.prepare('SELECT id FROM users WHERE handle = ?').bind(handle).first();
    if (!taken) break;
    i += 1;
    handle = base.slice(0, 18) + String(i);
  }
  return handle;
}
`;
    expect((await loopQueryViolations(code, 'auth-uniqueness-probe')).length).toBeGreaterThanOrEqual(1);
  });
});
