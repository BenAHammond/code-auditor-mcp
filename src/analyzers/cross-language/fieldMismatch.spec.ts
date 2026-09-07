/**
 * Spec 49 Session 20 — `schema-field-mismatch` (row 76).
 *
 * The ledger gap: the rule compares type-name strings via a tiny hardcoded
 * primitive map with a raw string-equality fallback — any unmapped or
 * non-primitive type is judged by exact spelling. A Go `[]User` and a TS
 * `User[]` are the same logical type, but the raw fallback reads `[]User !==
 * User[]` and fires; a Go `*string` (nullable) and a TS `string` fire the same
 * way; and a Go `uint64` vs a TS `number` fires because `uint64` is absent from
 * the map.
 *
 * These three tests pin the structural normalizer that replaces the proxy:
 *   - positive: a genuine primitive mismatch (string vs integer) still fires.
 *   - near-miss (container): Go `[]User` vs TS `User[]` are the same list type.
 *   - near-miss (pointer/nullability): Go `*string` vs TS `string` are the same
 *     type (the pointer is nullability, not a distinct type).
 */

import { describe, it, expect } from 'vitest';
import { SchemaValidator } from './SchemaValidator.js';
import type { SchemaDefinition } from './SchemaValidator.js';

function field(name: string, type: string): { name: string; type: string; required: boolean } {
  return { name, type, required: true };
}

/**
 * Build a cross-language schema pair sharing a single field `f`, so the only
 * possible finding is `schema-field-mismatch` (or none, when the types align).
 */
function typeMismatchRules(refType: string, curType: string): Promise<string[]> {
  const ref: SchemaDefinition = {
    id: 'ref:Thing',
    name: 'Thing',
    type: 'typescript-interface',
    language: 'typescript',
    file: 'src/models/thing.ts',
    line: 1,
    fields: [field('f', refType)],
  };
  const cur: SchemaDefinition = {
    id: 'cur:Thing',
    name: 'Thing',
    type: 'go-struct',
    language: 'go',
    file: 'internal/models/thing.go',
    line: 1,
    fields: [field('f', curType)],
  };
  return new SchemaValidator().validateSchemas([ref, cur]).then(vs =>
    vs.filter(v => v.rule === 'schema-field-mismatch').map(v => v.rule),
  );
}

describe('schema-field-mismatch (structural type normalization)', () => {
  it('positive — a genuine primitive mismatch (string vs integer) fires', async () => {
    expect(await typeMismatchRules('string', 'int64')).toContain('schema-field-mismatch');
  });

  it('near-miss (container) — Go `[]User` and TS `User[]` are the same list type', async () => {
    expect(await typeMismatchRules('User[]', '[]User')).not.toContain('schema-field-mismatch');
  });

  it('near-miss (pointer/nullability) — Go `*string` and TS `string` are the same type', async () => {
    expect(await typeMismatchRules('string', '*string')).not.toContain('schema-field-mismatch');
  });

  it('near-miss (primitive alias) — a numeric Go alias unmapped by the old table matches number', async () => {
    // `uint64` was absent from the old Go primitive map, so it fell through to
    // raw spelling and fired as a false positive against TS `number`.
    expect(await typeMismatchRules('number', 'uint64')).not.toContain('schema-field-mismatch');
  });
});
