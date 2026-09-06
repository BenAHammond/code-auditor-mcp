/**
 * Universal DRY (Don't Repeat Yourself) Analyzer — Spec 17 R3
 *
 * R3.1: Self-reference fix — span-overlap check prevents a block from citing itself.
 * R3.2: Minimum block size 5 → 15.
 * R3.3: Rule-id split — dry/duplicate (exact token match) + dry/structural-similarity
 *       (identical token-kind sequence with different identifiers/literals).
 * R7:   dry/duplicate → warning, dry/structural-similarity → suggestion.
 *
 * Spec 13 R5 — Diverging Clones: Exports DryPairSeed during analysis for
 * two-phase tracking (seed + re-measure pass in auditRunner).
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import { withRuleTiming } from '../ruleTiming.js';
import type { Violation, FunctionMetadata } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../languages/types.js';
import * as crypto from 'crypto';

/**
 * Pair seed emitted during DRY analysis for diverging-clone tracking.
 * The identity is fingerprint-based (file + enclosing symbol), not content-hash-based.
 */
export interface DryPairSeed {
  /** Order-normalized pair identity: SHA256(sorted(fp1, fp2).join('||')) */
  pairFingerprint: string;
  file1: string;
  symbol1: string;
  line1: number;
  contentHash1: string;
  file2: string;
  symbol2: string;
  line2: number;
  contentHash2: string;
  /** Jaccard similarity [0,1] — 1.0 for exact, ~Jaccard for structural. */
  similarity: number;
  /** Rule: 'dry/duplicate' or 'dry/structural-similarity' */
  rule: string;
}

/**
 * Configuration for DRY analyzer
 */
export interface DRYAnalyzerConfig {
  minLineThreshold?: number;
  similarityThreshold?: number;
  excludePatterns?: string[];
  checkImports?: boolean;
  checkStrings?: boolean;
  /** R4.2: Enables dry/structural-similarity analysis. Default false. */
  checkStructuralSimilarity?: boolean;
  /**
   * #132: Enables dry/similar-expression analysis — near-identical object
   * literals and fluent call chains that share a field/method sequence. Default
   * false: query-builder chains are structurally similar by design, so this is
   * opt-in like structural-similarity.
   */
  checkExpressionSimilarity?: boolean;
  /**
   * #132: Minimum number of field/method names two fragments must share (as a
   * common subsequence) before they count as "near-identical". Default 4, so a
   * 3-method chain (.select().from().where()) never fires, but a 4-method chain
   * (.update().set().where().returning()) and the 5-field resultSummary do.
   */
  minShapeNames?: number;
  ignoreComments?: boolean;
  ignoreWhitespace?: boolean;
  /** Full function index (all functions in codebase) for cross-file duplicate detection in scoped audits */
  fullFunctionIndex?: FunctionMetadata[];
}

export const DEFAULT_DRY_CONFIG: DRYAnalyzerConfig = {
  // R3.2: floor raised from 5 → 15
  minLineThreshold: 15,
  similarityThreshold: 0.85,
  excludePatterns: ['**/*.test.ts', '**/*.spec.ts'],
  // R4.1: sub-rules disabled by default
  checkImports: false,
  checkStrings: false,
  ignoreComments: true,
  ignoreWhitespace: true,
  // R4.2: structural similarity off by default
  checkStructuralSimilarity: false,
  // #132: expression similarity ON by default. Idiomatic query-builder chains
  // and unrelated schema literals are filtered out of the signal (query chains
  // are excluded; object literals must target the same identifier), so the rule
  // fires on real duplication — `resultSummary` built twice, repeated mutation
  // chains — without flooding a default audit.
  checkExpressionSimilarity: true,
  minShapeNames: 4,
};

interface CodeBlock {
  file: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  text: string;
  normalizedText: string;
  hash: string;
  /** R3.3 — token-kind structural hash (identifiers→ID, literals→LIT) */
  structuralHash: string;
  nodeType: string;
  lineCount: number;
}

/** Bundle of inputs threaded through the block-extraction free functions. */
interface BlockContext {
  ast: AST;
  adapter: LanguageAdapter;
  sourceCode: string;
  config: DRYAnalyzerConfig;
}

