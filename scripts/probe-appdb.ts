/**
 * Probe the within-file provenance of a single TS file: which names seed as DB
 * handles, and what `classifyRootIdentifier` says about a chosen name.
 *
 * Usage: npx tsx scripts/probe-appdb.ts <file.ts>
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { computeTsWithinFileProvenance } from '../src/analyzers/receiverResolution.js';
import { buildBindingEnv, classifyRootIdentifier, type RootResolutionEnv } from '../src/analyzers/receiverRoot.js';
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: probe-appdb.ts <file.ts>');
  process.exit(2);
}

async function main() {
  initializeLanguages();
  await initParsers();
  const src = fs.readFileSync(file, 'utf8');
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(file)!;
  const ast = parseFile(file, src)!;

  const prov = computeTsWithinFileProvenance(ast, adapter, src);
  console.log('=== within-file provenanced names ===');
  for (const [name, ev] of [...prov.entries()].sort()) {
    console.log(`  ${name}  (${ev.reason} — ${ev.source})`);
  }

  const bindings = buildBindingEnv(ast, adapter, src);
  console.log('\n=== bindings ===');
  for (const [name, b] of [...bindings.entries()].sort()) {
    console.log(`  ${name}: kind=${b.kind} source=${b.source ?? '-'} typeText=${b.typeText ?? '-'}`);
  }

  const env: RootResolutionEnv = { provenance: prov, bindings, adapter, sourceCode: src };
  console.log('\n=== classifyRootIdentifier (probe names) ===');
  for (const name of process.argv.slice(3)) {
    console.log(`  ${name} -> ${classifyRootIdentifier(name, env)}`);
  }

  ast.dispose?.();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
