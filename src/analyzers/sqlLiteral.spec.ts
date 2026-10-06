import { describe, it, expect } from 'vitest';
import { stripSqlQuotes } from './sqlLiteral.js';

describe('stripSqlQuotes', () => {
  it('strips the surrounding quote without altering plain content', () => {
    expect(stripSqlQuotes(`'SELECT 1'`)).toBe('SELECT 1');
    expect(stripSqlQuotes(`"SELECT 1"`)).toBe('SELECT 1');
    expect(stripSqlQuotes('`SELECT 1`')).toBe('SELECT 1');
  });

  it('un-escapes an embedded single quote (the named defect)', () => {
    expect(stripSqlQuotes(`'SELECT * FROM t WHERE name = \\'Bob\\''`)).toBe(
      "SELECT * FROM t WHERE name = 'Bob'",
    );
  });

  it('un-escapes an embedded double quote and backtick', () => {
    expect(stripSqlQuotes(`"SELECT \\"a\\" FROM t"`)).toBe('SELECT "a" FROM t');
    expect(stripSqlQuotes('`SELECT `x` FROM t`')).toBe('SELECT `x` FROM t');
  });

  it('un-escapes a doubled backslash to a literal backslash', () => {
    expect(stripSqlQuotes(`'SELECT * FROM t WHERE path LIKE \\'C:\\\\tmp%\\''`)).toBe(
      "SELECT * FROM t WHERE path LIKE 'C:\\tmp%'",
    );
  });

  it('un-escapes C-style control escapes', () => {
    expect(stripSqlQuotes(`'SELECT\\n *\\nFROM t'`)).toBe('SELECT\n *\nFROM t');
    expect(stripSqlQuotes(`'a\\tb'`)).toBe('a\tb');
  });

  it('un-escapes hex and unicode escapes', () => {
    expect(stripSqlQuotes(`'\\x41'`)).toBe('A');
    expect(stripSqlQuotes(`'\\u0041'`)).toBe('A');
    expect(stripSqlQuotes(`'\\u{41}'`)).toBe('A');
  });

  it('preserves an unrecognized escape verbatim (no silent backslash drop)', () => {
    expect(stripSqlQuotes(`'\\d+'`)).toBe('\\d+');
  });

  it('does not un-escape a raw string literal (Go backtick)', () => {
    expect(stripSqlQuotes('`SELECT * FROM t WHERE path LIKE \'C:\\tmp%\'`', { raw: true })).toBe(
      "SELECT * FROM t WHERE path LIKE 'C:\\tmp%'",
    );
  });

  it('returns non-literal text unchanged', () => {
    expect(stripSqlQuotes('abc')).toBe('abc');
    expect(stripSqlQuotes("'")).toBe("'");
  });
});
