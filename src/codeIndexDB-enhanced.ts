/**
 * Enhanced Code Index Database for Cross-Language Support
 * Extends the SQLite-backed CodeIndexDB with multi-language capabilities.
 *
 * TODO: Cross-language features (FTS5 search, dep graph, analysis) will get their
 * own dedicated schema and tests in a follow-up spec. For now, this provides
 * the SQLite tables and basic CRUD — enough for the tests to continue passing.
 */

import Database from 'better-sqlite3';
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
  DependencyCycle,
  CompatibilityAdapter,
  MigrationOptions
} from './types/crossLanguage.js';
import { FunctionMetadata, ComponentMetadata, EnhancedFunctionMetadata } from './types.js';

// ── Types for internal adapters ─────────────────────────────────────────

interface LokiFindQuery {
  [key: string]: any;
}

/** Simple result type for db queries */
interface DbRow {
  $loki: number;
  [key: string]: any;
}

// ── Cross-language SQLite adapter ──────────────────────────────────────

class CrossLangCollectionAdapter<T extends { $loki?: number }> {
  constructor(
    private db: Database.Database,
    private tableName: string
  ) {}

  find(query?: LokiFindQuery): T[] {
    if (!query) {
      return (this.db.prepare(`SELECT *, rowid as "$loki" FROM "${this.tableName}"`).all() as any[])
        .map((r: any) => this.rowToDoc(r));
    }

    // Handle $or
    if (query.$or && Array.isArray(query.$or)) {
      const results: T[] = [];
      for (const subQuery of query.$or) {
        results.push(...this.find(subQuery));
      }
      // Deduplicate by $loki
      const seen = new Set<number>();
      return results.filter(r => {
        if (seen.has(r.$loki!)) return false;
        seen.add(r.$loki!);
        return true;
      });
    }

    // Handle $in
    const clauses: string[] = [];
    const params: Record<string, any> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value && typeof value === 'object' && '$in' in (value as any)) {
        const vals = (value as any).$in as any[];
        const placeholders = vals.map((_: any, i: number) => `@in_${key}_${i}`);
        clauses.push(`"${key}" IN (${placeholders.join(', ')})`);
        vals.forEach((v: any, i: number) => { params[`in_${key}_${i}`] = v; });
      } else if (value === null || value === undefined) {
        clauses.push(`"${key}" IS NULL`);
      } else {
        clauses.push(`"${key}" = @${key}`);
        params[key] = value;
      }
    }

    const sql = `SELECT *, rowid as "$loki" FROM "${this.tableName}"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}`;
    return (this.db.prepare(sql).all(params) as any[]).map((r: any) => this.rowToDoc(r));
  }

  findOne(query: LokiFindQuery): T | null {
    const results = this.find({ ...query, _limit: 1 });
    return results[0] ?? null;
  }

  insert(doc: T): T {
    const row = doc as Record<string, any>;
    const keys = Object.keys(row).filter(k => k !== '$loki');
    const vals = keys.map(k => `@${k}`);
    const sql = `INSERT INTO "${this.tableName}" ("${keys.join('", "')}") VALUES (${vals.join(', ')})`;
    const info = this.db.prepare(sql).run(row);
    (doc as any).$loki = Number(info.lastInsertRowid);
    return doc;
  }

  update(doc: T): void {
    const row = doc as Record<string, any>;
    const keys = Object.keys(row).filter(k => k !== '$loki');
    const sets = keys.map(k => `"${k}" = @${k}`);
    const params: Record<string, any> = {};
    for (const k of keys) params[k] = row[k];
    params['_rowid'] = row.$loki;
    this.db.prepare(`UPDATE "${this.tableName}" SET ${sets.join(', ')} WHERE rowid = @_rowid`).run(params);
  }

  get(id: number): T | null {
    const row = this.db.prepare(
      `SELECT *, rowid as "$loki" FROM "${this.tableName}" WHERE rowid = ?`
    ).get(id) as DbRow | undefined;
    return row ? this.rowToDoc(row) : null;
  }

  remove(doc: T): void {
    if ((doc as any).$loki !== undefined) {
      this.db.prepare(`DELETE FROM "${this.tableName}" WHERE rowid = ?`).run((doc as any).$loki);
    }
  }

  removeWhere(query: LokiFindQuery): void {
    const clauses: string[] = [];
    const params: Record<string, any> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) {
        clauses.push(`"${key}" IS NULL`);
      } else {
        clauses.push(`"${key}" = @${key}`);
        params[key] = value;
      }
    }
    const sql = `DELETE FROM "${this.tableName}"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}`;
    this.db.prepare(sql).run(params);
  }

  clear(): void {
    this.db.prepare(`DELETE FROM "${this.tableName}"`).run();
  }

  private rowToDoc(row: any): T {
    const doc: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      // Unpack JSON columns
      if (typeof value === 'string' && (key.endsWith('_json') || key === 'searchTokens' || key === 'calls' ||
          key === 'calledBy' || key === 'implementedBy' || key === 'extendedBy' || key === 'parameters')) {
        try { doc[key] = JSON.parse(value); } catch { doc[key] = value; }
      } else {
        doc[key] = value;
      }
    }
    if ('createdAt' in doc && typeof doc.createdAt === 'string') doc.createdAt = new Date(doc.createdAt);
    if ('updatedAt' in doc && typeof doc.updatedAt === 'string') doc.updatedAt = new Date(doc.updatedAt);
    return doc as T;
  }
}