// ── R3.1: Span-overlap helpers ──────────────────────────────────────

/**
 * Returns true if the two blocks share code spans (same file + overlapping lines).
 */
function spansOverlap(a: CodeBlock, b: CodeBlock): boolean {
  if (a.file !== b.file) return false;
  return !(a.end.line < b.start.line || b.end.line < a.start.line);
}

/**
 * Sort comparator: earliest file+line first.
 */
function byFileAndLine(a: CodeBlock, b: CodeBlock): number {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  return a.start.line - b.start.line;
}

/**
 * R3.1: Deduplicate overlapping blocks. Prefers the innermost block when
 * one block fully contains another (nesting), and the earliest block when
 * blocks only partially overlap.
 *
 * This ensures that blocks nested inside functions/classes (e.g. for-loops
 * inside a function body) surface for duplicate detection instead of being
 * silently deduplicated by their outer container.
 */
function deduplicateBlocks(blocks: CodeBlock[]): CodeBlock[] {
  if (blocks.length <= 1) return blocks;

  // Sort by (file, startLine)
  const sorted = [...blocks].sort(byFileAndLine);
  const result: CodeBlock[] = [];
  let last: CodeBlock | null = null;

  for (const block of sorted) {
    if (last && last.file === block.file) {
      // Same file — check for overlap

      // Case 1: `last` fully contains `block` (nesting: last is outer, block is inner)
      // Replace outer with inner — the inner block is more specific.
      if (last.start.line <= block.start.line && last.end.line >= block.end.line) {
        result.pop();
        result.push(block);
        last = block;
        continue;
      }

      // Case 2: `block` fully contains `last` (nesting: block is outer, last is inner)
      // Keep `last` (already inner in result), skip the outer block.
      if (block.start.line <= last.start.line && block.end.line >= last.end.line) {
        continue;
      }

      // Case 3: Partial overlap (neither fully contains the other)
      // Keep the earlier block.
      if (!(last.end.line < block.start.line)) {
        continue;
      }
    }
    result.push(block);
    last = block;
  }
  return result;
}

// ── #132: Expression-similarity helpers ────────────────────────────────

/**
 * A "shape fragment" is a compact, order-sensitive fingerprint of a small
 * expression: an object literal's field names, or a fluent call chain's method
 * names. The block extractor only sees functions/classes/control-flow ≥15
 * lines, so near-identical *expressions* — the 5-field `resultSummary` object
 * built twice, the five `.update().set().where().returning()` switch arms —
 * were invisible to `dry/duplicate` and `dry/structural-similarity`.
 */
interface ShapeFragment {
  file: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  kind: 'object' | 'chain';
  /**
   * For object literals: the assignment/declaration target (`info.resultSummary`,
   * `const config`) the literal is built for. Two object literals only count as
   * "the same object built twice" when they target the *same* identifier — this
   * is what distinguishes the real `resultSummary` duplication from the flood of
   * near-identical `pgTable(...)` schema literals, which share column names
   * (`id`, `createdAt`) across entirely different targets. Chains leave this
   * undefined (chains are compared across the whole file).
   */
  target?: string;
  /** Field names (object) or method names (chain), in source order. */
  names: string[];
  /** Raw source text, used for the fix patch. */
  text: string;
}

/** True when `outer`'s span fully contains `inner`'s span in the same file. */
function shapeSpansContain(outer: ShapeFragment, inner: ShapeFragment): boolean {
  if (outer.file !== inner.file) return false;
  const startLte =
    outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line && outer.start.column <= inner.start.column);
  const endGte =
    outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line && outer.end.column >= inner.end.column);
  return startLte && endGte;
}

/**
 * Drop nested fragments, keeping the outermost. A fluent chain visits its outer
 * call first, then each suffix chain (`a().b()` vs `a().b().c()` share a start
 * position but the outer span is longer); a nested object literal is fully
 * contained in its parent. Sort puts the widest span first so the inner suffix
 * is skipped as contained.
 */
