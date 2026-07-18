/**
 * Schema Analyzer
 * Analyzes code against loaded database schemas to find violations and patterns
 *
 * Uses tree-sitter AST patterns instead of the TypeScript compiler API.
 */

import type { AnalyzerFunction, AnalyzerDefinition, SchemaViolation } from '../types.js';
import type { ASTNode } from '../languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { CodeIndexDB } from '../codeIndexDB.js';
import { parseFile, getLineAndColumn, getNodeName } from '../languages/adapterBridge.js';
import { promises as fs } from 'fs';
import path from 'path';

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

const SQL_KEYWORDS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the raw source text from an ASTNode's underlying tree-sitter node. */
function rawText(node: ASTNode): string {
  return (node.raw as TreeSitterNode)?.text ?? '';
}

/** Strip surrounding single or double quotes from a string. */
function stripQuotes(text: string): string {
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith('`') && text.endsWith('`'))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** Find the first direct child with a given type. */
function findChild(node: ASTNode, type: string): ASTNode | undefined {
  return node.children?.find(c => c.type === type);
}

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// File-level analysis
// ---------------------------------------------------------------------------

interface SchemaUsageEntry {
  tableName: string;
  functionName: string;
  usageType: 'query' | 'insert' | 'update' | 'delete' | 'reference';
  line: number;
  column: number;
  rawQuery?: string;
}

