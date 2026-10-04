/**
 * Measure the unproven (cannot-fire) query-site surface for one corpus, read-only.
 *
 * Calls the cross-file receiver resolution directly (not the full audit) and
 * dumps the *site*-level unproven surface — total count, method distribution,
 * and top receivers/roots by name. This is the measure the R2 re-run reports:
 * the number of query-shaped call sites whose receiver is neither a proven DB
 * handle nor a provably non-DB value.
 *
 * Usage:
 *   npx tsx scripts/measure-unproven-sites.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { resolveCorpusReceivers } from '../src/analyzers/receiverResolution.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-unproven-sites.ts <projectRoot>');
  process.exit(2);
}

function tally<T>(items: Iterable<T>): Map<T, number> {
  const m = new Map<T, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

function sorted<T>(m: Map<T, number>): Array<[T, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  initializeLanguages();
  await initParsers();

  const report = await resolveCorpusReceivers(projectRoot);
  const sites = report.unprovenQueryReceivers;

  console.log(`\n=== UNPROVEN SITES: ${projectRoot} ===`);
  console.log(`total unproven sites: ${sites.length}`);
  console.log(`files with unproven sites: ${new Set(sites.map((s) => s.file)).size}`);

  const byMethod = tally(sites.map((s) => s.method.toLowerCase()));
  console.log('\n--- method distribution (top 30) ---');
  for (const [m, c] of sorted(byMethod).slice(0, 30)) console.log(`${m}: ${c}`);

  const byReceiver = tally(sites.map((s) => s.receiver));
  console.log('\n--- top receivers (top 40) ---');
  for (const [r, c] of sorted(byReceiver).slice(0, 40)) console.log(`${r}: ${c}`);

  // Root: the resolved receiver-root identifier (the leftmost chain segment,
  // reached by descending through member *and* call expressions) — NOT the
  // last dot-segment of the receiver text (which is the previous method name).
  const byRoot = tally(sites.map((s) => s.root));
  console.log('\n--- top receiver roots (top 40) ---');
  for (const [r, c] of sorted(byRoot).slice(0, 40)) console.log(`${r}: ${c}`);

  // Sample reasons for the top non-DB-shaped methods, to see the unproven cause.
  const interesting = ['join', 'find', 'first', 'count'];
  for (const m of interesting) {
    const sample = sites.filter((s) => s.method.toLowerCase() === m).slice(0, 6);
    if (sample.length === 0) continue;
    console.log(`\n--- sample ${m} (${sample[0] ? '…' : ''}) ---`);
    for (const s of sample) {
      const rel = s.file.replace(projectRoot, '').replace(/^\//, '');
      console.log(`  ${rel}:${s.line}  ${s.receiver}  ::  ${s.reason}`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
