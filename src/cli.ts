#!/usr/bin/env node

/**
 * Code Auditor CLI
 */

import { createAuditRunner } from './auditRunner.js';
import { parseArgs } from 'util';

async function main() {
  console.log('🔍 Code Quality Audit Tool');
  console.log('══════════════════════════════════════════════════');
  
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' }
    }
  });
  
  if (values.help) {
    console.log(`
Usage: code-audit [options]

Options:
  -h, --help     Show help
`);
    process.exit(0);
  }
  
  try {
    const runner = createAuditRunner();
    const result = await runner.run();
    
    console.log(`\nFound ${result.summary.totalViolations} violations`);
    console.log(`Critical: ${result.summary.criticalIssues}`);
    console.log(`Warnings: ${result.summary.warnings}`);
    console.log(`Suggestions: ${result.summary.suggestions}`);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();