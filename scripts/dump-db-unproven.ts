/**
 * Dump the phase-model db-rooted unproven receivers as `file:line  receiver.method`
 * lines, for before/after diffing. Read-only. Production `runPhaseModel` call.
 *
 * Usage:
 *   npx tsx scripts/dump-db-unproven.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runPhaseModel } from '../src/phase/phaseModel.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { detectDialect } from '../src/languages/sql/dialectDetection.js';
import { assertCorpusPinned } from './corpus-pins.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: dump-db-unproven.ts <projectRoot>');
  process.exit(2);
}

async function main() {
  assertCorpusPinned(projectRoot);
  initializeLanguages();
  await initParsers();
  const files = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });
  const sqlDialect = detectDialect(projectRoot).dialect;
  const result = await runPhaseModel(files, new Map(), { projectRoot, workerCount: 1, sqlDialect });
  const dbUnproven = result.unprovenQueryReceivers.filter((u) => u.root === 'db');
  const relOf = (p: string) => p.replace(projectRoot, '').replace(/^\//, '');
  const flat = (s: string) => s.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (process.argv[3] === '--all') {
    for (const u of result.unprovenQueryReceivers) {
      console.log(`${relOf(u.file)}:${u.line}\t${flat(u.root)}\t${flat(u.receiver)}\t${flat(u.method)}\t${flat(u.reason)}`);
    }
    return;
  }
  for (const u of dbUnproven) {
    console.log(`${relOf(u.file)}:${u.line}\t${flat(u.receiver)}\t${flat(u.method)}\t${flat(u.reason)}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
