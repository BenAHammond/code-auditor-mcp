import { runAudit } from './src/auditRunner.js';
import { initializeLanguages, initParsers } from './src/languages/index.js';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function main() {
  initializeLanguages();
  await initParsers();

  const testDir = await mkdtemp(join(tmpdir(), 'ca-debug-'));
  await mkdir(join(testDir, 'src'), { recursive: true });

  await writeFile(join(testDir, 'src', 'lib.ts'), `export function calculateTotal(items: number[]): number {
  const start = performance.now();
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}
`);

  await writeFile(join(testDir, '.codeauditor.json'), JSON.stringify({
    enabledAnalyzers: ['documentation'],
    includePaths: ['src/**/*.ts'],
    excludePaths: ['**/node_modules/**'],
    minSeverity: 'suggestion',
    showProgress: false,
  }, null, 2));

  console.log('Test dir:', testDir);

  const result = await runAudit({
    projectRoot: testDir,
    indexFunctions: false,
    showProgress: false,
    scope: 'all',
  });

  const docs = result.analyzerResults['documentation']?.violations ?? [];
  console.log('Documentation violations:', docs.length);
  for (const v of docs) {
    console.log(JSON.stringify(v, null, 2));
  }
  console.log('Analyzer result keys:', Object.keys(result.analyzerResults));
}

main().catch(console.error);
