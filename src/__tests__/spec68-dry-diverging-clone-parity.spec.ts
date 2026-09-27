/**
 * Spec 68 §3.2 — parity: the migrated `dry/diverging-clone` rule reproduces the
 * old auditRunner Phase 2 divergence pass (Spec 13 R5) exactly.
 *
 * The divergence pass was index-backed and cross-run: it read the
 * `dry_pair_history` similarity series seeded by Phase 1, and flagged a pair
 * whose similarity had fallen by `divergenceThreshold` for `divergenceRuns`
 * consecutive runs. Its legacy emission lived inline in `auditRunner.ts` (not in
 * an analyzer), so this parity test transcribes that deleted pass verbatim as the
 * `legacyKeys` oracle and pins the migrated rule's `(file, line, column, rule,
 * severity)` multiset against it — same anchor, same rule, same severity.
 *
 * The load-bearing properties pinned:
 *   - the anchor is the MOST RECENT row (`ORDER BY timestamp DESC LIMIT 1`), not
 *     the first — the diverging pair's last row moves `file1`/`line1`, and the
 *     finding must follow it;
 *   - the decline check is STRICT (`<`, not `<=`) and CONSECUTIVE — a
 *     single decline followed by a recovery does not fire, and a drop exactly at
 *     the threshold does not fire;
 *   - a pair with fewer than `divergenceRuns + 1` rows is skipped.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { CodeIndexDB } from '../codeIndexDB.js';
import { CORPUS_PRODUCERS } from '../phase/producers.js';
import { dryRules } from '../phase/rules/dry.js';
import type { Finding } from '../phase/types.js';

let db: CodeIndexDB;

beforeAll(async () => {
  db = CodeIndexDB.getInstance(':memory:');
  await db.initialize();
}, 30_000);

beforeEach(() => {
  db.exec('DELETE FROM dry_pair_history');
});

afterAll(async () => {
  await CodeIndexDB.getInstance().close();
});

/** One `dry_pair_history` seed row — the snake_case DB columns derive from it. */
interface PairRow {
  fp: string;
  file1: string;
  line1: number;
  file2: string;
  line2: number;
  similarity: number;
  timestamp: string;
}

