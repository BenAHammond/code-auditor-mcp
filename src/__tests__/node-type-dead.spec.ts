/**
 * Red tests for the dead node-type literals found by the systemic node-type
 * audit (docs/node-type-audit.md, Tier A).
 *
 * Each Tier A entry is a string literal compared against a raw tree-sitter
 * `.type` that is NOT in any shipped grammar's `node-types.json`, so the guarded
 * branch never fires. Each test below asserts the construct the dead branch was
 * supposed to see — and is currently RED, pinning the defect so it cannot be
 * fixed silently or lost.
 *
 * Fix order (Ben): one failing test per Tier A entry, committed red, then made
 * green by replacing the dead literal with the grammar's actual node type.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { parseFile, findNodes } from '../languages/adapterBridge.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import type { ASTNode } from '../languages/types.js';
import { isClassType, isFunctionType } from '../languages/tree-sitter/converter.js';
import { getExports, getReExports, extractIdentifierUsage } from '../utils/astUtils.js';
import { extractFunctionsFromSource } from '../functionScanner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function parseSrc(filePath: string, source: string) {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(filePath);
  if (!adapter) throw new Error(`no adapter for ${filePath}`);
  const ast = parseFile(filePath, source);
  if (!ast) throw new Error(`parse failed for ${filePath}`);
  return { adapter, ast, src: source };
}

function firstOfType(filePath: string, source: string, type: string): ASTNode {
  const { ast } = parseSrc(filePath, source);
  const nodes = findNodes(ast.root, (n) => n.type === type);
  if (!nodes.length) throw new Error(`no ${type} node in ${filePath}`);
  return nodes[0];
}

describe('node-type audit — dead literals (red)', () => {
  // ── Go interface methods (method_spec → method_elem) ───────────────────────

  it('Go interface methods are extracted', () => {
    const { adapter, ast } = parseSrc(
      '/f.go',
      'package p\ntype I interface {\n\tM(x int) string\n}'
    );
    const interfaces = adapter.extractInterfaces?.(ast) ?? [];
    const methods = interfaces[0]?.members.filter((m) => m.type === 'method') ?? [];
    expect(methods.map((m) => m.name)).toEqual(['M']);
  });

  // ── Go switch cases (expression_case_clause → expression_case) ─────────────

  it('Go expression-switch case clauses count toward complexity', () => {
    const src = [
      'package p',
      'func f(x int) int {',
      '\tswitch x {',
      '\tcase 1:',
      '\t\treturn 1',
      '\tcase 2:',
      '\t\treturn 2',
      '\tdefault:',
      '\t\treturn 0',
      '\t}',
      '}',
    ].join('\n');
    const { adapter } = parseSrc('/f.go', src);
    const sw = firstOfType('/f.go', src, 'expression_switch_statement');
    expect(adapter.getComplexity(sw)).toBe(4);
  });

  it('Go type-switch case clauses count toward complexity', () => {
    const src = 'package p\nfunc f(x any) {\n\tswitch x.(type) {\n\tcase int:\n\t\tprintln("i")\n\tcase string:\n\t\tprintln("s")\n\t}\n}';
    const { adapter } = parseSrc('/f.go', src);
    const sw = firstOfType('/f.go', src, 'type_switch_statement');
    expect(adapter.getComplexity(sw)).toBe(3);
  });

  // ── Named exports (named_exports → export_clause children) ─────────────────

  it('getExports returns every named export', () => {
    const src = 'export { a, b };';
    const { ast } = parseSrc('/f.ts', src);
    const names = getExports(ast.root, src).filter((e) => !e.isDefault).map((e) => e.name);
    expect(names).toEqual(['a', 'b']);
  });

  it('getReExports returns every named re-export', () => {
    const src = "export { a, b } from './mod';";
    const { ast } = parseSrc('/f.ts', src);
    expect(getReExports(ast.root, src)).toEqual([
      { name: 'a', module: './mod' },
      { name: 'b', module: './mod' },
    ]);
  });

  // ── JSX element names (open_tag → jsx_opening_element) ─────────────────────

  it('non-self-closing JSX element names are extracted', () => {
    const funcs = extractFunctionsFromSource(
      'import React from "react";\nexport function App() { return <Foo>hi</Foo>; }',
      '/f.tsx'
    );
    const app = funcs.find((f) => f.name === 'App');
    expect(app?.metadata?.jsxElements).toContain('Foo');
  });

  // ── extends heritage (heritage_clause → extends_type_clause) ────────────────

  it('an identifier qualifying an interface `extends` base is type-only', () => {
    const src = 'import { ns } from "./x";\ninterface X extends ns.Base {}';
    const { ast } = parseSrc('/f.ts', src);
    const usage = extractIdentifierUsage(ast.root, src, new Set(['ns']));
    expect(usage.get('ns')?.usageType).toBe('type');
  });

  // ── typeof X (typeof_expression → type_query) ──────────────────────────────

  it('`typeof X` marks X as a type-only usage', () => {
    const src = 'import { A } from "./x";\ntype T = typeof A;';
    const { ast } = parseSrc('/f.ts', src);
    const usage = extractIdentifierUsage(ast.root, src, new Set(['A']));
    expect(usage.get('A')?.usageType).toBe('type');
  });

  // ── ns.Type (qualified_name → nested_type_identifier) ──────────────────────

  it('`ns.Type` marks ns as a type-only usage', () => {
    const src = 'import { ns } from "./x";\ntype T = ns.Type;';
    const { ast } = parseSrc('/f.ts', src);
    const usage = extractIdentifierUsage(ast.root, src, new Set(['ns']));
    expect(usage.get('ns')?.usageType).toBe('type');
  });

  // ── Anonymous class expression (class_expression → class) ──────────────────

  it('anonymous class expressions classify as class-like', () => {
    expect(isClassType('class')).toBe(true);
  });

  // ── Generator expression (generator_function_expression → generator_function)

  it('generator function expressions classify as function-like', () => {
    expect(isFunctionType('generator_function')).toBe(true);
  });
});
