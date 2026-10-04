import { initializeLanguages, initParsers, LanguageRegistry } from './src/languages/index.js';
import { parseFile } from './src/languages/adapterBridge.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from './src/analyzers/universal/UniversalDataAccessAnalyzer.js';
import { buildProvenanceContext } from './src/analyzers/provenance.js';
import { writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function check(label: string, code: string) {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  const p = join(tmpdir(), `dbg-map-${label}.ts`);
  await writeFile(p, code, 'utf-8');
  const src = await readFile(p, 'utf-8');
  const ast = parseFile(p, src)!;
  const prov = buildProvenanceContext(ast, adapter, src, {});
  console.log(`[${label}] provenanced:`, [...(prov.dbProvenanced as Map<string,any>).keys()]);
  const analyzer = new UniversalDataAccessAnalyzer();
  const vs = (await (analyzer as any).analyzeAST(ast, adapter, DEFAULT_DATA_ACCESS_CONFIG, src)) as any[];
  console.log(`[${label}] loop-query=${vs.filter((v:any)=>v.rule==='loop-query').length}`);
}

await initializeLanguages();
await initParsers();

// Array.find in a loop
await check('array-find', `const adjudication: Array<{uuid:string}> = [];
async function sync(repairLog: Array<{uuid:string}>) {
  for (const entry of repairLog) {
    const v = adjudication.find((c) => c.uuid === entry.uuid);
    console.log(v);
  }
}
`);

// Map.get/set in a loop
await check('map-get', `const counts = new Map<string, number>();
async function sync(list: Array<{name:string}>) {
  for (const row of list) {
    counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  }
}
`);
