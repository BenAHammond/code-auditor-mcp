/**
 * Measure the *phase-path* data-access findings (the number the shipped product
 * actually reports — the legacy `UniversalDataAccessAnalyzer` data-access findings
 * are stripped in the both-paths split). Read-only.
 *
 * Usage:
 *   npx tsx scripts/measure-phase-dataaccess.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runPhaseModel } from '../src/phase/phaseModel.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { detectDialect } from '../src/languages/sql/dialectDetection.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-phase-dataaccess.ts <projectRoot>');
  process.exit(2);
}

const DATA_ACCESS = new Set(['sql-injection-risk', 'unfiltered-query', 'complex-query', 'missing-org-filter']);

async function main() {
  initializeLanguages();
  await initParsers();

  const files = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });
  const sqlDialect = detectDialect(projectRoot).dialect;
  const result = await runPhaseModel(files, new Map(), { projectRoot, workerCount: 1, sqlDialect });

  const da = result.findings.filter((f) => DATA_ACCESS.has(f.ruleId));
  const unproven = result.unprovenQueryReceivers;
  const dbUnproven = unproven.filter((u) => u.root === 'db');
  console.log(`dialect: ${sqlDialect ?? '(null)'}`);
  console.log(`total findings: ${result.findings.length}`);
  console.log(`total unproven receivers (phase): ${unproven.length}`);
  console.log(`db-rooted unproven receivers (phase): ${dbUnproven.length}`);
  console.log(`data-access findings (phase): ${da.length}`);
  for (const [r, c] of [...new Map(da.map((f) => [f.ruleId, (da.filter((x) => x.ruleId === f.ruleId).length)])).entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r}: ${c}`);
  }
  if (process.argv[3] === '--findings') {
    for (const f of da) {
      const rel = f.file.replace(projectRoot, '').replace(/^\//, '');
      const msg = (f.message ?? '').replace(/\n/g, ' ').slice(0, 100);
      console.log(`    [${f.ruleId}] ${rel}:${f.line} ${msg}`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