function dedupeShapeFragments(fragments: ShapeFragment[]): ShapeFragment[] {
  const sorted = [...fragments].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.start.line !== b.start.line) return a.start.line - b.start.line;
    if (a.start.column !== b.start.column) return a.start.column - b.start.column;
    // Same start → outermost (largest end) first.
    if (a.end.line !== b.end.line) return b.end.line - a.end.line;
    return b.end.column - a.end.column;
  });

  const kept: ShapeFragment[] = [];
  for (const f of sorted) {
    if (!kept.some((k) => shapeSpansContain(k, f))) kept.push(f);
  }
  return kept;
}

/** Strip one layer of quotes from a string-literal object key. */
function bareKeyName(key: ASTNode, getText: (node: ASTNode) => string): string {
  let t = getText(key).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  return t;
}

/**
 * Field names of an object literal, in source order. Handles `{ a: 1 }`
 * (`pair` → key child) and `{ a }` (`shorthand_property_identifier`).
 */
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

/**
 * Method names of a fluent call chain (`db.update().set().where().returning()`),
 * in call order. Walks `call_expression` → `member_expression` callee chain,
 * collecting each `.method` name and recursing into the chain's receiver until
 * a bare identifier is reached. Returns [] for a bare (non-member) call.
 */
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
 * SQL query-building verbs. A chain that contains one of these is a read query
 * (`.select().from().where().orderBy()`), and two such chains are "structurally
 * similar by design" — the ORM's API surface, not duplicated logic. Excluding
 * them keeps the default-on rule quiet on idiomatic reads while still flagging
 * the mutation chains (`update().set().where().returning()`) that are the real
 * duplication signal.
 */
const QUERY_CHAIN_METHODS = new Set(['select', 'selectDistinct']);

/** True when the chain is a query builder (contains a read-query verb). */
function isQueryChain(names: string[]): boolean {
  return names.some((n) => QUERY_CHAIN_METHODS.has(n));
}

/**
 * Extract shape fragments (object literals + fluent call chains) from the AST.
 *
 * Object literals are only collected as the *direct value* of a declaration
 * (`const x = {...}`) or assignment (`info.resultSummary = {...}`), and carry
 * that target. Two literals must target the same identifier to be compared —
 * this keeps `pgTable('users', {...})` / `pgTable('orders', {...})` (different
 * targets, shared `id`/`createdAt` column names) out of the "built twice" set.
 *
 * Chains are collected from every `call_expression`, excluding query builders.
 * Fragments are filtered to `minShapeNames` names and deduplicated to the
 * outermost span.
 */
function extractShapeFragments(ctx: BlockContext, minShapeNames: number): ShapeFragment[] {
  const fragments: ShapeFragment[] = [];
  const getText = (node: ASTNode): string => ctx.adapter.getNodeText(node, ctx.sourceCode);

  const collectObject = (node: ASTNode, target: string): void => {
    const names = objectFieldNames(node, getText);
    if (names.length < minShapeNames) return;
    fragments.push({
      file: ctx.ast.filePath,
      start: node.location.start,
      end: node.location.end,
      kind: 'object',
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
      if (names.length < minShapeNames || isQueryChain(names)) return;
      fragments.push({
        file: ctx.ast.filePath,
        start: node.location.start,
        end: node.location.end,
        kind: 'chain',
        names,
        text: getText(node),
      });
    }
  });

  return dedupeShapeFragments(fragments);
}

/**
 * Longest common subsequence of two string arrays, returned as the actual
 * shared sequence (so the violation message can name the shared fields/methods).
 */
function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const seq: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      seq.push(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return seq.reverse();
}

// ── R3.3: Structural similarity helpers ──────────────────────────────

/**
 * Group blocks by a key field into a map of key→blocks[].
 */
function groupByHash(
  blocks: CodeBlock[],
  key: 'hash' | 'structuralHash'
): Map<string, CodeBlock[]> {
  const map = new Map<string, CodeBlock[]>();
  for (const block of blocks) {
    const hash = block[key];
    const existing = map.get(hash) || [];
    existing.push(block);
    map.set(hash, existing);
  }
  return map;
}

