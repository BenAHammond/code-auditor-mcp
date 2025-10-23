/**
 * Enhanced Code Index Database for Cross-Language Support
 * Extends the existing CodeIndexDB with multi-language capabilities
 */

import Loki, { Collection } from 'lokijs';
import * as FlexSearch from 'flexsearch';
import { promises as fs } from 'fs';
import path from 'path';
import { CodeIndexDB } from './codeIndexDB.js';
import { 
  CrossLanguageEntity,
  CrossLanguageEntityDocument,
  CrossReference,
  CrossReferenceDocument,
  APIContract,
  APIContractDocument,
  CrossLanguageSearchOptions,
  CrossLanguageSearchResult,
  CrossLanguageAnalysisResult,
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
  CompatibilityAdapter,
  MigrationOptions
} from './types/crossLanguage.js';
import { FunctionMetadata, ComponentMetadata, EnhancedFunctionMetadata } from './types.js';

/**
 * Enhanced CodeIndexDB with cross-language support
 * Maintains backward compatibility while adding new capabilities
 */
export class EnhancedCodeIndexDB extends CodeIndexDB {
  // New collections for cross-language support
  private crossLanguageEntitiesCollection: Collection<CrossLanguageEntityDocument> | null = null;
  private crossReferencesCollection: Collection<CrossReferenceDocument> | null = null;
  private apiContractsCollection: Collection<APIContractDocument> | null = null;
  
  // Enhanced search index for cross-language entities
  private crossLanguageSearchIndex: any;
  private migrationCompleted = false;

  constructor(dbPath: string = ':memory:') {
    super(dbPath);
    
    // Initialize enhanced FlexSearch for cross-language entities
    const { Document } = FlexSearch as any;
    this.crossLanguageSearchIndex = new Document({
      document: {
        id: '$loki',
        index: [
          {
            field: 'name',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            bidirectional: true,
            weight: 10
          },
          {
            field: 'signature',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 9
          },
          {
            field: 'purpose',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 8
          },
          {
            field: 'context',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 7
          },
          {
            field: 'language',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 6
          },
          {
            field: 'type',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 6
          },
          {
            field: 'searchTokens',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 5
          },
          {
            field: 'file',
            tokenize: 'full',
            optimize: true,
            resolution: 9,
            weight: 3
          }
        ]
      }
    });
  }

  /**
   * Initialize enhanced collections
   */
  async initializeEnhanced(): Promise<void> {
    await this.initialize(); // Initialize base collections first
    
    // Initialize cross-language collections
    this.crossLanguageEntitiesCollection = this.getDatabase().addCollection('crossLanguageEntities', {
      indices: ['id', 'name', 'language', 'type', 'file'],
      unique: ['id']
    });

    this.crossReferencesCollection = this.getDatabase().addCollection('crossReferences', {
      indices: ['sourceId', 'targetId', 'sourceLanguage', 'targetLanguage', 'type']
    });

    this.apiContractsCollection = this.getDatabase().addCollection('apiContracts', {
      indices: ['entityId', 'version']
    });

    console.log('[EnhancedCodeIndexDB] Cross-language collections initialized');
  }

  /**
   * Migrate existing data to cross-language format
   */
  async migrateToEnhanced(options: MigrationOptions = {
    preserveExisting: true,
    enhanceMetadata: true,
    buildReferences: false,
    validateContracts: false
  }): Promise<void> {
    if (this.migrationCompleted) {
      console.log('[EnhancedCodeIndexDB] Migration already completed');
      return;
    }

    console.log('[EnhancedCodeIndexDB] Starting migration to enhanced schema...');

    if (!this.crossLanguageEntitiesCollection) {
      await this.initializeEnhanced();
    }

    const adapter = new DefaultCompatibilityAdapter();
    
    // Migrate existing functions
    const existingFunctions = await this.getAllFunctions();
    for (const func of existingFunctions) {
      const entity = adapter.convertFunction(func);
      await this.addCrossLanguageEntity(entity);
    }

    // Migrate existing components (if any)
    // Note: This assumes components are stored somehow in the base class
    // Implementation would depend on how components are currently stored
    
    console.log(`[EnhancedCodeIndexDB] Migrated ${existingFunctions.length} functions to cross-language format`);
    
    this.migrationCompleted = true;
  }

