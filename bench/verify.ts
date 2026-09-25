/**
 * Live bench comparison (Spec 61 close-out, task 5).
 *
 * Every `expected.json` under `bench/corpus/` declares the finding set each
 * analyzer's corpus must produce — `{ file, rule, severity }` per violation,
 * plus a `nearMissFiles` list that must produce zero findings. For months
 * nothing in the repo read these files, so 78 stale severity values (the Spec
 * 54 `warning`/`suggestion` rename) sat undetected. This script makes that
 * comparison live again: it runs each corpus's analyzer for real and diffs the
 * produced finding *multiset* against the declared one — a count per
 * `{file, rule, severity}` key, so two same-rule findings in one file are two
 * entries, not one — severity included.
 *
 * It is a release gate (Spec 62 R8): `verify:close` runs it after
 * `test:integration`, and exit code 1 means "drift present". A corpus whose
 * declared findings no longer match what the analyzer actually emits is a
 * regression until proven otherwise — never re-baselined to make the gate green.
 * Run it with `npm run bench`; exit code 1 means the bench is red.
 */

import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../src/auditRouter.js';
import { ALL_ANALYZERS } from '../src/analyzers/ruleRegistry.js';
import { CodeIndexDB } from '../src/codeIndexDB.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = join(__dirname, 'corpus');

/** expected.json `analyzer` → runnable analyzer name (the registry key or
 *  pipeline-only `invariants`). */
const ANALYZER_MAP: Record<string, string> = {
  conventions: 'conventions',
  'cross-domain': 'cross-domain',
  'data-access': 'data-access',
  'diverging-clones': 'dry',
  documentation: 'documentation',
  dry: 'dry',
  'go-data-access': 'go',
  graph: 'dependency-graph',
  invariants: 'invariants',
  'non-english': 'data-access',
  react: 'react',
  schema: 'schema',
  solid: 'solid',
  styles: 'styles',
};

interface ExpectedJson {
  kind?: string;
  analyzer: string;
  config?: Record<string, unknown>;
  rationales?: Record<string, string>;
  expectedViolations?: Array<{ file: string; rule: string; severity: string }>;
  expectedMetrics?: Record<string, { min?: number }>;
  nearMissFiles?: string[];
  description?: string;
}

function normalizeViolation(v: any, root: string): string {
  // Findings report repo-relative paths (e.g. `src/x.ts`, or the pseudo-file
  // `app-level`); only an absolute path is made relative to the audit root.
  // `path.relative(root, 'src/x.ts')` would silently resolve a relative path
  // against the *process* cwd and produce a `../../…` path that points outside
  // the audit root — the Spec 62 R4 "path-outside-audit-root" symptom.
  const file = v.file
    ? isAbsolute(v.file)
      ? relative(root, v.file)
      : v.file
    : '(none)';
  const rule = v.rule ?? v.type ?? v.issueType ?? '(none)';
  return `${file}|${rule}|${v.severity}`;
}

/**
 * Seed corpus-specific pre-audit state that a single full-pipeline run cannot
 * produce on its own. The diverging-clone detector needs ≥3 runs of history in
 * `dry_pair_history` (declining similarity across `divergenceRuns` consecutive
 * measurements) — a single bench run only writes one. The fixture files document
 * this seed contract; a synthetic fingerprint keeps it isolated from any pair
 * the DRY visitor re-detects this run.
 */