/**
 * R3.3: Normalize code to its token-kind sequence.
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
    // Keep keywords intact
    const keywords = new Set([
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
      'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof',
      'instanceof', 'in', 'of', 'class', 'extends', 'super', 'this', 'function',
      'const', 'let', 'var', 'async', 'await', 'yield', 'import', 'export',
      'default', 'from', 'as', 'static', 'get', 'set', 'enum', 'type', 'interface',
      'implements', 'abstract', 'public', 'private', 'protected', 'readonly',
      'ID', 'LIT',
    ]);
    if (keywords.has(match)) return match;
    return 'ID';
  });

  return normalized;
}

/**
 * Normalize code for comparison
 */
function normalizeCode(code: string, config: DRYAnalyzerConfig): string {
  let normalized = code;

  if (config.ignoreWhitespace) {
    // Normalize whitespace but preserve structure
    normalized = normalized
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
  }

  if (config.ignoreComments) {
    // Remove single-line comments
    normalized = normalized.replace(/\/\/.*$/gm, '');
    // Remove multi-line comments
    normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
  }

  return normalized;
}

/**
 * R3.3: Normalize code for structural comparison.
 * First applies standard normalization (whitespace/comments), then
 * replaces identifiers and literals with placeholders.
 */
function normalizeCodeForStructure(code: string, config: DRYAnalyzerConfig): string {
  const normalized = normalizeCode(code, config);
  return normalizeStructure(normalized);
}

/**
 * Hash code for comparison
 */
function hashCode(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Count lines in text
 */
function countLines(text: string): number {
  return text.split('\n').filter(line => line.trim().length > 0).length;
}

/**
 * Check if block is large enough to be considered
 */
function isBlockLargeEnough(block: CodeBlock, config: DRYAnalyzerConfig): boolean {
  return block.lineCount >= (config.minLineThreshold || 5);
}

/**
 * Compute the Jaccard similarity index between two tokenized strings.
 * Jaccard = |intersection| / |union|. Range [0, 1].
 */
function computeJaccardSimilarity(text1: string, text2: string): number {
  const tokens1 = new Set(text1.split(/\s+/).filter(Boolean));
  const tokens2 = new Set(text2.split(/\s+/).filter(Boolean));

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }

  const union = tokens1.size + tokens2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute an order-independent pair fingerprint from two code blocks.
 * Uses SHA256(sorted(a, b).join('||')) so the same pair has the same
 * fingerprint regardless of argument order.
 */
function computePairFingerprint(original: CodeBlock, block: CodeBlock): string {
  const id1 = `${original.file}|${original.nodeType}|${original.start.line}`;
  const id2 = `${block.file}|${block.nodeType}|${block.start.line}`;
  const sorted = [id1, id2].sort();
  return crypto.createHash('sha256').update(sorted.join('||')).digest('hex');
}

/**
 * Find a node by its location via BFS.
 */
function findNodeByLocation(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
  const queue: ASTNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;

    if (node.location.start.line === location.line &&
        node.location.start.column === location.column) {
      return node;
    }

    if (node.children) {
      queue.push(...node.children);
    }
  }

  return null;
}

/**
 * Check whether a file path matches any of the given glob-ish exclude patterns.
 */
function isExcluded(filePath: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    return regex.test(filePath);
  });
}

/**
 * Walk the AST depth-first, invoking the callback on every node.
 */
function walkAST(node: ASTNode, callback: (node: ASTNode) => void): void {
  callback(node);
  if (node.children) {
    for (const child of node.children) {
      walkAST(child, callback);
    }
  }
}

/**
 * Check whether a node type is a block-like structure (if, for, while, etc.).
 * Pure check on the tree-sitter node type.
 */
function isSignificantBlockType(type: string): boolean {
  const blockTypes = new Set([
    'if_statement', 'for_statement', 'for_in_statement',
    'while_statement', 'do_statement', 'switch_statement', 'try_statement',
  ]);
  return blockTypes.has(type);
}

/**
 * Build a code block from a node, given the extraction context.
 */
