#!/usr/bin/env node
import * as ts from 'typescript';
import { extractIdentifierUsage } from './src/utils/astUtils.js';

// Test cases for interface extension detection
const testCases = [
  {
    name: 'Simple interface extends',
    code: `
import { BaseFilters } from '@/components/shared/filters/CommonFilterControls';

export interface ReportFilters extends BaseFilters {
  customField: string;
}`,
    expectedType: 'type'
  },
  {
    name: 'Interface extends with namespace',
    code: `
import * as Types from './types';

interface MyInterface extends Types.BaseInterface {
  additionalProp: boolean;
}`,
    expectedType: 'type'
  },
  {
    name: 'Multiple interface extends',
    code: `
import { Base1, Base2 } from './bases';

interface Combined extends Base1, Base2 {
  ownProp: number;
}`,
    expectedType: 'type'
  },
  {
    name: 'Direct usage (not type-only)',
    code: `
import { BaseFilters } from '@/components/shared/filters/CommonFilterControls';

const filters = new BaseFilters();`,
    expectedType: 'direct'
  }
];

console.log('Testing interface extension detection fix...\n');

for (const testCase of testCases) {
  console.log(`Test: ${testCase.name}`);
  
  const sourceFile = ts.createSourceFile(
    'test.ts',
    testCase.code,
    ts.ScriptTarget.Latest,
    true
  );
  
  // Get import names
  const importNames = new Set<string>();
  function findImports(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        clause.namedBindings.elements.forEach(spec => {
          importNames.add(spec.name.text);
        });
      }
      
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        importNames.add(clause.namedBindings.name.text);
      }
    }
    ts.forEachChild(node, findImports);
  }
  findImports(sourceFile);
  
  // Extract usage
  const usage = extractIdentifierUsage(sourceFile, sourceFile, importNames);
  
  // Check results
  const firstImport = Array.from(importNames)[0];
  const usageInfo = usage.get(firstImport);
  
  if (usageInfo) {
    console.log(`  Import: ${firstImport}`);
    console.log(`  Detected usage type: ${usageInfo.usageType}`);
    console.log(`  Expected: ${testCase.expectedType}`);
    console.log(`  ✅ ${usageInfo.usageType === testCase.expectedType ? 'PASS' : 'FAIL'}\n`);
  } else {
    console.log(`  ❌ FAIL: No usage detected\n`);
  }
}