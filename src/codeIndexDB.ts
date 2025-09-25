/**
 * Code Index Database using LokiJS + FlexSearch
 * Pure JavaScript implementation with no native dependencies
 */

import Loki, { Collection } from 'lokijs';
import * as FlexSearch from 'flexsearch';
import { promises as fs } from 'fs';
import path from 'path';
import { EnhancedFunctionMetadata, FunctionMetadata, SearchResult, SearchOptions, ParsedQuery } from './types.js';
import { QueryParser } from './search/QueryParser.js';

// Types
interface FunctionDocument extends EnhancedFunctionMetadata {
  $loki?: number;
  meta?: any;
}

// Using SearchOptions and SearchResult from types.ts

export class CodeIndexDB {
  private static instance: CodeIndexDB;
  private db: Loki;
  private functionsCollection: Collection<FunctionDocument> | null = null;
  private searchIndex: any; // FlexSearch Document instance
  private dbPath: string;
  private isInitialized = false;

  constructor(dbPath: string = './.code-index/index.db') {
    this.dbPath = dbPath;
    this.db = new Loki(dbPath, {
      autosave: true,
      autosaveInterval: 4000,
      autoload: false
    });

    // Initialize FlexSearch with full-text search configuration
    const { Document } = FlexSearch as any;
    this.searchIndex = new Document({
      document: {
        id: '$loki',
        index: [
          {
            field: 'name',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            bidirectional: true,
            weight: 10  // Highest weight for function name matches
          },
          {
            field: 'tokenizedName',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            bidirectional: true,
            weight: 9  // High weight for tokenized name matches
          },
          {
            field: 'signature',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 8  // High weight for signature matches
          },
          {
            field: 'purpose',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 7  // Important for semantic search
          },
          {
            field: 'context',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 6  // Contextual information
          },
          {
            field: 'jsDoc.description',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 5  // Documentation matches
          },
          {
            field: 'parameters[].name',
            tokenize: 'full',
            optimize: true,
            resolution: 7,
            weight: 4  // Parameter name matches
          },
          {
            field: 'parameters[].description',
            tokenize: 'full',
            optimize: true,
            resolution: 7,
            weight: 3  // Parameter description matches
          },
          {
            field: 'returnType',
            tokenize: 'full',
            optimize: true,
            resolution: 7,
            weight: 2  // Return type matches
          },
          {
            field: 'body',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 1  // Body content matches (lower weight to prioritize metadata matches)
          }
        ]
      },
      tokenize: 'full',  // Global full-text tokenization
      optimize: true,
      resolution: 9,
      cache: 100,
      context: {
        depth: 3,  // Enable contextual scoring
        bidirectional: true,  // Search in both directions
        resolution: 9
      },
      threshold: 7,  // Lower threshold for fuzzy matching
      depth: 3  // Search depth for better fuzzy matching
    });
  }