function createCodeBlock(ctx: BlockContext, node: ASTNode): CodeBlock | null {
  const text = ctx.adapter.getNodeText(node, ctx.sourceCode);
  if (!text) return null;

  const normalizedText = normalizeCode(text, ctx.config);
  const lineCount = countLines(text);

  // R3.3: Compute structural hash from token-kind sequence
  const structuralHash = hashCode(normalizeCodeForStructure(text, ctx.config));

  return {
    file: ctx.ast.filePath,
    start: node.location.start,
    end: node.location.end,
    text,
    normalizedText,
    hash: hashCode(normalizedText),
    structuralHash,
    nodeType: node.type,
    lineCount
  };
}

/**
 * Locate the node at `location`, build its block, and append it if large enough.
 */
function collectBlock(
  ctx: BlockContext,
  location: { line: number; column: number },
  blocks: CodeBlock[]
): void {
  const node = findNodeByLocation(ctx.ast.root, location);
  if (!node) return;
  const block = createCodeBlock(ctx, node);
  if (block && isBlockLargeEnough(block, ctx.config)) {
    blocks.push(block);
  }
}

/**
 * Extract all code blocks from an AST: functions, classes + methods, and
 * significant control-flow blocks (loops/conditionals/etc.).
 */
function extractCodeBlocks(ctx: BlockContext): CodeBlock[] {
  const blocks: CodeBlock[] = [];

  for (const func of ctx.adapter.extractFunctions(ctx.ast)) {
    collectBlock(ctx, func.location.start, blocks);
  }

  const classes = ctx.adapter.extractClasses(ctx.ast);
  for (const cls of classes) {
    collectBlock(ctx, cls.location.start, blocks);
    for (const method of cls.methods) {
      collectBlock(ctx, method.location.start, blocks);
    }
  }

  walkAST(ctx.ast.root, node => {
    if (isSignificantBlockType(node.type)) {
      collectBlock(ctx, node.location.start, blocks);
    }
  });

  return blocks;
}

/**
 * Detects duplicate and structurally-similar code blocks across a codebase.
 *
 * Emits `dry/duplicate` (warning) for exact token matches and, when enabled,
 * `dry/structural-similarity` (suggestion) for token-kind matches. During
 * analysis it seeds {@link DryPairSeed} records for Spec-13 diverging-clone
 * tracking.
 */
export class UniversalDRYAnalyzer extends UniversalAnalyzer {
  readonly name = 'dry';
  readonly description = 'Detects code duplication across the codebase';
  readonly category = 'maintainability';

  /** Per-file accumulator for pairs seeded during analyzeAST. */
  private _dryPairsForFile: DryPairSeed[] = [];

  /** Pairs collected during the current analysis run for diverging-clone seeding. */
  private _dryPairs: DryPairSeed[] = [];