function insertPair(r: PairRow): void {
  db.run(
    `INSERT INTO dry_pair_history
      (pair_fingerprint, file1, symbol1, line1, content_hash1,
       file2, symbol2, line2, content_hash2, similarity, timestamp, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.fp, r.file1, null, r.line1, `hash-${r.fp}-1`,
      r.file2, null, r.line2, `hash-${r.fp}-2`,
      r.similarity, r.timestamp, 'run-1',
    ],
  );
}

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** The divergence config the rule reads (subset of the legacy `divergence` object). */
type DivergenceCfg = { divergenceThreshold?: number; divergenceRuns?: number };

/** The legacy Phase 2 pass, transcribed verbatim from the deleted auditRunner
 *  block: `SELECT DISTINCT` fingerprints, per-fingerprint `ORDER BY timestamp ASC`
 *  similarity rows, strict consecutive-decline check, anchor from the most recent
 *  row. Returns the `(file,line,column,rule,severity)` multiset. */
function legacyKeys(cfg: DivergenceCfg): string[] {
  const threshold = cfg.divergenceThreshold ?? 0.05;
  const requiredDeclines = cfg.divergenceRuns ?? 2;
  if (threshold <= 0) return [];

  const fingerprints = db.query(
    'SELECT DISTINCT pair_fingerprint FROM dry_pair_history',
  ) as Array<{ pair_fingerprint: string }>;

  const out: string[] = [];
  for (const { pair_fingerprint: fp } of fingerprints) {
    const rows = db.query(
      'SELECT similarity, timestamp FROM dry_pair_history WHERE pair_fingerprint = ? ORDER BY timestamp ASC',
      [fp],
    ) as Array<{ similarity: number; timestamp: string }>;
    if (rows.length < requiredDeclines + 1) continue;

    let consecutiveDeclines = 0;
    for (let i = rows.length - requiredDeclines; i < rows.length; i++) {
      if (rows[i].similarity < rows[i - 1].similarity - threshold) consecutiveDeclines++;
    }

    if (consecutiveDeclines >= requiredDeclines) {
      const last = db.query(
        'SELECT file1, line1 FROM dry_pair_history WHERE pair_fingerprint = ? ORDER BY timestamp DESC LIMIT 1',
        [fp],
      )[0] as { file1: string; line1: number } | undefined;
      if (last) {
        out.push(key({ file: last.file1, line: last.line1, rule: 'dry/diverging-clone', severity: 'severe' }));
      }
    }
  }
  return out.sort();
}

/** The migrated rule over the same table, via the `clone-pair-history` producer. */
async function migratedKeys(cfg: DivergenceCfg): Promise<string[]> {
  const fact = CORPUS_PRODUCERS['clone-pair-history'].process({}, { indexHandle: db });
  const rule = dryRules.find((r) => r.id === 'dry/diverging-clone')!;
  const findings = (await rule.analyze({
    facts: {
      'imports': [],
      'string-literals': [],
      'code-block': [],
      'clone-pair-history': fact,
    },
    formats: ['typescript', 'tsx', 'javascript'],
    thresholds: { divergence: cfg },
  })) as readonly Finding[];
  return findings
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();
}

describe('Spec 68 dry parity (new analyze(ctx) === old Phase 2 divergence pass)', () => {
  it('flags a pair that declined for two consecutive runs, anchored at the most recent row', async () => {
    const fp = 'fp-diverged-abc123456789';
    const rows: PairRow[] = [
      { fp, file1: 'a.ts', line1: 1, file2: 'b.ts', line2: 1, similarity: 0.90, timestamp: '2026-01-01 00:00:01' },
      { fp, file1: 'a.ts', line1: 1, file2: 'b.ts', line2: 1, similarity: 0.85, timestamp: '2026-01-01 00:00:02' },
      { fp, file1: 'a.ts', line1: 1, file2: 'b.ts', line2: 1, similarity: 0.79, timestamp: '2026-01-01 00:00:03' },
      // The most recent row moves file1/line1 — the finding must anchor HERE.
      { fp, file1: 'a.ts', line1: 42, file2: 'b.ts', line2: 2, similarity: 0.72, timestamp: '2026-01-01 00:00:04' },
    ];
    for (const r of rows) insertPair(r);

    expect(await migratedKeys({})).toEqual(legacyKeys({}));
    expect(await migratedKeys({})).toEqual(['a.ts:42:0:dry/diverging-clone:severe']);
  });

  it('does not fire on a stable pair (no decline over the window)', async () => {
    const fp = 'fp-stable-xyz';
    [0.90, 0.89, 0.88, 0.87].forEach((similarity, i) =>
      insertPair({ fp, file1: 's.ts', line1: 10, file2: 't.ts', line2: 20, similarity, timestamp: `2026-01-01 00:00:0${i + 1}` }),
    );

    expect(await migratedKeys({})).toEqual(legacyKeys({}));
    expect(await migratedKeys({})).toEqual([]);
  });

  it('does not fire on a single decline followed by a recovery (consecutive requirement)', async () => {
    const fp = 'fp-recovered';
    [0.90, 0.80, 0.81].forEach((similarity, i) =>
      insertPair({ fp, file1: 'r.ts', line1: 1, file2: 'u.ts', line2: 2, similarity, timestamp: `2026-01-01 00:00:0${i + 1}` }),
    );

    expect(await migratedKeys({})).toEqual(legacyKeys({}));
    expect(await migratedKeys({})).toEqual([]);
  });

  it('does not fire on a pair with too few rows', async () => {
    const fp = 'fp-few';
    [0.90, 0.80].forEach((similarity, i) =>
      insertPair({ fp, file1: 'f.ts', line1: 1, file2: 'g.ts', line2: 2, similarity, timestamp: `2026-01-01 00:00:0${i + 1}` }),
    );

    expect(await migratedKeys({})).toEqual(legacyKeys({}));
    expect(await migratedKeys({})).toEqual([]);
  });

  it('does not fire on a drop exactly at the threshold (strict <)', async () => {
    const fp = 'fp-exact';
    [0.90, 0.85, 0.80].forEach((similarity, i) =>
      insertPair({ fp, file1: 'e.ts', line1: 1, file2: 'x.ts', line2: 2, similarity, timestamp: `2026-01-01 00:00:0${i + 1}` }),
    );

    expect(await migratedKeys({})).toEqual(legacyKeys({}));
    expect(await migratedKeys({})).toEqual([]);
  });

  it('honors a custom divergenceThreshold/divergenceRuns', async () => {
    // threshold 0.2: the 0.85→0.79→0.72 declines do NOT reach -0.2 per step, so
    // nothing fires; with the default 0.05 the same series fires (pinned above).
    const fp = 'fp-diverged-abc123456789';
    [0.90, 0.85, 0.79, 0.72].forEach((similarity, i) =>
      insertPair({ fp, file1: 'a.ts', line1: 1, file2: 'b.ts', line2: 1, similarity, timestamp: `2026-01-01 00:00:0${i + 1}` }),
    );

    expect(await migratedKeys({ divergenceThreshold: 0.2 })).toEqual(legacyKeys({ divergenceThreshold: 0.2 }));
    expect(await migratedKeys({ divergenceThreshold: 0.2 })).toEqual([]);

    // runs 1 with default threshold 0.05: only the last step (0.79→0.72) is
    // checked, one decline — still fires with a single required decline.
    expect(await migratedKeys({ divergenceRuns: 1 })).toEqual(legacyKeys({ divergenceRuns: 1 }));
    expect(await migratedKeys({ divergenceRuns: 1 })).toEqual(['a.ts:1:0:dry/diverging-clone:severe']);
  });

  it('returns nothing when divergenceThreshold is disabled (<= 0)', async () => {
    const fp = 'fp-diverged-abc123456789';
    [0.90, 0.85, 0.79, 0.72].forEach((similarity, i) =>
      insertPair({ fp, file1: 'a.ts', line1: 1, file2: 'b.ts', line2: 1, similarity, timestamp: `2026-01-01 00:00:0${i + 1}` }),
    );

    expect(await migratedKeys({ divergenceThreshold: 0 })).toEqual([]);
    expect(await migratedKeys({ divergenceThreshold: 0 })).toEqual(legacyKeys({ divergenceThreshold: 0 }));
  });

  it('covers exactly the six DRY rules, diverging-clone last', () => {
    expect(dryRules.map((r) => r.id)).toEqual([
      'duplicate-import',
      'duplicate-string-literal',
      'dry/duplicate',
      'dry/structural-similarity',
      'dry/similar-expression',
      'dry/diverging-clone',
    ]);
  });
});