async function analyzeFile(
  filePath: string,
  content: string,
  allTables: Set<string>,
  tableToSchema: Map<string, string>,
  config: SchemaAnalyzerConfig,
  db: CodeIndexDB
): Promise<SchemaViolation[]> {
  const violations: SchemaViolation[] = [];

  // Parse with tree-sitter
  const ast = parseFile(filePath, content);
  if (!ast) {
    return violations;
  }

  // Track schema usage for this file
  const schemaUsages: SchemaUsageEntry[] = [];

  /**
   * Walk the AST while tracking the enclosing function name.
   * Matches the original pattern: the visitor fires for the current node
   * using the *parent* function context, then computes a new context for
   * the node's children.
   */
  walkWithContext(ast.root, (node, currentFunction) => {
    // ---------------------------------------------------------------
    // 1. Drizzle ORM – Functional table definitions
    //    pgTable('table_name', { ... }), mysqlTable, sqliteTable
    // ---------------------------------------------------------------
    if (node.type === 'call_expression') {
      const identNode = findChild(node, 'identifier');
      if (identNode) {
        const funcName = rawText(identNode);
        if (['pgTable', 'mysqlTable', 'sqliteTable'].includes(funcName)) {
          const tableName = extractTableNameFromDrizzle(node);
          if (tableName) {
            const { line, column } = getLineAndColumn(node);
            schemaUsages.push({
              tableName,
              functionName: currentFunction || 'schema-definition',
              usageType: 'reference',
              line,
              column,
            });
          }
        }
      }
    }

    // ---------------------------------------------------------------
    // 2. TypeORM – Entity decorators
    //    @Entity('table_name') or @Entity({ name: 'table_name' })
    // ---------------------------------------------------------------
    if (node.type === 'decorator') {
      const callExpr = findChild(node, 'call_expression');
      if (callExpr) {
        const decoratorName = getDecoratorName(callExpr);
        if (decoratorName === 'Entity') {
          const tableName = extractTableNameFromTypeORM(callExpr);
          if (tableName) {
            const { line, column } = getLineAndColumn(node);
            schemaUsages.push({
              tableName,
              functionName: currentFunction || 'entity-definition',
              usageType: 'reference',
              line,
              column,
            });
          }
        }
      }
    }

    // ---------------------------------------------------------------
    // 3. Mongoose – Schema constructors
    //    new Schema({ field: { type: String, ref: 'OtherModel' } })
    // ---------------------------------------------------------------
    if (node.type === 'new_expression') {
      const exprIdent = findChild(node, 'identifier');
      if (exprIdent && rawText(exprIdent) === 'Schema') {
        analyzeMongooseSchema(node, currentFunction);
      }
    }

    // ---------------------------------------------------------------
    // 4. Prisma Client – Table access patterns
    //    prisma.user.findMany()
    // ---------------------------------------------------------------
    if (node.type === 'member_expression') {
      const propIdent = findChild(node, 'property_identifier');
      if (propIdent) {
        const propertyName = rawText(propIdent);

        // Prisma-specific check (prisma.user, db.user, client.user)
        if (isPrismaBoundProperty(node)) {
          const { line, column } = getLineAndColumn(node);
          schemaUsages.push({
            tableName: propertyName,
            functionName: currentFunction || 'unknown',
            usageType: 'query',
            line,
            column,
          });
        }
      }
    }

    // ---------------------------------------------------------------
    // 5. Detect SQL queries and table references in string/template literals
    // ---------------------------------------------------------------
    if (
      node.type === 'string' ||
      node.type === 'template_string' ||
      node.type === 'template_literal'
    ) {
      const queryText = getQueryText(node);
      if (queryText) {
        const queryAnalysis = analyzeQuery(queryText, allTables, filePath);
        violations.push(...queryAnalysis.violations);

        for (const table of queryAnalysis.tables) {
          const { line, column } = getLineAndColumn(node);
          schemaUsages.push({
            tableName: table,
            functionName: currentFunction || 'unknown',
            usageType: queryAnalysis.type as 'query' | 'insert' | 'update' | 'delete' | 'reference',
            line,
            column,
            rawQuery: queryText,
          });
        }
      }
    }

    // ---------------------------------------------------------------
    // 6. General ORM / model references
    //    Any member expression whose property matches a known table name
    // ---------------------------------------------------------------
    if (node.type === 'member_expression') {
      const propIdent = findChild(node, 'property_identifier');
      if (propIdent) {
        const propertyName = rawText(propIdent);
        if (allTables.has(propertyName)) {
          const { line, column } = getLineAndColumn(node);
          schemaUsages.push({
            tableName: propertyName,
            functionName: currentFunction || 'unknown',
            usageType: 'reference',
            line,
            column,
          });
        }
      }
    }
  });

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
        rawQuery: usage.rawQuery,
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

// ---------------------------------------------------------------------------
// AST walker with function-context tracking
// ---------------------------------------------------------------------------

/**
 * Walk an AST depth-first while tracking the name of the enclosing function.
 * The visitor receives the current node and the *parent's* function name,
 * then computes an updated name for the node's children.
 */
function walkWithContext(
  node: ASTNode,
  visitor: (node: ASTNode, functionName?: string) => void,
  currentFunction?: string
): void {
  // Invoke visitor with the parent's context
  visitor(node, currentFunction);

  // Determine the function context for children
  let funcName = currentFunction;
  if (
    node.type === 'function_declaration' ||
    node.type === 'method_definition' ||
    node.type === 'arrow_function'
  ) {
    const name = getNodeName(node);
    if (name) {
      funcName = name;
    }
  }

  // Recurse into children
  if (node.children) {
    for (const child of node.children) {
      walkWithContext(child, visitor, funcName);
    }
  }
}

// ---------------------------------------------------------------------------
// Query text detection
// ---------------------------------------------------------------------------

function getQueryText(node: ASTNode): string | null {
  if (node.type === 'string') {
    const text = rawText(node);
    const unquoted = stripQuotes(text);
    const upper = unquoted.toUpperCase();
    if (SQL_KEYWORDS.some(kw => upper.includes(kw))) {
      return unquoted;
    }
  }

  if (node.type === 'template_string' || node.type === 'template_literal') {
    // The first string_fragment contains the text before the first substitution
    const headNode = node.children?.find(c => c.type === 'string_fragment');
    if (headNode) {
      const headText = rawText(headNode).toUpperCase();
      if (SQL_KEYWORDS.some(kw => headText.includes(kw))) {
        return rawText(headNode) + ' ...';
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// SQL query analysis
// ---------------------------------------------------------------------------

function analyzeQuery(
  query: string,
  allTables: Set<string>,
  filePath: string
): {
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

  // Extract table names (basic regex — could be enhanced)
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
          suggestion: 'Load the appropriate database schema or check table name spelling',
        });
      } else if (tableName) {
        tables.push(tableName);
      }
    }
  }

  return { violations, tables, type };
}

// ---------------------------------------------------------------------------
// Validation checks
// ---------------------------------------------------------------------------

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
        suggestion: 'Load the database schema that contains this table',
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
        suggestion: 'Consider consolidating queries or extracting to a data access layer',
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// ORM-specific helper functions
// ---------------------------------------------------------------------------

/**
 * Extract the table name from a Drizzle ORM call.
 * Drizzle: pgTable('table_name', { ... })
 */
function extractTableNameFromDrizzle(node: ASTNode): string | null {
  // call_expression children: [expression, arguments]
  const argsNode = findChild(node, 'arguments');
  if (!argsNode) return null;

  // The first child of arguments that is a string literal
  const stringChild = argsNode.children?.find(c => c.type === 'string');
  if (stringChild) {
    return stripQuotes(rawText(stringChild));
  }
  return null;
}

