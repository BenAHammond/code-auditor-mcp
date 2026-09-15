/**
 * Schema analyzer configuration + single-source SQL-context constants.
 *
 * Spec 33 item 15 — split out of UniversalSchemaAnalyzer.ts so the constants
 * and default config are importable without pulling in the whole analyzer.
 */

import type { SchemaAnalyzerConfig } from './types.js';

/**
 * Single-source constants for SQL context detection.
 *
 * These are the ground-truth defaults. DEFAULT_SCHEMA_CONFIG references them,
 * and every inline fallback dereferences them directly — so ?? narrowing works
 * (TypeScript infers `string[]`, not `string[] | undefined` from the optional
 * SchemaAnalyzerConfig fields).
 *
 * Trimmed to D1/Workers DB patterns only (4 receivers, 6 methods).
 * Broader entries like 'connection'/'client'/'query'/'get'/'each' matched
 * non-DB code (WebSocket, Map, jQuery, vector stores), causing phantom
 * cross-domain lifecycle violations. See CHANGELOG 3.4.9 accuracy fix.
 */
export const DB_RECEIVER_NAMES = ['db', 'database', 'sql', 'stmt'] as const;
export const DB_CALL_METHOD_NAMES = ['exec', 'prepare', 'batch', 'run', 'all', 'first'] as const;
/**
 * DB-call methods whose first argument is SQL text (as opposed to bound
 * parameters, prepared statements, or a batch array). `extractDbCallRefs` only
 * resolves the first argument as SQL for these methods — `batch`/`run`/`all`/
 * `first` take a statements array or parameter object, so their first argument
 * is never SQL and must not be reported as an unresolvable query (Spec 58 R1).
 */
export const SQL_CARRYING_METHOD_NAMES = ['exec', 'prepare', 'query', 'raw', 'execute'] as const;
export const DB_BINDING_NAMES = ['env.DB'] as const;
export const DB_WRAPPER_NAMES = ['d1Query', 'd1Exec'] as const;
export const SQL_TAG_NAMES = ['sql', 'db'] as const;

export const DEFAULT_SCHEMA_CONFIG: SchemaAnalyzerConfig = {
  enableTableUsageTracking: true,
  checkMissingReferences: true,
  checkNamingConventions: true,
  detectUnusedTables: false,
  validateQueryPatterns: true,
  reportUnresolvedQueries: true,
  maxQueriesPerFunction: 5,
  skipTestFiles: true,
  requiredSchemas: [],
  schemas: [],
  validateJsonSchemas: true,
  jsonSchemaVersion: 'draft-07',
  allowedJsonTypes: ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'],
  schemaFilePatterns: ['*.schema.json', '*-schema.json'],
  dataFilePatterns: ['*.data.json', '*.example.json'],
  strictMode: false,
  allowAdditionalProperties: true,
  // Spec-17 R2 defaults
  sqlTagNames: [...SQL_TAG_NAMES],
  dbReceiverNames: [...DB_RECEIVER_NAMES],
  dbCallMethods: [...DB_CALL_METHOD_NAMES],
  dbBindingNames: [...DB_BINDING_NAMES],
  dbWrapperNames: [...DB_WRAPPER_NAMES],
  fileGateGlobs: ['**/*.sql', '**/migrations/**'],
  schemaFiles: [],
  tableSources: [],
};

/**
 * Escape regex special characters in a string.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
