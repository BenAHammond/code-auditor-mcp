import { initializeLanguages, initParsers, LanguageRegistry } from './src/languages/index.js';
import { parseFile } from './src/languages/adapterBridge.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from './src/analyzers/universal/UniversalDataAccessAnalyzer.js';
import { buildProvenanceContext, isDBProvenanced, DB_CALL_METHODS } from './src/analyzers/provenance.js';
import { writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function check(method: string) {
  const code = `import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function sync(ids: number[]) {
  for (const id of ids) {
    await prisma.user.${method}({ where: { id } });
  }
}
`;
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  const p = join(tmpdir(), `dbg-${method}.ts`);
  await writeFile(p, code, 'utf-8');
  const src = await readFile(p, 'utf-8');
  const ast = parseFile(p, src)!;
  const prov = buildProvenanceContext(ast, adapter, src, {});
  const analyzer = new UniversalDataAccessAnalyzer();
  const vs = (await (analyzer as any).analyzeAST(ast, adapter, DEFAULT_DATA_ACCESS_CONFIG, src)) as any[];
  const lq = vs.filter((v: any) => v.rule === 'loop-query').length;
  console.log(`${method}: loop-query=${lq}`);
}

await initializeLanguages();
await initParsers();
for (const m of ['create', 'findMany', 'findUnique', 'findFirst', 'update', 'select']) {
  await check(m);
}
