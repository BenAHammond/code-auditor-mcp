#!/usr/bin/env node

import { createAuditRunner } from './dist/auditRunner.js';

async function testSolidImprovements() {
  console.log('Testing SOLID analyzer improvements...\n');
  
  // Create a small test file to analyze
  const testCode = `
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { URL, URLSearchParams } from 'url';

// This should not be flagged - using platform APIs
class FileManager {
  constructor() {
    this.url = new URL('https://example.com');
    this.params = new URLSearchParams();
  }
  
  async readFile(filePath) {
    return fsPromises.readFile(filePath, 'utf-8');
  }
  
  hashContent(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
`;

  // Write test file
  await import('fs/promises').then(fs => 
    fs.writeFile('./test-solid-file.ts', testCode)
  );
  
  const runner = createAuditRunner({
    projectRoot: '.',
    enabledAnalyzers: ['solid'],
    minSeverity: 'warning',
    verbose: true
  });
  
  const result = await runner.run();
  
  console.log('\nSOLID Analysis Results:');
  console.log(`Total violations: ${result.summary.totalViolations}`);
  console.log(`Critical: ${result.summary.criticalIssues}`);
  console.log(`Warnings: ${result.summary.warnings}`);
  
  const solidResult = result.analyzerResults.solid;
  
  // Check for false positives on Node.js built-ins
  const nodeBuiltinViolations = solidResult.violations.filter(v => 
    v.message.includes('fs') || 
    v.message.includes('path') || 
    v.message.includes('crypto')
  );
  
  console.log(`\nNode.js built-in violations: ${nodeBuiltinViolations.length}`);
  
  // Check for false positives on platform APIs
  const platformApiViolations = solidResult.violations.filter(v => 
    v.message.includes('URL') || 
    v.message.includes('URLSearchParams')
  );
  
  console.log(`Platform API violations: ${platformApiViolations.length}`);
  
  // Clean up
  await import('fs/promises').then(fs => 
    fs.unlink('./test-solid-file.ts').catch(() => {})
  );
  
  console.log('\n✓ Test completed!');
}

testSolidImprovements().catch(console.error);