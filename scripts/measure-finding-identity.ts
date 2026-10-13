/**
 * Dump the full finding-identity multiset for a corpus — one `ruleId\tfile\tline`
 * per line, sorted — so two runs can be diffed exactly. This is the instrument
 * behind item B's before/after claim: reading a vendor declaration must not
 * silently add or drop a finding; the diff names every added/removed finding.
 *
 * Unlike `measure-phase-dataaccess.ts` (which filters to four rules), this dumps
 * *every* phase finding, because the vendor-probe rewire touches candidate
 * extraction shared by `loop-query`, `unknown-table`, and `sql-injection-risk`,
 * none of which are in that four-rule filter.
 *
 * Usage:
 *   npx tsx scripts/measure-finding-identity.ts /path/to/corpus
 *   # → stdout lines: <ruleId>\t<relative-file>\t<line>
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runPhaseModel } from '../src/phase/phaseModel.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { buildResolutionEnvironment } from '../src/graph/resolutionEnvironment.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-finding-identity.ts <projectRoot>');
  process.exit(2);
}

async function main() {
  initializeLanguages();
  await initParsers();

  const files = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });
  const sqlDialect = buildResolutionEnvironment(projectRoot).sqlDialect;
  const result = await runPhaseModel(files, new Map(), { projectRoot, workerCount: 1, sqlDialect });

  const lines = result.findings
    .map((f) => `${f.ruleId}\t${f.file.replace(projectRoot, '').replace(/^\//, '')}\t${f.line ?? 0}`)
    .sort();
  process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));
  process.stderr.write(
    `[${projectRoot}] total=${result.findings.length} dialect=${sqlDialect ?? '(null)'}\n`,
  );
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
