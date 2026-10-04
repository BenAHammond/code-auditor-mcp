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
 * Spec 69 §10 — there is deliberately NO receiver name list here. DB receivers
 * are provenanced by declaration (package import, handle-type annotation,
 * wrapper, or cross-file import resolution), never by their English name.
 */
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
