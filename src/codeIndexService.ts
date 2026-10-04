/**
 * Code Index Service
 * Main service functions for managing the function index using LokiJS + FlexSearch
 */

import { FunctionMetadata, EnhancedFunctionMetadata, SearchOptions, RegisterResult, SearchResult, IndexStats } from './types.js';
import { CodeIndexDB } from './codeIndexDB.js';
import { errorMessage } from './utils/errorMessage.js';
import { loadConfig } from './config/configLoader.js';
import path from 'path';

// Custom error types

/**
 * Base error type for code-index failures, carrying a stable machine-readable code.
 */
export class CodeIndexError extends Error {
  /**
   * Creates a code index error.
   *
   * @param message - The human-readable error message.
   * @param code - The stable machine-readable error code.
   */
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'CodeIndexError';
  }
}

/**
 * Raised when function metadata fails validation.
 */
export class ValidationError extends CodeIndexError {
  /**
   * Creates a validation error with the `VALIDATION_ERROR` code.
   *
   * @param message - The human-readable validation failure message.
   */
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

/**
 * Raised when a database operation on the code index fails.
 */
export class DatabaseError extends CodeIndexError {
  /**
   * Creates a database error with the `DATABASE_ERROR` code.
   *
   * @param message - The human-readable database failure message.
   */
  constructor(message: string) {
    super(message, 'DATABASE_ERROR');
  }
}

/**
 * Raised when a search over the code index fails.
 */
export class SearchError extends CodeIndexError {
  /**
   * Creates a search error with the `SEARCH_ERROR` code.
   *
   * @param message - The human-readable search failure message.
   */
  constructor(message: string) {
    super(message, 'SEARCH_ERROR');
  }
}

/**
 * Initialize database with schema.
 * Default (no path): same on-disk singleton as CodeIndexDB.getInstance() / MCP.
 * Explicit file path: separate DB instance (tests or advanced use).
 *
 * @param dbPath - Optional explicit database file path, or `:memory:`.
 * @returns The initialized `CodeIndexDB` instance.
 */
export async function initializeCodeIndex(dbPath?: string): Promise<CodeIndexDB> {
  try {
    if (dbPath && dbPath !== ':memory:') {
      const db = new CodeIndexDB(path.resolve(dbPath));
      await db.initialize();
      return db;
    }
    const db = CodeIndexDB.getInstance();
    await db.initialize();
    return db;
  } catch (error) {
    throw new DatabaseError(`Failed to initialize code index: ${errorMessage(error)}`);
  }
}

/**
 * Primary entry: persisted singleton (or explicit path via initializeCodeIndex elsewhere).
 * Aligns search/sync/register with MCP's CodeIndexDB.getInstance() — previously defaulted to :memory:.
 */
export async function getDatabase(): Promise<CodeIndexDB> {
  return initializeCodeIndex();
}

/**
 * Validate function metadata.
 *
 * @param func - The function metadata to validate.
 * @returns An error message, or null when the metadata is valid.
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
 * Register functions in the index.
 *
 * @param functions - The function metadata records to register.
 * @param options - Optional overwrite behavior.
 * @returns The registration result including any validation errors.
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
  const result = await db.functionIndex.registerFunctions(validFunctions);
  
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
 * Search functions with full-text search.
 *
 * @param searchOptions - The query, filters, and pagination for the search.
 * @returns The matching functions and metadata.
 */
export async function searchFunctions(searchOptions: SearchOptions): Promise<SearchResult> {
  const db = await getDatabase();
  
  try {
    return await db.search.searchFunctions(searchOptions);
  } catch (error) {
    throw new SearchError(`Search failed: ${errorMessage(error)}`);
  }
}

/**
 * Synchronize file index - ensures index matches current file state.
 *
 * @param filePath - The file whose index entry is being synced.
 * @param currentFunctions - The functions currently present in the file.
 * @returns Counts of added, updated, and removed functions.
 */
export async function syncFileIndex(
  filePath: string,
  currentFunctions: FunctionMetadata[]
): Promise<{ added: number; updated: number; removed: number }> {
  const db = await getDatabase();
  
  try {
    return await db.syncFileIndex(filePath, currentFunctions);
  } catch (error) {
    throw new DatabaseError(`Failed to sync file index: ${errorMessage(error)}`);
  }
}

/**
 * Find a specific function definition.
 *
 * @param name - The function name to look up.
 * @param filePath - Optional file path to disambiguate the lookup.
 * @returns The matching function metadata, or null if not found.
 */
export async function findDefinition(
  name: string,
  filePath?: string
): Promise<FunctionMetadata | null> {
  const db = await getDatabase();
  
  try {
    return await db.functionIndex.findDefinition(name, filePath);
  } catch (error) {
    throw new SearchError(`Failed to find definition: ${errorMessage(error)}`);
  }
}

/**
 * Get index statistics.
 *
 * @returns The current index statistics.
 */
export async function getIndexStats(): Promise<IndexStats> {
  const db = await getDatabase();
  
  try {
    const stats = await db.functionIndex.getStats();
    return {
      totalFunctions: stats.totalFunctions,
      languages: stats.languages,
      topDependencies: stats.topDependencies,
      filesIndexed: stats.filesIndexed,
      lastUpdated: stats.lastUpdated
    };
  } catch (error) {
    throw new DatabaseError(`Failed to get index stats: ${errorMessage(error)}`);
  }
}

/**
 * Clear analysis-derived index data (functions, search, audits, code maps, schemas).
 * Does not remove project tasks, analyzer configs, or whitelist entries.
 *
 * @returns A promise that resolves once the index is cleared.
 */
export async function clearIndex(): Promise<void> {
  const db = await getDatabase();
  
  try {
    await db.clearIndex();
  } catch (error) {
    throw new DatabaseError(`Failed to clear index: ${errorMessage(error)}`);
  }
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
  await CodeIndexDB.getInstance().close();
}

/**
 * Update dependency graph for all functions or a specific file.
 *
 * @param filePath - Optional file path to restrict the update to.
 * @returns A promise that resolves once the graph is updated.
 */
export async function updateDependencyGraph(filePath?: string): Promise<void> {
  const db = await getDatabase();
  
  try {
    await db.graph.updateDependencyGraph(filePath);
  } catch (error) {
    throw new DatabaseError(`Failed to update dependency graph: ${errorMessage(error)}`);
  }
}

/**
 * Get transitive dependencies for a function.
 *
 * @param functionName - The function to resolve dependencies for.
 * @param maxDepth - Maximum traversal depth (default 10).
 * @returns The transitive dependencies with their depths.
 */
export async function getTransitiveDependencies(
  functionName: string,
  maxDepth: number = 10
): Promise<Array<{ name: string; depth: number }>> {
  const db = await getDatabase();
  
  try {
    return await db.graph.getTransitiveDependencies(functionName, maxDepth);
  } catch (error) {
    throw new DatabaseError(`Failed to get transitive dependencies: ${errorMessage(error)}`);
  }
}

/**
 * Get transitive callers for a function.
 *
 * @param functionName - The function to resolve callers for.
 * @param maxDepth - Maximum traversal depth (default 10).
 * @returns The transitive callers with their depths.
 */
export async function getTransitiveCallers(
  functionName: string,
  maxDepth: number = 10
): Promise<Array<{ name: string; depth: number }>> {
  const db = await getDatabase();
  
  try {
    return await db.graph.getTransitiveCallers(functionName, maxDepth);
  } catch (error) {
    throw new DatabaseError(`Failed to get transitive callers: ${errorMessage(error)}`);
  }
}

/**
 * Detect circular dependencies in the codebase.
 *
 * @returns The detected dependency cycles.
 */
export async function detectCircularDependencies(): Promise<Array<string[]>> {
  const db = await getDatabase();
  
  try {
    return await db.graph.detectCircularDependencies();
  } catch (error) {
    throw new DatabaseError(`Failed to detect circular dependencies: ${errorMessage(error)}`);
  }
}

/**
 * Calculate dependency depths for all functions.
 *
 * @returns A promise that resolves once depths are calculated.
 */
export async function calculateDependencyDepths(): Promise<void> {
  const db = await getDatabase();
  
  try {
    await db.graph.calculateDependencyDepths();
  } catch (error) {
    throw new DatabaseError(`Failed to calculate dependency depths: ${errorMessage(error)}`);
  }
}

/**
 * Get all functions from the index.
 *
 * @returns All indexed functions with their metadata.
 */
export async function getAllFunctions(): Promise<EnhancedFunctionMetadata[]> {
  const db = await getDatabase();
  
  try {
    return await db.functionIndex.getAllFunctions();
  } catch (error) {
    throw new DatabaseError(`Failed to get all functions: ${errorMessage(error)}`);
  }
}