  static getInstance(dbPath?: string): CodeIndexDB {
    if (!CodeIndexDB.instance) {
      CodeIndexDB.instance = new CodeIndexDB(dbPath || './.code-index/index.db');
    }
    return CodeIndexDB.instance;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });

    // Load database
    await new Promise<void>((resolve, reject) => {
      this.db.loadDatabase({}, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Get or create functions collection
    this.functionsCollection = this.db.getCollection('functions') || 
      this.db.addCollection('functions', {
        indices: ['name', 'filePath', 'language']
      });

    // Rebuild search index from existing data
    const existingDocs = this.functionsCollection.find();
    for (const doc of existingDocs) {
      const normalizedData = this.normalizeFunctionData(doc);
      this.searchIndex.add(normalizedData);
    }

    this.isInitialized = true;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.functionsCollection) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
  }

  /**
   * Normalize function metadata for indexing
   * Converts FunctionMetadata to have required fields for FlexSearch
   */
  private normalizeFunctionData(func: FunctionMetadata | EnhancedFunctionMetadata): any {
    // If it's already enhanced, return as-is with $loki if present
    if ('signature' in func && 'parameters' in func) {
      const normalized = { ...func };
      // Ensure nested jsDoc structure exists
      if (!normalized.jsDoc) {
        normalized.jsDoc = { description: func.purpose || '' };
      }
      // Add tokenized name to improve searchability
      normalized.tokenizedName = this.tokenizeFunctionName(func.name);
      return normalized;
    }

    // Convert basic FunctionMetadata to have searchable fields
    const enhanced: any = {
      ...func,
      signature: func.name, // Use name as signature for now
      parameters: [], // Empty parameters array
      jsDoc: {
        description: func.purpose || ''
      },
      returnType: 'unknown',
      // Add tokenized name for better searching
      tokenizedName: this.tokenizeFunctionName(func.name),
      // Extract body from metadata if present
      body: func.metadata?.body
    };

    return enhanced;
  }

  /**
   * Tokenize function name for better search
   * Splits camelCase, PascalCase, and snake_case into individual words
   */
  private tokenizeFunctionName(name: string): string {
    // Remove class prefix if present (e.g., "UserService.authenticate" -> "authenticate")
    const functionName = name.includes('.') ? name.split('.').pop()! : name;
    
    // Split camelCase and PascalCase
    const camelSplit = functionName
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
    
    // Split snake_case and kebab-case
    const allSplit = camelSplit
      .replace(/[_-]/g, ' ')
      .toLowerCase()
      .trim();
    
    return allSplit;
  }

  async registerFunction(func: FunctionMetadata | EnhancedFunctionMetadata): Promise<void> {
    this.ensureInitialized();
    
    try {
      // Check if function already exists (use composite key: name + filePath + lineNumber)
      const existing = this.functionsCollection!.findOne({
        name: func.name,
        filePath: func.filePath,
        lineNumber: func.lineNumber
      });

      if (existing) {
        // Update existing
        Object.assign(existing, func);
        this.functionsCollection!.update(existing);
        const normalizedData = this.normalizeFunctionData(existing);
        this.searchIndex.update(normalizedData);
      } else {
        // Insert new
        const doc = this.functionsCollection!.insert(func as FunctionDocument);
        const normalizedData = this.normalizeFunctionData(doc);
        this.searchIndex.add(normalizedData);
      }

      // Force save
      this.db.saveDatabase();
    } catch (error) {
      throw new Error(`Failed to register function: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async registerFunctions(functions: (FunctionMetadata | EnhancedFunctionMetadata)[]): Promise<{
    success: boolean;
    registered: number;
    failed: number;
    errors?: Array<{ function: string; error: string }>;
  }> {
    this.ensureInitialized();
    
    let registered = 0;
    let failed = 0;
    const errors: Array<{ function: string; error: string }> = [];

    for (const func of functions) {
      try {
        await this.registerFunction(func);
        registered++;
      } catch (error) {
        failed++;
        errors.push({
          function: func.name || 'unknown',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return {
      success: failed === 0,
      registered,
      failed,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Synchronize file index - add new functions, update existing, remove deleted
   * @param filePath The file path to synchronize
   * @param currentFunctions The current functions found in the file
   * @returns Sync statistics
   */
  async syncFileIndex(filePath: string, currentFunctions: (FunctionMetadata | EnhancedFunctionMetadata)[]): Promise<{
    added: number;
    updated: number;
    removed: number;
  }> {
    this.ensureInitialized();
    
    const stats = {
      added: 0,
      updated: 0,
      removed: 0
    };

    try {
      // Get all currently indexed functions for this file
      const indexedFunctions = this.functionsCollection!.find({ filePath });
      
      // Create a map of current functions by composite key for quick lookup
      const createKey = (f: any) => `${f.name}:${f.filePath}:${f.lineNumber}`;
      const currentFunctionMap = new Map(
        currentFunctions.map(f => [createKey(f), f])
      );

      // Update or add functions
      for (const func of currentFunctions) {
        const existing = indexedFunctions.find(f => 
          f.name === func.name && 
          f.filePath === func.filePath && 
          f.lineNumber === func.lineNumber
        );
        
        if (existing) {
          // Update existing function
          Object.assign(existing, func);
          this.functionsCollection!.update(existing);
          const normalizedData = this.normalizeFunctionData(existing);
          this.searchIndex.update(normalizedData);
          stats.updated++;
        } else {
          // Add new function
          const doc = this.functionsCollection!.insert(func as FunctionDocument);
          const normalizedData = this.normalizeFunctionData(doc);
          this.searchIndex.add(normalizedData);
          stats.added++;
        }
      }

      // Remove functions that no longer exist in the file
      for (const indexed of indexedFunctions) {
        const indexedKey = createKey(indexed);
        if (!currentFunctionMap.has(indexedKey)) {
          // Function no longer exists, remove it
          this.functionsCollection!.remove(indexed);
          this.searchIndex.remove(indexed.$loki);
          stats.removed++;
        }
      }

      // Update dependency graph for the affected functions
      await this.updateDependencyGraph(filePath);

      // Force save
      this.db.saveDatabase();

    } catch (error) {
      throw new Error(`Failed to sync file index: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return stats;
  }

  /**
   * Update dependency graph - build reverse mappings for calledBy relationships
   * @param filePath Optional file path to limit the update scope
   */
  async updateDependencyGraph(filePath?: string): Promise<void> {
    this.ensureInitialized();
    
    try {
      // Get all functions (or just those in the specified file)
      const functions = filePath 
        ? this.functionsCollection!.find({ filePath })
        : this.functionsCollection!.find();
      
      // Clear existing calledBy relationships for affected functions
      for (const func of functions) {
        if (func.metadata) {
          func.metadata.calledBy = [];
        }
      }
      
      // Build calledBy relationships by iterating through all functions
      const allFunctions = this.functionsCollection!.find();
      
      for (const caller of allFunctions) {
        if (caller.metadata?.functionCalls) {
          for (const callee of caller.metadata.functionCalls) {
            // Find the called function
            const calledFunc = this.findFunctionByQualifiedName(callee);
            
            if (calledFunc && calledFunc.metadata) {
              if (!calledFunc.metadata.calledBy) {
                calledFunc.metadata.calledBy = [];
              }
              
              // Add caller to calledBy list if not already present
              const callerName = this.getQualifiedFunctionName(caller);
              if (!calledFunc.metadata.calledBy.includes(callerName)) {
                calledFunc.metadata.calledBy.push(callerName);
                this.functionsCollection!.update(calledFunc);
              }
            }
          }
        }
      }
    } catch (error) {
      throw new Error(`Failed to update dependency graph: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Find a function by its qualified name (e.g., "filePath#functionName")
   */
  private findFunctionByQualifiedName(qualifiedName: string): FunctionDocument | null {
    // Handle different name formats
    if (qualifiedName.includes('#')) {
      const [filePath, functionName] = qualifiedName.split('#');
      return this.functionsCollection!.findOne({ 
        filePath: { $regex: filePath },
        name: functionName 
      });
    } else {
      // Simple function name - search across all files
      return this.functionsCollection!.findOne({ name: qualifiedName });
    }
  }
  
  /**
   * Get qualified name for a function
   */
  private getQualifiedFunctionName(func: FunctionDocument): string {
    return `${func.filePath}#${func.name}`;
  }
  
  /**
   * Get transitive dependencies for a function (functions it calls, directly and indirectly)
   * @param functionName The function to analyze
   * @param maxDepth Maximum depth to traverse (default 10)
   * @returns Array of function names with their depth
   */
  async getTransitiveDependencies(
    functionName: string, 
    maxDepth: number = 10
  ): Promise<Array<{ name: string; depth: number }>> {
    this.ensureInitialized();
    
    const dependencies: Array<{ name: string; depth: number }> = [];
    const visited = new Set<string>();
    
    const traverse = (funcName: string, depth: number) => {
      if (depth > maxDepth || visited.has(funcName)) return;
      visited.add(funcName);
      
      const func = this.findFunctionByQualifiedName(funcName);
      if (!func?.metadata?.functionCalls) return;
      
      for (const callee of func.metadata.functionCalls) {
        if (!visited.has(callee)) {
          dependencies.push({ name: callee, depth });
          traverse(callee, depth + 1);
        }
      }
    };
    
    traverse(functionName, 1);
    return dependencies;
  }
  
  /**
   * Get transitive callers for a function (functions that call it, directly and indirectly)
   * @param functionName The function to analyze
   * @param maxDepth Maximum depth to traverse (default 10)
   * @returns Array of function names with their depth
   */
  async getTransitiveCallers(
    functionName: string,
    maxDepth: number = 10
  ): Promise<Array<{ name: string; depth: number }>> {
    this.ensureInitialized();
    
    const callers: Array<{ name: string; depth: number }> = [];
    const visited = new Set<string>();
    
    const traverse = (funcName: string, depth: number) => {
      if (depth > maxDepth || visited.has(funcName)) return;
      visited.add(funcName);
      
      const func = this.findFunctionByQualifiedName(funcName);
      if (!func?.metadata?.calledBy) return;
      
      for (const caller of func.metadata.calledBy) {
        if (!visited.has(caller)) {
          callers.push({ name: caller, depth });
          traverse(caller, depth + 1);
        }
      }
    };
    
    traverse(functionName, 1);
    return callers;
  }
  
  /**
   * Detect circular dependencies in the codebase
   * @returns Array of circular dependency chains
   */
  async detectCircularDependencies(): Promise<Array<string[]>> {
    this.ensureInitialized();
    
    const cycles: Array<string[]> = [];
    const allFunctions = this.functionsCollection!.find();
    
    for (const func of allFunctions) {
      if (!func.metadata?.functionCalls) continue;
      
      const funcName = this.getQualifiedFunctionName(func);
      const visited = new Set<string>();
      const path: string[] = [];
      
      const hasCycle = (current: string): boolean => {
        if (path.includes(current)) {
          // Found a cycle - extract it
          const cycleStart = path.indexOf(current);
          const cycle = [...path.slice(cycleStart), current];
          
          // Check if we already have this cycle (in any rotation)
          const isNewCycle = !cycles.some(existing => 
            existing.length === cycle.length &&
            existing.every(f => cycle.includes(f))
          );
          
          if (isNewCycle) {
            cycles.push(cycle);
          }
          return true;
        }
        
        if (visited.has(current)) return false;
        visited.add(current);
        path.push(current);
        
        const currentFunc = this.findFunctionByQualifiedName(current);
        if (currentFunc?.metadata?.functionCalls) {
          for (const callee of currentFunc.metadata.functionCalls) {
            if (hasCycle(callee)) return true;
          }
        }
        
        path.pop();
        return false;
      };
      
      hasCycle(funcName);
    }
    
    return cycles;
  }
  
  /**
   * Calculate the maximum dependency depth for each function
   * Updates the dependencyDepth field in metadata
   */
  async calculateDependencyDepths(): Promise<void> {
    this.ensureInitialized();
    
    const allFunctions = this.functionsCollection!.find();
    
    for (const func of allFunctions) {
      const funcName = this.getQualifiedFunctionName(func);
      const dependencies = await this.getTransitiveDependencies(funcName);
      
      const maxDepth = dependencies.length > 0 
        ? Math.max(...dependencies.map(d => d.depth))
        : 0;
      
      if (!func.metadata) {
        func.metadata = {};
      }
      
      func.metadata.dependencyDepth = maxDepth;
      this.functionsCollection!.update(func);
    }
    
    this.db.saveDatabase();
  }

  async searchFunctions(options: SearchOptions): Promise<SearchResult> {
    this.ensureInitialized();
    const startTime = Date.now();

    let results: FunctionDocument[] = [];
    let searchScores = new Map<number, number>(); // Map of $loki id to relevance score

    // Parse the query if provided
    const queryParser = new QueryParser();
    let parsedQuery: ParsedQuery | undefined;
    
    // Determine search mode
    const searchMode = options.searchMode || 'metadata';
    
    if (options.query) {
      parsedQuery = options.parsedQuery || queryParser.parse(options.query);
      
      // Check if there are search terms or just filters
      if (parsedQuery.terms.length > 0 || parsedQuery.phrases.length > 0) {
        if (searchMode === 'content') {
          // Content search only
          results = await this.executeContentSearch(parsedQuery, searchScores);
        } else if (searchMode === 'both') {
          // Both metadata and content search
          const metadataResults = await this.executeMultiStrategySearch(parsedQuery, searchScores);
          const contentResults = await this.executeContentSearch(parsedQuery, searchScores);
          
          // Merge results, combining scores for duplicates
          const resultMap = new Map<number, FunctionDocument>();
          metadataResults.forEach(doc => {
            if (doc.$loki !== undefined) {
              resultMap.set(doc.$loki, doc);
            }
          });
          contentResults.forEach(doc => {
            if (doc.$loki !== undefined) {
              resultMap.set(doc.$loki, doc);
              // Combine scores
              const existingScore = searchScores.get(doc.$loki) || 0;
              searchScores.set(doc.$loki, existingScore);
            }
          });
          results = Array.from(resultMap.values());
        } else {
          // Metadata search only (default)
          results = await this.executeMultiStrategySearch(parsedQuery, searchScores);
        }
      } else {
        // No search terms, just filters - get all
        results = this.functionsCollection!.find();
        results.forEach((doc, index) => {
          if (doc.$loki !== undefined) {
            searchScores.set(doc.$loki, 50); // Base score for browse mode
          }
        });
      }
    } else if (options.parsedQuery) {
      parsedQuery = options.parsedQuery;
      
      // Check if there are search terms or just filters
      if (parsedQuery.terms.length > 0 || parsedQuery.phrases.length > 0) {
        if (searchMode === 'content') {
          results = await this.executeContentSearch(parsedQuery, searchScores);
        } else if (searchMode === 'both') {
          const metadataResults = await this.executeMultiStrategySearch(parsedQuery, searchScores);
          const contentResults = await this.executeContentSearch(parsedQuery, searchScores);
          
          // Merge results
          const resultMap = new Map<number, FunctionDocument>();
          metadataResults.forEach(doc => {
            if (doc.$loki !== undefined) {
              resultMap.set(doc.$loki, doc);
            }
          });
          contentResults.forEach(doc => {
            if (doc.$loki !== undefined) {
              resultMap.set(doc.$loki, doc);
              // Combine scores
              const existingScore = searchScores.get(doc.$loki) || 0;
              searchScores.set(doc.$loki, existingScore);
            }
          });
          results = Array.from(resultMap.values());
        } else {
          results = await this.executeMultiStrategySearch(parsedQuery, searchScores);
        }
      } else {
        // No search terms, just filters - get all
        results = this.functionsCollection!.find();
        results.forEach((doc, index) => {
          if (doc.$loki !== undefined) {
            searchScores.set(doc.$loki, 50); // Base score for browse mode
          }
        });
      }
    } else {
      // No query, get all
      results = this.functionsCollection!.find();
      // Give all results a base score
      results.forEach((doc, index) => {
        if (doc.$loki !== undefined) {
          searchScores.set(doc.$loki, 50); // Base score for browse mode
        }
      });
    }

    // Apply filters from both options and parsedQuery
    const combinedFilters = this.mergeFilters(options.filters, parsedQuery?.filters);
    results = this.applyFilters(results, combinedFilters);

    // Sort by relevance score
    results.sort((a, b) => {
      const scoreA = searchScores.get(a.$loki!) || 0;
      const scoreB = searchScores.get(b.$loki!) || 0;
      return scoreB - scoreA; // Higher scores first
    });

    // Apply pagination
    const totalCount = results.length;
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    
    results = results.slice(offset, offset + limit);

    // Clean up results and add scores
    const functions = results.map((doc) => {
      const { $loki, meta, ...functionData } = doc;
      const score = searchScores.get($loki!) || 0;
      return {
        ...functionData,
        score
      } as EnhancedFunctionMetadata & { score: number };
    });

    return {
      functions,
      totalCount,
      query: options.query,
      parsedQuery,
      executionTime: Date.now() - startTime
    };
  }

  /**
   * Execute multi-strategy search with different approaches
   * @param parsedQuery The parsed query object
   * @param searchScores Map to store relevance scores
   * @returns Array of matching documents
   */
  private async executeMultiStrategySearch(
    parsedQuery: ParsedQuery,
    searchScores: Map<number, number>
  ): Promise<FunctionDocument[]> {
    const resultsMap = new Map<number, FunctionDocument>(); // Map of $loki id to document
    
    // Strategy 1: Exact phrase matching (highest weight)
    if (parsedQuery.phrases.length > 0) {
      for (const phrase of parsedQuery.phrases) {
        const phraseResults = await this.searchWithFlexSearch(phrase, 1000);
        this.mergeSearchResults(phraseResults, resultsMap, searchScores, 100); // High weight for exact phrases
      }
    }

    // Strategy 2: All terms must match (AND logic) - use original terms
    const originalTerms = parsedQuery.originalTerms || parsedQuery.terms;
    if (originalTerms.length > 0) {
      // For each original term, search including its synonyms
      const termResultSets: Map<string, Set<number>> = new Map();
      
      for (const originalTerm of originalTerms) {
        // Get synonyms for this term
        const queryParser = new QueryParser();
        const synonyms = queryParser.getSynonyms(originalTerm);
        const searchTerms = [originalTerm, ...synonyms];
        
        // Find documents containing ANY of the synonyms
        const termIds = new Set<number>();
        for (const searchTerm of searchTerms) {
          const termResults = await this.searchWithFlexSearch(searchTerm, 1000);
          termResults.forEach(doc => {
            if (doc.$loki !== undefined) termIds.add(doc.$loki);
          });
        }
        
        termResultSets.set(originalTerm, termIds);
      }
      
      // Find documents that contain ALL original terms (or their synonyms)
      if (termResultSets.size > 0) {
        const allTermIds = this.intersectSets(Array.from(termResultSets.values()));
        
        if (allTermIds.size > 0) {
          const allTermDocs = this.functionsCollection!.find({
            $loki: { $in: Array.from(allTermIds) }
          });
          
          // Calculate score based on how many fields matched
          allTermDocs.forEach(doc => {
            const baseScore = 80; // Base score for AND matches
            const fieldMatchBonus = this.calculateFieldMatchScore(doc, originalTerms);
            this.mergeSearchResults([doc], resultsMap, searchScores, baseScore + fieldMatchBonus);
          });
        }
      }
    }

    // Strategy 3: Any term can match (OR logic) - lower weight
    if (parsedQuery.terms.length > 0) {
      const orQuery = parsedQuery.terms.join(' ');
      const orResults = await this.searchWithFlexSearch(orQuery, 1000);
      
      // Score based on how many terms matched
      orResults.forEach(doc => {
        const matchCount = this.countMatchingTerms(doc, parsedQuery.terms);
        const score = 40 + (matchCount * 10); // Base score + bonus per matched term
        this.mergeSearchResults([doc], resultsMap, searchScores, score);
      });
    }

    // Strategy 4: Fuzzy search if enabled
    if (parsedQuery.fuzzy && parsedQuery.terms.length > 0) {
      // FlexSearch already provides fuzzy matching with threshold setting
      const fuzzyQuery = parsedQuery.terms.join(' ');
      const fuzzyResults = await this.searchWithFlexSearch(fuzzyQuery, 1000, true);
      this.mergeSearchResults(fuzzyResults, resultsMap, searchScores, 30); // Lower weight for fuzzy
    }

    // Apply excluded terms filter
    let finalResults = Array.from(resultsMap.values());
    if (parsedQuery.excludedTerms.length > 0) {
      finalResults = this.excludeTermsFromResults(finalResults, parsedQuery.excludedTerms);
    }

    return finalResults;
  }

  /**
   * Search using FlexSearch and return document results
   */
  private async searchWithFlexSearch(
    query: string, 
    limit: number, 
    fuzzy: boolean = false
  ): Promise<FunctionDocument[]> {
    const searchOptions: any = { limit };
    
    const searchResults = await this.searchIndex.search(query, searchOptions);
    
    // Extract loki IDs from FlexSearch results
    const lokiIds: number[] = [];
    for (const fieldResult of searchResults) {
      if (fieldResult.result && Array.isArray(fieldResult.result)) {
        lokiIds.push(...fieldResult.result);
      }
    }
    
    // Remove duplicates and fetch documents
    const uniqueLokiIds = [...new Set(lokiIds)];
    
    if (uniqueLokiIds.length === 0) {
      return [];
    }
    
    return this.functionsCollection!.find({
      $loki: { $in: uniqueLokiIds }
    });
  }

  /**
   * Merge search results with scoring
   */
  private mergeSearchResults(
    newResults: FunctionDocument[],
    resultsMap: Map<number, FunctionDocument>,
    searchScores: Map<number, number>,
    weight: number
  ): void {
    newResults.forEach(doc => {
      if (doc.$loki === undefined) return;
      
      // Add or update document in results map
      resultsMap.set(doc.$loki, doc);
      
      // Update score (accumulate if already exists)
      const currentScore = searchScores.get(doc.$loki) || 0;
      searchScores.set(doc.$loki, currentScore + weight);
    });
  }

  /**
   * Calculate bonus score based on which fields matched
   */
  private calculateFieldMatchScore(doc: FunctionDocument, terms: string[]): number {
    let score = 0;
    const lowerTerms = terms.map(t => t.toLowerCase());
    
    // Check each field with different weights
    if (doc.name && lowerTerms.some(t => doc.name.toLowerCase().includes(t))) {
      score += 15; // High bonus for name match
    }
    if (doc.signature && lowerTerms.some(t => doc.signature.toLowerCase().includes(t))) {
      score += 10;
    }
    if (doc.purpose && lowerTerms.some(t => doc.purpose.toLowerCase().includes(t))) {
      score += 8;
    }
    if (doc.jsDoc?.description && lowerTerms.some(t => doc.jsDoc.description.toLowerCase().includes(t))) {
      score += 5;
    }
    
    return score;
  }

  /**
   * Count how many terms match in a document
   */
  private countMatchingTerms(doc: FunctionDocument, terms: string[]): number {
    let count = 0;
    const documentText = this.getDocumentSearchText(doc).toLowerCase();
    
    terms.forEach(term => {
      if (documentText.includes(term.toLowerCase())) {
        count++;
      }
    });
    
    return count;
  }

  /**
   * Get searchable text from document
   */
  private getDocumentSearchText(doc: FunctionDocument): string {
    const parts = [
      doc.name,
      doc.signature,
      doc.purpose,
      doc.context,
      doc.jsDoc?.description,
      doc.returnType,
      ...(doc.parameters || []).map(p => `${p.name} ${p.description || ''}`),
      ...doc.dependencies
    ];
    
    return parts.filter(Boolean).join(' ');
  }

  /**
   * Get synonyms for a term using QueryParser
   */
  private getSynonyms(term: string): string[] {
    const queryParser = new QueryParser();
    return queryParser.getSynonyms(term);
  }

  /**
   * Exclude documents containing any of the excluded terms
   */
  private excludeTermsFromResults(
    results: FunctionDocument[],
    excludedTerms: string[]
  ): FunctionDocument[] {
    return results.filter(doc => {
      const searchText = this.getDocumentSearchText(doc).toLowerCase();
      return !excludedTerms.some(term => searchText.includes(term.toLowerCase()));
    });
  }

  /**
   * Intersect multiple sets to find common elements
   */
  private intersectSets<T>(sets: Set<T>[]): Set<T> {
    if (sets.length === 0) return new Set();
    if (sets.length === 1) return sets[0];
    
    const result = new Set(sets[0]);
    for (let i = 1; i < sets.length; i++) {
      for (const item of result) {
        if (!sets[i].has(item)) {
          result.delete(item);
        }
      }
    }
    
    return result;
  }

  /**
   * Merge filters from options and parsed query
   */
  private mergeFilters(
    optionsFilters?: SearchOptions['filters'],
    queryFilters?: ParsedQuery['filters']
  ): SearchOptions['filters'] {
    const merged: SearchOptions['filters'] = {};
    
    // Copy options filters
    if (optionsFilters) {
      Object.assign(merged, optionsFilters);
    }
    
    // Merge query filters (query filters take precedence)
    if (queryFilters) {
      if (queryFilters.language) merged.language = queryFilters.language;
      if (queryFilters.filePath) merged.filePath = queryFilters.filePath;
      if (queryFilters.fileType) merged.fileType = queryFilters.fileType;
      if (queryFilters.hasJsDoc !== undefined) merged.hasJsDoc = queryFilters.hasJsDoc;
      if (queryFilters.complexity) merged.complexity = queryFilters.complexity;
      if (queryFilters.dateRange) merged.dateRange = queryFilters.dateRange;
      if (queryFilters.metadata) merged.metadata = queryFilters.metadata;
    }
    
    return merged;
  }

  /**
   * Apply filters to search results
   */
  private applyFilters(
    results: FunctionDocument[],
    filters?: SearchOptions['filters']
  ): FunctionDocument[] {
    if (!filters) return results;
    
    let filtered = results;
    
    if (filters.language) {
      filtered = filtered.filter(doc => doc.language === filters.language);
    }
    
    if (filters.filePath) {
      // Support both exact match and includes based on the filter format
      if (filters.filePath.includes('*') || filters.filePath.includes('?')) {
        // Glob pattern - convert to regex
        const pattern = filters.filePath
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.')
          .replace(/\//g, '\\/');
        const regex = new RegExp(pattern);
        filtered = filtered.filter(doc => regex.test(doc.filePath));
      } else if (filters.filePath.endsWith('.ts') || filters.filePath.endsWith('.tsx') || 
                 filters.filePath.endsWith('.js') || filters.filePath.endsWith('.jsx')) {
        // If it looks like a full filename, match the end of the path
        filtered = filtered.filter(doc => doc.filePath.endsWith(filters.filePath!));
      } else {
        // Otherwise, do substring match (for directory paths)
        filtered = filtered.filter(doc => doc.filePath.includes(filters.filePath!));
      }
    }
    
    if (filters.fileType) {
      filtered = filtered.filter(doc => doc.filePath.endsWith(filters.fileType!));
    }
    
    if (filters.hasJsDoc !== undefined) {
      filtered = filtered.filter(doc => {
        const hasJsDoc = doc.jsDoc && doc.jsDoc.description && doc.jsDoc.description.length > 0;
        return filters.hasJsDoc ? hasJsDoc : !hasJsDoc;
      });
    }
    
    if (filters.complexity) {
      filtered = filtered.filter(doc => {
        if (!doc.complexity) return false;
        const complexity = doc.complexity;
        const min = filters.complexity!.min || 0;
        const max = filters.complexity!.max || Infinity;
        return complexity >= min && complexity <= max;
      });
    }
    
    if (filters.hasAnyDependency && filters.hasAnyDependency.length > 0) {
      filtered = filtered.filter(doc => 
        filters.hasAnyDependency!.some(dep => doc.dependencies.includes(dep))
      );
    }
    
    // Apply metadata filters
    if (filters.metadata) {
      filtered = filtered.filter(doc => {
        if (!doc.metadata) return false;
        
        // Check entityType
        if (filters.metadata!.entityType && 
            doc.metadata.entityType !== filters.metadata!.entityType) {
          return false;
        }
        
        // Check componentType
        if (filters.metadata!.componentType && 
            doc.metadata.componentType !== filters.metadata!.componentType) {
          return false;
        }
        
        // Check hasHook
        if (filters.metadata!.hasHook && doc.metadata.hooks) {
          const hasHook = doc.metadata.hooks.some(hook => 
            hook.name.toLowerCase().includes(filters.metadata!.hasHook!.toLowerCase())
          );
          if (!hasHook) return false;
        } else if (filters.metadata!.hasHook) {
          return false; // No hooks but filter requires one
        }
        
        // Check hasProp
        if (filters.metadata!.hasProp && doc.metadata.props) {
          const hasProp = doc.metadata.props.some(prop => 
            prop.name.toLowerCase().includes(filters.metadata!.hasProp!.toLowerCase())
          );
          if (!hasProp) return false;
        } else if (filters.metadata!.hasProp) {
          return false; // No props but filter requires one
        }
        
        // Check usesDependency
        if (filters.metadata!.usesDependency) {
          const dep = filters.metadata!.usesDependency.toLowerCase();
          // Check in both file-level dependencies and function-specific usedImports
          const usesDepInFile = doc.dependencies.some(d => d.toLowerCase().includes(dep));
          const usesDepInFunction = doc.metadata.usedImports?.some(imp => 
            imp.toLowerCase().includes(dep)
          ) || false;
          if (!usesDepInFile && !usesDepInFunction) return false;
        }
        
        // Check callsFunction
        if (filters.metadata!.callsFunction && doc.metadata.functionCalls) {
          const targetFunc = filters.metadata!.callsFunction.toLowerCase();
          const callsFunc = doc.metadata.functionCalls.some(call => 
            call.toLowerCase().includes(targetFunc)
          );
          if (!callsFunc) return false;
        } else if (filters.metadata!.callsFunction) {
          return false; // No function calls but filter requires one
        }
        
        // Check calledByFunction
        if (filters.metadata!.calledByFunction && doc.metadata.calledBy) {
          const callerFunc = filters.metadata!.calledByFunction.toLowerCase();
          const isCalledBy = doc.metadata.calledBy.some(caller => 
            caller.toLowerCase().includes(callerFunc)
          );
          if (!isCalledBy) return false;
        } else if (filters.metadata!.calledByFunction) {
          return false; // Not called by any function but filter requires one
        }
        
        // Check dependsOnModule
        if (filters.metadata!.dependsOnModule) {
          const module = filters.metadata!.dependsOnModule.toLowerCase();
          // Check if any import or function call references this module
          const dependsOnFile = doc.filePath.toLowerCase().includes(module);
          const dependsOnImport = doc.dependencies.some(dep => 
            dep.toLowerCase().includes(module)
          );
          const dependsOnCall = doc.metadata.functionCalls?.some(call => 
            call.toLowerCase().includes(module)
          ) || false;
          if (!dependsOnFile && !dependsOnImport && !dependsOnCall) return false;
        }
        
        // Check hasUnusedImports
        if (filters.metadata!.hasUnusedImports) {
          const hasUnused = doc.metadata.unusedImports && 
                           doc.metadata.unusedImports.length > 0;
          if (!hasUnused) return false;
        }
        
        return true;
      });
    }
    
    return filtered;
  }

  async findDefinition(name: string, filePath?: string): Promise<EnhancedFunctionMetadata | null> {
    this.ensureInitialized();

    const query: any = { name };
    if (filePath) {
      query.filePath = filePath;
    }

    const result = this.functionsCollection!.findOne(query);
    if (!result) return null;

    const { $loki, meta, ...functionData } = result;
    return functionData as EnhancedFunctionMetadata;
  }

  async getStats(): Promise<{
    totalFunctions: number;
    languages: Record<string, number>;
    topDependencies: Array<{ name: string; count: number }>;
    filesIndexed: number;
    lastUpdated: Date;
  }> {
    this.ensureInitialized();

    const allFunctions = this.functionsCollection!.find();

    // Calculate stats
    const languages: Record<string, number> = {};
    const dependencies: Record<string, number> = {};
    const files = new Set<string>();

    for (const func of allFunctions) {
      // Language stats
      if (func.language) {
        languages[func.language] = (languages[func.language] || 0) + 1;
      }

      // Dependency stats
      for (const dep of func.dependencies) {
        dependencies[dep] = (dependencies[dep] || 0) + 1;
      }

      // File stats
      files.add(func.filePath);
    }

    // Top dependencies
    const topDependencies = Object.entries(dependencies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    return {
      totalFunctions: allFunctions.length,
      languages,
      topDependencies,
      filesIndexed: files.size,
      lastUpdated: new Date()
    };
  }

  async clearIndex(): Promise<void> {
    this.ensureInitialized();
    
    this.functionsCollection!.clear();
    this.searchIndex.clear();
    this.db.saveDatabase();
  }

  async close(): Promise<void> {
    if (this.isInitialized) {
      this.db.close();
      this.isInitialized = false;
    }
  }

  /**
   * Synchronize a single file's functions with the index
   * Adds new functions, updates existing ones, and removes deleted ones
   */
  async synchronizeFile(filePath: string): Promise<{
    added: number;
    updated: number;
    removed: number;
  } | null> {
    this.ensureInitialized();
    
    const fs = require('fs').promises;
    
    try {
      // Check if file exists
      await fs.access(filePath);
    } catch {
      // File doesn't exist, remove all its functions
      const existingFuncs = this.functionsCollection!.find({ filePath });
      for (const func of existingFuncs) {
        this.functionsCollection!.remove(func);
        if (func.$loki !== undefined) {
          await this.searchIndex.remove(func.$loki);
        }
      }
      this.db.saveDatabase();
      return { added: 0, updated: 0, removed: existingFuncs.length };
    }
    
    // Parse the file for functions
    const { FunctionScanner } = await import('./functionScanner.js');
    const scanner = new FunctionScanner();
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const language = filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript';
    
    const parsedFunctions = await scanner.scanFunctions(fileContent, filePath, language);
    
    // Get existing functions
    const existingFuncs = this.functionsCollection!.find({ filePath });
    const existingMap = new Map(existingFuncs.map(f => [f.name, f]));
    const parsedMap = new Map(parsedFunctions.map(f => [f.name, f]));
    
    let added = 0, updated = 0, removed = 0;
    
    // Remove functions that no longer exist
    for (const existing of existingFuncs) {
      if (!parsedMap.has(existing.name)) {
        this.functionsCollection!.remove(existing);
        if (existing.$loki !== undefined) {
          await this.searchIndex.remove(existing.$loki);
        }
        removed++;
      }
    }
    
    // Add or update functions
    for (const parsed of parsedFunctions) {
      const existing = existingMap.get(parsed.name);
      if (existing) {
        // Update existing
        Object.assign(existing, parsed);
        this.functionsCollection!.update(existing);
        const normalizedData = this.normalizeFunctionData(existing);
        await this.searchIndex.update(normalizedData);
        updated++;
      } else {
        // Add new
        await this.registerFunction(parsed);
        added++;
      }
    }
    
    if (added > 0 || updated > 0 || removed > 0) {
      this.db.saveDatabase();
    }
    
    return { added, updated, removed };
  }

  /**
   * Performs bulk cleanup of the index by verifying all indexed files still exist
   * and removing entries for deleted files
   */
  async bulkCleanup(): Promise<{
    scannedCount: number;
    removedCount: number;
    removedFiles: string[];
    errors: Array<{ file: string; error: string }>;
  }> {
    this.ensureInitialized();
    
    const fs = require('fs').promises;
    const allFunctions = this.functionsCollection!.find();
    const fileMap = new Map<string, FunctionDocument[]>();
    
    // Group functions by file
    for (const func of allFunctions) {
      if (!fileMap.has(func.filePath)) {
        fileMap.set(func.filePath, []);
      }
      fileMap.get(func.filePath)!.push(func);
    }
    
    const removedFiles: string[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    let removedCount = 0;
    
    // Check each file
    for (const [filePath, functions] of fileMap) {
      try {
        await fs.access(filePath);
        // File exists, no action needed
      } catch (error) {
        // File doesn't exist, remove all its functions
        for (const func of functions) {
          this.functionsCollection!.remove(func);
          // Remove from search index
          if (func.$loki !== undefined) {
            await this.searchIndex.remove(func.$loki);
          }
          removedCount++;
        }
        removedFiles.push(filePath);
      }
    }
    
    // Save changes
    if (removedCount > 0) {
      this.db.saveDatabase();
    }
    
    return {
      scannedCount: fileMap.size,
      removedCount,
      removedFiles,
      errors
    };
  }

  /**
   * Performs deep synchronization by re-scanning all indexed files
   * Updates function signatures and removes stale entries
   */
  async deepSync(
    progressCallback?: (progress: { current: number; total: number; file: string }) => void
  ): Promise<{
    syncedFiles: number;
    addedFunctions: number;
    updatedFunctions: number;
    removedFunctions: number;
    errors: Array<{ file: string; error: string }>;
  }> {
    this.ensureInitialized();
    
    const allFunctions = this.functionsCollection!.find();
    const fileMap = new Map<string, FunctionDocument[]>();
    
    // Group functions by file
    for (const func of allFunctions) {
      if (!fileMap.has(func.filePath)) {
        fileMap.set(func.filePath, []);
      }
      fileMap.get(func.filePath)!.push(func);
    }
    
    let syncedFiles = 0;
    let totalAdded = 0;
    let totalUpdated = 0;
    let totalRemoved = 0;
    const errors: Array<{ file: string; error: string }> = [];
    
    let current = 0;
    const total = fileMap.size;
    
    // Sync each file
    for (const [filePath, _] of fileMap) {
      current++;
      if (progressCallback) {
        progressCallback({ current, total, file: filePath });
      }
      
      try {
        const result = await this.synchronizeFile(filePath);
        if (result) {
          syncedFiles++;
          totalAdded += result.added;
          totalUpdated += result.updated;
          totalRemoved += result.removed;
        }
      } catch (error) {
        errors.push({
          file: filePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    return {
      syncedFiles,
      addedFunctions: totalAdded,
      updatedFunctions: totalUpdated,
      removedFunctions: totalRemoved,
      errors
    };
  }

  /**
   * Execute content search - search within function bodies
   */
  private async executeContentSearch(
    parsedQuery: ParsedQuery,
    searchScores: Map<number, number>
  ): Promise<FunctionDocument[]> {
    const resultsMap = new Map<number, FunctionDocument>();
    
    // Get all functions (we'll filter them)
    const allFunctions = this.functionsCollection!.find();
    
    // Search in function bodies
    for (const doc of allFunctions) {
      // Check for body in multiple possible locations
      const body = doc.body || doc.metadata?.body;
      if (!body) continue;
      
      let score = 0;
      const bodyLower = body.toLowerCase();
      const matches: Array<{ term: string; line: number; column: number }> = [];
      
      // Split body into lines for line-level matching
      const lines = body.split('\n');
      
      // Check for exact phrases
      for (const phrase of parsedQuery.phrases) {
        const phraseLower = phrase.toLowerCase();
        lines.forEach((line, lineIndex) => {
          const lineLower = line.toLowerCase();
          let columnIndex = lineLower.indexOf(phraseLower);
          while (columnIndex !== -1) {
            matches.push({
              term: phrase,
              line: (doc.lineNumber || 0) + lineIndex,
              column: columnIndex + 1
            });
            score += 100; // High score for exact phrase match
            columnIndex = lineLower.indexOf(phraseLower, columnIndex + 1);
          }
        });
      }
      
      // Check for individual terms
      for (const term of parsedQuery.terms) {
        const termLower = term.toLowerCase();
        lines.forEach((line, lineIndex) => {
          const lineLower = line.toLowerCase();
          let columnIndex = lineLower.indexOf(termLower);
          while (columnIndex !== -1) {
            matches.push({
              term: term,
              line: (doc.lineNumber || 0) + lineIndex,
              column: columnIndex + 1
            });
            score += 20; // Score for term match
            columnIndex = lineLower.indexOf(termLower, columnIndex + 1);
          }
        });
      }
      
      // Check for excluded terms
      let excluded = false;
      for (const excludedTerm of parsedQuery.excludedTerms) {
        if (bodyLower.includes(excludedTerm.toLowerCase())) {
          excluded = true;
          break;
        }
      }
      
      // Add to results if score > 0 and not excluded
      if (score > 0 && !excluded && doc.$loki !== undefined) {
        // Store match information in metadata
        const resultDoc = { ...doc };
        if (!resultDoc.metadata) resultDoc.metadata = {};
        resultDoc.metadata.contentMatches = matches;
        
        // Add match context (surrounding lines)
        const contextLines = 2; // Number of lines before and after to include
        const matchContexts: Array<{
          match: { term: string; line: number; column: number };
          context: { before: string[]; line: string; after: string[] };
        }> = [];
        
        // Group matches by line to avoid duplicate context
        const matchesByLine = new Map<number, typeof matches[0][]>();
        for (const match of matches) {
          const relativeLineNum = match.line - (doc.lineNumber || 0);
          if (!matchesByLine.has(relativeLineNum)) {
            matchesByLine.set(relativeLineNum, []);
          }
          matchesByLine.get(relativeLineNum)!.push(match);
        }
        
        // Build context for each unique line
        for (const [relativeLineNum, lineMatches] of matchesByLine) {
          if (relativeLineNum >= 0 && relativeLineNum < lines.length) {
            const before: string[] = [];
            const after: string[] = [];
            
            // Get lines before
            for (let i = Math.max(0, relativeLineNum - contextLines); i < relativeLineNum; i++) {
              before.push(lines[i]);
            }
            
            // Get lines after
            for (let i = relativeLineNum + 1; i < Math.min(lines.length, relativeLineNum + contextLines + 1); i++) {
              after.push(lines[i]);
            }
            
            // Add context for each match on this line
            for (const match of lineMatches) {
              matchContexts.push({
                match,
                context: {
                  before,
                  line: lines[relativeLineNum],
                  after
                }
              });
            }
          }
        }
        
        resultDoc.metadata.matchContexts = matchContexts;
        
        resultsMap.set(doc.$loki, resultDoc);
        searchScores.set(doc.$loki, score);
      }
    }
    
    return Array.from(resultsMap.values());
  }
}