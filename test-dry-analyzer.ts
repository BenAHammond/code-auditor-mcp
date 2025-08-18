#!/usr/bin/env node

/**
 * Test script for DRY analyzer with debug logging
 */

import { createAuditRunner } from './src/auditRunner.js';
import { promises as fs } from 'fs';
import path from 'path';

async function testDryAnalyzer() {
  console.log('Testing DRY Analyzer with debug logging...\n');
  
  // Create audit runner
  const runner = createAuditRunner({
    projectRoot: './test-duplicates',
    enabledAnalyzers: ['dry'],
    analyzerConfigs: {
      dry: {
        debug: true,
        debugLogPath: './dry-analyzer-test-debug.log',
        minLineThreshold: 3, // Lower threshold for testing
        similarityThreshold: 0.75, // Lower threshold to catch more similarities
        excludePatterns: [] // Don't exclude test files
      }
    }
  });
  
  try {
    // Run the audit
    const result = await runner.run();
    
    // Print summary
    console.log('=== DRY Analysis Results ===\n');
    console.log(`Files processed: ${result.metadata.filesAnalyzed}`);
    console.log(`Execution time: ${result.metadata.auditDuration}ms`);
    console.log(`Total violations: ${result.summary.totalViolations}\n`);
    
    // Print violations
    const dryResults = result.analyzerResults['dry'];
    if (dryResults && dryResults.violations.length > 0) {
      console.log('Violations found:');
      
      for (const violation of dryResults.violations) {
        console.log(`\n[${violation.severity.toUpperCase()}] ${violation.type}`);
        console.log(`Message: ${violation.message}`);
        console.log(`File: ${violation.file}:${violation.line}`);
        
        if (violation.locations && violation.locations.length > 0) {
          console.log('Locations:');
          violation.locations.forEach(loc => {
            console.log(`  - ${loc.file}:${loc.line}`);
          });
        }
        
        if (violation.similarity) {
          console.log(`Similarity: ${(violation.similarity * 100).toFixed(1)}%`);
        }
        
        if (violation.recommendation) {
          console.log(`Recommendation: ${violation.recommendation}`);
        }
      }
    } else {
      console.log('No violations found.');
    }
    
    // Check debug log
    console.log('\n=== Debug Log ===');
    try {
      const debugLog = await fs.readFile('./dry-analyzer-test-debug.log', 'utf-8');
      console.log('Debug log created successfully!');
      console.log(`Log file size: ${debugLog.length} bytes`);
      console.log('\nFirst 500 characters of debug log:');
      console.log(debugLog.substring(0, 500) + '...\n');
    } catch (error) {
      console.log('Debug log not found or error reading it:', error);
    }
    
  } catch (error) {
    console.error('Error running DRY analyzer:', error);
  }
}

// Run the test
testDryAnalyzer().catch(console.error);