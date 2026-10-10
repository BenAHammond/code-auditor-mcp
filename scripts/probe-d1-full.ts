/**
 * Item 2 probe — what does the *shipped* phase path report for `this.env.DB`
 * (Cloudflare D1) sites, across literal and non-literal (batch / prepare(sqlVar))
 * shapes? Runs production `runPhaseModel` and prints the unproven receivers, the
 * data-access findings, and the per-file provenanced roots. Read-only.
 *
 * Usage:
 *   npx tsx scripts/probe-d1-full.ts /tmp/d1probe
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runPhaseModel } from '../src/phase/phaseModel.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { buildResolutionEnvironment } from '../src/graph/resolutionEnvironment.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: probe-d1-full.ts <projectRoot>');
  process.exit(2);
}

const DATA_ACCESS = new Set(['sql-injection-risk', 'unfiltered-query', 'complex-query', 'missing-org-filter']);

async function main() {
  initializeLanguages();
  await initParsers();
  const files = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });
  const sqlDialect = buildResolutionEnvironment(projectRoot).sqlDialect;
  const result = await runPhaseModel(files, new Map(), { projectRoot, workerCount: 1, sqlDialect });

  const relOf = (p: string) => p.replace(projectRoot, '').replace(/^\//, '');

  console.log(`dialect: ${sqlDialect ?? '(null)'}`);
  console.log(`\n=== data-access findings (${result.findings.filter((f) => DATA_ACCESS.has(f.ruleId)).length}) ===`);
  for (const f of result.findings.filter((f) => DATA_ACCESS.has(f.ruleId))) {
    const msg = (f.message ?? '').replace(/\n/g, ' ').slice(0, 90);
    console.log(`  [${f.ruleId}] ${relOf(f.file)}:${f.line}  ${msg}`);
  }

  console.log(`\n=== unproven query receivers (${result.unprovenQueryReceivers.length}) ===`);
  for (const u of result.unprovenQueryReceivers) {
    console.log(`  ${relOf(u.file)}:${u.line}  root=${u.root} receiver=${u.receiver}.${u.method}  :: ${u.reason.slice(0, 110)}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
