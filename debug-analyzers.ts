import { initializeLanguages, initParsers } from './src/languages/index.js';
import { UniversalDocumentationAnalyzer } from './src/analyzers/universal/UniversalDocumentationAnalyzer.js';
import { UniversalSOLIDAnalyzer } from './src/analyzers/universal/UniversalSOLIDAnalyzer.js';
import { UniversalDRYAnalyzer } from './src/analyzers/universal/UniversalDRYAnalyzer.js';
import { UniversalDataAccessAnalyzer } from './src/analyzers/universal/UniversalDataAccessAnalyzer.js';
import { UniversalSchemaAnalyzer } from './src/analyzers/universal/UniversalSchemaAnalyzer.js';
import { reactAnalyzer } from './src/analyzers/reactAnalyzer.js';
import { invariantsAnalyzer } from './src/analyzers/invariantsAnalyzer.js';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  initializeLanguages();
  await initParsers();

  // ── Documentation ────────────────────────────────────
  console.log('=== DOCUMENTATION ANALYZER ===');
  const docAnalyzer = new UniversalDocumentationAnalyzer();
  const docResult = await docAnalyzer.analyze([
    `${__dirname}/bench/corpus/documentation/src/undocumented.ts`,
    `${__dirname}/bench/corpus/documentation/src/short-enough.ts`,
  ], { scope: 'public', docsMinLines: 5 });

  console.log(`Files processed: ${docResult.filesProcessed}`);
  for (const v of docResult.violations) {
    console.log(`  file=${v.file} rule=${v.rule} symbol=${(v as any).symbol || (v as any).functionName} severity=${v.severity} message=${v.message}`);
    console.log(`    details:`, JSON.stringify((v as any).details));
  }

  // ── SOLID ─────────────────────────────────────────────
  console.log('\n=== SOLID ANALYZER ===');
  const solidAnalyzer = new UniversalSOLIDAnalyzer();
  const solidResult = await solidAnalyzer.analyze([
    `${__dirname}/bench/corpus/solid/src/complex-method.ts`,
    `${__dirname}/bench/corpus/solid/src/simple-method.ts`,
  ], { maxMethodComplexity: 5 });

  console.log(`Files processed: ${solidResult.filesProcessed}`);
  for (const v of solidResult.violations) {
    console.log(`  file=${v.file} rule=${v.rule} symbol=${(v as any).symbol || (v as any).functionName || (v as any).className || (v as any).name} severity=${v.severity}`);
  }

  // ── DRY ───────────────────────────────────────────────
  console.log('\n=== DRY ANALYZER ===');
  const dryAnalyzer = new UniversalDRYAnalyzer();
  const dryResult = await dryAnalyzer.analyze([
    `${__dirname}/bench/corpus/dry/src/duplicates.ts`,
    `${__dirname}/bench/corpus/dry/src/unique.ts`,
  ], { minLineThreshold: 15, similarityThreshold: 0.85 });

  console.log(`Files processed: ${dryResult.filesProcessed}`);
  for (const v of dryResult.violations) {
    console.log(`  file=${v.file} rule=${v.rule} symbol=${(v as any).symbol || (v as any).functionName || ''} severity=${v.severity}`);
    console.log(`    message=${v.message?.slice(0, 200)}`);
  }

  // ── Data Access ───────────────────────────────────────
  console.log('\n=== DATA ACCESS ANALYZER ===');
  const daAnalyzer = new UniversalDataAccessAnalyzer();
  const daResult = await daAnalyzer.analyze([
    `${__dirname}/bench/corpus/data-access/src/n-plus-one.ts`,
    `${__dirname}/bench/corpus/data-access/src/clean-queries.ts`,
  ], {});

  console.log(`Files processed: ${daResult.filesProcessed}`);
  for (const v of daResult.violations) {
    console.log(`  file=${v.file} rule=${v.rule} symbol=${(v as any).symbol || (v as any).functionName || ''} severity=${v.severity}`);
  }

  // ── Schema ────────────────────────────────────────────
  console.log('\n=== SCHEMA ANALYZER ===');
  const schemaAnalyzer = new UniversalSchemaAnalyzer();
  const schemaResult = await schemaAnalyzer.analyze([
    `${__dirname}/bench/corpus/schema/src/unknown-table.ts`,
    `${__dirname}/bench/corpus/schema/src/known-tables.ts`,
  ], {
    schemas: [{
      name: 'test',
      tables: [
        { name: 'users', columns: [] },
        { name: 'orders', columns: [] },
        { name: 'products', columns: [] },
      ],
    }],
  });

  console.log(`Files processed: ${schemaResult.filesProcessed}`);
  for (const v of schemaResult.violations) {
    console.log(`  file=${v.file} rule=${v.rule} symbol=${(v as any).symbol || (v as any).functionName || ''} severity=${v.severity}`);
    console.log(`    message=${v.message?.slice(0, 200)}`);
  }

  // ── React ─────────────────────────────────────────────
  console.log('\n=== REACT ANALYZER ===');
  const reactResult = await reactAnalyzer.analyze([
    `${__dirname}/bench/corpus/react/src/bad-hook.tsx`,
    `${__dirname}/bench/corpus/react/src/good-hook.tsx`,
  ], { maxComponentComplexity: 10, checkHooksRules: true }, {} as any);

  console.log(`Files processed: ${reactResult.filesProcessed}`);
  for (const v of reactResult.violations) {
    console.log(`  file=${v.file} rule=${v.rule} violationType=${(v as any).violationType} severity=${v.severity}`);
    console.log(`    details:`, JSON.stringify((v as any).details));
    console.log(`    message=${v.message?.slice(0, 200)}`);
  }

  // ── Invariants ────────────────────────────────────────
  console.log('\n=== INVARIANTS ANALYZER ===');
  const invResult = await invariantsAnalyzer.analyze([
    `${__dirname}/bench/corpus/invariants/src/ban-violation.ts`,
    `${__dirname}/bench/corpus/invariants/src/compliant.ts`,
    `${__dirname}/bench/corpus/invariants/src/legacy-utils.ts`,
  ], {}, { projectRoot: `${__dirname}/bench/corpus/invariants` } as any);

  console.log(`Files processed: ${invResult.filesProcessed}`);
  for (const v of invResult.violations) {
    console.log(`  file=${v.file} rule=${v.rule} symbol=${(v as any).symbol || ''} severity=${v.severity}`);
    console.log(`    message=${v.message?.slice(0, 200)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
