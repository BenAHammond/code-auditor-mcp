/**
 * Spec 68 §3.2 — the `json-document` producer.
 *
 * A `.json` file is parsed like any other format (Amendment 1): the
 * `JsonAdapter` produces a position-preserving value tree so later slices
 * (§13) can anchor findings to the real offending token. This slice does not
 * need that tree — the legacy `analyzeJsonSchemas` anchored every finding at
 * `line:1, column:1` and the parity test pins that anchor — so the producer
 * re-parses `.source` with `JSON.parse`, byte-identical to the legacy schema
 * reducer's `readJson` (`JSON.parse(raw)` with `null` on error).
 *
 * The parsed value is deliberately NOT the adapter's positioned AST: a
 * `JSON.parse` result is a plain-data tree (§4-serializable), which the corpus
 * `schema-validations` processor can hand straight back into the legacy
 * validation free functions without a tree-sitter node crossing the phase
 * boundary.
 */

import type { ParsedFile, JsonDocumentFact, JsonValue } from './types.js';

/** Parse one `.json` file into its `json-document` fact (one element). */
export function extractJsonDocument(file: ParsedFile): JsonDocumentFact[] {
  let json: JsonValue | null = null;
  try {
    json = JSON.parse(file.source) as JsonValue;
  } catch {
    // Invalid JSON — the legacy `readJson` returned null here too, and the
    // corpus processor surfaces it as an `invalid-json` finding.
    json = null;
  }
  return [{ file: file.file, json }];
}
