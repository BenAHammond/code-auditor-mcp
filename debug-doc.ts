import { initializeLanguages } from './src/languages/index.js';
import { initParsers } from './src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from './src/languages/registry.js';
import fs from 'fs';

async function main() {
  const file = 'src/analyzers/__tests__/fixtures/spec-17/scope-all-config.ts';
  const source = fs.readFileSync(file, 'utf-8');

  await initializeLanguages();
  await initParsers();

  const adapter = LanguageRegistry.getInstance().getAdapter(file);
  if (!adapter) throw new Error('No adapter');

  const ast = adapter.parse(file, source);
  const functions = adapter.extractFunctions(ast);

  console.log(`Found ${functions.length} functions:`);
  for (const f of functions) {
    console.log(`  ${f.name} (exported: ${f.isExported}, jsDoc: ${JSON.stringify(f.jsDoc ?? null)}, lines: ${f.location.start.line}-${f.location.end.line})`);
  }
}
main().catch(console.error);
