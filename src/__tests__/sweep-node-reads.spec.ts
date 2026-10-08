/**
 * Red tests for the source-text-read sweep (14 sites).
 *
 * Each site reads *source text* where a tree-sitter *node* is available. Reading
 * the text is a false-positive/false-negative source (a string or comment inside
 * a node's byte range is read as if it were structure). Each test below asserts
 * the node-read behaviour the site SHOULD have — and is currently RED, pinning
 * the defect so it cannot be fixed silently or lost.
 *
 * Fix order (Ben): Tier 3 (#13/#14) → Tier 1 (#1–#4) → Tier 2 (#5–#12).
 * Sites that move from a text signature to a node signature (#1/#4/#5/#6/#7)
 * keep the same assertion; only the fixture input changes from text to node in
 * the fix commit.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { parseFile, findNodes } from '../languages/adapterBridge.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import type { AST, ASTNode, DynamicPart } from '../languages/types.js';
import { buildDataAccessCalls } from '../phase/runner.js';
import type { ResolvedQuery } from '../phase/types.js';
import { extractStaticSql } from '../analyzers/sqlLiteral.js';
import {
  isQueryBuilderShape,
  extractOrmTables,
  builderWriteVerb,
  hasOrmFilterShape,
  isPrepareAssignedToVariable,
  parameterBoundToStatementType,
  isPromiseAllMember,
  isSafeDynamicPart,
  isDbCallNode,
  DEFAULT_DATA_ACCESS_CONFIG,
} from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { isD1RestCall, extractTopLevelIdentifiers } from '../analyzers/provenance.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function calls(path: string, source: string): Promise<ResolvedQuery[]> {
  return buildDataAccessCalls([{ path, content: source }], 'sqlite');
}

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

/** The node of `type` with the largest byte range (the outermost one). */
function outermostOfType(filePath: string, source: string, type: string): ASTNode {
  const { ast } = parseSrc(filePath, source);
  const nodes = findNodes(ast.root, (n) => n.type === type);
  if (!nodes.length) throw new Error(`no ${type} node in ${filePath}`);
  let best = nodes[0];
  for (const n of nodes) {
    if (n.range[1] - n.range[0] > best.range[1] - best.range[0]) best = n;
  }
  return best;
}

