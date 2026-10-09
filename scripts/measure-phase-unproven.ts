/**
 * Measure the *production* phase-model unproven surface (the cannot-fire signal
 * the audit actually reports — `runPhaseModel` → `classifyUnprovenQueryReceivers`),
 * and split it by the root's binding, so we can see whether the R3 sql-argument
 * propagation already closes the `db` sites (the `resolveCorpusReceivers` legacy
 * path this script once compared against is now deleted — this is the only live
 * resolver). Read-only.
 *
 * Usage:
 *   npx tsx scripts/measure-phase-unproven.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runPhaseModel } from '../src/phase/phaseModel.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { detectDialect } from '../src/languages/sql/dialectDetection.js';
import { readDeclaredTypePackages } from '../src/graph/importClassification.js';
import { assertCorpusPinned } from './corpus-pins.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-phase-unproven.ts <projectRoot>');
  process.exit(2);
}

// Corpus-integrity gate (Spec 70 item 2 — pin content, not HEAD). A dirty or
// drifted corpus fails here BEFORE any parsing: a number measured against an
// unreproducible tree is not a measurement.
assertCorpusPinned(projectRoot);

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

  const files = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });
  const sqlDialect = detectDialect(projectRoot).dialect;
  // Thread the declared-type-package set (the Fix 2 input) exactly as the
  // production audit does (`auditRunner` → `readDeclaredTypePackages`); without
  // it the measurement undercounts `not-handle` — every Fix 2 site (a declared
  // non-DB package like `vitest`/`hono`) reads as `unproven` and pollutes the
  // cannot-fire surface.
  const declaredTypePackages = readDeclaredTypePackages(projectRoot);
  const result = await runPhaseModel(files, new Map(), { projectRoot, workerCount: 1, sqlDialect, declaredTypePackages });

  const unproven = result.unprovenQueryReceivers;
  const unresolved = result.unresolvedQuerySites;
  console.log(`dialect: ${sqlDialect ?? '(null)'}`);
  console.log(`phase unprovenQueryReceivers: ${unproven.length}`);
  console.log(`phase unresolvedQuerySites:   ${unresolved.length}`);

  const dbUnproven = unproven.filter((u) => u.root === 'db');
  console.log(`\n=== phase unprovenQueryReceivers with root 'db': ${dbUnproven.length} ===`);
  for (const [m, c] of sorted(tally(dbUnproven.map((u) => u.method.toLowerCase()))).slice(0, 20)) {
    console.log(`  ${m}: ${c}`);
  }

  const dbUnresolved = unresolved.filter((u) => u.identifier === 'db');
  console.log(`\n=== phase unresolvedQuerySites with identifier 'db': ${dbUnresolved.length} ===`);

  // Top roots overall (to compare against the legacy 846-db shape).
  console.log('\n--- phase unproven roots (top 20) ---');
  for (const [r, c] of sorted(tally(unproven.map((u) => u.root))).slice(0, 20)) console.log(`  ${r}: ${c}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