  /** Expose collected pairs for the auditRunner to persist. */
  get dryPairs(): DryPairSeed[] {
    return this._dryPairs;
  }

  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: DRYAnalyzerConfig,
    sourceCode: string
  ): Promise<Violation[]> {
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_DRY_CONFIG, ...config };

    // Reset pair collection for this file
    this._dryPairsForFile = [];

    // Skip if file matches exclude patterns
    if (isExcluded(ast.filePath, finalConfig.excludePatterns || [])) {
      return violations;
    }

    const ctx: BlockContext = { ast, adapter, sourceCode, config: finalConfig };
    const blocks = extractCodeBlocks(ctx);

    // R3.1: Deduplicate blocks — sort by (file, startLine) and merge overlapping spans
    const deduped = deduplicateBlocks(blocks);

    this.reportExactDuplicates(deduped, violations);
    if (finalConfig.checkStructuralSimilarity) {
      this.reportStructuralDuplicates(deduped, violations);
    }
    // #132: near-identical object literals and fluent call chains
    if (finalConfig.checkExpressionSimilarity) {
      const fragments = extractShapeFragments(ctx, finalConfig.minShapeNames || 4);
      this.reportExpressionSimilarities(fragments, finalConfig, violations);
    }
    this.reportCrossFileDuplicates(blocks, finalConfig, violations);

    // Check for duplicate string literals if enabled
    if (finalConfig.checkStrings) {
      violations.push(...this.checkDuplicateStrings(ast, adapter, sourceCode));
    }

    // Check for duplicate imports if enabled
    if (finalConfig.checkImports) {
      violations.push(...this.checkDuplicateImports(ast, adapter));
    }

    // Merge per-file pair accumulator into global accumulator for diverging-clone tracking
    this._dryPairs.push(...this._dryPairsForFile);

    return violations;
  }

  /**
   * Report exact token-identical duplicates (dry/duplicate, warning).
   */
  private reportExactDuplicates(deduped: CodeBlock[], violations: Violation[]): void {
    withRuleTiming('dry/duplicate', () => {
      const exactHashmap = groupByHash(deduped, 'hash');

      for (const [, group] of exactHashmap) {
        if (group.length < 2) continue;

        const sorted = [...group].sort(byFileAndLine);
        const original = sorted[0];

        for (let i = 1; i < sorted.length; i++) {
          const block = sorted[i];

          // R3.1: Span-overlap check — skip if block overlaps with original
          if (spansOverlap(original, block)) continue;

          const violation = this.createViolation(
            block.file,
            block.start,
            `Duplicate code block detected (${block.lineCount} lines). ` +
            `First occurrence at ${original.file}:${original.start.line}`,
            { severity: 'warning', rule: 'dry/duplicate', symbol: block.hash,  // R7
              resolution: {
                action: 'extract-duplicate',
                summary: `Extract the ${block.lineCount}-line block duplicated at ${original.file}:${original.start.line} into a shared function both sites call.`,
                files: [block.file, original.file],
                lines: [block.start.line, original.start.line],
              } }
          );
          violation.fix = {
            oldText: block.text,
            newText: `// Consider extracting to a shared function`
          };
          violations.push(violation);

          // Spec 13 R5 — seed pair for diverging-clone tracking
          this.seedPair(original, block, 1.0, 'dry/duplicate');
        }
      }
    });
  }

  /**
   * Report token-kind-identical duplicates (dry/structural-similarity, suggestion).
   */
  private reportStructuralDuplicates(deduped: CodeBlock[], violations: Violation[]): void {
    const structuralHashmap = groupByHash(deduped, 'structuralHash');

    for (const [, group] of structuralHashmap) {
      if (group.length < 2) continue;

      const sorted = [...group].sort(byFileAndLine);
      const original = sorted[0];

      for (let i = 1; i < sorted.length; i++) {
        const block = sorted[i];

        // Skip if these are already exact duplicates (reported above)
        if (original.hash === block.hash) continue;

        // R3.1: Span-overlap check
        if (spansOverlap(original, block)) continue;

        // Compute the Jaccard similarity up front so the message can render the
        // actual percentage ({similarity}% in the registry template), rather
        // than a line count standing in for it.
        const jaccardSim = computeJaccardSimilarity(
          original.normalizedText, block.normalizedText
        );

        const violation = this.createViolation(
          block.file,
          block.start,
          `Structurally similar code block detected (${Math.round(jaccardSim * 100)}% similar). ` +
          `First occurrence at ${original.file}:${original.start.line}`,
          { severity: 'suggestion', rule: 'dry/structural-similarity', symbol: block.hash }  // R7
        );
        violation.fix = {
          oldText: block.text,
          newText: `// Consider extracting to a shared function`
        };
        violations.push(violation);

        // Spec 13 R5 — seed pair for diverging-clone tracking
        this.seedPair(original, block, jaccardSim, 'dry/structural-similarity');
      }
    }
  }

  /**
   * Report near-identical expression shapes (dry/similar-expression, suggestion).
   *
   * Two fragments are "near-identical" when their field/method-name sequence
   * shares a common subsequence of at least `minShapeNames` names — the same
   * `resultSummary` object built twice, the same `.update().set().where()`
   * chain repeated across switch arms. Each later fragment is reported at most
   * once, against the earliest fragment it resembles.
   */
  private reportExpressionSimilarities(
    fragments: ShapeFragment[],
    config: DRYAnalyzerConfig,
    violations: Violation[]
  ): void {
    withRuleTiming('dry/similar-expression', () => {
      const min = config.minShapeNames || 4;
      const reported = new Set<number>();

      for (let j = 1; j < fragments.length; j++) {
        if (reported.has(j)) continue;
        for (let i = 0; i < j; i++) {
          // Only compare like-with-like: a field list and a method chain are
          // different shapes and should never be flagged as "near-identical".
          if (fragments[i].kind !== fragments[j].kind) continue;
          // Object literals must target the same identifier (`info.resultSummary`
          // built twice), not merely two unrelated literals that share column
          // names. Chains have no target (undefined === undefined).
          if (fragments[i].target !== fragments[j].target) continue;
          const shared = longestCommonSubsequence(fragments[i].names, fragments[j].names);
          if (shared.length < min) continue;

          violations.push(this.buildSimilarityViolation(fragments[j], fragments[i], shared));
          reported.add(j);
          break;
        }
      }
    });
  }

  /**
   * Build the `dry/similar-expression` violation for `fragment` (the later
   * fragment) resembling `first` (the earliest).
   */
  private buildSimilarityViolation(
    fragment: ShapeFragment,
    first: ShapeFragment,
    shared: string[],
  ): Violation {
    const isObject = fragment.kind === 'object';
    const label = isObject ? 'object literal' : 'call chain';
    const unit = isObject ? 'fields' : 'methods';
    const targetClause = isObject && fragment.target
      ? ` built for "${fragment.target}"`
      : '';
    const violation = this.createViolation(
      fragment.file,
      fragment.start,
      `Near-identical ${label}${targetClause} detected (${shared.length} shared ${unit}: ${shared.join(', ')}). ` +
      `First occurrence at ${first.file}:${first.start.line}`,
      {
        severity: 'suggestion',
        rule: 'dry/similar-expression',
        symbol: shared.join('.'),
        resolution: {
          action: 'extract-shared-expression',
          summary: `Extract the shared ${isObject ? 'field list' : 'method chain'} (${shared.join(', ')}) into a shared helper, builder, or constant both sites use.`,
          files: [fragment.file, first.file],
          lines: [fragment.start.line, first.start.line],
        },
      }
    );
    violation.fix = {
      oldText: fragment.text,
      newText: `// Consider extracting the shared ${unit} into a shared helper`,
    };
    return violation;
  }

  /**
   * Report blocks that duplicate a function body from the full codebase index.
   * Only used in scoped (changed-file) audits.
   */
  private reportCrossFileDuplicates(
    blocks: CodeBlock[],
    config: DRYAnalyzerConfig,
    violations: Violation[]
  ): void {
    withRuleTiming('dry/duplicate', () => {
      if (!config.fullFunctionIndex || config.fullFunctionIndex.length === 0) return;

      const fullHashmap = this.buildFullFunctionHashmap(config);

      for (const block of blocks) {
        if (!isBlockLargeEnough(block, config)) continue;

        const fullMatch = fullHashmap.get(block.hash);
        if (fullMatch && fullMatch.file !== block.file) {
          const violation = this.createViolation(
            block.file,
            block.start,
            `Duplicate code block detected (${block.lineCount} lines). ` +
            `First occurrence in ${fullMatch.file}:${fullMatch.line} (${fullMatch.name})`,
            { severity: 'warning', rule: 'dry/duplicate', symbol: block.hash,
              resolution: {
                action: 'extract-duplicate',
                summary: `Extract the ${block.lineCount}-line block duplicated in ${fullMatch.file}:${fullMatch.line} (${fullMatch.name}) into a shared function both sites call.`,
                files: [block.file, fullMatch.file],
                lines: [block.start.line, fullMatch.line],
              } }
          );
          violation.fix = {
            oldText: block.text,
            newText: `// Consider extracting to a shared function`
          };
          violations.push(violation);
        }
      }
    });
  }

  /**
   * Build a hash→location map of every function body in the full codebase index.
   */
  private buildFullFunctionHashmap(
    config: DRYAnalyzerConfig
  ): Map<string, { file: string; name: string; line: number }> {
    const fullHashmap = new Map<string, { file: string; name: string; line: number }>();

    for (const func of config.fullFunctionIndex || []) {
      const body = (func as any).body ?? (func as any).metadata?.body;
      if (!body) continue;

      try {
        const normalized = normalizeCode(body, config);
        const hash = hashCode(normalized);
        if (!fullHashmap.has(hash)) {
          fullHashmap.set(hash, {
            file: func.filePath,
            name: func.name,
            line: func.startLine ?? func.lineNumber ?? 0
          });
        }
      } catch {
        // Skip functions whose body can't be normalized
      }
    }

    return fullHashmap;
  }

  /**
   * Check for duplicate string literals
   */
  private checkDuplicateStrings(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string
  ): Violation[] {
    const violations: Violation[] = [];
    const stringMap = new Map<string, Array<{ line: number; column: number }>>();

    // Find all string literals
    const stringNodes = adapter.findNodes(ast, {
      custom: (node) => this.isStringLiteral(node, adapter)
    });

    for (const node of stringNodes) {
      const value = adapter.getNodeText(node, sourceCode);
      if (value && value.length > 10) { // Only consider non-trivial strings
        const locations = stringMap.get(value) || [];
        locations.push(node.location.start);
        stringMap.set(value, locations);
      }
    }

    // Report duplicates
    for (const [value, locations] of stringMap) {
      if (locations.length > 2) { // More than 2 occurrences
        const violation = this.createViolation(
          ast.filePath,
          locations[0],
          `String literal "${value.substring(0, 30)}..." is duplicated ${locations.length} times`,
          { severity: 'suggestion', rule: 'duplicate-string-literal', symbol: value.substring(0, 50) }
        );
        violation.fix = {
          oldText: value,
          newText: '// Consider extracting to a constant'
        };
        violations.push(violation);
      }
    }

    return violations;
  }

  /**
   * Check for duplicate imports
   */
  private checkDuplicateImports(
    ast: AST,
    adapter: LanguageAdapter
  ): Violation[] {
    const violations: Violation[] = [];
    const importMap = new Map<string, number>();

    // Find all import statements
    const imports = adapter.extractImports(ast);

    for (const imp of imports) {
      const count = importMap.get(imp.source) || 0;
      importMap.set(imp.source, count + 1);
    }

    // Report duplicates
    for (const [source, count] of importMap) {
      if (count > 1) {
        violations.push(this.createViolation(
          ast.filePath,
          { line: 1, column: 1 }, // Import section is typically at the top
          `Module "${source}" is imported ${count} times`,
          { severity: 'warning', rule: 'duplicate-import', symbol: source }
        ));
      }
    }

    return violations;
  }

  /**
   * Check if this is a block-like structure (if, for, while, etc.).
   */
  private isSignificantBlock(node: ASTNode, adapter: LanguageAdapter): boolean {
    return isSignificantBlockType(node.type);
  }

  /**
   * Check if a node is a string or template-string literal.
   */
  private isStringLiteral(node: ASTNode, adapter: LanguageAdapter): boolean {
    return node.type === 'string' || node.type === 'template_string';
  }

  /**
   * Seed a pair into the per-file accumulator for diverging-clone tracking.
   * Called during analyzeAST when a duplicate or structural-similarity pair
   * is detected.
   */
  private seedPair(
    original: CodeBlock,
    block: CodeBlock,
    similarity: number,
    rule: string,
  ): void {
    const pairFingerprint = computePairFingerprint(original, block);
    this._dryPairsForFile.push({
      pairFingerprint,
      file1: original.file,
      symbol1: `${original.nodeType}:${original.start.line}`,
      line1: original.start.line,
      contentHash1: original.hash,
      file2: block.file,
      symbol2: `${block.nodeType}:${block.start.line}`,
      line2: block.start.line,
      contentHash2: block.hash,
      similarity,
      rule,
    });
  }

  /**
   * Run DRY analysis and attach the seeded pair list to the result.
   *
   * @param files List of file paths to analyze.
   * @param config Analyzer configuration merged over {@link DEFAULT_DRY_CONFIG}.
   * @param options Additional analyzer options (unused by DRY).
   * @returns The analyzer result, with `dryPairs` attached for diverging-clone tracking.
   */
  async analyze(
    files: string[],
    config: any = {},
    options: any = {},
  ): Promise<import('../../types.js').AnalyzerResult> {
    const result = await super.analyze(files, config, options);
    (result as any).dryPairs = this.dryPairs;
    return result;
  }
}
