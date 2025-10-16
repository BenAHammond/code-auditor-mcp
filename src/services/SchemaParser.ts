/**
 * Database Schema Parser and Validator
 * Handles loading, parsing, and validating database schema definitions
 */

import { promises as fs } from 'fs';
import path from 'path';
// import yaml from 'js-yaml';
// Temporary workaround for missing dependency
const yaml = {
  load: (content: string) => {
    throw new Error('YAML parsing not available - js-yaml dependency not installed');
  }
};
import {
  SchemaDefinition,
  DatabaseSchema,
  SchemaTable,
  SchemaColumn,
  SchemaReference,
  SchemaViolation,
  Severity
} from '../types.js';

export interface SchemaParseResult {
  success: boolean;
  schema?: SchemaDefinition;
  violations: SchemaViolation[];
  errors: string[];
}

export interface SchemaValidationOptions {
  checkReferences?: boolean;
  checkNamingConventions?: boolean;
  checkIndexes?: boolean;
  strictMode?: boolean;
  allowedDatabaseTypes?: string[];
}

export class SchemaParser {
  private static readonly SUPPORTED_FORMATS = ['.json', '.yaml', '.yml'];
  private static readonly DATABASE_TYPES = [
    'postgresql', 'mysql', 'mongodb', 'sqlite', 'redis', 'dynamodb', 'other'
  ];

