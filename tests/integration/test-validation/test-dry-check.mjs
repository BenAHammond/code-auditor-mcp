import { dryAnalyzer } from '../dist/analyzers/dryAnalyzer.js';

const testFiles = [
  '/Users/ben/playground/code-auditor/test-validation/test-dry-unused-imports.ts',
  '/Users/ben/playground/code-auditor/test-validation/test-edge-cases-imports.tsx',
  '/Users/ben/playground/code-auditor/test-validation/test-conditional-imports.ts'
];

console.log('Testing DRY analyzer with enhanced import detection...\n');

for (const file of testFiles) {
  console.log(`\nAnalyzing: ${file.split('/').pop()}`);
  console.log('='.repeat(50));
  
  const result = await dryAnalyzer.analyze(
    [file],
    { checkUnusedImports: true },
    {},
    () => {}
  );
  
  const unusedImportViolations = result.violations.filter(v => 
    v.message.includes('Unused import')
  );
  
  if (unusedImportViolations.length > 0) {
    console.log(`Found ${unusedImportViolations.length} unused import violations:`);
    unusedImportViolations.forEach(v => {
      console.log(`  - Line ${v.line}: ${v.message}`);
    });
  } else {
    console.log('No unused imports detected at file level.');
  }
}