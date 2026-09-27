/**
 * Spec 68 §3.2 — parity: the migrated schema-json rules reproduce the old
 * `analyzeJsonSchemas` findings exactly.
 *
 * The legacy JSON-schema validation was one monolithic free function
 * (`analyzeJsonSchemas`) that emitted 17 distinct rule ids, each anchored at the
 * hardcoded `line:1, column:1` (JSON files had no AST position the old path
 * read). The phase model splits that into three layers:
 *
 *   - `json-document` producer (`extractJsonDocument`) — `JSON.parse` each file;
 *   - `schema-validations` corpus processor (`buildSchemaValidations`) — one
 *     `analyzeJsonSchemas` call, projected onto `SchemaValidationFact`;
 *   - 17 thin rules — each filters the fact by its own rule id.
 *
 * Because the corpus processor re-homes the validation verbatim, the parity here
 * is by construction: `buildSchemaValidations` calls the *same* `analyzeJsonSchemas`
 * with the *same* `readJson` projection (null for a parse error, the literal
 * `null`, and any non-object value), and the 17 rules union to the whole fact.
 * What this test pins is the wiring — producer → corpus → rules — reproduces the
 * legacy multiset on `(file, line, column, rule, severity)`, non-empty, and that
 * every one of the 17 rules fires (route attribution: the fixture covers the full
 * rule set, so a rule dropped from the slice would read `clean` here).
 *
 * Both paths are pure free functions — no tree-sitter grammar, no SQLite index —
 * so the test needs neither `initializeLanguages()` nor `initParsers()`.
 */

import { describe, it, expect } from 'vitest';
import { analyzeJsonSchemas } from '../analyzers/universal/schema/jsonSchema.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';
import { buildSchemaValidations } from '../phase/schemaValidations.js';
import { analyzeSchemaJson } from '../phase/runner.js';
import { schemaJsonRules } from '../phase/rules/schemaJson.js';
import { extractJsonDocument } from '../phase/jsonDocument.js';
import type { JsonDocumentFact } from '../phase/types.js';
import type { Violation } from '../types.js';

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** The legacy `readJson` the schema reducer built over `context.readSource`. */
function legacyReadJson(contentByFile: Map<string, string>) {
  return (filePath: string): object | null => {
    const raw = contentByFile.get(filePath);
    if (raw === undefined) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? (parsed as object) : null;
    } catch {
      return null;
    }
  };
}

// ── Fixtures — one schema, one paired data file, one invalid-JSON schema ────

/** Self-validation violations: no `$schema`, an undefined required field, a
 *  disallowed type, and an inverted numeric range. Data-validation surface:
 *  type-mismatch (`count`), string-too-long (`bio`), too-many-items (`colors`),
 *  plus the paired-file rules below. `additionalProperties: false` makes the
 *  data file's `extra` key an `unexpected-property`. */
const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 5, pattern: '^[A-Z]' },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0, maximum: 120 },
    score: { type: 'number', minimum: 10, maximum: 5 },
    count: { type: 'string' },
    bio: { type: 'string', maxLength: 3 },
    tags: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
    colors: { type: 'array', maxItems: 2, items: { type: 'string' } },
    role: { type: 'string', enum: ['admin', 'user'] },
    badtype: { type: 'tuple' },
  },
  required: ['name', 'age', 'ghostField'],
  additionalProperties: false,
});

/** Data-validation violations: string-too-short + pattern-mismatch (`name`),
 *  invalid-format (`email`), above-maximum (`age`), below-minimum (`score`),
 *  type-mismatch (`count`), string-too-long (`bio`), too-few-items (`tags`),
 *  too-many-items (`colors`), enum-mismatch (`role`), missing-required-field
 *  (`ghostField`), unexpected-property (`extra`). */
const DATA = JSON.stringify({
  name: 'a',
  email: 'not-an-email',
  age: 150,
  score: 1,
  count: 123,
  bio: 'hello world',
  tags: ['x'],
  colors: ['a', 'b', 'c'],
  role: 'guest',
  extra: true,
});

/** A schema-pattern file that fails to parse — the `invalid-json` (critical) path. */
const BROKEN = '{ this is not valid json';

/** Build the two paths' identity multisets over one fixture set. */
async function parity(): Promise<{ old: string[]; fresh: string[]; rules: string[] }> {
  const files = [
    { path: '/parity/person.schema.json', content: SCHEMA },
    { path: '/parity/person.data.json', content: DATA },
    { path: '/parity/broken.schema.json', content: BROKEN },
  ];
  const contentByFile = new Map(files.map((f) => [f.path, f.content]));
  const paths = files.map((f) => f.path);

  // Legacy: one `analyzeJsonSchemas` call over the `.json` path set.
  const legacy = analyzeJsonSchemas(paths, legacyReadJson(contentByFile), DEFAULT_SCHEMA_CONFIG);

  // New: json-document → schema-validations → 17 rules.
  const documents: JsonDocumentFact[] = files
    .map((f) => extractJsonDocument({ file: f.path, format: 'json', source: f.content }))
    .flat();
  const validations = buildSchemaValidations(documents, DEFAULT_SCHEMA_CONFIG);
  const fresh = await analyzeSchemaJson(validations);

  const old = legacy.violations
    .map((v: Violation) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();
  const nu = fresh
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();
  const rules = [...new Set(fresh.map((f) => f.ruleId))].sort();

  return { old, fresh: nu, rules };
}

describe('Spec 68 schema-json parity (new analyze(ctx) === old analyzeJsonSchemas)', () => {
  it('covers exactly the 17 schema-json rules', () => {
    expect(schemaJsonRules.map((r) => r.id)).toEqual([
      'invalid-json',
      'missing-schema-declaration',
      'undefined-required-field',
      'invalid-type',
      'invalid-range',
      'type-mismatch',
      'string-too-short',
      'string-too-long',
      'pattern-mismatch',
      'invalid-format',
      'below-minimum',
      'above-maximum',
      'too-few-items',
      'too-many-items',
      'missing-required-field',
      'unexpected-property',
      'enum-mismatch',
    ]);
  });

  it('reproduces the legacy multiset exactly and non-empty', async () => {
    const { old, fresh } = await parity();
    expect(fresh).toEqual(old);
    expect(old.length).toBeGreaterThan(0);
  });

  it('fires every one of the 17 rules (no rule reads clean on this fixture)', async () => {
    const { rules } = await parity();
    expect(rules).toEqual(schemaJsonRules.map((r) => r.id).sort());
  });
});
