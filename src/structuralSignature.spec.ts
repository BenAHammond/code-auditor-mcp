/**
 * Spec 57 — structural signature fix contract.
 *
 *   - **positive** — a node's signature is its grammar-kind shape; a function
 *     containing a for-loop carries `for_in_statement`/`call_expression`.
 *   - **near-miss** — structurally identical code modulo identifiers/literals
 *     yields the *same* signature; structurally different code yields different.
 *   - **guard** (acceptance 4) — a snippet containing a secret, a table name,
 *     and a distinctive identifier produces a signature containing NONE of them.
 *   - **absence** — a location outside the tree yields null.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from './languages/index.js';
import { parseFile } from './languages/adapterBridge.js';
import type { AST } from './languages/types.js';
import { structuralSignature, signatureForLocation } from './structuralSignature.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

function parse(code: string): AST {
  const ast = parseFile('test.ts', code)!;
  if (!ast) throw new Error('failed to parse');
  return ast;
}

describe('structuralSignature', () => {
  it('positive — emits grammar kinds, not content, and is deterministic', () => {
    const ast = parse(`export function handler(req) { for (const x of req.items) { x.save(); } }`);
    const sig = structuralSignature(ast.root, { maxDepth: 12, maxNodes: 200 });
    expect(sig).toContain('function_declaration');
    expect(sig).toContain('for_in_statement');
    expect(sig).toContain('call_expression');
    // Deterministic: same tree → same signature.
    expect(structuralSignature(ast.root, { maxDepth: 12, maxNodes: 200 })).toBe(sig);
  });

  it('near-miss — structurally identical code modulo identifiers yields the same signature', () => {
    const a = structuralSignature(
      parse(`function a() { for (const x of items) { x.save(); } }`).root,
      { maxDepth: 12, maxNodes: 200 },
    );
    const b = structuralSignature(
      parse(`function b() { for (const y of rows) { y.delete(); } }`).root,
      { maxDepth: 12, maxNodes: 200 },
    );
    // Same shape (function → for-in → call), different names/member — the
    // signature drops identifiers and member names, so they must be identical.
    expect(a).toBe(b);
  });

  it('near-miss — structurally different code yields a different signature', () => {
    const loop = structuralSignature(
      parse(`function a() { for (const x of items) { x.save(); } }`).root,
      { maxDepth: 12, maxNodes: 200 },
    );
    const branch = structuralSignature(
      parse(`function a() { if (x) { y(); } }`).root,
      { maxDepth: 12, maxNodes: 200 },
    );
    expect(loop).not.toBe(branch);
  });

  it('guard — secret, table name, and distinctive identifier never appear in the signature', () => {
    const code = [
      `export function checkSecret(users_table_name: string) {`,
      `  const apiKey = "secret_api_key_4eC39HqLyjWDarjtT1zdp7dc";`,
      `  const distinctiveMarkerZxKq9 = "unlikely_identifier_9f2a";`,
      `  for (const row of users_table_name) { row.save(); }`,
      `  return apiKey;`,
      `}`,
    ].join('\n');
    const sig = structuralSignature(parse(code).root, { maxDepth: 20, maxNodes: 1000 });

    // The three acceptance-4 sentinels must not leak into the shape.
    expect(sig).not.toContain('secret_api_key_4eC39HqLyjWDarjtT1zdp7dc'); // the secret
    expect(sig).not.toContain('users_table_name'); // the table name
    expect(sig).not.toContain('distinctiveMarkerZxKq9'); // the distinctive identifier
    expect(sig).not.toContain('unlikely_identifier_9f2a'); // the literal value

    // But it still carries real shape.
    expect(sig).toContain('for_in_statement');
    expect(sig).toContain('call_expression');
  });
});

describe('signatureForLocation', () => {
  it('positive — resolves a finding location up to its function boundary', () => {
    const ast = parse(`function handler() {\n  for (const x of items) { x.save(); }\n}`);
    // Line 2 is the for-loop; the signature root is the enclosing function.
    const sig = signatureForLocation(ast, { line: 2, column: 3 });
    expect(sig).not.toBeNull();
    expect(sig!).toContain('function_declaration');
    expect(sig!).toContain('for_in_statement');
  });

  it('absence — a location outside the tree yields null', () => {
    const ast = parse(`const x = 1;`);
    expect(signatureForLocation(ast, { line: 99, column: 1 })).toBeNull();
  });
});
