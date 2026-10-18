/**
 * Directive K item 7 — end-to-end check for `dry/structural-similarity`.
 *
 * The feedback run asked why an audit of `src/worker/lib/moderation.ts`
 * (endless-guessing) reported zero `dry/structural-similarity` findings when
 * `mergeClusters`, `splitCluster`, and `killQuestion` all open with the same
 * five-step `withTx` body. The answer has two independent halves:
 *
 *   1. `checkStructuralSimilarity` defaults to `false` (defaults.ts `dry` block,
 *      and `DRY_BLOCK_DEFAULTS` here). But it is ALSO dead: the migrated
 *      `dryStructuralSimilarity` rule calls `detectStructuralDuplicates`
 *      unconditionally and never reads `checkStructuralSimilarity` (§10 — config
 *      tunes, never selects). So the default-off gate is not the zero-producer.
 *
 *   2. The zero is produced by the rule's real thresholds: `minLineThreshold`
 *      (15) and `similarityThreshold` (0.85, bigram-Jaccard over structural
 *      skeletons). The real `mergeClusters`/`splitCluster` bodies are 31 lines
 *      each but only ~33% structurally similar — the shared five-step preamble
 *      is a minority of each body — so their Jaccard is far below 0.85.
 *
 * This spec proves the rule DOES fire end-to-end (through the live `runDrySlice`
 * phase path, with *default* thresholds — no `minLineThreshold`/`checkStructuralSimilarity`
 * override) on a pair of functions that share the five-step `withTx` preamble
 * AND a near-identical ≥15-line payload, which crosses both thresholds.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runDrySlice } from '../phase/runner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/**
 * Two functions whose entire body is one `withTx(async db => { … })` call. The
 * five-step preamble (status query → destructure → not-found guard → killed
 * guard → updates) is the shared shape from `src/worker/lib/moderation.ts`; the
 * remaining statements are byte-identical between the two functions, so the
 * structural skeletons are ~100% shared and every block survives the 15-line
 * floor.
 */
const FIXTURE = `
async function mergeClusters(qid: string, target: string, sources: string[]): Promise<void> {
  await withTx(env, async db => {
    const q = await db.query('SELECT status FROM questions WHERE id = :qid', { qid });
    const [question] = q.rows;
    if (!question) throw new AppError('NOT_FOUND', 'Question not found.');
    if (question.status === 'killed') throw new AppError('FORBIDDEN', 'Question is killed.');
    await db.query('UPDATE answers SET cluster_key = :target WHERE question_id = :qid AND cluster_key = :sk', { target, qid });
    await db.query('UPDATE aliases SET cluster_key = :target WHERE question_id = :qid AND cluster_key = :sk', { target, qid });
    await db.query('DELETE FROM clusters WHERE question_id = :qid AND cluster_key = :sk', { qid });
    await db.query('DELETE FROM merge_suggestions WHERE question_id = :qid AND a_key = :sk', { qid });
    await db.query('UPDATE clusters SET count = (SELECT COUNT(*) FROM answers WHERE question_id = :qid)', { qid });
    await db.query('UPDATE questions SET log_sum = COALESCE(s, 0) FROM (SELECT SUM(count * LN(count)) AS s)', { qid });
    await recompute(db, qid);
  });
}

async function splitCluster(qid: string, target: string, sources: string[]): Promise<void> {
  await withTx(env, async db => {
    const q = await db.query('SELECT status FROM questions WHERE id = :qid', { qid });
    const [question] = q.rows;
    if (!question) throw new AppError('NOT_FOUND', 'Question not found.');
    if (question.status === 'killed') throw new AppError('FORBIDDEN', 'Question is killed.');
    await db.query('UPDATE answers SET cluster_key = :target WHERE question_id = :qid AND cluster_key = :sk', { target, qid });
    await db.query('UPDATE aliases SET cluster_key = :target WHERE question_id = :qid AND cluster_key = :sk', { target, qid });
    await db.query('DELETE FROM clusters WHERE question_id = :qid AND cluster_key = :sk', { qid });
    await db.query('DELETE FROM merge_suggestions WHERE question_id = :qid AND a_key = :sk', { qid });
    await db.query('UPDATE clusters SET count = (SELECT COUNT(*) FROM answers WHERE question_id = :qid)', { qid });
    await db.query('UPDATE questions SET log_sum = COALESCE(s, 0) FROM (SELECT SUM(count * LN(count)) AS s)', { qid });
    await recompute(db, qid);
  });
}
`;

describe('dry/structural-similarity — withTx end-to-end (K7)', () => {
  it('reports a structural-similarity finding for two functions sharing the withTx body under default config', async () => {
    const findings = await runDrySlice([{ path: 'withTx.ts', content: FIXTURE }], {});
    const structural = findings.filter((f) => f.ruleId === 'dry/structural-similarity');
    expect(structural.length).toBeGreaterThanOrEqual(1);
    expect(structural[0].message).toMatch(/\d+% similar/);
  });
});