/**
 * Get the decorator name from a call_expression inside a decorator.
 * e.g. @Entity(...) → 'Entity'
 */
function getDecoratorName(node: ASTNode): string | null {
  // node is a call_expression inside a decorator
  const identNode = findChild(node, 'identifier');
  if (identNode) {
    return rawText(identNode);
  }
  return null;
}

/**
 * Extract the table name from a TypeORM Entity decorator call.
 * @Entity('table_name') or @Entity({ name: 'table_name' })
 */
function extractTableNameFromTypeORM(node: ASTNode): string | null {
  // node is a call_expression
  const argsNode = findChild(node, 'arguments');
  if (!argsNode) return null;

  // First non-bracket argument
  const firstArg = argsNode.children?.find(c => c.type !== '(' && c.type !== ')');
  if (!firstArg) return null;

  // @Entity('table_name')
  if (firstArg.type === 'string') {
    return stripQuotes(rawText(firstArg));
  }

  // @Entity({ name: 'table_name' })
  if (firstArg.type === 'object') {
    for (const prop of firstArg.children ?? []) {
      if (prop.type === 'pair') {
        // pair children: [key, :, value]
        const keyNode = prop.children?.[0];
        if (
          keyNode &&
          (keyNode.type === 'identifier' || keyNode.type === 'string' || keyNode.type === 'property_identifier')
        ) {
          const keyText = stripQuotes(rawText(keyNode));
          if (keyText === 'name') {
            const valueNode = prop.children?.find(c => c.type === 'string');
            if (valueNode) {
              return stripQuotes(rawText(valueNode));
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Analyze a Mongoose Schema constructor for field-level references.
 * Mongoose: new Schema({ field: { type: String, ref: 'OtherModel' } })
 */
function analyzeMongooseSchema(node: ASTNode, currentFunction?: string): void {
  // node is a new_expression: children [new, expression, arguments]
  const argsNode = findChild(node, 'arguments');
  if (!argsNode) return;

  const schemaArg = argsNode.children?.find(c => c.type === 'object');
  if (schemaArg) {
    analyzeObjectForReferences(schemaArg, currentFunction);
  }
}

/**
 * Recurse into an object literal looking for { ref: 'ModelName' } patterns.
 */
function analyzeObjectForReferences(obj: ASTNode, currentFunction?: string): void {
  // obj is an 'object' literal
  for (const prop of obj.children ?? []) {
    if (prop.type !== 'pair') continue;

    // pair children: [key, :, value]
    const valueNode = prop.children?.find(c => c.type === 'object');
    if (!valueNode) continue;

    // Look for a nested 'ref' property
    for (const nestedProp of valueNode.children ?? []) {
      if (nestedProp.type !== 'pair') continue;

      const keyNode = nestedProp.children?.[0];
      if (!keyNode) continue;

      const keyText = stripQuotes(rawText(keyNode));
      if (keyText === 'ref') {
        const refValueNode = nestedProp.children?.find(c => c.type === 'string');
        if (refValueNode) {
          const referencedModel = stripQuotes(rawText(refValueNode));
          // NOTE: referencedModel is currently not added to schemaUsages
          // because this helper does not have access to the parent scope's array.
          // Future enhancement: track Mongoose ref relationships.
          void referencedModel;
        }
      }
    }
  }
}

/**
 * Check if a member_expression looks like a Prisma client table access.
 * prisma.user.findMany() — the top-level object is 'prisma'/'db'/'client'.
 */
function isPrismaBoundProperty(node: ASTNode): boolean {
  // node is a member_expression: children [object, ., property_identifier]
  // For prisma.user.findMany(), the outer member_expression's object is another
  // member_expression (prisma.user), whose object is the identifier 'prisma'.

  // Find the nested member_expression that is the object of this one
  const nestedME = node.children?.find(
    c => c.type === 'member_expression'
  );

  if (nestedME) {
    // The object of the nested member_expression is the base identifier
    const baseId = findChild(nestedME, 'identifier');
    if (baseId) {
      const baseName = rawText(baseId).toLowerCase();
      return ['prisma', 'db', 'client'].includes(baseName);
    }
  }

  // Also handle direct access like prisma.$queryRaw
  const directId = findChild(node, 'identifier');
  if (directId) {
    const baseName = rawText(directId).toLowerCase();
    return ['prisma', 'db', 'client'].includes(baseName);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Analyzer Definition
// ---------------------------------------------------------------------------

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
