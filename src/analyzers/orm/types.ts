/**
 * ORM Adapter Types — Spec 15 R2
 *
 * ORM adapters extract table references and schema definitions from
 * ORM-specific source code patterns (Drizzle, Prisma). They complement
 * the raw-SQL extraction in UniversalSchemaAnalyzer, feeding into the
 * schema_usage table for cross-domain lifecycle analysis.
 */

import type { AST, ASTNode, LanguageAdapter } from '../../languages/types.js';

// ---------------------------------------------------------------------------
// Extracted table reference (same shape as UniversalSchemaAnalyzer's internal
// TableReference, but defined here so ORM adapters don't depend on that module)
// ---------------------------------------------------------------------------

export interface OrmTableReference {
  table: string;
  type: 'select' | 'insert' | 'update' | 'delete' | 'create' | 'reference';
  location: { line: number; column: number };
  context: string;
}

// ---------------------------------------------------------------------------
// Extracted schema definition (table + columns from ORM schema declarations)
// ---------------------------------------------------------------------------

export interface OrmSchemaDefinition {
  tableName: string;
  columns: Array<{ name: string; type: string }>;
  location: { line: number; column: number };
}

// ---------------------------------------------------------------------------
// ORM Adapter interface
// ---------------------------------------------------------------------------

export interface OrmAdapter {
  /** Unique name for this adapter (e.g. "drizzle", "prisma") */
  readonly name: string;

  /** File extensions this adapter handles */
  readonly fileExtensions: string[];

  /**
   * Whether this adapter can handle the given file.
   * Default checks file extension, but adapters can override for
   * content-based detection (e.g. Prisma checks for `schema.prisma`).
   */
  supportsFile(filePath: string): boolean;

  /**
   * Extract table references from ORM-specific patterns in the AST.
   * Called during per-file analysis when the file matches this adapter.
   *
   * @param ast        — Parsed AST of the source file
   * @param adapter    — Language adapter for AST navigation
   * @param sourceCode — Raw source text
   * @returns Array of extracted table references
   */
  extractTableReferences(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmTableReference[];

  /**
   * Extract schema/table definitions from ORM schema declarations.
   * For Drizzle this is pgTable/mysqlTable/sqliteTable calls.
   * For Prisma this is `model` blocks in schema.prisma.
   *
   * @param ast        — Parsed AST of the source file
   * @param adapter    — Language adapter for AST navigation
   * @param sourceCode — Raw source text
   * @returns Array of extracted schema definitions
   */
  extractSchemaDefinitions(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmSchemaDefinition[];
}
