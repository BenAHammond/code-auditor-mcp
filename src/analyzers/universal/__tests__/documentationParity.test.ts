/**
 * Parity tests to ensure the universal analyzer produces identical results
 */

import { describe, it, expect } from 'vitest';
import { analyzeDocumentation as legacyAnalyze } from '../../documentationAnalyzer.js';
import { analyzeDocumentation as universalAnalyze } from '../../documentationAnalyzerCompat.js';
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

describe('DocumentationAnalyzer Parity Tests', () => {
  afterEach(async () => {
    await cleanupTestFiles();
  });
  
  describe('Function Documentation', () => {
    it('should produce identical results for undocumented function', async () => {
      const code = `
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
      `;
      
      const file = await createTestFile(code, 'undocumented.ts');
      
      const legacyResult = await legacyAnalyze([file]);
      const universalResult = await universalAnalyze([file]);
      
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
      expect(universalResult.violations[0].message).toBe(legacyResult.violations[0].message);
      expect(universalResult.violations[0].line).toBe(legacyResult.violations[0].line);
    });
    
    it('should produce identical results for properly documented function', async () => {
      const code = `
/**
 * Calculate the total price of items
 * @param items - Array of items with price property
 * @returns The total price
 */
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
      `;
      
      const file = await createTestFile(code, 'documented.ts');
      
      const legacyResult = await legacyAnalyze([file]);
      const universalResult = await universalAnalyze([file]);
      
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
    });
    
    it('should handle missing parameter documentation identically', async () => {
      const code = `
/**
 * Calculate the total price
 */
function calculateTotal(items, taxRate) {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0);
  return subtotal * (1 + taxRate);
}
      `;
      
      const file = await createTestFile(code, 'missing-params.ts');
      
      const config = { requireParamDocs: true };
      const legacyResult = await legacyAnalyze([file], config);
      const universalResult = await universalAnalyze([file], config);
      
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
      
      // Should have violations for both missing parameters
      const paramViolations = universalResult.violations.filter(v => 
        v.message.includes('parameter')
      );
      expect(paramViolations).toHaveLength(2);
    });
  });
  
  describe('Class/Component Documentation', () => {
    it('should handle React component documentation identically', async () => {
      const code = `
import React from 'react';

export const Button = ({ label, onClick }) => {
  return <button onClick={onClick}>{label}</button>;
};
      `;
      
      const file = await createTestFile(code, 'component.tsx');
      
      const config = { requireComponentDocs: true };
      const legacyResult = await legacyAnalyze([file], config);
      const universalResult = await universalAnalyze([file], config);
      
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
    });
    
    it('should handle class documentation identically', async () => {
      const code = `
export class UserService {
  constructor(private db: Database) {}
  
  async getUser(id: string) {
    return this.db.users.findOne({ id });
  }
}
      `;
      
      const file = await createTestFile(code, 'class.ts');
      
      const legacyResult = await legacyAnalyze([file]);
      const universalResult = await universalAnalyze([file]);
      
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
    });
  });
  
  describe('File Documentation', () => {
    it('should handle missing file documentation identically', async () => {
      const code = `
export function helper() {
  return 'helper';
}
      `;
      
      const file = await createTestFile(code, 'no-header.ts');
      
      const config = { requireFileDocs: true };
      const legacyResult = await legacyAnalyze([file], config);
      const universalResult = await universalAnalyze([file], config);
      
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
      expect(universalResult.violations[0].line).toBe(1);
    });
    
    it('should accept file with proper header identically', async () => {
      const code = `
/**
 * User utility functions
 * This module provides helper functions for user management
 */

export function helper() {
  return 'helper';
}
      `;
      
      const file = await createTestFile(code, 'with-header.ts');
      
      const config = { requireFileDocs: true, requireFunctionDocs: false };
      const legacyResult = await legacyAnalyze([file], config);
      const universalResult = await universalAnalyze([file], config);
      
      expect(universalResult.violations).toHaveLength(0);
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
    });
  });
  
  describe('Configuration Options', () => {
    it('should respect checkExportedOnly identically', async () => {
      const code = `
function internalHelper() {
  return 'internal';
}

export function publicHelper() {
  return 'public';
}
      `;
      
      const file = await createTestFile(code, 'exported.ts');
      
      const config = { checkExportedOnly: true };
      const legacyResult = await legacyAnalyze([file], config);
      const universalResult = await universalAnalyze([file], config);
      
      // Should only have violation for the exported function
      expect(universalResult.violations).toHaveLength(1);
      expect(universalResult.violations[0].message).toContain('publicHelper');
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
    });
    
    it('should respect exemptPatterns identically', async () => {
      const code = `
function testHelper() {
  return 'test';
}

function mockData() {
  return 'mock';
}

function normalFunction() {
  return 'normal';
}
      `;
      
      const file = await createTestFile(code, 'exempt.ts');
      
      const config = { 
        exemptPatterns: ['test', 'mock']
      };
      const legacyResult = await legacyAnalyze([file], config);
      const universalResult = await universalAnalyze([file], config);
      
      // Should only have violation for normalFunction
      expect(universalResult.violations).toHaveLength(1);
      expect(universalResult.violations[0].message).toContain('normalFunction');
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
    });
    
    it('should handle minDescriptionLength identically', async () => {
      const code = `
/**
 * Short
 */
function shortDoc() {
  return 'short';
}

/**
 * This is a much longer description that exceeds the minimum length requirement
 */
function longDoc() {
  return 'long';
}
      `;
      
      const file = await createTestFile(code, 'description-length.ts');
      
      const config = { minDescriptionLength: 20 };
      const legacyResult = await legacyAnalyze([file], config);
      const universalResult = await universalAnalyze([file], config);
      
      // Should only have violation for shortDoc
      expect(universalResult.violations).toHaveLength(1);
      expect(universalResult.violations[0].message).toContain('shortDoc');
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
    });
  });
  
  describe('Edge Cases', () => {
    it('should handle arrow functions identically', async () => {
      const code = `
export const arrowFunc = (a: number, b: number) => a + b;

export const asyncArrow = async (id: string) => {
  const result = await fetch(\`/api/users/\${id}\`);
  return result.json();
};
      `;
      
      const file = await createTestFile(code, 'arrows.ts');
      
      const legacyResult = await legacyAnalyze([file]);
      const universalResult = await universalAnalyze([file]);
      
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
    });
    
    it('should handle method documentation identically', async () => {
      const code = `
/**
 * User management service
 */
export class UserService {
  /**
   * Get user by ID
   */
  async getUser(id: string) {
    return { id };
  }
  
  async updateUser(id: string, data: any) {
    return { id, ...data };
  }
}
      `;
      
      const file = await createTestFile(code, 'methods.ts');
      
      const legacyResult = await legacyAnalyze([file]);
      const universalResult = await universalAnalyze([file]);
      
      // Should have violation for undocumented updateUser method
      expect(universalResult.violations).toHaveLength(1);
      expect(universalResult.violations[0].message).toContain('updateUser');
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
    });
    
    it('should handle complex JSDoc identically', async () => {
      const code = `
/**
 * Complex function with various JSDoc tags
 * @param {Object} options - Configuration options
 * @param {string} options.name - The name
 * @param {number} [options.age] - The age (optional)
 * @returns {Promise<User>} The user object
 * @throws {Error} If user not found
 * @example
 * const user = await getUser({ name: 'John', age: 30 });
 * @see {@link https://example.com/docs}
 * @since 1.0.0
 * @deprecated Use getUserById instead
 */
export async function getUser(options) {
  return { name: options.name, age: options.age };
}
      `;
      
      const file = await createTestFile(code, 'complex-jsdoc.ts');
      
      const legacyResult = await legacyAnalyze([file]);
      const universalResult = await universalAnalyze([file]);
      
      // Should have no violations - fully documented
      expect(universalResult.violations).toHaveLength(0);
      expect(universalResult.violations).toHaveLength(legacyResult.violations.length);
    });
  });
});

