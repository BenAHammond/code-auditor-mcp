/**
 * Shared types for the schema analyzer family.
 *
 * Split out of UniversalSchemaAnalyzer.ts (Spec 33 item 15) so the
 * migration/DDL, discovery, table-analysis, and JSON-schema modules can each
 * import what they need without dragging in the whole analyzer — and without
 * creating a circular import through the class.
 */

import type { SchemaUsage } from '../../../types.js';
import type { AST, LanguageAdapter } from '../../../languages/types.js';

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
  schemaFilePatterns?: string[];
  dataFilePatterns?: string[];
  schemaDataPairs?: Array<{
    schema: string;
    data: string | string[];
  }>;
  strictMode?: boolean;
  allowAdditionalProperties?: boolean;

  // Spec-17 R2 additions — SQL context detection
  // Default values live in DEFAULT_SCHEMA_CONFIG — the single source of truth.
  sqlTagNames?: string[];           // @see DEFAULT_SCHEMA_CONFIG
  dbReceiverNames?: string[];       // @see DEFAULT_SCHEMA_CONFIG
  dbCallMethods?: string[];         // @see DEFAULT_SCHEMA_CONFIG
  dbBindingNames?: string[];        // @see DEFAULT_SCHEMA_CONFIG
  dbWrapperNames?: string[];        // @see DEFAULT_SCHEMA_CONFIG
  fileGateGlobs?: string[];         // default ['**/*.sql', '**/migrations/**'] — R2.2
  schemaFiles?: string[];           // explicit paths to SQL schema files (e.g., 'snapshots/schema.sql')

  /** Spec 29: Declarative table-source registry for Tier 2 ORM detection */
  tableSources?: TableSourceEntry[];
}

export interface TableReference {
  table: string;
  type: 'select' | 'insert' | 'update' | 'delete' | 'create' | 'reference';
  location: { line: number; column: number };
  context: string;
}

/**
 * Registry entry for declarative table-source detection.
 * Adding an ORM becomes a config entry, not code.
 */
export interface TableSourceEntry {
  /** Type discriminator for the match shape */
  kind: 'callee' | 'decorator';
  /** The function/method/decorator name to match */
  name: string;
  /** Which argument (0-indexed) holds the table name as a string literal */
  arg: number;
  /** Human-readable description for provenance display */
  description?: string;
  /**
   * Optional: required module path. When set, the call/decorator is only
   * considered if the identifier originates from an import matching this
   * specifier. Example: 'knex' prevents matching a local function also
   * named createTable.
   */
  module?: string;
}

/**
 * Per-table origin record — tracks which tier and source file contributed
 * a table to the catalog.
 */
export interface TableProvenance {
  table: string;
  tier: 'sql-migration' | 'orm-registry' | 'prisma-model' | 'external-config';
  sourceFile?: string;
  description?: string;
}

/**
 * A complete catalog entry: one table name with all its known sources.
 */
export interface TableCatalogEntry {
  table: string;
  sources: TableProvenance[];
}

/**
 * Resolution context threaded through the registry table extractors. Bundling
 * the AST + adapter + source + file-path + module-reader tuple keeps the
 * extractor signatures at three positional parameters (target + context +
 * accumulator) instead of six.
 *
 * `importMap` is populated by `extractTablesFromRegistry` before dispatch —
 * callers build the context without it.
 */
export interface RegistryExtractionContext {
  ast: AST;
  adapter: LanguageAdapter;
  sourceCode: string;
  filePath: string;
  importMap?: Map<string, Map<string, string>>;
  readModule?: (fromFile: string, specifier: string) => string | null;
}

/** A single DDL state transition parsed from migration SQL. */
export type MigrationOp = {
  op: 'CREATE' | 'DROP' | 'RENAME';
  table: string;
  newTable?: string;
};

/** A single re-export statement from a barrel file. */
export interface ReExport {
  /** The module the statement re-exports from. */
  source: string;
  /** True for `export * from 'x'` (every name maps to itself). */
  star: boolean;
  /** For named re-exports: local export name → original package name. */
  renamed: Map<string, string>;
}
