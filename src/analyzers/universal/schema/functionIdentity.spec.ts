/**
 * Spec 61 Amendment A — function identity is a coordinate, not a name.
 *
 * Verifies `findEnclosingFunctionIdentity` / `functionIdentityLabel` return a
 * (start line, start column) coordinate plus a nullable declaration name, so:
 *   - two anonymous handlers in the same file are distinct by line,
 *   - two anonymous handlers on the same line are distinct by column,
 *   - a nested arrow is distinct from its enclosing arrow,
 *   - a usage outside any function (top-level) carries its own coordinate and is
 *     flagged `topLevel` — distinct from a usage inside an anonymous function,
 *   - the identity is self-contained: `filePath` is carried so a byte-identical
 *     anonymous handler in two files is still distinct,
 *   - a declaration name is returned when present, null for anonymous (never
 *     source text, never 'top-level', never empty string).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../../../languages/index.js';
import { LanguageRegistry } from '../../../languages/LanguageRegistry.js';
import { findEnclosingFunctionIdentity, functionIdentityLabel } from './codeAnalysis.js';
import type { LanguageAdapter, AST, ASTNode } from '../../../languages/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function getAdapter(): LanguageAdapter {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts');
  if (!adapter) throw new Error('TypeScript adapter not registered');
  return adapter;
}

async function parseSource(source: string, filePath = 'test.ts'): Promise<AST> {
  return getAdapter().parse(filePath, source);
}

const FUNCTION_NODE_TYPES = new Set([
  'arrow_function',
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function_expression',
  'method_definition',
]);

/** Collect all function nodes in source order. */
function collectFunctions(ast: AST): ASTNode[] {
  return getAdapter().findNodes(ast, {
    custom: (node) => FUNCTION_NODE_TYPES.has(node.type),
  });
}

/** All arrow_function nodes in source order. */
function arrowsOf(ast: AST): ASTNode[] {
  return collectFunctions(ast).filter((n) => n.type === 'arrow_function');
}

