/**
 * verify-recall-cases.ts — machine-check a *named-case* recall assertion (the
 * replacement for the retired `verify:oracle-shortfalls` count-baseline gate).
 *
 * The retired gate pinned a per-(fact-kind, corpus) aggregate count against a
 * stored total, so it went red every time the detector got better and a number
 * moved. A count is not a fact worth gating on; a *named case* is. This gate
 * holds a hand-authored list of specific (kind, corpus, file, site) cases drawn
 * from HEAD — "this file, this producer, should still emit a fact at this site"
 * — and asserts each one is still emitted. A legitimate gain (more facts) leaves
 * every named case in place and stays green; a regression (a producer silently
 * stops emitting that site) goes red, per case, with no reference to any
 * historical total.
 *
 * The corpora are READ-ONLY reference (frozen at pinned SHAs), so the named
 * sites are stable: a case goes missing only if a producer regressed or a corpus
 * changed (a violation of the read-only contract). It SKIPs (exit 0) cases whose
 * corpus is absent, so CI without the corpora stays green — the same contract as
 * verify-recall-value-drift and verify-extraction-completeness.
 *
 * Re-pinning is a hand edit: add/remove a case object (with its one-line `note`
 * saying what the site is and why it is pinned), never a re-recording of totals.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runPhaseModel } from '../src/phase/phaseModel.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { buildResolutionEnvironment } from '../src/graph/resolutionEnvironment.js';
import { compareRecallCases } from './verify-recall-cases-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = join(APP_ROOT, 'bench', 'baselines', 'recall-cases.json');

/** The four TS/JS validation corpora, as siblings of app. */
const CORPORA = ['hhra-org', 'blitz', 'openstatus', 'recall-protocol'] as const;

/**
 * Per-kind site extractors: map a fact to the site string(s) the gate keys a
 * named case on. A location-based kind names the node start (`line:column`); a
 * file-level kind names the concrete object the producer declares (a table, a
 * class). The extractor returns an array so a single per-file fact can yield
 * several sites (one per DDL op).
 */
const SITE_EXTRACTORS: Record<string, (fact: Record<string, any>) => string[]> = {
  'data-access-calls-candidates': (f) => [`${f.line}:${f.column}`],
  'secret-candidates': (f) => [`${f.line}:${f.column}`],
  'security-candidates': (f) => [`${f.kind}:${f.line}:${f.column}`],
  'loop-query-candidates': (f) => [`${f.line}:${f.column}`],
  'defined-classes': (f) => [f.className],
  'ddl-declarations': (f) => (f.ops ?? []).map((o: { op: string; table: string }) => `${o.op}:${o.table}`),
};

/** The field each kind carries its source path on (most use `file`). */
const FILE_FIELD: Record<string, string> = {
  'defined-classes': 'filePath',
};

/** Resolve a corpus dir, or null to skip that corpus. */
async function resolveCorpusDir(name: string): Promise<string | null> {
  const override = process.env.CORPUS_ROOT;
  const base = override ?? resolve(APP_ROOT, '..', '..');
  const dir = resolve(base, name);
  const s = await stat(dir).catch(() => null);
  return s?.isDirectory() ? dir : null;
}

/** Measure one corpus: kind → (relative file → emitted site strings). */
async function measureCorpus(dir: string): Promise<Map<string, Map<string, string[]>>> {
  const files = await discoverFiles(dir, { extensions: ALL_EXTENSIONS });
  // Same serial, dialect-detected configuration the retired gate and its peers
  // record under; worker count never reorders the per-file site sets.
  const sqlDialect = buildResolutionEnvironment(dir).sqlDialect;
  const result = await runPhaseModel(files, new Map(), { projectRoot: dir, workerCount: 1, sqlDialect });

  const byKindFile = new Map<string, Map<string, string[]>>();
  for (const [kind, arr] of result.facts) {
    const extractor = SITE_EXTRACTORS[kind];
    if (!extractor) continue;
    const fileField = FILE_FIELD[kind] ?? 'file';
    const perFile = byKindFile.get(kind) ?? new Map<string, string[]>();
    byKindFile.set(kind, perFile);
    for (const fact of arr as Array<Record<string, any>>) {
      const abs = fact[fileField];
      if (typeof abs !== 'string') continue;
      const rel = relative(dir, abs);
      const sites = perFile.get(rel) ?? [];
      for (const s of extractor(fact)) sites.push(s);
      perFile.set(rel, sites);
    }
  }
  return byKindFile;
}

interface NamedCase {
  kind: string;
  corpus: string;
  file: string;
  site: string;
  note: string;
}

async function main(): Promise<number> {
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const cases: NamedCase[] = baseline.cases ?? [];
  for (const c of cases) {
    if (!SITE_EXTRACTORS[c.kind]) {
      console.error(`recall-cases baseline names an unsupported kind: ${c.kind} (case ${c.corpus}/${c.file})`);
      return 2;
    }
  }

  initializeLanguages();
  await initParsers();

  const measured: Record<string, Record<string, Record<string, string[]>>> = {};
  const skipped: string[] = [];
  for (const name of CORPORA) {
    const dir = await resolveCorpusDir(name);
    if (!dir) {
      skipped.push(name);
      continue;
    }
    const byKindFile = await measureCorpus(dir);
    for (const [kind, perFile] of byKindFile) {
      (measured[kind] ??= {})[name] = Object.fromEntries(perFile);
    }
    const n = [...byKindFile.values()].reduce((sum, m) => sum + m.size, 0);
    console.log(`${name}: measured ${n} (kind, file) site groups across ${byKindFile.size} fact-kind(s)`);
  }

  if (skipped.length) {
    console.log(`SKIP: ${skipped.join(', ')} not found — cases on these corpora are not compared (set CORPUS_ROOT to the playground dir)`);
  }

  const presentCases = cases.filter((c) => !skipped.includes(c.corpus));
  const drift = compareRecallCases(measured, presentCases);
  if (drift.length) {
    console.error('\nrecall-cases baseline DRIFT:');
    for (const d of drift) console.error(`  ${d}`);
    return 1;
  }
  console.log(`recall-cases intact: ${presentCases.length} named case(s) all emitted.`);
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
      console.error('verify-recall-cases crashed:', err);
      process.exit(2);
    });
}
