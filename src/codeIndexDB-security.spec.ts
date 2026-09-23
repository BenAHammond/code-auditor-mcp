import { describe, it, expect } from 'vitest';
import { assertSqlIdentifier, escapeRegExpLiteral } from './codeIndexDB.js';

describe('assertSqlIdentifier (Spec 61 R5.8)', () => {
  it('accepts a plain SQL identifier', () => {
    expect(() => assertSqlIdentifier('functions_2024', 'table name')).not.toThrow();
  });

  it('rejects a hostile table identifier', () => {
    expect(() =>
      assertSqlIdentifier('functions; DROP TABLE users; --', 'table name')
    ).toThrow(/invalid SQL identifier in table name/);
  });

  it('rejects an identifier with whitespace or quotes', () => {
    expect(() => assertSqlIdentifier('foo bar', 'column name')).toThrow(
      /invalid SQL identifier/
    );
    expect(() => assertSqlIdentifier('foo"bar', 'column name')).toThrow(
      /invalid SQL identifier/
    );
  });
});

describe('escapeRegExpLiteral (Spec 61 R5.8)', () => {
  it('escapes every regex metacharacter so it matches literally', () => {
    // `[0-9]` must not become a character class; `.` must not become "any char".
    expect(escapeRegExpLiteral('foo[0-9].ts')).toBe('foo\\[0-9\\]\\.ts');
  });

  it('escapes a full metacharacter set', () => {
    const metachars = '.*+?^${}()|[]\\';
    const escaped = escapeRegExpLiteral(metachars);
    // A regex built from the escaped string matches the literal metachar string,
    // not any of its metachar meanings.
    expect(new RegExp(escaped).test(metachars)).toBe(true);
    expect(new RegExp(escaped).test('x')).toBe(false);
  });

  it('leaves non-metacharacter characters unchanged', () => {
    // Slashes, alphanumerics, and `-`/`_` are not regex metacharacters.
    expect(escapeRegExpLiteral('src/utils/parser-2024_v2')).toBe(
      'src/utils/parser-2024_v2'
    );
  });
});
