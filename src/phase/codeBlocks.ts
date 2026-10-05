/**
 * Spec 68 §3.2 — the per-file `code-block` producer.
 *
 * Projects the block/fragment extraction half of `UniversalDRYAnalyzer` onto one
 * serializable fact. The fact is a union of two element shapes — a *block*
 * (function/class/method/control-flow span, with its normalized hash and
 * structural skeleton pre-computed) and a *fragment* (an object literal's field
 * names or a call chain's method names) — so the three DRY rules
 * (`dry/duplicate`, `dry/structural-similarity`, `dry/similar-expression`) read
 * plain data and never the AST.
 *
 * The producer is a *pure projection*: it runs the legacy walk and computes the
 * hash/skeleton with the default normalization (comments/whitespace ignored),
 * but it applies **no threshold** and **no dedup**. `minLineThreshold`,
 * `similarityThreshold`, `minShapeNames`, `excludePatterns`, the two
 * check-gates, the fluent-chain exclusion and both dedup passes are the rules'
 * — re-applied in `dry.ts` over the projected data, in the exact legacy order
 * (filter → dedupe → compare). That keeps the tree's only job "project the raw
 * blocks and fragments before it dies", and keeps every configurable decision a
 * pure-data decision the rule can reproduce.
 */

import * as crypto from 'crypto';
import type { AST, LanguageAdapter, ASTNode } from '../languages/types.js';
import { buildLocationIndex, locationKey } from '../languages/locationIndex.js';
import type { AstFile, CodeBlockFact } from './types.js';

// ── Normalization (re-homed verbatim; the default ignore flags are fixed) ──
// `ignoreComments` / `ignoreWhitespace` are internal normalization knobs, not
// the DRY rules' declared threshold surface (`minLineThreshold` /
// `similarityThreshold` / `minShapeNames`), so they are pinned at their
// DEFAULT_DRY_CONFIG values (true) here — the same values the legacy
// default-merged analyzer used before any user override.

/** Reserved words left intact by `normalizeStructure` — hoisted so the replace
 *  callback does not re-allocate a 70-entry Set for every identifier match. */
const STRUCTURE_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof',
  'instanceof', 'in', 'of', 'class', 'extends', 'super', 'this', 'function',
  'const', 'let', 'var', 'async', 'await', 'yield', 'import', 'export',
  'default', 'from', 'as', 'static', 'get', 'set', 'enum', 'type', 'interface',
  'implements', 'abstract', 'public', 'private', 'protected', 'readonly',
  'ID', 'LIT',
]);

/**
 * Normalize code to its token-kind sequence.
 * Identifiers → ID, string/number/regex literals → LIT.
 */
