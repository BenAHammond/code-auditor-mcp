import { initializeLanguages, initParsers, LanguageRegistry } from './src/languages/index.js';
import { parseFile } from './src/languages/adapterBridge.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from './src/analyzers/universal/UniversalDataAccessAnalyzer.js';
import { buildProvenanceContext } from './src/analyzers/provenance.js';
import { readFile } from 'node:fs/promises';

const file = '/Users/ben/playground/recall-protocol/src/lib/build-review-store.ts';
await initializeLanguages();
await initParsers();
const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
const src = await readFile(file, 'utf-8');
const ast = parseFile(file, src)!;
const prov = buildProvenanceContext(ast, adapter, src, {});
const names = [...(prov.dbProvenanced as Map<string,any>).keys()];
console.log('provenanced count:', names.length);
console.log('contains counts:', names.includes('counts'));
console.log('contains db:', names.includes('db'));
console.log('sample:', names.slice(0, 40).join(', '));