describe('findEnclosingFunctionIdentity — coordinate identity (Amendment A)', () => {
  it('returns a null name for a truly anonymous (callback) arrow, with its coordinate', async () => {
    const ast = await parseSource(`const run = [].map(x => db.insert('orders'))`);
    // The `.map(x => …)` callback arrow is anonymous; `const run` names the map
    // call, not the callback.
    const arrow = arrowsOf(ast)[0];
    expect(arrow.location.start.line).toBe(1);
    const id = findEnclosingFunctionIdentity(arrow, getAdapter(), 'test.ts');
    expect(id.filePath).toBe('test.ts');
    expect(id.startLine).toBe(1);
    expect(id.topLevel).toBe(false);
    expect(id.name).toBeNull();
    expect(functionIdentityLabel(id)).toBe(`fn:1:${id.startColumn}`);
  });

  it('returns the variable-declarator name for an arrow assigned to a named variable', async () => {
    const ast = await parseSource(`const migrateAll = () => db.insert('users')`);
    const id = findEnclosingFunctionIdentity(arrowsOf(ast)[0], getAdapter(), 'test.ts');
    expect(id.name).toBe('migrateAll');
    expect(functionIdentityLabel(id)).toBe('migrateAll');
  });

  it('distinguishes two anonymous callbacks on the same line by column', async () => {
    const ast = await parseSource(
      `const x = [1].map(a => db.select('a')).filter(b => db.insert('b'))`,
    );
    const [first, second] = arrowsOf(ast);
    expect(first.location.start.line).toBe(1);
    expect(second.location.start.line).toBe(1);
    expect(first.location.start.column).not.toBe(second.location.start.column);

    const id1 = findEnclosingFunctionIdentity(first, getAdapter(), 'test.ts');
    const id2 = findEnclosingFunctionIdentity(second, getAdapter(), 'test.ts');
    expect(id1.name).toBeNull();
    expect(id2.name).toBeNull();
    expect(id1.startColumn).not.toBe(id2.startColumn);
    expect(functionIdentityLabel(id1)).not.toBe(functionIdentityLabel(id2));
  });

  it('distinguishes two anonymous callbacks in the same file by line', async () => {
    const ast = await parseSource(
      `const a = [1].map(x => db.insert('a'))\nconst b = [1].map(y => db.insert('b'))`,
    );
    const [first, second] = arrowsOf(ast);
    expect(first.location.start.line).toBe(1);
    expect(second.location.start.line).toBe(2);

    const id1 = findEnclosingFunctionIdentity(first, getAdapter(), 'test.ts');
    const id2 = findEnclosingFunctionIdentity(second, getAdapter(), 'test.ts');
    expect(id1.startLine).toBe(1);
    expect(id2.startLine).toBe(2);
    expect(id1.name).toBeNull();
    expect(id2.name).toBeNull();
    expect(functionIdentityLabel(id1)).not.toBe(functionIdentityLabel(id2));
  });

  it('distinguishes a nested anonymous arrow from its enclosing arrow', async () => {
    const ast = await parseSource(
      `const outer = [1].map(x => {\n  return [2].map(y => db.insert('x'))\n})`,
    );
    const arrows = arrowsOf(ast);
    expect(arrows.length).toBe(2);
    const idOuter = findEnclosingFunctionIdentity(arrows[0], getAdapter(), 'test.ts');
    const idInner = findEnclosingFunctionIdentity(arrows[1], getAdapter(), 'test.ts');
    expect(idInner.startLine).toBeGreaterThan(idOuter.startLine);
    expect(idOuter.name).toBeNull();
    expect(idInner.name).toBeNull();
    expect(functionIdentityLabel(idOuter)).not.toBe(functionIdentityLabel(idInner));
  });

  it('returns the declaration name for a named function declaration', async () => {
    const ast = await parseSource(`function migrateAll() { db.insert('users') }`);
    const fn = collectFunctions(ast).find((n) => n.type === 'function_declaration')!;
    const id = findEnclosingFunctionIdentity(fn, getAdapter(), 'test.ts');
    expect(id.name).toBe('migrateAll');
    expect(functionIdentityLabel(id)).toBe('migrateAll');
  });

  it('gives a top-level usage its own coordinate, flagged topLevel (not NULL)', async () => {
    const ast = await parseSource(`db.insert('users')\nconst run = [1].map(x => db.insert('orders'))`);
    const adapter = getAdapter();

    // Top-level usage: walk up from the module-scope call → no enclosing function.
    const topCall = adapter.findNodes(ast, {
      custom: (n) => n.type === 'call_expression' && n.location.start.line === 1,
    })[0];
    const topId = findEnclosingFunctionIdentity(topCall, adapter, 'test.ts');
    // Amendment A fix — a top-level usage carries its own coordinate (not NULL),
    // so it is a distinct key from every other top-level usage in the same file.
    expect(topId.startLine).toBe(topCall.location.start.line);
    expect(topId.startColumn).toBe(topCall.location.start.column);
    expect(topId.name).toBeNull();
    expect(topId.topLevel).toBe(true);
    expect(functionIdentityLabel(topId)).toBe('top-level');

    // Inside an unnamed callback: coordinate present, name null, not top-level.
    const anonId = findEnclosingFunctionIdentity(arrowsOf(ast)[0], adapter, 'test.ts');
    expect(anonId.startLine).toBe(2);
    expect(anonId.topLevel).toBe(false);
    expect(anonId.name).toBeNull();
    expect(functionIdentityLabel(anonId)).toBe(`fn:2:${anonId.startColumn}`);
  });

  it('distinguishes byte-identical anonymous handlers in different files by filePath', async () => {
    // The identity is self-contained: a byte-identical anonymous handler in two
    // files yields the same coordinate and a null name, but a distinct filePath.
    const source = `const x = [1].map(a => db.insert('t'))`;
    const astA = await parseSource(source, 'a.ts');
    const astB = await parseSource(source, 'b.ts');

    const idA = findEnclosingFunctionIdentity(arrowsOf(astA)[0], getAdapter(), 'a.ts');
    const idB = findEnclosingFunctionIdentity(arrowsOf(astB)[0], getAdapter(), 'b.ts');

    // Same coordinate, both anonymous — the coordinate alone cannot tell them apart.
    expect(idA.startLine).toBe(1);
    expect(idA.startColumn).toBe(idB.startColumn);
    expect(idA.name).toBeNull();
    expect(idB.name).toBeNull();

    // The full identity key — filePath::(line,column) — is what disambiguates.
    expect(idA.filePath).toBe('a.ts');
    expect(idB.filePath).toBe('b.ts');
    const keyA = `${idA.filePath}::${idA.startLine}:${idA.startColumn}`;
    const keyB = `${idB.filePath}::${idB.startLine}:${idB.startColumn}`;
    expect(keyA).not.toBe(keyB);
  });
});