describe('sweep — node reads (red)', () => {
  // ── Tier 3 ────────────────────────────────────────────────────────────────

  it('#13 — a `const` string assignment is discovered as SQL', async () => {
    const out = await calls('/f.ts', 'const q = "SELECT * FROM users";');
    expect(out.some((c) => c.tables.includes('users'))).toBe(true);
  });

  it('#14 — extractStaticSql reads the TS lexical_declaration initializer', () => {
    const src = 'const q = "SELECT * FROM users";';
    const { adapter } = parseSrc('/f.ts', src);
    const node = firstOfType('/f.ts', src, 'lexical_declaration');
    expect(extractStaticSql(node, adapter, src)).toBe('SELECT * FROM users');
  });

  it('#14 — extractStaticSql reads the Go short_var_declaration initializer', () => {
    const src = 'q := "SELECT * FROM users"';
    const { adapter } = parseSrc('/f.go', src);
    const node = firstOfType('/f.go', src, 'short_var_declaration');
    expect(extractStaticSql(node, adapter, src)).toBe('SELECT * FROM users');
  });

  // ── Tier 1 ────────────────────────────────────────────────────────────────

  it('#1 — hasChainCompanion reads the member chain, not a string argument', () => {
    // The `.from(x)` lives inside the string argument to `.select(…)`, not in
    // the member chain. The chain is `select → where` — no `.from` member.
    const src = 'someObj.select("a.b.from(x)").where(y);';
    const { adapter } = parseSrc('/f.ts', src);
    const node = outermostOfType('/f.ts', src, 'call_expression');
    expect(isQueryBuilderShape(node, adapter, src)).toBe(false);
  });

  it('#2 — isPrismaObjectForm reads the property node, not `.split(".")`', () => {
    // `obj["a.b"]` is a subscript; the `.b` is inside a string index, so the
    // callee is `obj[..].update` — two real segments, no `<Model>`.
    const src = 'obj["a.b"].update({ data: {} });';
    const { adapter } = parseSrc('/f.ts', src);
    const node = outermostOfType('/f.ts', src, 'call_expression');
    expect(isQueryBuilderShape(node, adapter, src)).toBe(false);
  });

  it('#3 — isD1RestCall reads the URL from the string-literal argument', () => {
    // The URL literal is an argument to `makeUrl`, not to `fetch`; the value
    // `fetch` receives is the *result* of `makeUrl(…)`, not the literal.
    const src = 'fetch(makeUrl("/d1/database/abc/query"));';
    const { adapter } = parseSrc('/f.ts', src);
    const node = outermostOfType('/f.ts', src, 'call_expression');
    expect(isD1RestCall(node, adapter, src)).toBe(false);
  });

  it('#3 — positive: a literal URL argument to fetch IS a D1 call', () => {
    const src = 'fetch("/d1/database/abc/query");';
    const { adapter } = parseSrc('/f.ts', src);
    const node = outermostOfType('/f.ts', src, 'call_expression');
    expect(isD1RestCall(node, adapter, src)).toBe(true);
  });

  it('#4 — extractTopLevelIdentifiers skips `await` to the root identifier', () => {
    const src = 'const q = await db.connect();';
    const { adapter } = parseSrc('/f.ts', src);
    const node = firstOfType('/f.ts', src, 'await_expression');
    expect(extractTopLevelIdentifiers(node, adapter, src)).toEqual(['db']);
  });

  it('#4 — extractTopLevelIdentifiers skips parentheses to the root identifier', () => {
    const src = 'const q = (db.prepare(sql));';
    const { adapter } = parseSrc('/f.ts', src);
    const node = firstOfType('/f.ts', src, 'parenthesized_expression');
    expect(extractTopLevelIdentifiers(node, adapter, src)).toEqual(['db']);
  });

  // ── Tier 2 ────────────────────────────────────────────────────────────────

  it('#5 — builderWriteVerb reads the member chain, not a string argument', () => {
    const src = 'db.raw(".insertInto(x)")';
    const { adapter } = parseSrc('/f.ts', src);
    const node = outermostOfType('/f.ts', src, 'call_expression');
    expect(builderWriteVerb(node, adapter, src)).toBeNull();
  });

  it('#6 — hasOrmFilterShape reads the member chain, not a string argument', () => {
    const src = 'db.raw(".where(x)")';
    const { adapter } = parseSrc('/f.ts', src);
    const node = outermostOfType('/f.ts', src, 'call_expression');
    expect(hasOrmFilterShape(node, adapter, src)).toBe(false);
  });

  it('#7 — extractOrmTables does not read a `.from(…)` inside a string', () => {
    const src = 'db.raw("a.b.from(x)")';
    const { adapter } = parseSrc('/f.ts', src);
    const node = outermostOfType('/f.ts', src, 'call_expression');
    expect(extractOrmTables(node, adapter, src, DEFAULT_DATA_ACCESS_CONFIG)).toEqual([]);
  });

  it('#8 — isPrepareAssignedToVariable walks the subtree, not function text', () => {
    const src = [
      'function f(db, sql) {',
      '  const stmt = db.prepare(sql);',
      '  // stmt.bind(x) — a comment mentioning .bind( must not count',
      '  return stmt;',
      '}',
    ].join('\n');
    const { adapter } = parseSrc('/f.ts', src);
    const call = firstOfType('/f.ts', src, 'call_expression');
    expect(isPrepareAssignedToVariable(call, adapter, src)).toBe(false);
  });

  it('#9 — parameterBoundToStatementType reads the type node, not regex over text', () => {
    // `StatementFactory` embeds "Statement" but is a factory, not a
    // `*Statement`/`*Statements` prepared-statement type.
    const src = 'function f(x: StatementFactory) { return x; }';
    const { adapter } = parseSrc('/f.ts', src);
    const fn = firstOfType('/f.ts', src, 'function_declaration');
    expect(parameterBoundToStatementType('x', fn, adapter, src)).toBe(false);
  });

  it('#10 — isSafeDynamicPart reads the call node, not text startsWith', () => {
    const src = 'mySanitizer  (x)';
    const { adapter, ast } = parseSrc('/f.ts', src);
    const callNode = firstOfType('/f.ts', src, 'call_expression');
    const part: DynamicPart = { text: 'mySanitizer  (x)', isIdentifier: false, node: callNode };
    const scan = {
      adapter,
      sourceCode: src,
      config: { ...DEFAULT_DATA_ACCESS_CONFIG, sanitizerNames: ['mySanitizer'] },
      ast,
    } as Parameters<typeof isSafeDynamicPart>[2];
    expect(isSafeDynamicPart(part, ast, scan)).toBe(true);
  });

  it('#11 — isPromiseAllMember reads the object identifier node, not text suffix', () => {
    // `foo.Promise` ends with `.Promise` but is not the `Promise` global.
    const src = 'foo.Promise.all([x]);';
    const { adapter } = parseSrc('/f.ts', src);
    const member = outermostOfType('/f.ts', src, 'member_expression');
    expect(isPromiseAllMember(member, adapter, src)).toBe(false);
  });

  it('#12 — isDbCallNode has no dbPatterns substring fallback', () => {
    // Without provenance context, a `map.delete(k)` call must not be classified
    // as a DB call just because its text contains "delete". The legacy
    // dbPatterns fallback is dead in a default run and must be deleted, not
    // fixed — this test locks that the fallback is gone.
    const src = 'map.delete(k);';
    const { adapter, ast } = parseSrc('/f.ts', src);
    const call = firstOfType('/f.ts', src, 'call_expression');
    const scan = {
      adapter,
      sourceCode: src,
      config: DEFAULT_DATA_ACCESS_CONFIG,
      ast,
      provenanceContext: undefined,
    } as Parameters<typeof isDbCallNode>[1];
    expect(isDbCallNode(call, scan)).toBe(false);
  });
});