  /**
   * Add a cross-language entity to the index
   */
  async addCrossLanguageEntity(entity: CrossLanguageEntity): Promise<void> {
    if (!this.crossLanguageEntitiesCollection) {
      await this.initializeEnhanced();
    }

    // Ensure required fields
    const enhancedEntity: CrossLanguageEntityDocument = {
      ...entity,
      id: entity.id || this.generateEntityId(entity),
      searchTokens: entity.searchTokens || this.generateSearchTokens(entity),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Check for existing entity
    const existing = this.crossLanguageEntitiesCollection!.findOne({ id: enhancedEntity.id });
    if (existing) {
      // Update existing
      Object.assign(existing, enhancedEntity);
      existing.updatedAt = new Date();
      this.crossLanguageEntitiesCollection!.update(existing);
    } else {
      // Add new
      this.crossLanguageEntitiesCollection!.insert(enhancedEntity);
    }

    // Update search index
    this.crossLanguageSearchIndex.add(enhancedEntity);
  }

  /**
   * Add cross-reference between entities
   */
  async addCrossReference(reference: CrossReference): Promise<void> {
    if (!this.crossReferencesCollection) {
      await this.initializeEnhanced();
    }

    const refDoc: CrossReferenceDocument = {
      ...reference,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.crossReferencesCollection!.insert(refDoc);
  }

  /**
   * Add API contract for an entity
   */
  async addAPIContract(entityId: string, contract: APIContract): Promise<void> {
    if (!this.apiContractsCollection) {
      await this.initializeEnhanced();
    }

    const contractDoc: APIContractDocument = {
      ...contract,
      entityId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Remove existing contract for this entity
    this.apiContractsCollection!.removeWhere({ entityId });
    
    // Add new contract
    this.apiContractsCollection!.insert(contractDoc);
  }

  /**
   * Search cross-language entities
   */
  async searchCrossLanguage(
    query: string, 
    options: CrossLanguageSearchOptions = {}
  ): Promise<CrossLanguageSearchResult[]> {
    if (!this.crossLanguageEntitiesCollection) {
      await this.initializeEnhanced();
    }

    // Perform FlexSearch
    const searchResults = this.crossLanguageSearchIndex.search(query, {
      limit: 50,
      enrich: true
    });

    const results: CrossLanguageSearchResult[] = [];

    for (const result of searchResults) {
      for (const doc of result.result) {
        const entity = this.crossLanguageEntitiesCollection!.get(doc.id);
        if (!entity) continue;

        // Apply filters
        if (options.languages && !options.languages.includes(entity.language)) continue;
        if (options.types && !options.types.includes(entity.type)) continue;

        const searchResult: CrossLanguageSearchResult = {
          entity,
          score: 1.0, // FlexSearch doesn't provide scores directly
          matches: [result.field] // Field that matched
        };

        // Include references if requested
        if (options.includeReferences) {
          searchResult.references = this.crossReferencesCollection!.find({
            $or: [
              { sourceId: entity.id },
              { targetId: entity.id }
            ]
          });
        }

        // Include contracts if requested
        if (options.includeContracts) {
          searchResult.contracts = this.apiContractsCollection!.find({ entityId: entity.id });
        }

        results.push(searchResult);
      }
    }

    return results;
  }

  /**
   * Find entity by ID
   */
  async findEntityById(id: string): Promise<CrossLanguageEntity | null> {
    if (!this.crossLanguageEntitiesCollection) {
      await this.initializeEnhanced();
    }

    return this.crossLanguageEntitiesCollection!.findOne({ id }) || null;
  }

  /**
   * Find entities by language
   */
  async findEntitiesByLanguage(language: string): Promise<CrossLanguageEntity[]> {
    if (!this.crossLanguageEntitiesCollection) {
      await this.initializeEnhanced();
    }

    return this.crossLanguageEntitiesCollection!.find({ language });
  }

  /**
   * Find entities by type
   */
  async findEntitiesByType(type: CrossLanguageEntity['type']): Promise<CrossLanguageEntity[]> {
    if (!this.crossLanguageEntitiesCollection) {
      await this.initializeEnhanced();
    }

    return this.crossLanguageEntitiesCollection!.find({ type });
  }

  /**
   * Get cross-references for an entity
   */
  async getCrossReferences(entityId: string): Promise<CrossReference[]> {
    if (!this.crossReferencesCollection) {
      await this.initializeEnhanced();
    }

    return this.crossReferencesCollection!.find({
      $or: [
        { sourceId: entityId },
        { targetId: entityId }
      ]
    });
  }

  /**
   * Generate dependency graph
   */
  async generateDependencyGraph(languages?: string[]): Promise<DependencyGraph> {
    if (!this.crossLanguageEntitiesCollection || !this.crossReferencesCollection) {
      await this.initializeEnhanced();
    }

    const entities = languages 
      ? this.crossLanguageEntitiesCollection!.find({ language: { $in: languages } })
      : this.crossLanguageEntitiesCollection!.find();

    const references = this.crossReferencesCollection!.find();

    const nodes: DependencyNode[] = entities.map(entity => ({
      id: entity.id,
      name: entity.name,
      language: entity.language,
      type: entity.type,
      file: entity.file,
      weight: entity.complexity || 1
    }));

    const edges: DependencyEdge[] = references.map(ref => ({
      from: ref.sourceId,
      to: ref.targetId,
      type: ref.type,
      weight: ref.confidence,
      protocol: ref.protocol
    }));

    // TODO: Implement cycle detection
    const cycles = [];
    
    return {
      nodes,
      edges,
      cycles,
      metrics: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        cycleCount: cycles.length,
        averageDepth: 0, // TODO: Calculate
        maxDepth: 0, // TODO: Calculate
        stronglyConnectedComponents: 0 // TODO: Calculate
      }
    };
  }

  /**
   * Get analysis summary
   */
  async getAnalysisSummary(): Promise<CrossLanguageAnalysisResult> {
    if (!this.crossLanguageEntitiesCollection || !this.crossReferencesCollection) {
      await this.initializeEnhanced();
    }

    const entities = this.crossLanguageEntitiesCollection!.find();
    const references = this.crossReferencesCollection!.find();
    const contracts = this.apiContractsCollection!.find();

    const entitiesByLanguage: Record<string, number> = {};
    const entitiesByType: Record<string, number> = {};
    const complexities: Record<string, number[]> = {};

    for (const entity of entities) {
      entitiesByLanguage[entity.language] = (entitiesByLanguage[entity.language] || 0) + 1;
      entitiesByType[entity.type] = (entitiesByType[entity.type] || 0) + 1;
      
      if (entity.complexity) {
        if (!complexities[entity.language]) complexities[entity.language] = [];
        complexities[entity.language].push(entity.complexity);
      }
    }

    // Calculate average complexities
    const avgComplexities: Record<string, number> = {};
    for (const [lang, values] of Object.entries(complexities)) {
      avgComplexities[lang] = values.reduce((a, b) => a + b, 0) / values.length;
    }

    // Find orphaned entities (no references)
    const referencedIds = new Set([
      ...references.map(r => r.sourceId),
      ...references.map(r => r.targetId)
    ]);
    const orphanedEntities = entities
      .filter(e => !referencedIds.has(e.id))
      .map(e => e.id);

    return {
      totalEntities: entities.length,
      entitiesByLanguage,
      entitiesByType,
      crossReferences: references.length,
      apiContracts: contracts.length,
      orphanedEntities,
      complexities: avgComplexities,
      coverage: {} // TODO: Calculate test coverage
    };
  }

  /**
   * Generate entity ID
   */
  private generateEntityId(entity: CrossLanguageEntity): string {
    return `${entity.language}:${entity.type}:${entity.file}:${entity.name}:${entity.startLine || 0}`;
  }

  /**
   * Generate search tokens for an entity
   */
  private generateSearchTokens(entity: CrossLanguageEntity): string[] {
    const tokens = new Set<string>();
    
    // Add name variations
    tokens.add(entity.name);
    tokens.add(entity.name.toLowerCase());
    
    // Add camelCase breakdown
    const camelCaseTokens = entity.name.replace(/([A-Z])/g, ' $1').trim().split(' ');
    camelCaseTokens.forEach(token => tokens.add(token.toLowerCase()));
    
    // Add snake_case breakdown
    const snakeCaseTokens = entity.name.split('_');
    snakeCaseTokens.forEach(token => tokens.add(token.toLowerCase()));
    
    // Add type and language
    tokens.add(entity.type);
    tokens.add(entity.language);
    
    // Add purpose keywords
    const purposeWords = entity.purpose.split(/\s+/);
    purposeWords.forEach(word => {
      if (word.length > 2) tokens.add(word.toLowerCase());
    });
    
    return Array.from(tokens);
  }

  /**
   * Get access to the underlying database for advanced operations
   */
  getDatabase(): Loki {
    // Protected method to access the underlying database
    return (this as any).db;
  }
}

/**
 * Default compatibility adapter for migrating existing data
 */
class DefaultCompatibilityAdapter implements CompatibilityAdapter {
  convertFunction(func: FunctionMetadata): CrossLanguageEntity {
    return {
      id: this.generateId('function', func.filePath, func.name, func.lineNumber),
      name: func.name,
      language: func.language || 'typescript',
      file: func.filePath,
      type: 'function',
      startLine: func.startLine,
      endLine: func.endLine,
      lineNumber: func.lineNumber,
      signature: func.name, // Basic signature, could be enhanced
      parameters: [], // Would need to be extracted from enhanced metadata
      purpose: func.purpose,
      context: func.context,
      searchTokens: [],
      calls: [],
      calledBy: [],
      implementedBy: [],
      extendedBy: [],
      metadata: func.metadata
    };
  }

  convertComponent(comp: ComponentMetadata): CrossLanguageEntity {
    return {
      id: this.generateId('component', comp.filePath, comp.name, comp.lineNumber),
      name: comp.name,
      language: comp.language || 'typescript',
      file: comp.filePath,
      type: 'component',
      startLine: comp.startLine,
      endLine: comp.endLine,
      lineNumber: comp.lineNumber,
      signature: comp.name,
      parameters: comp.props?.map(prop => ({
        name: prop.name,
        type: prop.type,
        optional: !prop.required,
        language: 'typescript'
      })) || [],
      purpose: comp.purpose,
      context: comp.context,
      searchTokens: [],
      calls: [],
      calledBy: [],
      implementedBy: [],
      extendedBy: [],
      complexity: comp.complexity,
      metadata: comp.metadata
    };
  }

  toFunctionMetadata(entity: CrossLanguageEntity): FunctionMetadata {
    return {
      name: entity.name,
      filePath: entity.file,
      lineNumber: entity.lineNumber,
      startLine: entity.startLine,
      endLine: entity.endLine,
      language: entity.language,
      dependencies: [], // Would need to be extracted from references
      purpose: entity.purpose,
      context: entity.context,
      metadata: entity.metadata
    };
  }

  toComponentMetadata(entity: CrossLanguageEntity): ComponentMetadata {
    // This would need more implementation based on the ComponentMetadata interface
    throw new Error('Component metadata conversion not implemented');
  }

  private generateId(type: string, filePath: string, name: string, line?: number): string {
    return `${type}:${filePath}:${name}:${line || 0}`;
  }
}