/**
 * Universal Schema Analyzer
 * Works across multiple programming languages using the adapter pattern
 * Analyzes code against database schemas
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../languages/types.js';

/**
 * Configuration for Schema analyzer
 */
export interface SchemaAnalyzerConfig {
  // Database schema analysis
  enableTableUsageTracking?: boolean;
  checkMissingReferences?: boolean;
  checkNamingConventions?: boolean;
  detectUnusedTables?: boolean;
  validateQueryPatterns?: boolean;
  maxQueriesPerFunction?: number;
  requiredSchemas?: string[];
  // In-memory schemas for testing
  schemas?: Array<{
    name: string;
    tables: Array<{
      name: string;
      columns: Array<{ name: string; type: string; }>;
    }>;
  }>;
  
  // JSON Schema validation
  validateJsonSchemas?: boolean;
  jsonSchemaVersion?: 'draft-04' | 'draft-06' | 'draft-07' | '2019-09' | '2020-12';
  allowedJsonTypes?: string[];
  
  // Schema validation options
  schemaFilePatterns?: string[];  // Patterns to identify schema files (e.g., '*.schema.json')
  dataFilePatterns?: string[];     // Patterns to identify data files to validate
  schemaDataPairs?: Array<{        // Explicit schema-data file pairs
    schema: string;
    data: string | string[];
  }>;
  strictMode?: boolean;            // Enforce strict JSON Schema rules
  allowAdditionalProperties?: boolean;
}

export const DEFAULT_SCHEMA_CONFIG: SchemaAnalyzerConfig = {
  enableTableUsageTracking: true,
  checkMissingReferences: true,
  checkNamingConventions: true,
  detectUnusedTables: false,
  validateQueryPatterns: true,
  maxQueriesPerFunction: 5,
  requiredSchemas: [],
  schemas: [],
  validateJsonSchemas: true,
  jsonSchemaVersion: 'draft-07',
  allowedJsonTypes: ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'],
  schemaFilePatterns: ['*.schema.json', '*-schema.json'],
  dataFilePatterns: ['*.data.json', '*.example.json'],
  strictMode: false,
  allowAdditionalProperties: true
};

interface TableReference {
  table: string;
  type: 'select' | 'insert' | 'update' | 'delete' | 'create' | 'reference';
  location: { line: number; column: number };
  context: string;
}

interface ColumnReference {
  table: string;
  column: string;
  location: { line: number; column: number };
}

import { promises as fs } from 'fs';
import type { Violation as BaseViolation, AnalyzerResult } from '../../types.js';

export class UniversalSchemaAnalyzer extends UniversalAnalyzer {
  readonly name = 'schema';
  readonly description = 'Analyzes code against database schemas and validates JSON schemas';
  readonly category = 'database';
  
  // Track references across files
  private tableReferences = new Map<string, TableReference[]>();
  private columnReferences = new Map<string, ColumnReference[]>();
  
