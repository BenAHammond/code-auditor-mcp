/**
 * Spec 70 2b — the diverging-clone WRITE path, exercised end-to-end.
 *
 * `dry/diverging-clone` needs `rows.length >= divergenceRuns + 1` (default 3)
 * before it can fire, so a single-run count of 0-before / 0-after proves nothing
 * about the path that was just moved: the only consumer of `dry_pair_history`
 * (`clone-pair-history` → `dry/diverging-clone`) is unexercised by a single run.
 * This test drives the real writer (`persistDryPairs`) three times against one
 * drifting fixture and pins the whole chain:
 *
 *   `buildCodeBlocks` → `seedDryPairs` → `persistDryPairs` (INSERT OR IGNORE +
 *   fresh `datetime('now')` + fresh `run_id`) → `clone-pair-history` producer →
 *   `dry/diverging-clone` rule.
 *
 * The two functions (`alpha` at line 1, `beta` at line 4) keep the same nodeType
 * and start lines across all three runs, so `computePairFingerprint` — SHA256 of
 * the sorted `file|nodeType|line` ids — is byte-identical every run. Only `beta`'s
 * body drifts, which moves the bare-token-set Jaccard 1.0 → ~0.625 → ~0.364: two
 * strict declines well past the 0.05 default threshold.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { persistDryPairs } from '../auditRunner.js';
import { buildCodeBlocks } from '../phase/runner.js';
import { seedDryPairs, resolveBlockConfig, type DryPairSeed } from '../phase/rules/dry.js';
import { CORPUS_PRODUCERS } from '../phase/producers.js';
import { dryRules } from '../phase/rules/dry.js';
import type { Finding } from '../phase/types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** alpha is constant across runs; beta drifts. Both stay function_declaration,
 *  alpha at line 1 and beta at line 4, so the pair fingerprint is stable. */
const ALPHA = ['function alpha() {', '  return 1;', '}'].join('\n');

const RUNS = [
  // Run 1 — beta is an exact duplicate of alpha → `dry/duplicate`, similarity 1.0.
  ALPHA + '\n' + ['function beta() {', '  return 1;', '}'].join('\n'),
  // Run 2 — beta's body adds a `+` operator and a second literal.
  ALPHA + '\n' + ['function beta() {', '  return 1 + 2;', '}'].join('\n'),
  // Run 3 — beta's body swaps the expression for a `const` + call + return.
  ALPHA + '\n' + ['function beta() {', '  const result = work();', '  return result;', '}'].join('\n'),
];

const ROOT = '/tmp/code-auditor-drift-test';
const CONFIG = { minLineThreshold: 3, similarityThreshold: 0.1, checkStructuralSimilarity: true };

let db: CodeIndexDB;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  db = CodeIndexDB.getInstance(':memory:');
  await db.initialize();
}, 30_000);

beforeEach(() => {
  db.rawSql.exec('DELETE FROM dry_pair_history');
});

afterAll(async () => {
  await CodeIndexDB.getInstance().close();
});

/** Seed the single `(alpha, beta)` pair for one run's source, in per-file order. */
async function seedFor(source: string): Promise<DryPairSeed[]> {
  const codeBlocks = await buildCodeBlocks([{ path: 'drift.ts', content: source }]);
  return seedDryPairs(codeBlocks, resolveBlockConfig(CONFIG));
}

describe('Spec 70 dry-pair persist (seed → persist → producer → diverging-clone)', () => {
  it('accumulates three rows under one stable fingerprint and fires dry/diverging-clone', async () => {
    // Three runs against the same fixture, seeding then persisting each.
    const seeds: DryPairSeed[][] = [];
    for (const source of RUNS) {
      seeds.push(await seedFor(source));
    }

    // Each run seeds exactly one pair (alpha vs beta — no control-flow blocks).
    for (const s of seeds) expect(s.length).toBe(1);

    // The fingerprint is byte-identical across all three runs (nodeType + line stable).
    const fp = seeds[0][0].pairFingerprint;
    expect(seeds[1][0].pairFingerprint).toBe(fp);
    expect(seeds[2][0].pairFingerprint).toBe(fp);

    // The similarity strictly declines: 1.0 → ~0.625 → ~0.364 (each drop > 0.05).
    const sims = seeds.map((s) => s[0].similarity);
    expect(sims[0]).toBeGreaterThan(sims[1] + 0.05);
    expect(sims[1]).toBeGreaterThan(sims[2] + 0.05);

    // Persist three times, sleeping past the 1s granularity of datetime('now').
    await persistDryPairs(seeds[0], ROOT);
    await sleep(1100);
    await persistDryPairs(seeds[1], ROOT);
    await sleep(1100);
    await persistDryPairs(seeds[2], ROOT);

    // The write accumulates — INSERT OR IGNORE has no unique constraint on
    // pair_fingerprint, so all three rows land, each with a fresh timestamp/run_id.
    const rows = db.rawSql.query(
      'SELECT pair_fingerprint, similarity, timestamp, run_id FROM dry_pair_history WHERE pair_fingerprint = ? ORDER BY timestamp ASC',
      [fp],
    ) as Array<{ pair_fingerprint: string; similarity: number; timestamp: string; run_id: string }>;

    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.similarity)).toEqual([sims[0], sims[1], sims[2]]);
    // Distinct timestamps (slept past the second boundary) and distinct run_ids.
    expect(new Set(rows.map((r) => r.timestamp)).size).toBe(3);
    expect(new Set(rows.map((r) => r.run_id)).size).toBe(3);

    // The clone-pair-history producer reads the accumulated series back and the
    // diverging-clone rule fires once, anchored at the most recent (run 3) row.
    const fact = CORPUS_PRODUCERS['clone-pair-history'].process({}, { indexHandle: db.indexHandle });
    const rule = dryRules.find((r) => r.id === 'dry/diverging-clone')!;
    const findings = (await rule.analyze({
      facts: {
        'imports': [],
        'string-literals': [],
        'code-block': [],
        'clone-pair-history': fact,
      },
      formats: ['typescript', 'tsx', 'javascript'],
      thresholds: { divergence: {} },
    })) as readonly Finding[];

    expect(findings.map((f) => f.ruleId)).toEqual(['dry/diverging-clone']);
    expect(findings[0].file).toBe('drift.ts');
    expect(findings[0].line).toBe(seeds[2][0].line1);
  });

  it('does not fire when the pair stays stable across three runs', async () => {
    // Same source all three runs → similarity 1.0 every time, no decline.
    const source = RUNS[0];
    const seeds = [await seedFor(source), await seedFor(source), await seedFor(source)];
    const fp = seeds[0][0].pairFingerprint;

    await persistDryPairs(seeds[0], ROOT);
    await sleep(1100);
    await persistDryPairs(seeds[1], ROOT);
    await sleep(1100);
    await persistDryPairs(seeds[2], ROOT);

    const rows = db.rawSql.query(
      'SELECT similarity FROM dry_pair_history WHERE pair_fingerprint = ? ORDER BY timestamp ASC',
      [fp],
    ) as Array<{ similarity: number }>;
    expect(rows.length).toBe(3);

    const fact = CORPUS_PRODUCERS['clone-pair-history'].process({}, { indexHandle: db.indexHandle });
    const rule = dryRules.find((r) => r.id === 'dry/diverging-clone')!;
    const findings = (await rule.analyze({
      facts: {
        'imports': [],
        'string-literals': [],
        'code-block': [],
        'clone-pair-history': fact,
      },
      formats: ['typescript', 'tsx', 'javascript'],
      thresholds: { divergence: {} },
    })) as readonly Finding[];

    expect(findings).toEqual([]);
  });
});