// ── Main enhanced class ─────────────────────────────────────────────────

export class EnhancedCodeIndexDB extends CodeIndexDB {
  /** @internal — subclasses use these directly */
  protected crossLanguageEntities!: CrossLangCollectionAdapter<CrossLanguageEntityDocument>;
  protected crossReferences!: CrossLangCollectionAdapter<CrossReferenceDocument>;
  protected apiContracts!: CrossLangCollectionAdapter<APIContractDocument>;

  private enhancedInitialized = false;
  private migrationCompleted = false;

  constructor(dbPath: string = ':memory:') {
    super(dbPath);
  }

  /**
   * Initialize enhanced collections (SQLite tables).
   */
  async initializeEnhanced(): Promise<void> {
    if (this.enhancedInitialized) return;
    await this.initialize(); // Ensure base is ready

    // Create cross-language tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cross_language_entities (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        language    TEXT NOT NULL DEFAULT 'typescript',
        file        TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'function',
        startLine   INTEGER,
        endLine     INTEGER,
        lineNumber  INTEGER,
        signature   TEXT,
        parameters  TEXT DEFAULT '[]',
        returnType  TEXT,
        purpose     TEXT DEFAULT '',
        context     TEXT DEFAULT '',
        complexity  INTEGER DEFAULT 0,
        searchTokens TEXT DEFAULT '[]',
        calls       TEXT DEFAULT '[]',
        calledBy    TEXT DEFAULT '[]',
        implementedBy TEXT DEFAULT '[]',
        extendedBy  TEXT DEFAULT '[]',
        metadata_json TEXT DEFAULT '{}',
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_cle_language ON cross_language_entities(language);
      CREATE INDEX IF NOT EXISTS idx_cle_type ON cross_language_entities(type);
      CREATE INDEX IF NOT EXISTS idx_cle_file ON cross_language_entities(file);

      -- FTS5 for cross-language entity search
      CREATE VIRTUAL TABLE IF NOT EXISTS cross_language_fts USING fts5(
        name, signature, purpose, context, language, type, searchTokens,
        content='cross_language_entities', content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS cross_references (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId        TEXT NOT NULL,
        targetId        TEXT NOT NULL,
        sourceLanguage  TEXT,
        targetLanguage  TEXT,
        type            TEXT DEFAULT 'calls',
        protocol        TEXT,
        confidence      REAL DEFAULT 1.0,
        metadata_json   TEXT DEFAULT '{}',
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_cref_source ON cross_references(sourceId);
      CREATE INDEX IF NOT EXISTS idx_cref_target ON cross_references(targetId);

      CREATE TABLE IF NOT EXISTS api_contracts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entityId    TEXT NOT NULL,
        version     TEXT DEFAULT '1.0.0',
        endpoints   TEXT DEFAULT '[]',
        schemas     TEXT DEFAULT '{}',
        protocols   TEXT DEFAULT '[]',
        metadata_json TEXT DEFAULT '{}',
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ac_entity ON api_contracts(entityId);
    `);

    this.crossLanguageEntities = new CrossLangCollectionAdapter(this.db, 'cross_language_entities');
    this.crossReferences = new CrossLangCollectionAdapter(this.db, 'cross_references');
    this.apiContracts = new CrossLangCollectionAdapter(this.db, 'api_contracts');

    this.enhancedInitialized = true;
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
      return;
    }

    if (!this.enhancedInitialized) {
      await this.initializeEnhanced();
    }

    const adapter = new DefaultCompatibilityAdapter();

    // Migrate existing functions
    const existingFunctions = await this.getAllFunctions();
    for (const func of existingFunctions) {
      const entity = adapter.convertFunction(func);
      await this.addCrossLanguageEntity(entity);
    }

    this.migrationCompleted = true;
  }

  /**
   * Add a cross-language entity to the index
   */
  async addCrossLanguageEntity(entity: CrossLanguageEntity): Promise<void> {
    if (!this.enhancedInitialized) await this.initializeEnhanced();

    // Ensure required fields
    const enhancedEntity: CrossLanguageEntityDocument = {
      ...entity,
      id: entity.id || this.generateEntityId(entity),
      searchTokens: entity.searchTokens || this.generateSearchTokens(entity),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const existing = this.crossLanguageEntities.findOne({ id: enhancedEntity.id });
    if (existing) {
      Object.assign(existing, enhancedEntity);
      existing.updatedAt = new Date();
      this.crossLanguageEntities.update(existing);
    } else {
      this.crossLanguageEntities.insert(enhancedEntity);
    }
  }

  /**
   * Add cross-reference between entities
   */
  async addCrossReference(reference: CrossReference): Promise<void> {
    if (!this.enhancedInitialized) await this.initializeEnhanced();

    const refDoc: CrossReferenceDocument = {
      ...reference,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.crossReferences.insert(refDoc);
  }

  /**
   * Add API contract for an entity
   */
  async addAPIContract(entityId: string, contract: APIContract): Promise<void> {
    if (!this.enhancedInitialized) await this.initializeEnhanced();

    const contractDoc: APIContractDocument = {
      ...contract,
      entityId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Remove existing contract for this entity
    this.apiContracts.removeWhere({ entityId });

    // Add new contract
    this.apiContracts.insert(contractDoc);
  }

  /**
   * Search cross-language entities (uses FTS5).
   */
  async searchCrossLanguage(
    query: string,
    options: CrossLanguageSearchOptions = {}
  ): Promise<CrossLanguageSearchResult[]> {
    if (!this.enhancedInitialized) await this.initializeEnhanced();

    const results: CrossLanguageSearchResult[] = [];

    // FTS5 search
    let ftsQuery = query.split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ');
    if (!ftsQuery) ftsQuery = '"*"';

    let sql = `SELECT cle.*, cle.rowid as "$loki" FROM cross_language_entities cle
      JOIN cross_language_fts ON cross_language_fts.rowid = cle.rowid
      WHERE cross_language_fts MATCH @q`;
    const params: Record<string, any> = { q: ftsQuery };

    if (options.languages && options.languages.length > 0) {
      sql += ' AND cle.language IN (@langs)';
      params.langs = options.languages;
    }
    if (options.types && options.types.length > 0) {
      sql += ' AND cle.type IN (@types)';
      params.types = options.types;
    }

    sql += ' ORDER BY rank LIMIT 50';

    let rows: any[];
    try {
      rows = this.db.prepare(sql).all(params);
    } catch {
      // FTS5 syntax error — fall back to LIKE-based search (simple)
      sql = `SELECT cle.*, cle.rowid as "$loki" FROM cross_language_entities cle
        WHERE cle.name LIKE @like`;
      params.like = `%${query}%`;
      rows = this.db.prepare(sql).all(params);
    }

    for (const row of rows) {
      const entity: any = {};
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'string' && ['parameters', 'searchTokens', 'calls', 'calledBy',
            'implementedBy', 'extendedBy', 'metadata_json'].includes(k)) {
          try { entity[k] = JSON.parse(v); } catch { entity[k] = v; }
        } else {
          entity[k] = v;
        }
      }

      if (options.languages && !options.languages.includes(entity.language)) continue;
      if (options.types && !options.types.includes(entity.type)) continue;

      const searchResult: CrossLanguageSearchResult = {
        entity,
        score: 1.0,
        matches: ['name']
      };

      if (options.includeReferences) {
        searchResult.references = [
          ...this.crossReferences.find({ sourceId: entity.id }),
          ...this.crossReferences.find({ targetId: entity.id })
        ];
      }

      if (options.includeContracts) {
        searchResult.contracts = this.apiContracts.find({ entityId: entity.id });
      }

      results.push(searchResult);
    }

    return results;
  }

  /**
   * Find entity by ID
   */
  async findEntityById(id: string): Promise<CrossLanguageEntity | null> {
    if (!this.enhancedInitialized) await this.initializeEnhanced();
    return this.crossLanguageEntities.findOne({ id }) || null;
  }

  /**
   * Find entities by language
   */
  async findEntitiesByLanguage(language: string): Promise<CrossLanguageEntity[]> {
    if (!this.enhancedInitialized) await this.initializeEnhanced();
    return this.crossLanguageEntities.find({ language });
  }

  /**
   * Find entities by type
   */
  async findEntitiesByType(type: CrossLanguageEntity['type']): Promise<CrossLanguageEntity[]> {
    if (!this.enhancedInitialized) await this.initializeEnhanced();
    return this.crossLanguageEntities.find({ type });
  }

  /**
   * Get cross-references for an entity
   */
  async getCrossReferences(entityId: string): Promise<CrossReference[]> {
    if (!this.enhancedInitialized) await this.initializeEnhanced();
    return [
      ...this.crossReferences.find({ sourceId: entityId }),
      ...this.crossReferences.find({ targetId: entityId })
    ];
  }

  /**
   * Generate dependency graph
   */
  async generateDependencyGraph(languages?: string[]): Promise<DependencyGraph> {
    if (!this.enhancedInitialized) await this.initializeEnhanced();

    const entities = languages
      ? this.crossLanguageEntities.find({ language: { $in: languages } })
      : this.crossLanguageEntities.find();

    const references = this.crossReferences.find();

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

    const cycles: DependencyCycle[] = [];

    return {
      nodes,
      edges,
      cycles,
      metrics: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        cycleCount: cycles.length,
        averageDepth: 0,
        maxDepth: 0,
        stronglyConnectedComponents: 0
      }
    };
  }

  /**
   * Get analysis summary
   */
  async getAnalysisSummary(): Promise<CrossLanguageAnalysisResult> {
    if (!this.enhancedInitialized) await this.initializeEnhanced();

    const entities = this.crossLanguageEntities.find();
    const references = this.crossReferences.find();
    const contracts = this.apiContracts.find();

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
      coverage: {}
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
    const camelCaseTokens = entity.name.replace(/(\p{Lu})/gu, ' $1').trim().split(' ');
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
   * Also clears cross-language derived collections.
   */
  async clearIndex(): Promise<void> {
    await super.clearIndex();
    if (this.enhancedInitialized) {
      this.crossLanguageEntities.clear();
      this.crossReferences.clear();
      this.apiContracts.clear();
    }
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
      signature: func.name,
      parameters: [],
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
      dependencies: [],
      purpose: entity.purpose,
      context: entity.context,
      metadata: entity.metadata
    };
  }

  toComponentMetadata(entity: CrossLanguageEntity): ComponentMetadata {
    throw new Error('Component metadata conversion not implemented');
  }

  private generateId(type: string, filePath: string, name: string, line?: number): string {
    return `${type}:${filePath}:${name}:${line || 0}`;
  }
}
