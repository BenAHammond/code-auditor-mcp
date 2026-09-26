/**
 * verify-recall-value-drift.ts — machine-check the recall-protocol value-drift
 * count of 3 (Spec 67 follow-up, "Item 1").
 *
 * `specs/corpus-baselines.md` recorded `styles::styles/value-drift` at 680 → 27
 * → 3 on recall-protocol, and the 3 are the first value-drift numbers that mean
 * what the rule's name says: three genuine near-identical color pairs. That was
 * prose — it documented the number, it did not defend it. This gate re-measures
 * it from a fresh index every run and fails when the count or any pair moves,
 * reading its baseline from `bench/baselines/recall-value-drift.json`.
 *
 * recall-protocol is READ-ONLY reference (it is the validation corpus this
 * project measures against); this script only *reads* it and writes its index to
 * a throwaway temp dir. It SKIPs (exit 0) when the corpus is absent, so CI
 * without the corpus stays green — the gate only bites where the corpus exists.
 */

import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../src/auditRouter.js';
import { extractDriftPairs, compareToBaseline } from './verify-recall-value-drift-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = join(APP_ROOT, 'bench', 'baselines', 'recall-value-drift.json');

/** Resolve the recall-protocol corpus dir, or null to skip the gate. */
async function resolveCorpusDir(): Promise<string | null> {
  // An explicit override is authoritative: if it is set but not a directory, the
  // gate SKIPs rather than silently falling back to a sibling that happens to
  // exist (a stale override must not re-point the measurement at the wrong repo).
  if (process.env.RECALL_PROTOCOL_DIR) {
    const s = await stat(process.env.RECALL_PROTOCOL_DIR).catch(() => null);
    return s?.isDirectory() ? resolve(process.env.RECALL_PROTOCOL_DIR) : null;
  }
  // Default sibling: code-auditor/app → ../../recall-protocol = playground/recall-protocol.
  const sibling = resolve(APP_ROOT, '..', '..', 'recall-protocol');
  const s = await stat(sibling).catch(() => null);
  return s?.isDirectory() ? sibling : null;
}

async function main(): Promise<number> {
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const corpusDir = await resolveCorpusDir();
  if (!corpusDir) {
    console.log('SKIP: recall-protocol not found (set RECALL_PROTOCOL_DIR) — value-drift=3 gate not run');
    return 0;
  }

  initializeLanguages();
  await initParsers();

  // Fresh index — isolate from the shared dev cache. #256 (styles
  // index-state-dependence) means a warm cache can serve stale style facts, so
  // a re-measure must start from an empty index or it asserts yesterday's data.
  const dataDir = await mkdtemp(join(tmpdir(), 'ca-vd-gate-'));
  process.env.CODE_AUDITOR_DATA_DIR = dataDir;
  try {
    // Styles-only: value-drift reads only the style_* tables, which the styles
    // collector populates on its own pass. The full analyzer set would only add
    // latency, not findings (verified — styles-only reproduces the 3 on a fresh
    // index). indexFunctions off: the gate needs no function index.
    const result = await runAuditDispatch({
      projectRoot: corpusDir,
      enabledAnalyzers: ['styles'],
      indexFunctions: false,
      writeToLedger: false,
    });
    const ar = (result.analyzerResults as Record<string, any>)['styles'];
    const violations = (ar?.violations ?? []) as Array<{ rule?: string; message?: string }>;
    const pairs = extractDriftPairs(violations);
    const drift = compareToBaseline(pairs, baseline);

    console.log(`recall-protocol styles/value-drift: ${pairs.length} finding(s)`);
    for (const p of pairs) console.log(`  ${p.drift} → ${p.canonical} (ΔE ${p.deltaE76})`);

    if (drift.length) {
      console.error('\nvalue-drift baseline DRIFT:');
      for (const d of drift) console.error(`  ${d}`);
      return 1;
    }
    console.log(`value-drift baseline intact (${baseline.expectedCount} genuine near-identical pairs).`);
    return 0;
  } finally {
    delete process.env.CODE_AUDITOR_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  }
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
      console.error('verify-recall-value-drift crashed:', err);
      process.exit(2);
    });
}
