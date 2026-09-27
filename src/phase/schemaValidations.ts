/**
 * Spec 68 §3.2 — the `schema-validations` corpus processor.
 *
 * The legacy schema Stage-3 reducer called `analyzeJsonSchemas(jsonFiles,
 * readJson, schemaConfig)` over the `.json` file set, where `readJson` parsed a
 * file on demand. This processor re-homes that one call: it builds the file
 * list from the `json-document` fact, re-derives the same `readJson` projection
 * (`null` for a parse error, the literal `null`, or any non-object value), and
 * calls the same `analyzeJsonSchemas` free function. The resulting violations
 * — already `{ rule, file, line:1, column:1, severity, message }` — are
 * projected onto the `SchemaValidationFact` shape, one element per violation.
 *
 * The validation logic is NOT re-homed here: `analyzeJsonSchemas` is already a
 * module-level free function with no analyzer-class or pipeline dependency (it
 * survives §15), so the processor imports it and stays byte-identical by
 * construction. The 17 schema-json rules then filter this fact by rule id.
 *
 * Config: the corpus-processor interface does not thread config (like
 * `mined-conventions`, it reads the shared default), so `DEFAULT_SCHEMA_CONFIG`
 * is the sole source. The §10 config bridge is where a project's
 * `schemaFilePatterns` / `schemaDataPairs` override reach the phase model; this
 * slice keeps the config-free parity the legacy reducer had under its default.
 */

import { analyzeJsonSchemas } from '../analyzers/universal/schema/jsonSchema.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';
import type { SchemaAnalyzerConfig } from '../analyzers/universal/schema/types.js';
import type { JsonDocumentFact, SchemaValidationFact } from './types.js';

/** Reduce the `json-document` fact through the legacy validation free functions. */
export function buildSchemaValidations(
  documents: readonly JsonDocumentFact[],
  config: SchemaAnalyzerConfig = DEFAULT_SCHEMA_CONFIG,
): SchemaValidationFact[] {
  const files = documents.map((d) => d.file);
  const jsonByFile = new Map(documents.map((d) => [d.file, d.json]));

  // The exact `readJson` the legacy reducer built over `context.readSource`:
  // `null` for an absent file, a parse error, the literal `null`, or any
  // non-object value — an array/string/number/boolean document reads back null.
  const readJson = (filePath: string): object | null => {
    const json = jsonByFile.get(filePath) ?? null;
    return json !== null && typeof json === 'object' ? (json as object) : null;
  };

  const result = analyzeJsonSchemas(files, readJson, config);
  return result.violations.map((v) => ({
    rule: v.rule,
    file: v.file,
    line: v.line ?? 1,
    column: v.column ?? 1,
    severity: v.severity,
    message: v.message,
  }));
}
