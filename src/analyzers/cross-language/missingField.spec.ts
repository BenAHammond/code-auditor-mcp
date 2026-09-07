/**
 * Spec 49 Session 21 — `missing-field` (row 77).
 *
 * The ledger gap: "Missing required field" asserted requiredness, but for Go
 * `required` was proxied by `isExported` (capitalization = publicness, not
 * requiredness). An exported nilable field (`Email *string`) was marked required
 * — a false "missing field" when the other language legitimately omits it — and
 * an unexported value field (`id int`) was marked optional, so a genuinely
 * required field's absence was missed.
 *
 * The fix — Go requiredness = non-nilable value type via `isGoValueType` — was
 * already applied in spec-44 (commit `a60f655`), and `isGoValueType` has its own
 * unit suite. These tests close the remaining gap: they tie that helper to the
 * `missing-field` emission end-to-end through `extractSchemas` →
 * `validateSchemas`, which the helper suite does not.
 *
 *   - positive: a required value-type field (`ID int`) absent from the other
 *     language fires.
 *   - near-miss: a nilable reference field (`Email *string`) absent does NOT fire
 *     (the old `isExported` proxy's false positive).
 *   - inverse near-miss: an unexported value-type field (`id int`) absent DOES
 *     fire (the old `isExported` proxy's false negative — it treated unexported
 *     as optional).
 */

import { describe, it, expect } from 'vitest';
import { SchemaValidator, extractSchemas } from './SchemaValidator.js';
import type { CrossLanguageEntity } from '../../types/crossLanguage.js';

function goStruct(name: string, fields: Array<{ name: string; type: string }>): CrossLanguageEntity {
  return {
    id: `go:${name}`,
    name,
    language: 'go',
    type: 'struct',
    file: `internal/${name.toLowerCase()}.go`,
    signature: '',
    parameters: [],
    calls: [],
    calledBy: [],
    searchTokens: [],
    purpose: '',
    context: '',
    metadata: { fields },
  } as CrossLanguageEntity;
}

function tsInterface(name: string): CrossLanguageEntity {
  return {
    id: `ts:${name}`,
    name,
    language: 'typescript',
    type: 'interface',
    file: `src/${name.toLowerCase()}.ts`,
    signature: '',
    parameters: [],
    calls: [],
    calledBy: [],
    searchTokens: [],
    purpose: '',
    context: '',
  } as CrossLanguageEntity;
}

/** Field names that `missing-field` reports for a Go-reference/TS-current pair. */
async function missingFields(goFields: Array<{ name: string; type: string }>): Promise<string[]> {
  const schemas = extractSchemas([goStruct('Thing', goFields), tsInterface('Thing')]);
  const violations = await new SchemaValidator().validateSchemas(schemas);
  return violations.filter(v => v.rule === 'missing-field').map(v => v.fieldName!);
}

describe('missing-field (Go required = non-nilable value type)', () => {
  it('positive — a required value-type field absent from the other language fires', async () => {
    expect(await missingFields([{ name: 'ID', type: 'int' }])).toContain('ID');
  });

  it('near-miss — a nilable reference field absent does NOT fire (not required)', async () => {
    expect(await missingFields([{ name: 'Email', type: '*string' }])).not.toContain('Email');
  });

  it('inverse near-miss — an unexported value-type field absent DOES fire (is required)', async () => {
    expect(await missingFields([{ name: 'id', type: 'int' }])).toContain('id');
  });
});
