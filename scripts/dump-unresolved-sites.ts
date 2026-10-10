/**
 * Dump the phase-model `unresolvedQuerySites` as `file:line:col  identifier`
 * lines, for before/after diffing. Read-only. Production `runPhaseModel` call.
 *
 * Usage:
 *   npx tsx scripts/dump-unresolved-sites.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runPhaseModel } from '../src/phase/phaseModel.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { buildResolutionEnvironment } from '../src/graph/resolutionEnvironment.js';
import { assertCorpusPinned } from './corpus-pins.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: dump-unresolved-sites.ts <projectRoot>');
  process.exit(2);
}

async function main() {
  assertCorpusPinned(projectRoot);
  initializeLanguages();
  await initParsers();
  const files = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });
  const sqlDialect = buildResolutionEnvironment(projectRoot).sqlDialect;
  const result = await runPhaseModel(files, new Map(), { projectRoot, workerCount: 1, sqlDialect });
  const relOf = (p: string) => p.replace(projectRoot, '').replace(/^\//, '');
  for (const u of result.unresolvedQuerySites) {
    console.log(`${relOf(u.file)}:${u.location.line}:${u.location.column}\t${u.identifier}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
