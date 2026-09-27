/**
 * Spec 68 §3.2 — parity: the migrated `hardcoded-connection` rule reproduces
 * the old `UniversalDataAccessAnalyzer.checkGeneralPatterns` findings exactly.
 *
 * The rule re-homes the one detector that walks raw string literals: flag any
 * string/template-string whose text matches a connection-string shape. It reads
 * the `string-literals` fact (whose producer pre-computes the `enclosingFunction`
 * label `enclosingIdentity` used to return), so the symbol
 * (`<fn>:hardcoded-connection[:n]`) is byte-identical to the pre-migration
 * output. The message is the full legacy literal, not the registry's shortened
 * template.
 *
 * This test runs BOTH paths (the old analyzer still live) and asserts the
 * identity multisets — (file, line, column, severity) — are equal and non-empty.
 * It is the pin that lets §15 delete the old `checkGeneralPatterns` path without
 * losing the golden reference.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import {
  UniversalDataAccessAnalyzer,
  DEFAULT_DATA_ACCESS_CONFIG,
} from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { runSecuritySlice } from '../phase/runner.js';

let adapter: LanguageAdapter;
let analyzer: UniversalDataAccessAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDataAccessAnalyzer();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, severity. */
function key(f: { file: string; line?: number; column?: number; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.severity}`;
}

/** Run the old analyzer and the new slice, return the per-rule identity multisets. */
async function parity(source: string) {
  const ast = parseFile('parity.ts', source);
  expect(ast, `fixture failed to parse`).not.toBeNull();
  const { violations } = await analyzer.analyzeWithFacts(ast!, adapter, DEFAULT_DATA_ACCESS_CONFIG, source);
  const old = violations
    .filter((v) => v.rule === 'hardcoded-connection')
    .map((v) => key(v))
    .sort();

  const fresh = await runSecuritySlice([{ path: 'parity.ts', content: source }]);
  const nu = fresh
    .filter((f) => f.ruleId === 'hardcoded-connection')
    .map((f) => key(f))
    .sort();

  return { old, nu };
}

describe('Spec 68 hardcoded-connection parity (new analyze(ctx) === old checkGeneralPatterns)', () => {
  it('fires on a mongodb:// connection string inside a function', async () => {
    const { old, nu } = await parity(
      'export function connect() {\n' +
      '  return "mongodb://localhost:27017/mydb";\n' +
      '}\n',
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on a postgres:// template literal', async () => {
    const { old, nu } = await parity(
      'export function connect() {\n' +
      '  return `postgres://user:pass@localhost:5432/app`;\n' +
      '}\n',
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on ADO.NET-style Server=…;Database= strings', async () => {
    const { old, nu } = await parity(
      'export function connect() {\n' +
      '  return "Server=localhost;Database=app;User Id=sa;";\n' +
      '}\n',
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires on a top-level connection string (enclosing identity = top-level)', async () => {
    const { old, nu } = await parity(
      'const url = "mysql://root@localhost:3306/app";\n' +
      'export function connect() { return url; }\n',
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('fires once per literal when a function holds two connection strings', async () => {
    const { old, nu } = await parity(
      'export function connect() {\n' +
      '  const a = "postgres://a/app";\n' +
      '  const b = "postgres://b/app";\n' +
      '  return a + b;\n' +
      '}\n',
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBe(2);
  });

  it('does NOT fire on a non-connection string literal', async () => {
    const { old, nu } = await parity(
      'export function greet() {\n' +
      '  return "hello world";\n' +
      '}\n',
    );
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });
});