  /**
   * Override analyze to handle both TypeScript files and JSON files
   */
  async analyze(files: string[], config: any): Promise<AnalyzerResult> {
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const codeFiles = files.filter(f => !f.endsWith('.json'));
    
    // Analyze code files using the standard Universal approach
    const codeResult = codeFiles.length > 0 ? await super.analyze(codeFiles, config) : {
      violations: [],
      errors: [],
      filesProcessed: 0,
      executionTime: 0
    };
    
    // Analyze JSON schema files
    const jsonResult = await this.analyzeJsonSchemas(jsonFiles, config);
    
    // Combine results
    return {
      violations: [...codeResult.violations, ...jsonResult.violations],
      errors: [...(codeResult.errors || []), ...(jsonResult.errors || [])],
      filesProcessed: codeResult.filesProcessed + jsonResult.filesProcessed,
      executionTime: (codeResult.executionTime || 0) + (jsonResult.executionTime || 0)
    };
  }
  
  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: SchemaAnalyzerConfig,
    sourceCode: string
  ): Promise<Violation[]> {
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_SCHEMA_CONFIG, ...config };
    
    // Get available schemas
    const schemas = finalConfig.schemas || [];
    const allTables = new Set<string>();
    const tableColumns = new Map<string, Set<string>>();
    
    // Build lookup maps
    for (const schema of schemas) {
      for (const table of schema.tables) {
        allTables.add(table.name);
        const columns = new Set<string>(table.columns.map(c => c.name));
        tableColumns.set(table.name, columns);
      }
    }
    
    // Check if schemas are required but missing
    if (finalConfig.requiredSchemas && finalConfig.requiredSchemas.length > 0 && schemas.length === 0) {
      violations.push(this.createViolation(
        ast.filePath,
        { line: 1, column: 1 },
        'No database schemas loaded for analysis',
        'warning',
        'missing-schemas'
      ));
      return violations;
    }
    
    // Find table references in the code
    const tableRefs = this.findTableReferences(ast, adapter, sourceCode);
    const columnRefs = this.findColumnReferences(ast, adapter, sourceCode);
    
    // Check for missing table references
    if (finalConfig.checkMissingReferences) {
      for (const ref of tableRefs) {
        if (!allTables.has(ref.table) && !this.isSystemTable(ref.table)) {
          violations.push(this.createViolation(
            ast.filePath,
            ref.location,
            `Reference to unknown table '${ref.table}'`,
            'warning',
            'unknown-table'
          ));
        }
      }
      
      // Check column references
      for (const ref of columnRefs) {
        const columnSet = tableColumns.get(ref.table);
        if (columnSet && !columnSet.has(ref.column)) {
          violations.push(this.createViolation(
            ast.filePath,
            ref.location,
            `Reference to unknown column '${ref.column}' in table '${ref.table}'`,
            'warning',
            'unknown-column'
          ));
        }
      }
    }
    
    // Check naming conventions
    if (finalConfig.checkNamingConventions) {
      violations.push(...this.checkNamingConventions(tableRefs, ast.filePath));
    }
    
    // Check query patterns
    if (finalConfig.validateQueryPatterns) {
      violations.push(...this.checkQueryPatterns(ast, adapter, sourceCode, finalConfig));
    }
    
    // Check for SQL injection patterns
    violations.push(...this.checkSQLInjection(ast, adapter, sourceCode));
    
    return violations;
  }
  
  /**
   * Find table references in the code
   */
  private findTableReferences(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string
  ): TableReference[] {
    const references: TableReference[] = [];
    
    // Common patterns for table references
    const patterns = [
      // ORM patterns
      /from\s*\(\s*["'`]?(\w+)["'`]?\s*\)/gi,
      /table\s*[:=]\s*["'`](\w+)["'`]/gi,
      /\.(\w+Table)\s*\(/gi,
      
      // SQL patterns
      /FROM\s+["'`]?(\w+)["'`]?/gi,
      /JOIN\s+["'`]?(\w+)["'`]?/gi,
      /UPDATE\s+["'`]?(\w+)["'`]?/gi,
      /INSERT\s+INTO\s+["'`]?(\w+)["'`]?/gi,
      /DELETE\s+FROM\s+["'`]?(\w+)["'`]?/gi,
      /CREATE\s+TABLE\s+["'`]?(\w+)["'`]?/gi,
      
      // Schema definition patterns
      /pgTable\s*\(\s*["'`](\w+)["'`]/gi,
      /mysqlTable\s*\(\s*["'`](\w+)["'`]/gi,
      /sqliteTable\s*\(\s*["'`](\w+)["'`]/gi
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(sourceCode)) !== null) {
        const table = match[1];
        const index = match.index;
        const lines = sourceCode.substring(0, index).split('\n');
        const line = lines.length;
        const column = lines[lines.length - 1].length + 1;
        
        references.push({
          table,
          type: this.getQueryType(match[0]),
          location: { line, column },
          context: match[0]
        });
      }
    }
    
    return references;
  }
  
  /**
   * Find column references
   */
  private findColumnReferences(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string
  ): ColumnReference[] {
    const references: ColumnReference[] = [];
    
    // Patterns for column references
    const patterns = [
      /(\w+)\.(\w+)\s*[=<>]/gi,  // table.column comparison
      /SELECT\s+.*?(\w+)\.(\w+)/gi,  // SELECT table.column
      /WHERE\s+.*?(\w+)\.(\w+)/gi,  // WHERE table.column
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(sourceCode)) !== null) {
        const table = match[1];
        const column = match[2];
        const index = match.index;
        const lines = sourceCode.substring(0, index).split('\n');
        const line = lines.length;
        const col = lines[lines.length - 1].length + 1;
        
        references.push({
          table,
          column,
          location: { line, column: col }
        });
      }
    }
    
    return references;
  }
  
  /**
   * Check naming conventions
   */
  private checkNamingConventions(
    references: TableReference[],
    filePath: string
  ): Violation[] {
    const violations: Violation[] = [];
    
    for (const ref of references) {
      // Check for camelCase tables (should be snake_case)
      if (/[A-Z]/.test(ref.table) && !ref.table.endsWith('Table')) {
        violations.push(this.createViolation(
          filePath,
          ref.location,
          `Table name '${ref.table}' should use snake_case convention`,
          'suggestion',
          'naming-convention'
        ));
      }
      
      // Check for reserved words
      const reserved = ['user', 'order', 'group', 'table', 'column', 'index'];
      if (reserved.includes(ref.table.toLowerCase())) {
        violations.push(this.createViolation(
          filePath,
          ref.location,
          `Table name '${ref.table}' is a reserved word. Consider using a different name.`,
          'warning',
          'reserved-word'
        ));
      }
    }
    
    return violations;
  }
  
  /**
   * Check query patterns
   */
  private checkQueryPatterns(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
    config: SchemaAnalyzerConfig
  ): Violation[] {
    const violations: Violation[] = [];
    
    // Count queries per function
    const functions = adapter.extractFunctions(ast);
    
    for (const func of functions) {
      const funcNode = this.findNodeByLocation(ast.root, func.location.start);
      if (!funcNode) continue;
      
      const funcText = adapter.getNodeText(funcNode, sourceCode);
      const queryCount = this.countQueries(funcText);
      
      if (queryCount > (config.maxQueriesPerFunction || 5)) {
        violations.push(this.createViolation(
          ast.filePath,
          func.location.start,
          `Function '${func.name}' has ${queryCount} queries, exceeding the maximum of ${config.maxQueriesPerFunction}`,
          'warning',
          'too-many-queries'
        ));
      }
    }
    
    // Check for N+1 query patterns
    if (sourceCode.includes('.map') && (sourceCode.includes('.query') || sourceCode.includes('SELECT'))) {
      violations.push(this.createViolation(
        ast.filePath,
        { line: 1, column: 1 },
        'Potential N+1 query pattern detected. Consider using a join or batch query.',
        'warning',
        'n-plus-one'
      ));
    }
    
    return violations;
  }
  
  /**
   * Check for SQL injection vulnerabilities
   */
  private checkSQLInjection(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string
  ): Violation[] {
    const violations: Violation[] = [];
    
    // Patterns that indicate potential SQL injection
    const dangerousPatterns = [
      /query\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g,  // Template literals in queries
      /query\s*\(\s*['"][^'"]*['"]?\s*\+/g,     // String concatenation
      /execute\s*\(\s*['"][^'"]*['"]?\s*\+/g,   // String concatenation in execute
    ];
    
    for (const pattern of dangerousPatterns) {
      if (pattern.test(sourceCode)) {
        violations.push(this.createViolation(
          ast.filePath,
          { line: 1, column: 1 },
          'Potential SQL injection vulnerability. Use parameterized queries.',
          'critical',
          'sql-injection'
        ));
        break;
      }
    }
    
    return violations;
  }
  
  /**
   * Helper methods
   */
  private getQueryType(context: string): TableReference['type'] {
    const upper = context.toUpperCase();
    if (upper.includes('SELECT')) return 'select';
    if (upper.includes('INSERT')) return 'insert';
    if (upper.includes('UPDATE')) return 'update';
    if (upper.includes('DELETE')) return 'delete';
    if (upper.includes('CREATE')) return 'create';
    return 'reference';
  }
  
  private isSystemTable(table: string): boolean {
    const systemTables = [
      'information_schema',
      'pg_catalog',
      'mysql',
      'performance_schema',
      'sys'
    ];
    return systemTables.some(st => table.toLowerCase().startsWith(st));
  }
  
  private countQueries(text: string): number {
    const patterns = [
      /\.query\s*\(/g,
      /\.execute\s*\(/g,
      /SELECT\s+/gi,
      /INSERT\s+INTO/gi,
      /UPDATE\s+/gi,
      /DELETE\s+FROM/gi
    ];
    
    let count = 0;
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) count += matches.length;
    }
    
    return count;
  }
  
  private findNodeByLocation(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
    const queue: ASTNode[] = [root];
    
    while (queue.length > 0) {
      const node = queue.shift()!;
      
      if (node.location.start.line === location.line &&
          node.location.start.column === location.column) {
        return node;
      }
      
      if (node.children) {
        queue.push(...node.children);
      }
    }
    
    return null;
  }
  
  /**
   * Analyze JSON Schema files
   */
  private async analyzeJsonSchemas(
    files: string[],
    config: SchemaAnalyzerConfig
  ): Promise<AnalyzerResult> {
    const violations: BaseViolation[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    let filesProcessed = 0;
    const startTime = Date.now();
    
    const finalConfig = { ...DEFAULT_SCHEMA_CONFIG, ...config };
    
    if (!finalConfig.validateJsonSchemas) {
      return { violations, errors, filesProcessed, executionTime: 0 };
    }
    
    // Categorize files
    const schemaFiles = this.identifySchemaFiles(files, finalConfig);
    const dataFiles = this.identifyDataFiles(files, finalConfig);
    const unknownJsonFiles = files.filter(f => !schemaFiles.includes(f) && !dataFiles.includes(f));
    
    // Load and validate schema files
    const schemas = new Map<string, any>();
    for (const file of schemaFiles) {
      try {
        const content = await fs.readFile(file, 'utf8');
        const schema = JSON.parse(content);
        schemas.set(file, schema);
        
        // Validate the JSON Schema itself
        const fileViolations = this.validateJsonSchema(schema, file, finalConfig);
        violations.push(...fileViolations);
        
        filesProcessed++;
      } catch (error) {
        if (error instanceof SyntaxError) {
          violations.push({
            file,
            line: 1,
            column: 1,
            severity: 'critical',
            message: `Invalid JSON: ${error.message}`,
            rule: 'invalid-json',
            analyzer: 'schema'
          });
        } else {
          errors.push({
            file,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        filesProcessed++;
      }
    }
    
    // Validate data files against schemas
    if (finalConfig.schemaDataPairs) {
      // Use explicit schema-data pairs
      for (const pair of finalConfig.schemaDataPairs) {
        const schema = schemas.get(pair.schema) || await this.loadSchema(pair.schema);
        if (schema) {
          const dataFiles = Array.isArray(pair.data) ? pair.data : [pair.data];
          for (const dataFile of dataFiles) {
            if (files.includes(dataFile)) {
              const dataViolations = await this.validateDataAgainstSchema(dataFile, schema, finalConfig);
              violations.push(...dataViolations);
              filesProcessed++;
            }
          }
        }
      }
    } else {
      // Try to match data files with schemas based on naming conventions
      for (const dataFile of [...dataFiles, ...unknownJsonFiles]) {
        const matchedSchema = this.findMatchingSchema(dataFile, schemas, finalConfig);
        if (matchedSchema) {
          const dataViolations = await this.validateDataAgainstSchema(dataFile, matchedSchema, finalConfig);
          violations.push(...dataViolations);
        } else if (unknownJsonFiles.includes(dataFile)) {
          // For unknown files, just check if they're valid JSON
          try {
            const content = await fs.readFile(dataFile, 'utf8');
            JSON.parse(content);
          } catch (error) {
            violations.push({
              file: dataFile,
              line: 1,
              column: 1,
              severity: 'critical',
              message: `Invalid JSON: ${error instanceof Error ? error.message : 'Parse error'}`,
              rule: 'invalid-json',
              analyzer: 'schema'
            });
          }
        }
        filesProcessed++;
      }
    }
    
    return {
      violations,
      errors,
      filesProcessed,
      executionTime: Date.now() - startTime
    };
  }
  
  /**
   * Validate a JSON Schema
   */
  private validateJsonSchema(
    schema: any,
    filePath: string,
    config: SchemaAnalyzerConfig
  ): BaseViolation[] {
    const violations: BaseViolation[] = [];
    
    // Check for $schema property
    if (!schema.$schema && config.jsonSchemaVersion) {
      violations.push({
        file: filePath,
        line: 1,
        column: 1,
        severity: 'suggestion',
        message: 'JSON Schema missing $schema declaration',
        rule: 'missing-schema-declaration',
        analyzer: 'schema'
      });
    }
    
    // Validate types recursively
    this.validateSchemaTypes(schema, filePath, config, violations);
    
    // Check for common issues
    if (schema.type === 'object' && schema.properties) {
      // Check for inconsistent required fields
      if (schema.required && Array.isArray(schema.required)) {
        for (const field of schema.required) {
          if (!schema.properties[field]) {
            violations.push({
              file: filePath,
              line: 1,
              column: 1,
              severity: 'critical',
              message: `Required field "${field}" not defined in properties`,
              rule: 'undefined-required-field',
              analyzer: 'schema'
            });
          }
        }
      }
    }
    
    return violations;
  }
  
  /**
   * Recursively validate schema types
   */
  private validateSchemaTypes(
    schema: any,
    filePath: string,
    config: SchemaAnalyzerConfig,
    violations: BaseViolation[],
    path: string = ''
  ): void {
    if (!schema || typeof schema !== 'object') return;
    
    // Check type validity
    if (schema.type && config.allowedJsonTypes) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      for (const type of types) {
        if (!config.allowedJsonTypes.includes(type)) {
          violations.push({
            file: filePath,
            line: 1,
            column: 1,
            severity: 'critical',
            message: `Invalid type "${type}" at ${path || 'root'}. Allowed types: ${config.allowedJsonTypes.join(', ')}`,
            rule: 'invalid-type',
            analyzer: 'schema'
          });
        }
      }
    }
    
    // Check numeric constraints
    if (schema.type === 'integer' || schema.type === 'number') {
      if (schema.minimum !== undefined && schema.maximum !== undefined) {
        if (schema.minimum > schema.maximum) {
          violations.push({
            file: filePath,
            line: 1,
            column: 1,
            severity: 'critical',
            message: `Invalid range at ${path}: minimum (${schema.minimum}) > maximum (${schema.maximum})`,
            rule: 'invalid-range',
            analyzer: 'schema'
          });
        }
      }
    }
    
    // Recursively check properties
    if (schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        this.validateSchemaTypes(value, filePath, config, violations, `${path}.${key}`);
      }
    }
    
    // Check array items
    if (schema.items) {
      this.validateSchemaTypes(schema.items, filePath, config, violations, `${path}[items]`);
    }
    
    // Check additional properties
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      this.validateSchemaTypes(
        schema.additionalProperties, 
        filePath, 
        config, 
        violations, 
        `${path}[additionalProperties]`
      );
    }
  }
  
  /**
   * Identify schema files based on patterns
   */
  private identifySchemaFiles(files: string[], config: SchemaAnalyzerConfig): string[] {
    if (!config.schemaFilePatterns) return [];
    
    return files.filter(file => {
      const fileName = file.split('/').pop() || '';
      return config.schemaFilePatterns!.some(pattern => {
        const regex = new RegExp(pattern.replace('*', '.*'));
        return regex.test(fileName);
      });
    });
  }
  
  /**
   * Identify data files based on patterns
   */
  private identifyDataFiles(files: string[], config: SchemaAnalyzerConfig): string[] {
    if (!config.dataFilePatterns) return [];
    
    return files.filter(file => {
      const fileName = file.split('/').pop() || '';
      return config.dataFilePatterns!.some(pattern => {
        const regex = new RegExp(pattern.replace('*', '.*'));
        return regex.test(fileName);
      });
    });
  }
  
  /**
   * Load a schema from file
   */
  private async loadSchema(schemaPath: string): Promise<any | null> {
    try {
      const content = await fs.readFile(schemaPath, 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  
  /**
   * Find matching schema for a data file
   */
  private findMatchingSchema(
    dataFile: string, 
    schemas: Map<string, any>, 
    config: SchemaAnalyzerConfig
  ): any | null {
    const dataFileName = dataFile.split('/').pop() || '';
    const dataBaseName = dataFileName.replace(/\.(data|example|test)\.json$/, '');
    
    // Look for schema with matching base name
    for (const [schemaFile, schema] of schemas) {
      const schemaFileName = schemaFile.split('/').pop() || '';
      const schemaBaseName = schemaFileName.replace(/[.-]?schema\.json$/, '');
      
      if (dataBaseName === schemaBaseName) {
        return schema;
      }
    }
    
    // If only one schema exists, use it for all data files
    if (schemas.size === 1) {
      return schemas.values().next().value;
    }
    
    return null;
  }
  
  /**
   * Validate data against a JSON Schema
   */
  private async validateDataAgainstSchema(
    dataFile: string,
    schema: any,
    config: SchemaAnalyzerConfig
  ): Promise<BaseViolation[]> {
    const violations: BaseViolation[] = [];
    
    try {
      const content = await fs.readFile(dataFile, 'utf8');
      const data = JSON.parse(content);
      
      // Validate the data against the schema
      this.validateAgainstSchema(data, schema, dataFile, violations, config);
      
    } catch (error) {
      if (error instanceof SyntaxError) {
        violations.push({
          file: dataFile,
          line: 1,
          column: 1,
          severity: 'critical',
          message: `Invalid JSON: ${error.message}`,
          rule: 'invalid-json',
          analyzer: 'schema'
        });
      } else {
        violations.push({
          file: dataFile,
          line: 1,
          column: 1,
          severity: 'critical',
          message: `Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}`,
          rule: 'file-error',
          analyzer: 'schema'
        });
      }
    }
    
    return violations;
  }
  
  /**
   * Validate data against schema recursively
   */
  private validateAgainstSchema(
    data: any,
    schema: any,
    filePath: string,
    violations: BaseViolation[],
    config: SchemaAnalyzerConfig,
    path: string = ''
  ): void {
    // Type validation
    if (schema.type) {
      const actualType = Array.isArray(data) ? 'array' : 
                        data === null ? 'null' : 
                        typeof data;
      
      const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
      
      // Special handling for integer vs number
      const isValidType = allowedTypes.some(type => {
        if (type === 'integer') {
          return typeof data === 'number' && Number.isInteger(data);
        }
        return type === actualType;
      });
      
      if (!isValidType) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'critical',
          message: `Type mismatch at ${path || 'root'}: expected ${allowedTypes.join(' | ')}, got ${actualType}`,
          rule: 'type-mismatch',
          analyzer: 'schema'
        });
        return; // Don't validate further if type is wrong
      }
    }
    
    // String validations
    if (schema.type === 'string' && typeof data === 'string') {
      if (schema.minLength !== undefined && data.length < schema.minLength) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `String at ${path} too short: ${data.length} < ${schema.minLength}`,
          rule: 'string-too-short',
          analyzer: 'schema'
        });
      }
      
      if (schema.maxLength !== undefined && data.length > schema.maxLength) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `String at ${path} too long: ${data.length} > ${schema.maxLength}`,
          rule: 'string-too-long',
          analyzer: 'schema'
        });
      }
      
      if (schema.pattern) {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(data)) {
          violations.push({
            file: filePath,
            line: 1,
            column: 1,
            severity: 'warning',
            message: `String at ${path} doesn't match pattern: ${schema.pattern}`,
            rule: 'pattern-mismatch',
            analyzer: 'schema'
          });
        }
      }
      
      if (schema.format) {
        // Basic format validation
        switch (schema.format) {
          case 'email':
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data)) {
              violations.push({
                file: filePath,
                line: 1,
                column: 1,
                severity: 'warning',
                message: `Invalid email format at ${path}`,
                rule: 'invalid-format',
                analyzer: 'schema'
              });
            }
            break;
          case 'uuid':
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data)) {
              violations.push({
                file: filePath,
                line: 1,
                column: 1,
                severity: 'warning',
                message: `Invalid UUID format at ${path}`,
                rule: 'invalid-format',
                analyzer: 'schema'
              });
            }
            break;
          // Add more formats as needed
        }
      }
    }
    
    // Number validations
    if ((schema.type === 'number' || schema.type === 'integer') && typeof data === 'number') {
      if (schema.minimum !== undefined && data < schema.minimum) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Value at ${path} below minimum: ${data} < ${schema.minimum}`,
          rule: 'below-minimum',
          analyzer: 'schema'
        });
      }
      
      if (schema.maximum !== undefined && data > schema.maximum) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Value at ${path} above maximum: ${data} > ${schema.maximum}`,
          rule: 'above-maximum',
          analyzer: 'schema'
        });
      }
    }
    
    // Array validations
    if (schema.type === 'array' && Array.isArray(data)) {
      if (schema.minItems !== undefined && data.length < schema.minItems) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Array at ${path} has too few items: ${data.length} < ${schema.minItems}`,
          rule: 'too-few-items',
          analyzer: 'schema'
        });
      }
      
      if (schema.maxItems !== undefined && data.length > schema.maxItems) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Array at ${path} has too many items: ${data.length} > ${schema.maxItems}`,
          rule: 'too-many-items',
          analyzer: 'schema'
        });
      }
      
      if (schema.items) {
        data.forEach((item, index) => {
          this.validateAgainstSchema(
            item,
            schema.items,
            filePath,
            violations,
            config,
            `${path}[${index}]`
          );
        });
      }
    }
    
    // Object validations
    if (schema.type === 'object' && typeof data === 'object' && data !== null) {
      // Check required fields
      if (schema.required && Array.isArray(schema.required)) {
        for (const requiredField of schema.required) {
          if (!(requiredField in data)) {
            violations.push({
              file: filePath,
              line: 1,
              column: 1,
              severity: 'critical',
              message: `Missing required field "${requiredField}" at ${path}`,
              rule: 'missing-required-field',
              analyzer: 'schema'
            });
          }
        }
      }
      
      // Validate properties
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in data) {
            this.validateAgainstSchema(
              data[key],
              propSchema,
              filePath,
              violations,
              config,
              path ? `${path}.${key}` : key
            );
          }
        }
      }
      
      // Check additional properties
      if (schema.additionalProperties === false || (config.strictMode && !schema.additionalProperties)) {
        const definedKeys = new Set(Object.keys(schema.properties || {}));
        const actualKeys = Object.keys(data);
        
        for (const key of actualKeys) {
          if (!definedKeys.has(key)) {
            violations.push({
              file: filePath,
              line: 1,
              column: 1,
              severity: config.strictMode ? 'critical' : 'warning',
              message: `Unexpected property "${key}" at ${path}`,
              rule: 'unexpected-property',
              analyzer: 'schema'
            });
          }
        }
      } else if (typeof schema.additionalProperties === 'object') {
        // Validate additional properties against schema
        const definedKeys = new Set(Object.keys(schema.properties || {}));
        for (const [key, value] of Object.entries(data)) {
          if (!definedKeys.has(key)) {
            this.validateAgainstSchema(
              value,
              schema.additionalProperties,
              filePath,
              violations,
              config,
              path ? `${path}.${key}` : key
            );
          }
        }
      }
    }
    
    // Enum validation
    if (schema.enum && Array.isArray(schema.enum)) {
      if (!schema.enum.includes(data)) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'critical',
          message: `Value at ${path} not in enum: ${JSON.stringify(data)}. Allowed: ${schema.enum.join(', ')}`,
          rule: 'enum-mismatch',
          analyzer: 'schema'
        });
      }
    }
  }
}