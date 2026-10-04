/**
 * Spec 68 board §6.1 — behaviour fixtures for the 16 schema-JSON rules that were
 * emitted but never had a test asserting they fire.
 *
 * `invalid-format` already has its own harness (jsonSchema.spec.ts, Spec 49
 * Session 17). These are the remaining sixteen, each pinned through the public
 * `analyzeJsonSchemas` entry point — the same seam the pipeline uses — so a rule
 * that stops firing (its guard moved, its surface renamed, or its emission
 * deleted) fails here instead of silently reading an empty corpus as clean.
 *
 * The split matters:
 *   - Schema-shape rules (`missing-schema-declaration`, `undefined-required-field`,
 *     `invalid-type`, `invalid-range`) are emitted while the schema file loads,
 *     before any data is validated — so they fire with a bare schema and no data.
 *   - Data-validation rules (`type-mismatch`, `string-too-short`, …) are emitted
 *     while a data file is validated against a schema↔data pair.
 *   - `invalid-json` fires when a file that claims to be JSON fails to parse.
 */

import { describe, it, expect } from 'vitest';
import { analyzeJsonSchemas } from './jsonSchema.js';
import type { AnalyzerResult } from '../../../types.js';
import type { SchemaAnalyzerConfig } from './types.js';

const SCHEMA_PATH = '/t/user.schema.json';
const DATA_PATH = '/t/user.data.json';

const DRAFT07 = 'http://json-schema.org/draft-07/schema#';

function fires(result: AnalyzerResult, rule: string): boolean {
  return result.violations.some((v) => v.rule === rule);
}

/** Run a schema↔data pair through the public entry point and return the result. */
function runPair(schema: object, data: object, overrides: Partial<SchemaAnalyzerConfig> = {}): AnalyzerResult {
  const files = [SCHEMA_PATH, DATA_PATH];
  const readJson = (fp: string): object | null => {
    if (fp === SCHEMA_PATH) return schema;
    if (fp === DATA_PATH) return data;
    return null;
  };
  return analyzeJsonSchemas(files, readJson, {
    schemaDataPairs: [{ schema: SCHEMA_PATH, data: DATA_PATH }],
    ...overrides,
  });
}

describe('schema-JSON behaviour fixtures — every schema-JSON rule fires (Spec 68 board §6.1)', () => {
  it('invalid-json — a schema file that fails to parse fires', () => {
    const result = analyzeJsonSchemas(['/t/broken.schema.json'], () => null, {});
    expect(fires(result, 'invalid-json')).toBe(true);
  });

  it('missing-schema-declaration — a schema with no $schema fires', () => {
    // jsonSchemaVersion defaults to draft-07 (truthy), so a schema missing the
    // declaration is flagged while it loads.
    const result = runPair({ type: 'object', properties: {} }, {});
    expect(fires(result, 'missing-schema-declaration')).toBe(true);
  });

  it('undefined-required-field — a required field absent from properties fires', () => {
    const result = runPair(
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'missing'] },
      { a: 'x' },
    );
    expect(fires(result, 'undefined-required-field')).toBe(true);
  });

  it('invalid-type — a schema type outside the allowed set fires', () => {
    // `date` is not in the default allowedJsonTypes list.
    const result = runPair({ type: 'date' }, {});
    expect(fires(result, 'invalid-type')).toBe(true);
  });

  it('invalid-range — minimum > maximum fires', () => {
    const result = runPair({ type: 'integer', minimum: 10, maximum: 5 }, 7);
    expect(fires(result, 'invalid-range')).toBe(true);
  });

  it('type-mismatch — data of the wrong type fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { age: { type: 'string' } }, required: ['age'] },
      { age: 30 },
    );
    expect(fires(result, 'type-mismatch')).toBe(true);
  });

  it('string-too-short — a string under minLength fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { name: { type: 'string', minLength: 5 } }, required: ['name'] },
      { name: 'abc' },
    );
    expect(fires(result, 'string-too-short')).toBe(true);
  });

  it('string-too-long — a string over maxLength fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { name: { type: 'string', maxLength: 3 } }, required: ['name'] },
      { name: 'abcdef' },
    );
    expect(fires(result, 'string-too-long')).toBe(true);
  });

  it('pattern-mismatch — a string not matching the pattern fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { code: { type: 'string', pattern: '^\\d+$' } }, required: ['code'] },
      { code: 'abc' },
    );
    expect(fires(result, 'pattern-mismatch')).toBe(true);
  });

  it('below-minimum — a number under minimum fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { n: { type: 'number', minimum: 10 } }, required: ['n'] },
      { n: 5 },
    );
    expect(fires(result, 'below-minimum')).toBe(true);
  });

  it('above-maximum — a number over maximum fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { n: { type: 'number', maximum: 10 } }, required: ['n'] },
      { n: 15 },
    );
    expect(fires(result, 'above-maximum')).toBe(true);
  });

  it('too-few-items — an array under minItems fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { tags: { type: 'array', minItems: 3 } }, required: ['tags'] },
      { tags: [1] },
    );
    expect(fires(result, 'too-few-items')).toBe(true);
  });

  it('too-many-items — an array over maxItems fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { tags: { type: 'array', maxItems: 2 } }, required: ['tags'] },
      { tags: [1, 2, 3] },
    );
    expect(fires(result, 'too-many-items')).toBe(true);
  });

  it('missing-required-field — an object missing a required field fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      {},
    );
    expect(fires(result, 'missing-required-field')).toBe(true);
  });

  it('unexpected-property — an extra key under additionalProperties:false fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      { a: 'x', b: 'y' },
    );
    expect(fires(result, 'unexpected-property')).toBe(true);
  });

  it('enum-mismatch — a value outside the enum fires', () => {
    const result = runPair(
      { $schema: DRAFT07, type: 'object', properties: { color: { enum: ['red', 'blue'] } }, required: ['color'] },
      { color: 'green' },
    );
    expect(fires(result, 'enum-mismatch')).toBe(true);
  });
});
