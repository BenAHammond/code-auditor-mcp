import { describe, it, expect } from 'vitest';
import { SchemaValidator, countCrossLanguagePairs, isGoValueType } from './SchemaValidator.js';
import type { SchemaDefinition } from './SchemaValidator.js';

function tsInterface(overrides: Partial<SchemaDefinition> = {}): SchemaDefinition {
  return {
    id: 'ts:User',
    name: 'User',
    type: 'typescript-interface',
    language: 'typescript',
    file: 'src/models/user.ts',
    line: 1,
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'email', type: 'string', required: true },
    ],
    ...overrides,
  };
}

function goStruct(overrides: Partial<SchemaDefinition> = {}): SchemaDefinition {
  return {
    id: 'go:User',
    name: 'User',
    type: 'go-struct',
    language: 'go',
    file: 'internal/models/user.go',
    line: 1,
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'username', type: 'string', required: true },
    ],
    ...overrides,
  };
}

describe('SchemaValidator (cross-language pairs)', () => {
  it('flags missing/extra fields across a TS interface and Go struct', async () => {
    const validator = new SchemaValidator();
    const violations = await validator.validateSchemas([tsInterface(), goStruct()]);

    const missing = violations.filter(v => v.rule === 'missing-field');
    const extra = violations.filter(v => v.rule === 'extra-field');

    // `email` is required in the TS reference but absent from the Go struct.
    expect(missing.some(v => v.fieldName === 'email')).toBe(true);
    // `username` exists only in the Go struct.
    expect(extra.some(v => v.fieldName === 'username')).toBe(true);
  });

  it('emits nothing when a cross-language pair aligns', async () => {
    const validator = new SchemaValidator();
    const alignedGo = goStruct({
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'email', type: 'string', required: true },
      ],
    });

    const violations = await validator.validateSchemas([tsInterface(), alignedGo]);
    expect(violations).toHaveLength(0);
  });

  it('emits nothing for a single-language corpus (no cross-language pair)', async () => {
    const validator = new SchemaValidator();
    const otherTs = tsInterface({ id: 'ts:Other', name: 'Other' });

    const violations = await validator.validateSchemas([tsInterface(), otherTs]);
    expect(violations).toHaveLength(0);
  });
});

describe('isGoValueType — required = non-nilable value type (pointer-vs-value, not exportedness)', () => {
  it('treats value types as required', () => {
    expect(isGoValueType('string')).toBe(true);
    expect(isGoValueType('int64')).toBe(true);
    expect(isGoValueType('bool')).toBe(true);
    expect(isGoValueType('time.Time')).toBe(true);
    expect(isGoValueType('[4]byte')).toBe(true);
  });

  it('treats nilable reference types as optional', () => {
    expect(isGoValueType('*string')).toBe(false);
    expect(isGoValueType('[]string')).toBe(false);
    expect(isGoValueType('map[string]int')).toBe(false);
    expect(isGoValueType('chan int')).toBe(false);
    expect(isGoValueType('func()')).toBe(false);
    expect(isGoValueType('interface{}')).toBe(false);
    expect(isGoValueType('any')).toBe(false);
    expect(isGoValueType('error')).toBe(false);
  });

  it('treats an absent type as optional (unknown, cannot prove presence)', () => {
    expect(isGoValueType(undefined)).toBe(false);
    expect(isGoValueType('')).toBe(false);
  });
});

describe('countCrossLanguagePairs', () => {
  it('is zero for a single-language corpus', () => {
    expect(countCrossLanguagePairs([tsInterface(), tsInterface({ id: 'ts:Other', name: 'Other' })])).toBe(0);
  });

  it('counts one comparison per additional language in a group', () => {
    // TS (reference) + Go → one comparison; + Python → two.
    const pyUser = goStruct({ id: 'py:User', language: 'python', type: 'json-schema' });
    expect(countCrossLanguagePairs([tsInterface(), goStruct()])).toBe(1);
    expect(countCrossLanguagePairs([tsInterface(), goStruct(), pyUser])).toBe(2);
  });

  it('is zero when there are no schemas', () => {
    expect(countCrossLanguagePairs([])).toBe(0);
  });
});
