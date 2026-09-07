/**
 * Spec 49 Session 17 — `invalid-format` (row 63).
 *
 * The ledger gap: `invalid-format` claims "invalid format for field X" but only
 * `email` and `uuid` are implemented via lightweight regexes; every other
 * JSON-Schema format (date, date-time, uri, ipv4/6, hostname, …) is silently
 * ignored.
 *
 * These tests pin the behaviour through the public entry point
 * `analyzeJsonSchemas` before the format registry is built. They are the three
 * TDD kinds:
 *   - positive: a genuinely invalid `email` must fire.
 *   - inverse near-miss: a genuinely invalid `date` must fire (the old proxy
 *     silently ignores every format except email/uuid).
 *   - near-miss: a valid leap-year date must NOT fire — proving the new date
 *     validator is calendar-aware, not a `\d{4}-\d{2}-\d{2}` shape regex (a
 *     shape regex would also accept the impossible 2023-02-29, which the
 *     contrast assertion requires to fire).
 */

import { describe, it, expect } from 'vitest';
import { analyzeJsonSchemas } from './jsonSchema.js';
import type { AnalyzerResult } from '../../../types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const SCHEMA_PATH = '/t/user.schema.json';
const DATA_PATH = '/t/user.data.json';

function analyzeFormat(format: string, value: string): AnalyzerResult {
  const files = [SCHEMA_PATH, DATA_PATH];
  const readJson = (fp: string): object | null => {
    if (fp === SCHEMA_PATH) {
      return {
        type: 'object',
        properties: { field: { type: 'string', format } },
        required: ['field'],
      };
    }
    if (fp === DATA_PATH) {
      return { field: value };
    }
    return null;
  };
  return analyzeJsonSchemas(files, readJson, {
    schemaDataPairs: [{ schema: SCHEMA_PATH, data: DATA_PATH }],
  });
}

function hasInvalidFormat(result: AnalyzerResult): boolean {
  return result.violations.some(v => v.rule === 'invalid-format');
}

// ── The three tests ─────────────────────────────────────────────────────────

describe('invalid-format (format registry)', () => {
  it('positive — a genuinely invalid email fires', () => {
    expect(hasInvalidFormat(analyzeFormat('email', 'definitely-not-an-email'))).toBe(true);
  });

  it('inverse near-miss — a genuinely invalid date fires (old proxy ignored date)', () => {
    expect(hasInvalidFormat(analyzeFormat('date', 'not-a-date'))).toBe(true);
  });

  it('near-miss — a valid leap-year date does NOT fire (calendar-aware, not shape-only)', () => {
    expect(hasInvalidFormat(analyzeFormat('date', '2024-02-29'))).toBe(false);
    // Contrast: an impossible calendar date with the same shape must fire.
    expect(hasInvalidFormat(analyzeFormat('date', '2023-02-29'))).toBe(true);
  });
});
