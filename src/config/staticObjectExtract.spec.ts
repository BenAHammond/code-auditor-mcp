/**
 * Spec 61 R3.1 — `extractModuleExport` (acceptance criterion 8: one test per
 * export/expression form in the R3.1 table, plus one per unresolved reason).
 *
 * The extractor's contract is "read a project config without executing it": it
 * parses the file with tree-sitter and reduces only the *literal* export to a
 * plain value. Anything it cannot prove is a literal is an unresolved
 * first-class result (never an exception), which the caller surfaces as a
 * `cannot-fire` coverage diagnostic.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractModuleExport } from './staticObjectExtract.js';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

describe('extractModuleExport — export forms (R3.1 table)', () => {
  it('`export default <expr>` evaluates the expression', () => {
    const r = extractModuleExport('cfg.ts', 'export default { a: 1 };');
    expect(r).toEqual({ resolved: true, value: { a: 1 } });
  });

  it('`module.exports = <expr>` (CommonJS) evaluates the expression', () => {
    const r = extractModuleExport('cfg.cjs', 'module.exports = { b: 2 };');
    expect(r).toEqual({ resolved: true, value: { b: 2 } });
  });

  it('`export default <ident>` resolves a same-file const initializer', () => {
    const r = extractModuleExport('cfg.ts', 'const cfg = { c: 3 };\nexport default cfg;');
    expect(r).toEqual({ resolved: true, value: { c: 3 } });
  });

  it('`export const config = <expr>` evaluates the declarator initializer', () => {
    const r = extractModuleExport('cfg.ts', 'export const config = { d: 4 };');
    expect(r).toEqual({ resolved: true, value: { d: 4 } });
  });
});

describe('extractModuleExport — expression forms', () => {
  it('nested object and array literals', () => {
    const r = extractModuleExport(
      'cfg.ts',
      'export default { arr: [1, 2, { x: "y" }], nested: { deep: [true, null] } };',
    );
    expect(r).toEqual({
      resolved: true,
      value: { arr: [1, 2, { x: 'y' }], nested: { deep: [true, null] } },
    });
  });

  it('primitives — string, number, boolean, null', () => {
    expect(extractModuleExport('cfg.ts', 'export default "s";')).toEqual({ resolved: true, value: 's' });
    expect(extractModuleExport('cfg.ts', 'export default 42;')).toEqual({ resolved: true, value: 42 });
    expect(extractModuleExport('cfg.ts', 'export default true;')).toEqual({ resolved: true, value: true });
    expect(extractModuleExport('cfg.ts', 'export default null;')).toEqual({ resolved: true, value: null });
  });

  it('template literal with no substitutions', () => {
    expect(extractModuleExport('cfg.ts', 'export default `hello`;')).toEqual({ resolved: true, value: 'hello' });
  });

  it('identifier reference to a same-file const', () => {
    const r = extractModuleExport('cfg.ts', 'const base = { n: 1 };\nexport default { ...base, m: 2 };');
    expect(r).toEqual({ resolved: true, value: { n: 1, m: 2 } });
  });

  it('object spread of an identifier that evaluates', () => {
    const r = extractModuleExport('cfg.ts', 'const colors = { blue: "#00f" };\nexport default { colors, spacing: { 0: "0px" } };');
    expect(r).toEqual({ resolved: true, value: { colors: { blue: '#00f' }, spacing: { 0: '0px' } } });
  });
});

describe('extractModuleExport — unresolved reasons', () => {
  it('call-expression — a call cannot be reduced to a literal', () => {
    const r = extractModuleExport('cfg.ts', 'export default makeConfig();');
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toBe('call-expression');
  });

  it('call-expression — require() is a call, never evaluated', () => {
    const r = extractModuleExport('cfg.cjs', 'module.exports = require("./x");');
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toBe('call-expression');
  });

  it('imported-spread — an identifier not declared as a const in this file', () => {
    const r = extractModuleExport('cfg.ts', 'import { base } from "./x";\nexport default { ...base };');
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toBe('imported-spread');
  });

  it('computed-key — a computed property name is not a literal key', () => {
    const r = extractModuleExport('cfg.ts', 'export default { [key]: 1 };');
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toBe('computed-key');
  });

  it('function-value — an arrow/function export is a factory, never invoked', () => {
    const r = extractModuleExport('cfg.cjs', 'module.exports = () => ({ rules: {} });');
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toBe('function-value');
  });

  it('template-substitution — an interpolated template is not a constant', () => {
    const r = extractModuleExport('cfg.ts', 'export default `x${y}`;');
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toBe('template-substitution');
  });

  it('dynamic-export — no recognized export form', () => {
    const r = extractModuleExport('cfg.ts', 'const x = 1;');
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toBe('dynamic-export');
  });

  it('parse-error — invalid source', () => {
    const r = extractModuleExport('cfg.ts', 'export default {{{;');
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toBe('parse-error');
  });
});

describe('extractModuleExport — grammar mapping (R3.1)', () => {
  it('.cjs and .mjs map to the TypeScript grammar and parse', () => {
    const cjs = LanguageRegistry.getInstance().getAdapterForFile('cfg.cjs');
    const mjs = LanguageRegistry.getInstance().getAdapterForFile('cfg.mjs');
    expect(cjs).toBeDefined();
    expect(mjs).toBeDefined();

    expect(extractModuleExport('cfg.cjs', 'module.exports = { a: 1 };')).toEqual({ resolved: true, value: { a: 1 } });
    expect(extractModuleExport('cfg.mjs', 'export default { b: 2 };')).toEqual({ resolved: true, value: { b: 2 } });
  });
});
