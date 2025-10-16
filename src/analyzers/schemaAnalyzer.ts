/**
 * Schema Analyzer
 * Analyzes code against loaded database schemas to find violations and patterns
 */

import type { AnalyzerFunction, AnalyzerDefinition, SchemaViolation, AnalyzerResult } from '../types.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { promises as fs } from 'fs';
import path from 'path';
import ts from 'typescript';

export interface SchemaAnalyzerConfig {
  enableTableUsageTracking: boolean;
  checkMissingReferences: boolean;
  checkNamingConventions: boolean;
  detectUnusedTables: boolean;
  validateQueryPatterns: boolean;
  maxQueriesPerFunction: number;
  allowedQueryPatterns: string[];
  requiredSchemas: string[];
}

const DEFAULT_CONFIG: SchemaAnalyzerConfig = {
  enableTableUsageTracking: true,
  checkMissingReferences: true,
  checkNamingConventions: true,
  detectUnusedTables: false,
  validateQueryPatterns: true,
  maxQueriesPerFunction: 5,
  allowedQueryPatterns: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  requiredSchemas: []
};

export const analyzeSchema: AnalyzerFunction = async (
  files: string[],
  config: Partial<SchemaAnalyzerConfig> = {},
  options = {},
  progressCallback
) => {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const violations: SchemaViolation[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let filesProcessed = 0;
  const startTime = Date.now();

  // Get database handle
  const db = CodeIndexDB.getInstance();
  await db.initialize();

  // Get all loaded schemas
  const loadedSchemas = await db.getAllSchemas();
  
  if (loadedSchemas.length === 0 && finalConfig.requiredSchemas.length > 0) {
    violations.push({
      file: 'project',
      severity: 'warning',
      message: 'No database schemas loaded for analysis',
      schemaType: 'missing-reference',
      details: 'Load schema definitions using schema management tools'
    });
  }

  // Build table name lookup for fast access
  const allTables = new Set<string>();
  const tableToSchema = new Map<string, string>();
  
  for (const { schema } of loadedSchemas) {
    for (const database of schema.databases) {
      for (const table of database.tables) {
        allTables.add(table.name);
        tableToSchema.set(table.name, schema.name);
      }
    }
  }

  // Analyze each file
  for (const file of files) {
    try {
      progressCallback?.({
        current: filesProcessed,
        total: files.length,
        analyzer: 'schema',
        file: path.basename(file),
        phase: 'analyzing'
      });

      // Skip non-source files
      if (!file.match(/\.(ts|tsx|js|jsx)$/)) {
        continue;
      }

      const content = await fs.readFile(file, 'utf-8');
      const fileViolations = await analyzeFile(
        file, 
        content, 
        allTables, 
        tableToSchema, 
        finalConfig,
        db
      );
      
      violations.push(...fileViolations);
      filesProcessed++;

    } catch (error) {
      errors.push({
        file,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  return {
    violations,
    filesProcessed,
    executionTime: Date.now() - startTime,
    errors: errors.length > 0 ? errors : undefined,
    analyzerName: 'schema',
    metadata: {
      loadedSchemas: loadedSchemas.length,
      totalTables: allTables.size,
      config: finalConfig
    }
  };
};

async function analyzeFile(
  filePath: string,
  content: string,
  allTables: Set<string>,
  tableToSchema: Map<string, string>,
  config: SchemaAnalyzerConfig,
  db: CodeIndexDB
): Promise<SchemaViolation[]> {
  const violations: SchemaViolation[] = [];

  // Parse TypeScript/JavaScript
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  // Track schema usage for this file
  const schemaUsages: Array<{
    tableName: string;
    functionName: string;
    usageType: 'query' | 'insert' | 'update' | 'delete' | 'reference';
    line: number;
    column: number;
    rawQuery?: string;
  }> = [];

  // Analyze the AST
  function visit(node: ts.Node, currentFunction?: string) {
    // Detect ORM-specific patterns
    
    // 1. Drizzle ORM - Functional table definitions
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const funcName = node.expression.text;
      if (['pgTable', 'mysqlTable', 'sqliteTable'].includes(funcName)) {
        const tableName = extractTableNameFromDrizzle(node);
        if (tableName) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          schemaUsages.push({
            tableName,
            functionName: currentFunction || 'schema-definition',
            usageType: 'reference' as const,
            line: pos.line + 1,
            column: pos.character + 1
          });
        }
      }
    }

    // 2. TypeORM - Entity decorators
    if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
      const decoratorName = getDecoratorName(node.expression);
      if (decoratorName === 'Entity') {
        // Extract table name from Entity decorator
        const tableName = extractTableNameFromTypeORM(node.expression);
        if (tableName) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          schemaUsages.push({
            tableName,
            functionName: currentFunction || 'entity-definition',
            usageType: 'reference' as const,
            line: pos.line + 1,
            column: pos.character + 1
          });
        }
      }
    }

    // 3. Mongoose - Schema constructors
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'Schema') {
        // Analyze schema object literal for field references
        analyzeMongooseSchema(node, currentFunction);
      }
    }

    // 4. Prisma Client - Table access patterns
    if (ts.isPropertyAccessExpression(node)) {
      const propertyName = node.name.text;
      // Check if this looks like Prisma client table access (prisma.user.findMany)
      if (isPrismaBoundProperty(node)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        schemaUsages.push({
          tableName: propertyName,
          functionName: currentFunction || 'unknown',
          usageType: 'query' as const,
          line: pos.line + 1,
          column: pos.character + 1
        });
      }
    }

    // 5. Detect SQL queries and table references (existing logic)
    if (ts.isStringLiteral(node) || ts.isTemplateExpression(node)) {
      const queryText = getQueryText(node);
      if (queryText) {
        const queryAnalysis = analyzeQuery(queryText, allTables, filePath);
        violations.push(...queryAnalysis.violations);
        
        // Record schema usage
        for (const table of queryAnalysis.tables) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          schemaUsages.push({
            tableName: table,
            functionName: currentFunction || 'unknown',
            usageType: queryAnalysis.type as 'query' | 'insert' | 'update' | 'delete' | 'reference',
            line: pos.line + 1,
            column: pos.character + 1,
            rawQuery: queryText
          });
        }
      }
    }

    // Detect ORM/model references
    if (ts.isPropertyAccessExpression(node)) {
      const propertyName = node.name.text;
      if (allTables.has(propertyName)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        schemaUsages.push({
          tableName: propertyName,
          functionName: currentFunction || 'unknown',
          usageType: 'reference' as const,
          line: pos.line + 1,
          column: pos.character + 1
        });
      }
    }

    // Track current function context
    let funcName = currentFunction;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        funcName = node.name.text;
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        funcName = node.name.text;
      }
    }

    ts.forEachChild(node, child => visit(child, funcName));
  }

  visit(sourceFile);

  // Record schema usages in database
  if (config.enableTableUsageTracking) {
    for (const usage of schemaUsages) {
      await db.recordSchemaUsage({
        tableName: usage.tableName,
        filePath,
        functionName: usage.functionName,
        usageType: usage.usageType,
        line: usage.line,
        column: usage.column,
        rawQuery: usage.rawQuery
      });
    }
  }

  // Check for violations
  if (config.checkMissingReferences) {
    violations.push(...checkMissingTableReferences(schemaUsages, allTables, filePath));
  }

  if (config.validateQueryPatterns) {
    violations.push(...validateQueryPatterns(schemaUsages, config, filePath));
  }

  return violations;
}

