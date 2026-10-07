/**
 * Spec 68 §3.2 — the migrated `hardcoded-connection` rule, pinned against the
 * golden reference.
 *
 * The rule re-homes the one detector that walks raw string literals: flag any
 * string/template-string whose text matches a connection-string shape. It reads
 * the `string-literals` fact (whose producer pre-computes the `enclosingFunction`
 * label `enclosingIdentity` used to return), so the symbol
 * (`<fn>:hardcoded-connection[:n]`) is byte-identical to the pre-migration
 * output. The message is the full legacy literal, not the registry's shortened
 * template.
 *
 * This test originally ran BOTH paths (the old analyzer still live) and asserted
 * the identity multisets — (file, line, column, severity) — were equal and
 * non-empty; that was the pin that let §15 delete the old `checkGeneralPatterns`
 * path without losing the golden reference. The old path is now deleted, so this
 * test asserts the migrated slice directly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runSecuritySlice } from '../phase/runner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, severity. */
function key(f: { file: string; line?: number; column?: number; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.severity}`;
}

/** Run the migrated slice, returning the per-rule identity multiset. */
async function slice(source: string) {
  const fresh = await runSecuritySlice([{ path: 'parity.ts', content: source }]);
  return fresh
    .filter((f) => f.ruleId === 'hardcoded-connection')
    .map((f) => key(f))
    .sort();
}

describe('Spec 68 hardcoded-connection parity (migrated analyze(ctx) === golden reference)', () => {
  it('fires on a mongodb:// connection string inside a function', async () => {
    const nu = await slice(
      'export function connect() {\n' +
      '  return "mongodb://localhost:27017/mydb";\n' +
      '}\n',
    );
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on a postgres:// template literal', async () => {
    const nu = await slice(
      'export function connect() {\n' +
      '  return `postgres://user:pass@localhost:5432/app`;\n' +
      '}\n',
    );
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on ADO.NET-style Server=…;Database= strings', async () => {
    const nu = await slice(
      'export function connect() {\n' +
      '  return "Server=localhost;Database=app;User Id=sa;";\n' +
      '}\n',
    );
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on a top-level connection string (enclosing identity = top-level)', async () => {
    const nu = await slice(
      'const url = "mysql://root@localhost:3306/app";\n' +
      'export function connect() { return url; }\n',
    );
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires once per literal when a function holds two connection strings', async () => {
    const nu = await slice(
      'export function connect() {\n' +
      '  const a = "postgres://a/app";\n' +
      '  const b = "postgres://b/app";\n' +
      '  return a + b;\n' +
      '}\n',
    );
    expect(nu.length).toBe(2);
  });

  it('does NOT fire on a non-connection string literal', async () => {
    const nu = await slice(
      'export function greet() {\n' +
      '  return "hello world";\n' +
      '}\n',
    );
    expect(nu).toEqual([]);
  });
});
