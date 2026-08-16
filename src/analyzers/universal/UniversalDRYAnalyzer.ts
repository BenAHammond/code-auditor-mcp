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

        const violation = this.createViolation(
          block.file,
          block.start,
          `Structurally similar code block detected (${block.lineCount} lines). ` +
          `First occurrence at ${original.file}:${original.start.line}`,
          { severity: 'suggestion', rule: 'dry/structural-similarity', symbol: block.hash }  // R7
        );
        violation.fix = {
          oldText: block.text,
          newText: `// Consider extracting to a shared function`
        };
        violations.push(violation);

        // Spec 13 R5 — seed pair for diverging-clone tracking
        const jaccardSim = computeJaccardSimilarity(
          original.normalizedText, block.normalizedText
        );
        this.seedPair(original, block, jaccardSim, 'dry/structural-similarity');
      }
    }
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