function normalizeStructure(code: string): string {
  let normalized = code;

  // Template expressions: strip dynamic parts for structural matching
  normalized = normalized.replace(/\$\{[^}]*\}/g, 'ID');

  // String literals (single, double, backtick) → LIT
  normalized = normalized.replace(/(['"`])\1/g, 'LIT'); // empty strings
  normalized = normalized.replace(/`[^`]*`/g, 'LIT');
  normalized = normalized.replace(/'[^']*'/g, 'LIT');
  normalized = normalized.replace(/"[^"]*"/g, 'LIT');

  // Numeric literals → LIT
  normalized = normalized.replace(/\b\d+\.?\d*\b/g, 'LIT');

  // Regex literals → LIT (approximate — /pattern/flags)
  normalized = normalized.replace(/\/[^/*][^/]*\/[gimsuy]*/g, 'LIT');

  // Boolean/null literals
  normalized = normalized.replace(/\b(true|false|null|undefined)\b/g, 'LIT');

  // Identifiers → ID (after literals so we don't replace inside strings)
  // Match camelCase, PascalCase, snake_case, dollar-prefixed, underscore-prefixed
  normalized = normalized.replace(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g, (match) => {
    if (STRUCTURE_KEYWORDS.has(match)) return match;
    return 'ID';
  });

  return normalized;
}

/** Normalize code for comparison — default ignore flags (whitespace + comments). */
function normalizeCode(code: string): string {
  let normalized = code;
  // ignoreWhitespace
  normalized = normalized.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join('\n');
  // ignoreComments
  normalized = normalized.replace(/\/\/.*$/gm, '');
  normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
  return normalized;
}

/** Hash code for comparison. */
function hashCode(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Count lines in text (non-blank). */
function countLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

/** Walk the AST depth-first, invoking the callback on every node. */
function walkAST(node: ASTNode, callback: (node: ASTNode) => void): void {
  callback(node);
  if (node.children) {
    for (const child of node.children) {
      walkAST(child, callback);
    }
  }
}

/** True for a block-like node type (if/for/while/switch/try). */
function isSignificantBlockType(type: string): boolean {
  const blockTypes = new Set([
    'if_statement', 'for_statement', 'for_in_statement',
    'while_statement', 'do_statement', 'switch_statement', 'try_statement',
  ]);
  return blockTypes.has(type);
}

// ── Blocks ────────────────────────────────────────────────────────────────────

/** Bundle of inputs threaded through the block/fragment extraction. */
interface BlockContext {
  ast: AST;
  adapter: LanguageAdapter;
  sourceCode: string;
}

/** Build a block fact from a node (raw text + pre-computed hash/skeleton). */
function createCodeBlock(ctx: BlockContext, node: ASTNode): CodeBlockFact | null {
  const text = ctx.adapter.getNodeText(node, ctx.sourceCode);
  if (!text) return null;

  const normalizedText = normalizeCode(text);
  const lineCount = countLines(text);
  const structuralSkeleton = normalizeStructure(normalizedText);

  return {
    kind: 'block',
    file: ctx.ast.filePath,
    start: node.location.start,
    end: node.location.end,
    text,
    hash: hashCode(normalizedText),
    structuralSkeleton,
    nodeType: node.type,
    lineCount,
  };
}

/** Look up the node at `location` in the pre-built index, build its block, and
 *  append it. */
function collectBlock(
  ctx: BlockContext,
  index: Map<string, ASTNode>,
  location: { line: number; column: number },
  blocks: CodeBlockFact[],
): void {
  const node = index.get(locationKey(location));
  if (!node) return;
  const block = createCodeBlock(ctx, node);
  if (block) blocks.push(block);
}

/** Extract all code blocks from an AST: functions, classes + methods, control-flow. */
function extractBlocks(ctx: BlockContext): CodeBlockFact[] {
  const blocks: CodeBlockFact[] = [];
  // `true` skips the whole-file wrapper: the block producer's legacy search
  // started from `root.children`, never the root (see locationIndex.ts).
  const index = buildLocationIndex(ctx.ast.root, true);

  for (const func of ctx.adapter.extractFunctions(ctx.ast)) {
    collectBlock(ctx, index, func.location.start, blocks);
  }

  const classes = ctx.adapter.extractClasses(ctx.ast);
  for (const cls of classes) {
    collectBlock(ctx, index, cls.location.start, blocks);
    for (const method of cls.methods) {
      collectBlock(ctx, index, method.location.start, blocks);
    }
  }

  walkAST(ctx.ast.root, (node) => {
    if (isSignificantBlockType(node.type)) {
      collectBlock(ctx, index, node.location.start, blocks);
    }
  });

  return blocks;
}

// ── Shape fragments ──────────────────────────────────────────────────────────

/** Strip one layer of quotes from a string-literal object key. */
function bareKeyName(key: ASTNode, getText: (node: ASTNode) => string): string {
  let t = getText(key).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  return t;
}

/** Field names of an object literal, in source order (`{ a: 1 }` and `{ a }`). */
function objectFieldNames(node: ASTNode, getText: (n: ASTNode) => string): string[] {
  const names: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type === 'pair') {
      const key = child.children?.[0];
      if (key) {
        const name = bareKeyName(key, getText);
        if (name) names.push(name);
      }
    } else if (child.type === 'shorthand_property_identifier') {
      const name = getText(child).trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Method names of a fluent call chain, in call order ([] for a bare call). */
function callChainMethodNames(node: ASTNode, getText: (n: ASTNode) => string): string[] {
  const names: string[] = [];
  let current: ASTNode | undefined = node;
  while (current && current.type === 'call_expression') {
    const callee: ASTNode | undefined = current.children?.[0];
    if (!callee) break;
    if (callee.type === 'member_expression') {
      const prop: ASTNode | undefined = callee.children?.find((c) => c.type === 'property_identifier');
      if (!prop) break;
      names.push(getText(prop).trim());
      current = callee.children?.[0];
    } else if (callee.type === 'call_expression') {
      current = callee; // curried/IIFE — skip the anonymous level, keep walking
    } else {
      break; // bare identifier callee — end of the chain
    }
  }
  return names.reverse();
}

/**
 * Extract shape fragments (object literals + call chains) from the AST, with no
 * threshold filter and no dedup — both are the rule's. Object literals are only
 * collected as the *direct value* of a declaration or assignment and carry that
 * target; chains carry their method-name sequence.
 */
function extractFragments(ctx: BlockContext): CodeBlockFact[] {
  const fragments: CodeBlockFact[] = [];
  const getText = (node: ASTNode): string => ctx.adapter.getNodeText(node, ctx.sourceCode);

  const collectObject = (node: ASTNode, target: string): void => {
    const names = objectFieldNames(node, getText);
    fragments.push({
      kind: 'fragment',
      file: ctx.ast.filePath,
      start: node.location.start,
      end: node.location.end,
      fragmentKind: 'object',
      target,
      names,
      text: getText(node),
    });
  };

  walkAST(ctx.ast.root, (node) => {
    if (node.type === 'variable_declarator') {
      // `const name: T = value` — target is the declarator name, value the last child.
      const name = node.children?.[0];
      const value = node.children?.[node.children.length - 1];
      if (name && value?.type === 'object') collectObject(value, getText(name));
    } else if (node.type === 'assignment_expression') {
      // `target = value` — target is the left-hand side, value the last child.
      const left = node.children?.[0];
      const value = node.children?.[node.children.length - 1];
      if (left && value?.type === 'object') collectObject(value, getText(left));
    } else if (node.type === 'call_expression') {
      const names = callChainMethodNames(node, getText);
      fragments.push({
        kind: 'fragment',
        file: ctx.ast.filePath,
        start: node.location.start,
        end: node.location.end,
        fragmentKind: 'chain',
        names,
        text: getText(node),
      });
    }
  });

  return fragments;
}

// ── Entry point ───────────────────────────────────────────────────────────────

/** One file's code blocks + shape fragments, as a single `code-block` fact. */
export function extractCodeBlocks(file: AstFile): CodeBlockFact[] {
  const ctx: BlockContext = { ast: file.ast, adapter: file.adapter, sourceCode: file.source };
  return [...extractBlocks(ctx), ...extractFragments(ctx)];
}
