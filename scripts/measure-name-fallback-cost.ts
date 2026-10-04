/**
 * Measure the cost of deleting `DB_RECEIVER_NAMES` (the raw-SQL receiver name
 * fallback), per corpus, read-only.
 *
 * For each TS/JS file in the corpus, build the provenance context in BOTH
 * `hybrid` (current default, name-list fallback on) and `provenance` (name-list
 * fallback off) modes, and count the DB-provenanced identifiers that carry
 * `reason: 'fallback'` — i.e. receivers recognised ONLY because their name is in
 * `DB_RECEIVER_NAMES`/`dbBindingNames`/`dbWrapperNames`, not traced to a DB
 * package import. Those are exactly the receivers that go unresolvable when the
 * name list is deleted.
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   npx tsx scripts/measure-name-fallback-cost.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { buildProvenanceContext } from '../src/analyzers/provenance.js';
import { DEFAULT_SCHEMA_CONFIG } from '../src/analyzers/universal/schema/config.js';
import { findFiles } from '../src/utils/fileDiscovery.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());

async function main() {
  initializeLanguages();
  await initParsers();
  const registry = LanguageRegistry.getInstance();
  const files = await findFiles(projectRoot);

  let totalFiles = 0;
  const fallbackNames = new Map<string, number>(); // receiver name → count of files
  const fallbackByLabel = new Map<string, number>();
  let hybridProvenanced = 0;
  let provenanceProvenanced = 0;

  for (const filePath of files) {
    const rel = path.relative(projectRoot, filePath);
    if (rel.includes('node_modules')) continue;
    const adapter = registry.getAdapterForFile(filePath);
    if (!adapter) continue;
    let source: string;
    try {
      source = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    let ast;
    try {
      ast = await adapter.parse(filePath, source);
    } catch {
      continue;
    }
    if (!ast?.root) continue;
    totalFiles++;

    const hybrid = buildProvenanceContext(ast, adapter, source, {
      mode: 'hybrid',
      dbReceiverNames: DEFAULT_SCHEMA_CONFIG.dbReceiverNames,
      dbBindingNames: DEFAULT_SCHEMA_CONFIG.dbBindingNames,
      dbCallMethods: DEFAULT_SCHEMA_CONFIG.dbCallMethods,
      dbWrapperNames: DEFAULT_SCHEMA_CONFIG.dbWrapperNames,
    });
    const prov = buildProvenanceContext(ast, adapter, source, {
      mode: 'provenance',
      dbReceiverNames: [],
      dbBindingNames: [],
      dbCallMethods: DEFAULT_SCHEMA_CONFIG.dbCallMethods,
      dbWrapperNames: [],
    });

    hybridProvenanced += hybrid.dbProvenanced.size;
    provenanceProvenanced += prov.dbProvenanced.size;

    for (const [name, ev] of hybrid.dbProvenanced) {
      if (ev.reason === 'fallback') {
        fallbackNames.set(name, (fallbackNames.get(name) ?? 0) + 1);
        const label = ev.source ?? 'unknown';
        fallbackByLabel.set(label, (fallbackByLabel.get(label) ?? 0) + 1);
      }
    }
    ast.dispose?.();
  }

  const fallbackTotal = [...fallbackNames.values()].reduce((a, b) => a + b, 0);
  console.log(`=== CORPUS: ${projectRoot} ===`);
  console.log(`files scanned: ${totalFiles}`);
  console.log(`hybrid provenanced identifiers (total): ${hybridProvenanced}`);
  console.log(`provenance-only provenanced identifiers (total): ${provenanceProvenanced}`);
  console.log(`fallback-only identifiers (deleted by removing name list): ${fallbackTotal}`);
  console.log('\n--- fallback receiver names (name → files) ---');
  for (const [name, n] of [...fallbackNames.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${name}: ${n}`);
  }
  console.log('\n--- fallback source labels (label → count) ---');
  for (const [label, n] of [...fallbackByLabel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${label}: ${n}`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
