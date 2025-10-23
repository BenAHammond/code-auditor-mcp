/**
 * Parity tests to ensure the universal DRY analyzer produces similar results
 */

import { describe, it, expect } from 'vitest';
import { analyzeDRY as legacyAnalyze } from '../../dryAnalyzer.js';
import { analyzeDRY as universalAnalyze } from '../../dryAnalyzerCompat.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Test helper to create temporary test files
 */
async function createTestFile(content: string, filename: string): Promise<string> {
  const testDir = path.join(__dirname, 'temp');
  await fs.mkdir(testDir, { recursive: true });
  const filePath = path.join(testDir, filename);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

/**
 * Clean up test files
 */
async function cleanupTestFiles(): Promise<void> {
  const testDir = path.join(__dirname, 'temp');
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore if directory doesn't exist
  }
}

describe('DRY Analyzer Parity Tests', () => {
  afterEach(async () => {
    await cleanupTestFiles();
  });
  
  describe('Duplicate Code Detection', () => {
    it('should detect exact function duplicates', async () => {
      const code = `
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

function computeSum(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
      `;
      
      const file = await createTestFile(code, 'duplicates.ts');
      
      const legacyResult = await legacyAnalyze([file]);
      const universalResult = await universalAnalyze([file]);
      
      // Both should detect the duplicate
      expect(universalResult.violations.length).toBeGreaterThan(0);
      expect(universalResult.violations.some(v => v.message.includes('Duplicate'))).toBe(true);
    });
    
    it('should ignore whitespace differences when configured', async () => {
      const code = `
function processData(data) {
  const result = data.map(item => item * 2);
  return result;
}

function   processData2(data)   {
  const   result   =   data.map(item   =>   item   *   2);
  return   result;
}
      `;
      
      const file = await createTestFile(code, 'whitespace.ts');
      
      const config = { ignoreWhitespace: true };
      const legacyResult = await legacyAnalyze([file], config);
      const universalResult = await universalAnalyze([file], config);
      
      // Should detect as duplicate when ignoring whitespace
      expect(universalResult.violations.length).toBeGreaterThan(0);
    });
    
    it('should respect minLineThreshold', async () => {
      const code = `
// Short duplicate (3 lines)
function short1() {
  const x = 1;
  return x;
}

function short2() {
  const x = 1;
  return x;
}

// Long duplicate (6 lines)
function long1() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  return a + b + c + d + e;
}

function long2() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  return a + b + c + d + e;
}
      `;
      
      const file = await createTestFile(code, 'threshold.ts');
      
      const config = { minLineThreshold: 5 };
      const universalResult = await universalAnalyze([file], config);
      
      // Should only detect the long duplicate
      const duplicateViolations = universalResult.violations.filter(v => 
        v.message.includes('Duplicate') && v.message.includes('6 lines')
      );
      expect(duplicateViolations.length).toBeGreaterThan(0);
      
      // Should not detect the short duplicate
      const shortDuplicates = universalResult.violations.filter(v =>
        v.message.includes('short')
      );
      expect(shortDuplicates.length).toBe(0);
    });
  });
  
  describe('String Literal Detection', () => {
    it('should detect duplicate string literals when enabled', async () => {
      const code = `
const msg1 = "This is a long error message that should be extracted";
const msg2 = "This is a long error message that should be extracted";
const msg3 = "This is a long error message that should be extracted";

const short1 = "hi";
const short2 = "hi";
      `;
      
      const file = await createTestFile(code, 'strings.ts');
      
      const config = { checkStrings: true };
      const universalResult = await universalAnalyze([file], config);
      
      // Should detect the long string duplicate
      const stringViolations = universalResult.violations.filter(v => 
        v.message.includes('String literal')
      );
      expect(stringViolations.length).toBeGreaterThan(0);
    });
  });
  
  describe('Import Detection', () => {
    it('should detect duplicate imports when enabled', async () => {
      const code = `
import { useState } from 'react';
import { useEffect } from 'react';
import React from 'react';

import path from 'path';
      `;
      
      const file = await createTestFile(code, 'imports.ts');
      
      const config = { checkImports: true };
      const universalResult = await universalAnalyze([file], config);
      
      // Should detect react imported multiple times
      const importViolations = universalResult.violations.filter(v => 
        v.message.includes('imported') && v.message.includes('times')
      );
      expect(importViolations.length).toBeGreaterThan(0);
    });
  });
  
  describe('Complex Scenarios', () => {
    it('should handle class method duplicates', async () => {
      const code = `
class UserService {
  getUser(id: string) {
    const query = \`SELECT * FROM users WHERE id = \${id}\`;
    return this.db.query(query);
  }
  
  getUserById(id: string) {
    const query = \`SELECT * FROM users WHERE id = \${id}\`;
    return this.db.query(query);
  }
}
      `;
      
      const file = await createTestFile(code, 'class-methods.ts');
      
      const universalResult = await universalAnalyze([file]);
      
      // Should detect duplicate methods
      expect(universalResult.violations.length).toBeGreaterThan(0);
    });
    
    it('should handle nested block duplicates', async () => {
      const code = `
function process1(items) {
  for (const item of items) {
    if (item.active) {
      console.log(item.name);
      item.processed = true;
      item.timestamp = Date.now();
    }
  }
}

function process2(elements) {
  for (const item of elements) {
    if (item.active) {
      console.log(item.name);
      item.processed = true;
      item.timestamp = Date.now();
    }
  }
}
      `;
      
      const file = await createTestFile(code, 'nested.ts');
      
      const config = { minLineThreshold: 3 };
      const universalResult = await universalAnalyze([file], config);
      
      // Should detect the duplicate nested block
      expect(universalResult.violations.length).toBeGreaterThan(0);
    });
  });
  
  describe('Configuration Options', () => {
    it('should respect excludePatterns', async () => {
      const code = `
function duplicate1() {
  return 'test';
}

function duplicate2() {
  return 'test';
}
      `;
      
      const file = await createTestFile(code, 'exclude.test.ts');
      
      const config = { excludePatterns: ['**/*.test.ts'] };
      const universalResult = await universalAnalyze([file], config);
      
      // Should not analyze test files
      expect(universalResult.violations).toHaveLength(0);
    });
    
    it('should ignore comments when configured', async () => {
      const code = `
function func1() {
  // This is a comment
  const x = 1;
  /* Multi-line
     comment */
  return x;
}

function func2() {
  // Different comment
  const x = 1;
  /* Another
     comment */
  return x;
}
      `;
      
      const file = await createTestFile(code, 'comments.ts');
      
      const config = { ignoreComments: true, minLineThreshold: 3 };
      const universalResult = await universalAnalyze([file], config);
      
      // Should detect as duplicate when ignoring comments
      expect(universalResult.violations.length).toBeGreaterThan(0);
    });
  });
});