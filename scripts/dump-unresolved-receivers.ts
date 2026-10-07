/**
 * Dump the receiver of every `unresolved` DB-call candidate (the raw
 * `schema-usage-candidates` producer), so before/after A1 diffs can answer
 * *why* a site entered/left `unresolvedQuerySites`: the receiver's shape
 * (identifier callee = a helper/wrapper name; member callee = a chain root),
 * not just the unresolvable SQL-argument identifier.
 *
 * Read-only. Usage:
 *   npx tsx scripts/dump-unresolved-receivers.ts /path/to/corpus
 *
 * Output: `file:line:col\tcalleeType\tname|root\tidentifier`
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { extractSchemaUsageCandidates } from '../src/phase/schemaUsageCandidates.js';
import { assertCorpusPinned } from './corpus-pins.js';
import fs from 'node:fs';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: dump-unresolved-receivers.ts <projectRoot>');
  process.exit(2);
}

async function main() {
  assertCorpusPinned(projectRoot);
  initializeLanguages();
  await initParsers();
  const files = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });
  const registry = LanguageRegistry.getInstance();
  const relOf = (p: string) => p.replace(projectRoot, '').replace(/^\//, '');

  for (const file of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;
    const adapter = registry.getAdapterForFile(file);
    if (!adapter || adapter.name !== 'typescript') continue;
    const src = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parseFile(file, src);
    } catch {
      continue;
    }
    if (!ast) continue;
    const fact = extractSchemaUsageCandidates({ ast, adapter, source: src, file })[0];
    for (const call of fact.dbCalls) {
      if (call.unresolved === null) continue;
      const receiver = call.calleeType === 'identifier' ? (call.name ?? '?') : (call.root ?? '?');
      console.log(
        `${relOf(file)}:${call.unresolved.location.line}:${call.unresolved.location.column}\t${call.calleeType}\t${receiver}\t${call.unresolved.identifier}`,
      );
    }
    ast.dispose?.();
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