function getQueryText(node: ts.StringLiteral | ts.TemplateExpression): string | null {
  if (ts.isStringLiteral(node)) {
    const text = node.text.toUpperCase();
    // Check if it looks like SQL
    if (text.includes('SELECT') || text.includes('INSERT') || 
        text.includes('UPDATE') || text.includes('DELETE') ||
        text.includes('CREATE') || text.includes('DROP')) {
      return node.text;
    }
  }
  
  if (ts.isTemplateExpression(node)) {
    // For template literals, check the head
    const headText = node.head.text.toUpperCase();
    if (headText.includes('SELECT') || headText.includes('INSERT') || 
        headText.includes('UPDATE') || headText.includes('DELETE')) {
      // Return a simplified version for analysis
      return node.head.text + ' ...';
    }
  }
  
  return null;
}

function analyzeQuery(query: string, allTables: Set<string>, filePath: string): {
  violations: SchemaViolation[];
  tables: string[];
  type: string;
} {
  const violations: SchemaViolation[] = [];
  const tables: string[] = [];
  const queryUpper = query.toUpperCase();
  
  let type = 'query';
  if (queryUpper.includes('SELECT')) type = 'query';
  else if (queryUpper.includes('INSERT')) type = 'insert';
  else if (queryUpper.includes('UPDATE')) type = 'update';
  else if (queryUpper.includes('DELETE')) type = 'delete';

  // Extract table names (basic regex - could be enhanced)
  const tableMatches = query.match(/(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi);
  
  if (tableMatches) {
    for (const match of tableMatches) {
      const tableName = match.split(/\s+/).pop();
      if (tableName && !allTables.has(tableName)) {
        violations.push({
          file: filePath,
          severity: 'warning',
          message: `Table '${tableName}' not found in loaded schemas`,
          schemaType: 'missing-reference',
          tableName,
          snippet: query.substring(0, 100),
          suggestion: 'Load the appropriate database schema or check table name spelling'
        });
      } else if (tableName) {
        tables.push(tableName);
      }
    }
  }

  return { violations, tables, type };
}

function checkMissingTableReferences(
  usages: Array<{ tableName: string; line: number }>,
  allTables: Set<string>,
  filePath: string
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  
  for (const usage of usages) {
    if (!allTables.has(usage.tableName)) {
      violations.push({
        file: filePath,
        line: usage.line,
        severity: 'warning',
        message: `Reference to unknown table '${usage.tableName}'`,
        schemaType: 'missing-reference',
        tableName: usage.tableName,
        suggestion: 'Load the database schema that contains this table'
      });
    }
  }
  
  return violations;
}

function validateQueryPatterns(
  usages: Array<{ functionName: string; usageType: string }>,
  config: SchemaAnalyzerConfig,
  filePath: string
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  
  // Count queries per function
  const queriesPerFunction = usages.reduce((acc, usage) => {
    if (usage.usageType !== 'reference') {
      acc[usage.functionName] = (acc[usage.functionName] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  // Check for functions with too many queries
  for (const [funcName, count] of Object.entries(queriesPerFunction)) {
    if (count > config.maxQueriesPerFunction) {
      violations.push({
        file: filePath,
        severity: 'suggestion',
        message: `Function '${funcName}' has ${count} database queries (max recommended: ${config.maxQueriesPerFunction})`,
        schemaType: 'missing-reference',
        suggestion: 'Consider consolidating queries or extracting to a data access layer'
      });
    }
  }

  return violations;
}

// ORM-specific helper functions
function extractTableNameFromDrizzle(node: ts.CallExpression): string | null {
  // Drizzle: pgTable('table_name', { ... })
  if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
    return node.arguments[0].text;
  }
  return null;
}

function getDecoratorName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  return null;
}

function extractTableNameFromTypeORM(node: ts.CallExpression): string | null {
  // TypeORM: @Entity('table_name') or @Entity({ name: 'table_name' })
  if (node.arguments.length > 0) {
    const firstArg = node.arguments[0];
    if (ts.isStringLiteral(firstArg)) {
      return firstArg.text;
    }
    if (ts.isObjectLiteralExpression(firstArg)) {
      // Look for name property
      for (const prop of firstArg.properties) {
        if (ts.isPropertyAssignment(prop) && 
            ts.isIdentifier(prop.name) && 
            prop.name.text === 'name' &&
            ts.isStringLiteral(prop.initializer)) {
          return prop.initializer.text;
        }
      }
    }
  }
  return null;
}

function analyzeMongooseSchema(node: ts.NewExpression, currentFunction?: string): void {
  // Mongoose: new Schema({ field: { type: String, ref: 'OtherModel' } })
  if (node.arguments && node.arguments.length > 0) {
    const schemaArg = node.arguments[0];
    if (ts.isObjectLiteralExpression(schemaArg)) {
      // Look for ref properties that indicate relationships
      analyzeObjectForReferences(schemaArg, currentFunction);
    }
  }
}

function analyzeObjectForReferences(obj: ts.ObjectLiteralExpression, currentFunction?: string): void {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
      // Look for ref property
      for (const nestedProp of prop.initializer.properties) {
        if (ts.isPropertyAssignment(nestedProp) &&
            ts.isIdentifier(nestedProp.name) &&
            nestedProp.name.text === 'ref' &&
            ts.isStringLiteral(nestedProp.initializer)) {
          // Found a reference to another model
          const referencedModel = nestedProp.initializer.text;
          // Add to schema usage tracking
          // This would need access to the parent scope's schemaUsages array
        }
      }
    }
  }
}

function isPrismaBoundProperty(node: ts.PropertyAccessExpression): boolean {
  // Check if this looks like prisma.tableName.operation
  if (ts.isPropertyAccessExpression(node.expression) && 
      ts.isIdentifier(node.expression.expression)) {
    const baseName = node.expression.expression.text;
    // Common Prisma client variable names
    return ['prisma', 'db', 'client'].includes(baseName.toLowerCase());
  }
  return false;
}

/**
 * Schema Analyzer Definition
 */
export const schemaAnalyzer: AnalyzerDefinition = {
  name: 'schema',
  analyze: analyzeSchema,
  defaultConfig: DEFAULT_CONFIG,
  description: 'Analyzes code against loaded database schemas to detect violations and track usage patterns',
  category: 'Data Access'
};