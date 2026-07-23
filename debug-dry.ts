import { initializeLanguages, initParsers } from './src/languages/index.js';
import { UniversalDRYAnalyzer } from './src/analyzers/universal/UniversalDRYAnalyzer.js';

async function main() {
  initializeLanguages();
  await initParsers();

  const analyzer = new UniversalDRYAnalyzer();
  
  const result = await analyzer.analyze([
    './bench/corpus/dry/src/duplicates.ts',
  ], { minLineThreshold: 15, similarityThreshold: 0.85 });

  console.log('Files processed:', result.filesProcessed);
  console.log('Violations:', result.violations.length);
  console.log('Metadata:', JSON.stringify(result.metadata, null, 2));
  
  // Try with no threshold
  const result2 = await analyzer.analyze([
    './bench/corpus/dry/src/duplicates.ts',
  ], { minLineThreshold: 1, similarityThreshold: 0.85 });
  
  console.log('\nWith minLineThreshold=1:');
  console.log('Files processed:', result2.filesProcessed);
  console.log('Violations:', result2.violations.length);
  for (const v of result2.violations) {
    console.log(`  file=${v.file} rule=${v.rule} severity=${v.severity}`);
    console.log(`  message=${v.message?.slice(0, 200)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