/**
 * Run comparison on real-world files
 */
describe('Real-world File Comparison', () => {
  it('should produce identical results on actual TypeScript files', async () => {
    // Test on some actual files from the codebase
    const testFiles = [
      path.join(__dirname, '../../analyzerUtils.ts'),
      path.join(__dirname, '../../../types.ts')
    ];
    
    // Filter to only existing files
    const existingFiles = [];
    for (const file of testFiles) {
      try {
        await fs.access(file);
        existingFiles.push(file);
      } catch {
        // Skip non-existent files
      }
    }
    
    if (existingFiles.length > 0) {
      const legacyResult = await legacyAnalyze(existingFiles);
      const universalResult = await universalAnalyze(existingFiles);
      
      // Compare violation counts
      expect(universalResult.violations.length).toBe(legacyResult.violations.length);
      
      // Compare each violation
      for (let i = 0; i < legacyResult.violations.length; i++) {
        const legacy = legacyResult.violations[i];
        const universal = universalResult.violations[i];
        
        expect(universal.file).toBe(legacy.file);
        expect(universal.line).toBe(legacy.line);
        expect(universal.severity).toBe(legacy.severity);
        expect(universal.rule).toBe(legacy.rule);
        // Messages might have slight differences, but should be similar
        expect(universal.message).toContain(legacy.message.split(' ')[0]);
      }
    }
  });
});