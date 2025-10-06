/**
 * Code Index Service
 * Main service functions for managing the function index using LokiJS + FlexSearch
 */

import { FunctionMetadata, EnhancedFunctionMetadata, SearchOptions, RegisterResult, SearchResult, IndexStats } from './types.js';
import { CodeIndexDB } from './codeIndexDB.js';
import { loadConfig } from './config/configLoader.js';
import path from 'path';

// Custom error types
export class CodeIndexError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'CodeIndexError';
  }
}

export class ValidationError extends CodeIndexError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

export class DatabaseError extends CodeIndexError {
  constructor(message: string) {
    super(message, 'DATABASE_ERROR');
  }
}

export class SearchError extends CodeIndexError {
  constructor(message: string) {
    super(message, 'SEARCH_ERROR');
  }
}

// Database instance storage
let dbInstance: CodeIndexDB | null = null;

/**
 * Initialize database with schema
 */
export async function initializeCodeIndex(dbPath?: string): Promise<CodeIndexDB> {
  try {
    // Use in-memory database by default
    if (!dbPath) {
      dbPath = ':memory:';
    }
    
    // Use path as-is for in-memory, resolve for file paths
    const finalPath = dbPath === ':memory:' ? dbPath : path.resolve(dbPath);
    
    // Create and initialize database
    const db = new CodeIndexDB(finalPath);
    await db.initialize();
    
    // Store instance for reuse
    dbInstance = db;
    
    return db;
  } catch (error) {
    throw new DatabaseError(`Failed to initialize code index: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get or create database instance
 */
export async function getDatabase(): Promise<CodeIndexDB> {
  if (!dbInstance) {
    dbInstance = await initializeCodeIndex();
  }
  return dbInstance;
}

/**
 * Validate function metadata
 */
export function validateFunctionMetadata(func: any): string | null {
  if (!func || typeof func !== 'object') {
    return 'Function metadata must be an object';
  }
  
  if (!func.name || typeof func.name !== 'string' || func.name.trim().length === 0) {
    return 'Function name is required and must be a non-empty string';
  }
  
  if (!func.filePath || typeof func.filePath !== 'string' || func.filePath.trim().length === 0) {
    return 'File path is required and must be a non-empty string';
  }
  
  if (!func.purpose || typeof func.purpose !== 'string' || func.purpose.trim().length === 0) {
    return 'Purpose is required and must be a non-empty string';
  }
  
  if (!func.context || typeof func.context !== 'string' || func.context.trim().length === 0) {
    return 'Context is required and must be a non-empty string';
  }
  
  if (!Array.isArray(func.dependencies)) {
    return 'Dependencies must be an array';
  }
  
  if (func.lineNumber !== undefined && (typeof func.lineNumber !== 'number' || func.lineNumber < 1)) {
    return 'Line number must be a positive number';
  }
  
  if (func.language !== undefined && typeof func.language !== 'string') {
    return 'Language must be a string';
  }
  
  return null;
}

/**
 * Register functions in the index
 */
export async function registerFunctions(
  functions: FunctionMetadata[],
  options: { overwrite?: boolean } = {}
): Promise<RegisterResult> {
  const db = await getDatabase();
  
  // Validate all functions first
  const errors: Array<{ function: string; error: string }> = [];
  const validFunctions: FunctionMetadata[] = [];
  
  for (const func of functions) {
    const validationError = validateFunctionMetadata(func);
    if (validationError) {
      errors.push({ function: func.name || 'unknown', error: validationError });
    } else {
      validFunctions.push(func);
    }
  }
  
  // Register valid functions
  const result = await db.registerFunctions(validFunctions);
  
  // Combine errors
  if (errors.length > 0 && result.errors) {
    result.errors.push(...errors);
  } else if (errors.length > 0) {
    result.errors = errors;
  }
  
  result.failed += errors.length;
  
  return result;
}

/**
 * Search functions with full-text search
 */
export async function searchFunctions(searchOptions: SearchOptions): Promise<SearchResult> {
  const db = await getDatabase();
  
  try {
    return await db.searchFunctions(searchOptions);
  } catch (error) {
    throw new SearchError(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Synchronize file index - ensures index matches current file state
 */
export async function syncFileIndex(
  filePath: string,
  currentFunctions: FunctionMetadata[]
): Promise<{ added: number; updated: number; removed: number }> {
  const db = await getDatabase();
  
  try {
    return await db.syncFileIndex(filePath, currentFunctions);
  } catch (error) {
    throw new DatabaseError(`Failed to sync file index: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Find a specific function definition
 */
export async function findDefinition(
  name: string,
  filePath?: string
): Promise<FunctionMetadata | null> {
  const db = await getDatabase();
  
  try {
    return await db.findDefinition(name, filePath);
  } catch (error) {
    throw new SearchError(`Failed to find definition: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get index statistics
 */
export async function getIndexStats(): Promise<IndexStats> {
  const db = await getDatabase();
  
  try {
    const stats = await db.getStats();
    return {
      totalFunctions: stats.totalFunctions,
      languages: stats.languages,
      topDependencies: stats.topDependencies,
      filesIndexed: stats.filesIndexed,
      lastUpdated: stats.lastUpdated
    };
  } catch (error) {
    throw new DatabaseError(`Failed to get index stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Clear the entire index
 */
export async function clearIndex(): Promise<void> {
  const db = await getDatabase();
  
  try {
    await db.clearIndex();
  } catch (error) {
    throw new DatabaseError(`Failed to clear index: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Update dependency graph for all functions or specific file
 */
export async function updateDependencyGraph(filePath?: string): Promise<void> {
  const db = await getDatabase();
  
  try {
    await db.updateDependencyGraph(filePath);
  } catch (error) {
    throw new DatabaseError(`Failed to update dependency graph: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get transitive dependencies for a function
 */
export async function getTransitiveDependencies(
  functionName: string,
  maxDepth: number = 10
): Promise<Array<{ name: string; depth: number }>> {
  const db = await getDatabase();
  
  try {
    return await db.getTransitiveDependencies(functionName, maxDepth);
  } catch (error) {
    throw new DatabaseError(`Failed to get transitive dependencies: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get transitive callers for a function
 */
export async function getTransitiveCallers(
  functionName: string,
  maxDepth: number = 10
): Promise<Array<{ name: string; depth: number }>> {
  const db = await getDatabase();
  
  try {
    return await db.getTransitiveCallers(functionName, maxDepth);
  } catch (error) {
    throw new DatabaseError(`Failed to get transitive callers: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Detect circular dependencies in the codebase
 */
export async function detectCircularDependencies(): Promise<Array<string[]>> {
  const db = await getDatabase();
  
  try {
    return await db.detectCircularDependencies();
  } catch (error) {
    throw new DatabaseError(`Failed to detect circular dependencies: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Calculate dependency depths for all functions
 */
export async function calculateDependencyDepths(): Promise<void> {
  const db = await getDatabase();
  
  try {
    await db.calculateDependencyDepths();
  } catch (error) {
    throw new DatabaseError(`Failed to calculate dependency depths: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get all functions from the index
 */
export async function getAllFunctions(): Promise<EnhancedFunctionMetadata[]> {
  const db = await getDatabase();
  
  try {
    return await db.getAllFunctions();
  } catch (error) {
    throw new DatabaseError(`Failed to get all functions: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}