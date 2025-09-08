import { createAuditRunner } from './src/auditRunner.js';

async function testIndexDuringAudit() {
  console.log('Testing function indexing during audit...\n');
  
  // Create runner with function indexing enabled
  const runner = createAuditRunner({
    projectRoot: './src',
    enabledAnalyzers: ['solid', 'dry'],
    indexFunctions: true,
    progressCallback: (progress) => {
      if (progress.phase === 'function-indexing') {
        console.log(`[Function Indexing] ${progress.message}`);
      }
    }
  });
  
  // Run audit
  const result = await runner.run();
  
  console.log('\n=== Audit Results ===');
  console.log(`Files analyzed: ${result.metadata.filesAnalyzed}`);
  console.log(`Total violations: ${result.summary.totalViolations}`);
  
  if (result.metadata.collectedFunctions) {
    console.log(`\n=== Collected Functions ===`);
    console.log(`Total functions collected: ${result.metadata.collectedFunctions.length}`);
    
    // Show first 5 functions
    console.log('\nFirst 5 functions:');
    result.metadata.collectedFunctions.slice(0, 5).forEach((func, i) => {
      console.log(`${i + 1}. ${func.name} in ${func.filePath}:${func.lineNumber}`);
    });
  } else {
    console.log('\nNo functions were collected.');
  }
}

testIndexDuringAudit().catch(console.error);