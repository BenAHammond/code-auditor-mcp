#!/usr/bin/env node

/**
 * Script to verify that the DRY analyzer correctly detects unused imports
 */

import { dryAnalyzer } from '../src/analyzers/dryAnalyzer.js';
import path from 'path';

async function verifyUnusedImports() {
  console.log('Testing unused import detection...\n');
  
  const testFile = path.join(process.cwd(), 'test-validation/test-unused-imports.ts');
  
  // Run the DRY analyzer with unused imports checking enabled
  const result = await dryAnalyzer.analyze(
    [testFile],
    {
      checkUnusedImports: true,
      checkImports: false,
      checkStrings: false,
      debug: true
    },
    undefined,
    (progress) => {
      console.log(`Progress: ${progress.current}/${progress.total} - ${progress.phase}`);
    }
  );
  
  console.log('\nAnalysis complete!');
  console.log(`Total violations found: ${result.violations.length}`);
  
  // Expected unused imports
  const expectedUnused = [
    'useState',
    'useEffect', 
    'useCallback',
    'debounce',
    'throttle',
    'fs',
    'path',
    'crypto',
    'ReactNode' // Type-only import
  ];
  
  console.log('\nExpected unused imports:');
  expectedUnused.forEach(imp => console.log(`  - ${imp}`));
  
  console.log('\nActual violations found:');
  const unusedImportViolations = result.violations.filter(v => 
    v.message.includes('Unused import')
  );
  
  unusedImportViolations.forEach(violation => {
    console.log(`  - Line ${violation.line}: ${violation.message}`);
  });
  
  // Check if all expected imports were detected
  const detectedImports = unusedImportViolations.map(v => {
    const match = v.message.match(/Unused import '(\w+)'/);
    return match ? match[1] : null;
  }).filter(Boolean);
  
  console.log('\nVerification results:');
  expectedUnused.forEach(imp => {
    const detected = detectedImports.includes(imp);
    console.log(`  ${detected ? '✓' : '✗'} ${imp}`);
  });
  
  const allDetected = expectedUnused.every(imp => detectedImports.includes(imp));
  const noFalsePositives = !detectedImports.includes('format'); // This one is used
  
  console.log('\n' + '='.repeat(50));
  console.log(`All expected imports detected: ${allDetected ? 'PASS' : 'FAIL'}`);
  console.log(`No false positives: ${noFalsePositives ? 'PASS' : 'FAIL'}`);
  console.log('='.repeat(50));
  
  // Write debug log if enabled
  const debugLogPath = './dry-analyzer-debug.log';
  console.log(`\nDebug log written to: ${debugLogPath}`);
}

// Run the verification
verifyUnusedImports().catch(console.error);