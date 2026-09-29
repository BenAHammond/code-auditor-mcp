/**
 * verify-oracle-shortfalls.ts — machine-check the Spec 69 R1 completeness-oracle
 * residuals (criterion 4).
 *
 * Each file processor declares a counted oracle — an independent upper bound on
 * the fragments a file *should* yield — or an explicit `none`. `runPhaseModel`
 * compares each counted oracle against what its processor actually emitted and
 * returns the per-file shortfalls (actual < expected). The gap is the by-design
 * residual (an oracle counts a dumber superset than its producer emits); this
 * gate pins the *aggregate* of that residual, per (fact-kind, corpus).
 *
 * The corpora are READ-ONLY reference (frozen), so the aggregates are stable: a
 * move means a producer or oracle changed (the regression this gate exists to
 * catch) or a corpus changed (a violation of the read-only contract). Either way
 * the gate fails loudly. It SKIPs (exit 0) per absent corpus, so CI without the
 * corpora stays green — the gate only bites where the corpus exists (the same
 * contract as verify-recall-value-drift and verify-extraction-completeness).
 *
 * `--record` re-measures and writes the baseline JSON (numbers only, empty
 * `composition` prose) — the composition notes are hand-authored into the
 * baseline afterwards, once per kind.
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runPhaseModel } from '../src/phase/phaseModel.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { compareOracleShortfalls } from './verify-oracle-shortfalls-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = join(APP_ROOT, 'bench', 'baselines', 'oracle-shortfalls.json');

/** The four TS/JS validation corpora, as siblings of app. */
const CORPORA = ['hhra-org', 'blitz', 'openstatus', 'recall-protocol'] as const;

interface Aggregate {
  files: number;
  expected: number;
  actual: number;
}

/** Resolve a corpus dir, or null to skip that corpus. */
async function resolveCorpusDir(name: string): Promise<string | null> {
  const override = process.env.CORPUS_ROOT;
  // Default: app → ../../<name> = playground/<name> (siblings of code-auditor).
  const base = override ?? resolve(APP_ROOT, '..', '..');
  const dir = resolve(base, name);
  const s = await stat(dir).catch(() => null);
  return s?.isDirectory() ? dir : null;
}

/** Measure one corpus: aggregate shortfalls per fact kind (merging formats). */
async function measureCorpus(dir: string): Promise<Map<string, Aggregate>> {
  // ALL_EXTENSIONS matches the plain `all`-scope audit's default discovery; the
  // phase model then filters to the formats the migrated rules actually need.
  const files = await discoverFiles(dir, { extensions: ALL_EXTENSIONS });
  // Serial (workerCount 1) is deterministic and the same configuration the
  // baseline was recorded under; the fact merge is file-sorted regardless, so
  // worker count never reorders or changes the aggregate.
  const result = await runPhaseModel(files, new Map(), { projectRoot: dir, workerCount: 1 });

  const byKind = new Map<string, Aggregate>();
  for (const s of result.oracleShortfalls) {
    const kind = s.processor.split('.')[0];
    const agg = byKind.get(kind) ?? { files: 0, expected: 0, actual: 0 };
    agg.files += 1;
    agg.expected += s.expected;
    agg.actual += s.actual;
    byKind.set(kind, agg);
  }
  return byKind;
}

async function main(): Promise<number> {
  const record = process.argv.includes('--record');
  // `--record` bootstraps the baseline, so it must not require one to already
  // exist; the normal (compare) run reads it and fails loudly on drift.
  const baseline = record ? { kinds: {} } : JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  initializeLanguages();
  await initParsers();

  const measured: Record<string, Record<string, Aggregate>> = {};
  const skipped: string[] = [];
  for (const name of CORPORA) {
    const dir = await resolveCorpusDir(name);
    if (!dir) {
      skipped.push(name);
      continue;
    }
    const byKind = await measureCorpus(dir);
    for (const [kind, agg] of byKind) {
      (measured[kind] ??= {})[name] = { files: agg.files, expected: agg.expected, actual: agg.actual };
    }
    console.log(`${name}: ${byKind.size} fact-kind(s) with a shortfall`);
    for (const [kind, agg] of [...byKind].sort()) {
      console.log(`  ${kind}: files ${agg.files}, expected ${agg.expected}, actual ${agg.actual} (residual ${agg.expected - agg.actual})`);
    }
  }

  if (skipped.length) {
    console.log(`SKIP: ${skipped.join(', ')} not found (set CORPUS_ROOT to the playground dir)`);
  }

  if (record) {
    const kinds: Record<string, { composition: string; corpora: Record<string, Aggregate> }> = {};
    for (const [kind, corpora] of Object.entries(measured).sort()) {
      kinds[kind] = { composition: '', corpora };
    }
    await writeFile(BASELINE_PATH, `${JSON.stringify({ kinds }, null, 2)}\n`, 'utf8');
    console.log(`\nrecorded baseline → ${BASELINE_PATH} (fill in per-kind composition prose)`);
    return 0;
  }

  const drift = compareOracleShortfalls(measured, baseline.kinds ?? {});
  if (drift.length) {
    console.error('\noracle-shortfalls baseline DRIFT:');
    for (const d of drift) console.error(`  ${d}`);
    return 1;
  }
  if (Object.keys(measured).length) {
    console.log('oracle-shortfalls baseline intact.');
  }
  return 0;
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('verify-oracle-shortfalls crashed:', err);
      process.exit(2);
    });
}
