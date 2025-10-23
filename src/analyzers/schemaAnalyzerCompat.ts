/**
 * Compatibility layer for Schema Analyzer
 * Ensures the new universal analyzer produces similar results to the legacy one
 */

import type { AnalyzerFunction } from '../types.js';
import { UniversalSchemaAnalyzer } from './universal/UniversalSchemaAnalyzer.js';
import { initializeLanguages } from '../languages/index.js';
import { CodeIndexDB } from '../codeIndexDB.js';

// Initialize language system on module load
initializeLanguages();

/**
 * Legacy-compatible schema analyzer function
 * This wraps the new UniversalSchemaAnalyzer to maintain API compatibility
 */
export const analyzeSchema: AnalyzerFunction = async (
  files: string[],
  config: any = {},
  options = {},
  progressCallback
) => {
  const analyzer = new UniversalSchemaAnalyzer();
  
  // Get loaded schemas from database if available
  let schemas: any[] = [];
  try {
    const db = CodeIndexDB.getInstance();
    await db.initialize();
    const loadedSchemas = await db.getAllSchemas();
    
    // Convert database schemas to universal format
    schemas = loadedSchemas.map(({ schema }) => ({
      name: schema.name,
      tables: schema.databases.flatMap(db => 
        db.tables.map(table => ({
          name: table.name,
          columns: table.columns || []
        }))
      )
    }));
  } catch (error) {
    // If database isn't available, continue without schemas
    console.warn('Schema database not available:', error);
  }
  
  // Map legacy config to universal config
  const universalConfig = {
    enableTableUsageTracking: config.enableTableUsageTracking ?? true,
    checkMissingReferences: config.checkMissingReferences ?? true,
    checkNamingConventions: config.checkNamingConventions ?? true,
    detectUnusedTables: config.detectUnusedTables ?? false,
    validateQueryPatterns: config.validateQueryPatterns ?? true,
    maxQueriesPerFunction: config.maxQueriesPerFunction ?? 5,
    requiredSchemas: config.requiredSchemas ?? [],
    schemas // Pass loaded schemas
  };
  
  // Call the universal analyzer
  const result = await analyzer.analyze(files, universalConfig);
  
  // Transform violations to match legacy format
  const transformedViolations = result.violations.map(v => ({
    ...v,
    schemaType: v.rule,
    details: v.message,
    analyzer: 'schema'
  }));
  
  return {
    ...result,
    violations: transformedViolations
  };
};

/**
 * Analyzer definition for registration
 */
export const schemaAnalyzer = {
  name: 'schema',
  description: 'Analyzes code against database schemas',
  category: 'database',
  analyze: analyzeSchema
};