async function seedCorpusState(corpus: string, tmp: string): Promise<void> {
  if (corpus !== 'diverging-clones') return;
  const indexDb = CodeIndexDB.getInstance(undefined, tmp);
  await indexDb.initialize();
  const insert = indexDb.rawDb.prepare(`
    INSERT INTO dry_pair_history
      (pair_fingerprint, file1, symbol1, line1, content_hash1,
       file2, symbol2, line2, content_hash2, similarity, timestamp, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const fp = 'bench-seed-diverging-clone';
  const declining = [
    { similarity: 0.85, ts: '2026-01-01 00:00:01', run: 'bench-seed-1' },
    { similarity: 0.78, ts: '2026-01-01 00:00:02', run: 'bench-seed-2' },
    { similarity: 0.68, ts: '2026-01-01 00:00:03', run: 'bench-seed-3' },
  ];
  const tx = indexDb.rawDb.transaction(() => {
    for (const r of declining) {
      insert.run(
        fp, 'src/clone_a.ts', 'processOrder', 5, 'seed-a',
        'src/clone_b.ts', 'handleInvoice', 5, 'seed-b',
        r.similarity, r.ts, r.run,
      );
    }
  });
  tx();
}

async function auditCorpus(corpus: string): Promise<{ drift: string[]; actual: string[]; note?: string }> {
  const srcDir = join(CORPUS_ROOT, corpus);
  const expected = JSON.parse(await readFile(join(srcDir, 'expected.json'), 'utf8')) as ExpectedJson;

  // Metrics-only corpora have no finding list to compare severity against.
  if (expected.kind === 'metrics' || !expected.expectedViolations) {
    return { drift: [], actual: [], note: 'metrics-only (no expectedViolations)' };
  }

  const target = ANALYZER_MAP[expected.analyzer] ?? expected.analyzer;
  const tmp = await mkdtemp(join(tmpdir(), 'ca-bench-'));
  try {
    await cp(srcDir, tmp, { recursive: true });
    await seedCorpusState(corpus, tmp);
    // Spec 62 A2 — full-pipeline fidelity. Run the same entry point, stage
    // sequence, hooks, and analyzer gating a real `code-audit audit` runs: no
    // single-analyzer `enabledAnalyzers` narrowing. Narrowing to `[target]` was
    // the shortcut that made DB-backed analyzers (conventions, styles) look
    // unreachable — their prerequisite passes (convention mining, style-index
    // sync) only run under the full gating. The comparison below still filters
    // to `target`, so the extra analyzers only satisfy prerequisites; they do
    // not add drift lines.
    //
    // A pipeline-only target (`invariants`) is absent from `ALL_ANALYZERS` (it
    // emits no registry rule; its rules come from `.codeauditor.json`). The
    // registry-derived full set would silently drop it, so add it back when it
    // is the corpus under test.
    const enabledAnalyzers = ALL_ANALYZERS.includes(target as any)
      ? undefined
      : [...ALL_ANALYZERS, target];
    const opts: any = { projectRoot: tmp, writeToLedger: false };
    if (enabledAnalyzers) opts.enabledAnalyzers = enabledAnalyzers;
    if (Object.keys(expected.config ?? {}).length) {
      opts.analyzerConfigs = { [target]: expected.config };
    }
    if (expected.rationales && Object.keys(expected.rationales).length) {
      opts.rationales = expected.rationales;
    }
    const result = await runAuditDispatch(opts);
    const ar = result.analyzerResults as Record<string, any>;
    const actual: string[] = [];
    for (const [key, r] of Object.entries(ar)) {
      if (key !== target && !key.startsWith(`${target}-`)) continue;
      for (const v of r.violations ?? []) actual.push(normalizeViolation(v, tmp));
    }
    actual.sort();

    // Compare as a *multiset*, not a set. The old Set comparison collapsed every
    // finding that shared a `(file, rule, severity)` key into one entry, so two
    // same-rule findings in one file looked like one: a dead expectation stayed
    // green (styles declared both a color- and an exact-drift value-drift, and
    // the exact one silently dropped), and equally a *new* second finding of an
    // already-declared rule would too. Counting per key makes the declared count
    // and the produced count disagree the moment either changes, so the drift a
    // Set could never see surfaces as `missing`/`extra` with the counts attached.
    const expectedKeys = expected.expectedViolations.map((e) => `${e.file}|${e.rule}|${e.severity}`);
    const eCounts = new Map<string, number>();
    const aCounts = new Map<string, number>();
    for (const k of expectedKeys) eCounts.set(k, (eCounts.get(k) ?? 0) + 1);
    for (const k of actual) aCounts.set(k, (aCounts.get(k) ?? 0) + 1);
    const drift: string[] = [];
    const allKeys = new Set([...eCounts.keys(), ...aCounts.keys()]);
    for (const k of allKeys) {
      const e = eCounts.get(k) ?? 0;
      const a = aCounts.get(k) ?? 0;
      if (e > a) drift.push(`missing  ${k} (declared ${e}, produced ${a})`);
      else if (a > e) drift.push(`extra    ${k} (declared ${e}, produced ${a})`);
    }

    if (expected.nearMissFiles?.length) {
      const nm = new Set(expected.nearMissFiles.map((f) => f.replace(/^src\//, 'src/')));
      const nmHits = actual.filter((x) => nm.has(x.split('|')[0])).length;
      if (nmHits > 0) drift.push(`near-miss files produced ${nmHits} finding(s)`);
    }

    return { drift, actual };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  initializeLanguages();
  await initParsers();

  const corpora = (await readdirSafe(CORPUS_ROOT)).filter((d) =>
    // Only dirs carrying an expected.json participate.
    true,
  );
  let totalDrift = 0;
  const lines: string[] = [];

  for (const corpus of corpora) {
    let expected: ExpectedJson;
    try {
      expected = JSON.parse(await readFile(join(CORPUS_ROOT, corpus, 'expected.json'), 'utf8'));
    } catch {
      continue; // shadcn-jit has no expected.json
    }
    const target = ANALYZER_MAP[expected.analyzer] ?? expected.analyzer;
    let result: { drift: string[]; actual: string[]; note?: string };
    try {
      result = await auditCorpus(corpus);
    } catch (err: any) {
      lines.push(`\n${corpus}  [target=${target}]  ERROR: ${err?.message ?? err}`);
      totalDrift++;
      continue;
    }
    const { drift, note } = result;
    if (note) {
      lines.push(`\n${corpus}  [target=${target}]  (${note})`);
      continue;
    }
    const declared = (expected.expectedViolations ?? []).length;
    if (drift.length === 0) {
      lines.push(`\n${corpus}  [target=${target}]  OK (${declared} findings)`);
    } else {
      totalDrift += drift.length;
      lines.push(`\n${corpus}  [target=${target}]  DRIFT (declared ${declared}):`);
      for (const d of drift) lines.push(`  ${d}`);
    }
  }

  console.log(lines.join('\n'));
  console.log(`\nTotal drift lines: ${totalDrift}`);
  return totalDrift > 0 ? 1 : 0;
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return (await import('node:fs/promises').then((m) => m.readdir(dir, { withFileTypes: true })))
      .filter((e: any) => e.isDirectory())
      .map((e: any) => e.name)
      .sort();
  } catch {
    return [];
  }
}

main().then((code) => process.exit(code));
