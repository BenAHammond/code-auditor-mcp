import { dryAnalyzer } from '../dist/analyzers/dryAnalyzer.js';
import { discoverFiles } from '../dist/utils/fileDiscovery.js';

const files = ['/Users/ben/playground/code-auditor/test-validation/test-dry-unused-imports.ts'];

console.log('Files found:', files);

const result = await dryAnalyzer.analyze(
  files,
  { debug: true, checkUnusedImports: true },
  {},
  (progress) => console.log('Progress:', progress)
);

console.log('\nTotal violations:', result.violations.length);
console.log('Unused import violations:', result.violations.filter(v => v.message.includes('Unused import')).length);

// Log debug output
if (result.violations.length === 0) {
  console.log('\nNo violations found. Check debug logs at ./dry-analyzer-debug.log');
}

// Show all violations
result.violations.forEach(v => {
  console.log(`\n${v.severity}: ${v.message}`);
  console.log(`  File: ${v.file}:${v.line}`);
  console.log(`  Recommendation: ${v.recommendation}`);
});