  /**
   * Parse schema from file
   */
  async parseFromFile(filePath: string, options: SchemaValidationOptions = {}): Promise<SchemaParseResult> {
    try {
      const ext = path.extname(filePath).toLowerCase();
      
      if (!SchemaParser.SUPPORTED_FORMATS.includes(ext)) {
        return {
          success: false,
          violations: [],
          errors: [`Unsupported file format: ${ext}. Supported formats: ${SchemaParser.SUPPORTED_FORMATS.join(', ')}`]
        };
      }

      const content = await fs.readFile(filePath, 'utf-8');
      return this.parseFromString(content, ext, options);
      
    } catch (error) {
      return {
        success: false,
        violations: [],
        errors: [`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  /**
   * Parse schema from string content
   */
  async parseFromString(
    content: string, 
    format: string, 
    options: SchemaValidationOptions = {}
  ): Promise<SchemaParseResult> {
    const violations: SchemaViolation[] = [];
    const errors: string[] = [];

    try {
      let parsed: any;

      if (format === '.json') {
        parsed = JSON.parse(content);
      } else if (format === '.yaml' || format === '.yml') {
        parsed = yaml.load(content);
      } else {
        return {
          success: false,
          violations,
          errors: [`Unsupported format: ${format}`]
        };
      }

      // Validate structure
      const structureValidation = this.validateStructure(parsed);
      if (!structureValidation.valid) {
        return {
          success: false,
          violations,
          errors: structureValidation.errors
        };
      }

      // Convert to typed schema
      const schema = this.normalizeSchema(parsed);
      
      // Validate schema content
      const contentViolations = this.validateSchema(schema, options);
      violations.push(...contentViolations);

      return {
        success: true,
        schema,
        violations,
        errors
      };

    } catch (error) {
      return {
        success: false,
        violations,
        errors: [`Parse error: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  /**
   * Validate basic structure of parsed object
   */
  private validateStructure(obj: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!obj || typeof obj !== 'object') {
      errors.push('Schema must be an object');
      return { valid: false, errors };
    }

    // Required fields
    if (!obj.version) errors.push('Missing required field: version');
    if (!obj.name) errors.push('Missing required field: name');
    if (!obj.databases || !Array.isArray(obj.databases)) {
      errors.push('Missing or invalid field: databases (must be an array)');
    }

    // Validate databases structure
    if (obj.databases && Array.isArray(obj.databases)) {
      obj.databases.forEach((db: any, index: number) => {
        if (!db.name) errors.push(`Database ${index}: missing name`);
        if (!db.type) errors.push(`Database ${index}: missing type`);
        if (!db.tables || !Array.isArray(db.tables)) {
          errors.push(`Database ${index}: missing or invalid tables array`);
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Normalize parsed object to typed schema
   */
  private normalizeSchema(obj: any): SchemaDefinition {
    return {
      version: obj.version,
      name: obj.name,
      description: obj.description,
      databases: obj.databases.map((db: any) => this.normalizeDatabase(db)),
      globalReferences: obj.globalReferences || [],
      metadata: {
        author: obj.metadata?.author,
        createdAt: obj.metadata?.createdAt ? new Date(obj.metadata.createdAt) : undefined,
        updatedAt: obj.metadata?.updatedAt ? new Date(obj.metadata.updatedAt) : undefined,
        tags: obj.metadata?.tags || [],
        environment: obj.metadata?.environment
      }
    };
  }

  /**
   * Normalize database object
   */
  private normalizeDatabase(db: any): DatabaseSchema {
    return {
      name: db.name,
      type: db.type,
      version: db.version,
      host: db.host,
      port: db.port,
      database: db.database,
      schemas: db.schemas || [],
      tables: (db.tables || []).map((table: any) => this.normalizeTable(table)),
      relationships: db.relationships || [],
      description: db.description,
      createdAt: db.createdAt ? new Date(db.createdAt) : undefined,
      updatedAt: db.updatedAt ? new Date(db.updatedAt) : undefined,
      metadata: db.metadata
    };
  }

  /**
   * Normalize table object
   */
  private normalizeTable(table: any): SchemaTable {
    return {
      name: table.name,
      type: table.type || 'table',
      database: table.database,
      schema: table.schema,
      columns: (table.columns || []).map((col: any) => this.normalizeColumn(col)),
      references: table.references || [],
      indexes: table.indexes || [],
      constraints: table.constraints || [],
      description: table.description,
      tags: table.tags || [],
      estimatedRows: table.estimatedRows,
      isTemporary: table.isTemporary || false,
      partitionKey: table.partitionKey
    };
  }

  /**
   * Normalize column object
   */
  private normalizeColumn(col: any): SchemaColumn {
    return {
      name: col.name,
      type: col.type,
      nullable: col.nullable !== false, // Default to true if not specified
      primaryKey: col.primaryKey || false,
      defaultValue: col.defaultValue,
      unique: col.unique || false,
      indexed: col.indexed || false,
      length: col.length,
      precision: col.precision,
      scale: col.scale,
      description: col.description,
      enum: col.enum
    };
  }

  /**
   * Validate schema content and relationships
   */
  private validateSchema(schema: SchemaDefinition, options: SchemaValidationOptions): SchemaViolation[] {
    const violations: SchemaViolation[] = [];

    for (const database of schema.databases) {
      violations.push(...this.validateDatabase(database, options));
    }

    return violations;
  }

  /**
   * Validate individual database
   */
  private validateDatabase(database: DatabaseSchema, options: SchemaValidationOptions): SchemaViolation[] {
    const violations: SchemaViolation[] = [];

    // Check database type
    if (!SchemaParser.DATABASE_TYPES.includes(database.type)) {
      violations.push({
        file: 'schema',
        severity: 'warning' as Severity,
        message: `Unknown database type: ${database.type}`,
        schemaType: 'naming-convention',
        details: `Supported types: ${SchemaParser.DATABASE_TYPES.join(', ')}`
      });
    }

    // Validate tables
    for (const table of database.tables) {
      violations.push(...this.validateTable(table, database, options));
    }

    // Check for orphaned references
    if (options.checkReferences !== false) {
      violations.push(...this.validateReferences(database));
    }

    return violations;
  }

  /**
   * Validate individual table
   */
  private validateTable(table: SchemaTable, database: DatabaseSchema, options: SchemaValidationOptions): SchemaViolation[] {
    const violations: SchemaViolation[] = [];

    // Check for primary key
    const hasPrimaryKey = table.columns.some(col => col.primaryKey);
    if (!hasPrimaryKey && table.type === 'table') {
      violations.push({
        file: 'schema',
        severity: 'warning' as Severity,
        message: `Table '${table.name}' has no primary key`,
        schemaType: 'missing-index',
        tableName: table.name
      });
    }

    // Check naming conventions
    if (options.checkNamingConventions !== false) {
      violations.push(...this.validateTableNaming(table));
    }

    // Validate columns
    for (const column of table.columns) {
      violations.push(...this.validateColumn(column, table));
    }

    return violations;
  }

  /**
   * Validate column definitions
   */
  private validateColumn(column: SchemaColumn, table: SchemaTable): SchemaViolation[] {
    const violations: SchemaViolation[] = [];

    // Check for missing type
    if (!column.type) {
      violations.push({
        file: 'schema',
        severity: 'critical' as Severity,
        message: `Column '${column.name}' in table '${table.name}' is missing type`,
        schemaType: 'missing-reference',
        tableName: table.name,
        columnName: column.name
      });
    }

    // Check for enum without values
    if (column.type === 'enum' && (!column.enum || column.enum.length === 0)) {
      violations.push({
        file: 'schema',
        severity: 'warning' as Severity,
        message: `Enum column '${column.name}' in table '${table.name}' has no values defined`,
        schemaType: 'missing-reference',
        tableName: table.name,
        columnName: column.name
      });
    }

    return violations;
  }

  /**
   * Validate table naming conventions
   */
  private validateTableNaming(table: SchemaTable): SchemaViolation[] {
    const violations: SchemaViolation[] = [];

    // Check snake_case convention
    if (!/^[a-z][a-z0-9_]*$/.test(table.name)) {
      violations.push({
        file: 'schema',
        severity: 'suggestion' as Severity,
        message: `Table name '${table.name}' should follow snake_case convention`,
        schemaType: 'naming-convention',
        tableName: table.name,
        suggestion: 'Use lowercase letters, numbers, and underscores only'
      });
    }

    // Check for plural table names
    if (!table.name.endsWith('s') && !table.name.includes('_')) {
      violations.push({
        file: 'schema',
        severity: 'suggestion' as Severity,
        message: `Table name '${table.name}' should typically be plural`,
        schemaType: 'naming-convention',
        tableName: table.name,
        suggestion: 'Consider using plural form for table names'
      });
    }

    return violations;
  }

  /**
   * Validate references across tables
   */
  private validateReferences(database: DatabaseSchema): SchemaViolation[] {
    const violations: SchemaViolation[] = [];
    const tableNames = new Set(database.tables.map(t => t.name));

    for (const table of database.tables) {
      for (const reference of table.references) {
        // Check if referenced table exists
        if (!tableNames.has(reference.referencedTable)) {
          violations.push({
            file: 'schema',
            severity: 'critical' as Severity,
            message: `Reference in table '${table.name}' points to non-existent table '${reference.referencedTable}'`,
            schemaType: 'missing-reference',
            tableName: table.name,
            details: `Foreign key: ${reference.foreignKey} -> ${reference.referencedTable}.${reference.referencedColumn}`
          });
          continue;
        }

        // Check if referenced column exists
        const referencedTable = database.tables.find(t => t.name === reference.referencedTable);
        if (referencedTable) {
          const referencedColumn = referencedTable.columns.find(c => c.name === reference.referencedColumn);
          if (!referencedColumn) {
            violations.push({
              file: 'schema',
              severity: 'critical' as Severity,
              message: `Reference in table '${table.name}' points to non-existent column '${reference.referencedColumn}' in table '${reference.referencedTable}'`,
              schemaType: 'missing-reference',
              tableName: table.name,
              columnName: reference.referencedColumn,
              details: `Foreign key: ${reference.foreignKey} -> ${reference.referencedTable}.${reference.referencedColumn}`
            });
          }
        }

        // Check if foreign key column exists in current table
        const foreignKeyColumn = table.columns.find(c => c.name === reference.foreignKey);
        if (!foreignKeyColumn) {
          violations.push({
            file: 'schema',
            severity: 'critical' as Severity,
            message: `Foreign key column '${reference.foreignKey}' not found in table '${table.name}'`,
            schemaType: 'missing-reference',
            tableName: table.name,
            columnName: reference.foreignKey
          });
        }
      }
    }

    return violations;
  }

  /**
   * Get schema statistics
   */
  getSchemaStats(schema: SchemaDefinition): {
    databaseCount: number;
    tableCount: number;
    columnCount: number;
    referenceCount: number;
    indexCount: number;
  } {
    let tableCount = 0;
    let columnCount = 0;
    let referenceCount = 0;
    let indexCount = 0;

    for (const database of schema.databases) {
      tableCount += database.tables.length;
      
      for (const table of database.tables) {
        columnCount += table.columns.length;
        referenceCount += table.references.length;
        indexCount += table.indexes?.length || 0;
      }
    }

    return {
      databaseCount: schema.databases.length,
      tableCount,
      columnCount,
      referenceCount,
      indexCount
    };
  }

  /**
   * Find circular dependencies in schema
   */
  findCircularDependencies(database: DatabaseSchema): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const path: string[] = [];

    const dfs = (tableName: string): boolean => {
      if (path.includes(tableName)) {
        // Found cycle
        const cycleStart = path.indexOf(tableName);
        const cycle = [...path.slice(cycleStart), tableName];
        cycles.push(cycle);
        return true;
      }

      if (visited.has(tableName)) return false;
      visited.add(tableName);
      path.push(tableName);

      const table = database.tables.find(t => t.name === tableName);
      if (table) {
        for (const ref of table.references) {
          if (dfs(ref.referencedTable)) return true;
        }
      }

      path.pop();
      return false;
    };

    for (const table of database.tables) {
      if (!visited.has(table.name)) {
        dfs(table.name);
      }
    }

    return cycles;
  }
}