/**
 * Universal DRY (Don't Repeat Yourself) Analyzer — Spec 17 R3
 *
 * R3.1: Self-reference fix — span-overlap check prevents a block from citing itself.
 * R3.2: Minimum block size 5 → 15.
 * R3.3: Rule-id split — dry/duplicate (exact token match) + dry/structural-similarity
 *       (identical token-kind sequence with different identifiers/literals).
 * R7:   dry/duplicate → warning, dry/structural-similarity → suggestion.
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation, FunctionMetadata } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../languages/types.js';
import * as crypto from 'crypto';

/**
 * Configuration for DRY analyzer
 */
export interface DRYAnalyzerConfig {
  minLineThreshold?: number;
  similarityThreshold?: number;
  excludePatterns?: string[];
  checkImports?: boolean;
  checkStrings?: boolean;
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
  checkImports: true,
  checkStrings: true,
  ignoreComments: true,
  ignoreWhitespace: true
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

interface CodeIndex {
  blocks: CodeBlock[];
  hashMap: Map<string, CodeBlock[]>;
  stringLiterals: Map<string, Array<{ file: string; line: number; column: number }>>;
  imports: Map<string, string[]>; // import path -> files
}

export class UniversalDRYAnalyzer extends UniversalAnalyzer {
  readonly name = 'dry';
  readonly description = 'Detects code duplication across the codebase';
  readonly category = 'maintainability';
  
  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: DRYAnalyzerConfig,
    sourceCode: string
  ): Promise<Violation[]> {
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_DRY_CONFIG, ...config };

    // Skip if file matches exclude patterns
    if (this.isExcluded(ast.filePath, finalConfig.excludePatterns || [])) {
      return violations;
    }

    // Extract code blocks from this file
    const blocks = this.extractCodeBlocks(ast, adapter, sourceCode, finalConfig);

    // R3.1: Deduplicate blocks — sort by (file, startLine) and merge overlapping spans
    const deduped = this.deduplicateBlocks(blocks);

    // ── R3.3: dry/duplicate — exact token-identical match (warning) ─────
    const exactHashmap = this.groupByHash(deduped, 'hash');

    for (const [, group] of exactHashmap) {
      if (group.length < 2) continue;

      // R3.1: Find earliest occurrence as "original" — sort by (file, startLine)
      const sorted = [...group].sort(this.byFileAndLine);
      const original = sorted[0];

      for (let i = 1; i < sorted.length; i++) {
        const block = sorted[i];

        // R3.1: Span-overlap check — skip if block overlaps with original
        if (this.spansOverlap(original, block)) continue;

        violations.push(this.createViolation(
          block.file,
          block.start,
          `Duplicate code block detected (${block.lineCount} lines). ` +
          `First occurrence at ${original.file}:${original.start.line}`,
          'warning',                                         // R7
          'dry/duplicate',
          {
            oldText: block.text,
            newText: `// Consider extracting to a shared function`
          }
        ));
      }
    }

    // ── R3.3: dry/structural-similarity — token-kind match (suggestion) ─
    const structuralHashmap = this.groupByHash(deduped, 'structuralHash');

    for (const [, group] of structuralHashmap) {
      if (group.length < 2) continue;

      const sorted = [...group].sort(this.byFileAndLine);
      const original = sorted[0];

      for (let i = 1; i < sorted.length; i++) {
        const block = sorted[i];

        // Skip if these are already exact duplicates (reported above)
        if (original.hash === block.hash) continue;

        // R3.1: Span-overlap check
        if (this.spansOverlap(original, block)) continue;

        violations.push(this.createViolation(
          block.file,
          block.start,
          `Structurally similar code block detected (${block.lineCount} lines). ` +
          `First occurrence at ${original.file}:${original.start.line}`,
          'suggestion',                                      // R7
          'dry/structural-similarity',
          {
            oldText: block.text,
            newText: `// Consider extracting to a shared function`
          }
        ));
      }
    }

    // ── Cross-file duplicate detection (scoped audit) ──────────────────
    if (finalConfig.fullFunctionIndex && finalConfig.fullFunctionIndex.length > 0) {
      const fullHashmap = new Map<string, { file: string; name: string; line: number }>();

      for (const func of finalConfig.fullFunctionIndex) {
        const body = (func as any).body ?? (func as any).metadata?.body;
        if (!body) continue;

        try {
          const normalized = this.normalizeCode(body, finalConfig);
          const hash = this.hashCode(normalized);
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

      for (const block of blocks) {
        if (!this.isBlockLargeEnough(block, finalConfig)) continue;

        const fullMatch = fullHashmap.get(block.hash);
        if (fullMatch && fullMatch.file !== block.file) {
          violations.push(this.createViolation(
            block.file,
            block.start,
            `Duplicate code block detected (${block.lineCount} lines). ` +
            `First occurrence in ${fullMatch.file}:${fullMatch.line} (${fullMatch.name})`,
            'warning',
            'dry/duplicate',
            {
              oldText: block.text,
              newText: `// Consider extracting to a shared function`
            }
          ));
        }
      }
    }

    // Check for duplicate string literals if enabled
    if (finalConfig.checkStrings) {
      const stringViolations = this.checkDuplicateStrings(ast, adapter, sourceCode);
      violations.push(...stringViolations);
    }

    // Check for duplicate imports if enabled
    if (finalConfig.checkImports) {
      const importViolations = this.checkDuplicateImports(ast, adapter);
      violations.push(...importViolations);
    }

    return violations;
  }

  // ── R3.1: Span-overlap helpers ──────────────────────────────────────

  /**
   * Returns true if the two blocks share code spans (same file + overlapping lines).
   */
  private spansOverlap(a: CodeBlock, b: CodeBlock): boolean {
    if (a.file !== b.file) return false;
    return !(a.end.line < b.start.line || b.end.line < a.start.line);
  }

  /**
   * Sort comparator: earliest file+line first.
   */
  private byFileAndLine(a: CodeBlock, b: CodeBlock): number {
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
  private deduplicateBlocks(blocks: CodeBlock[]): CodeBlock[] {
    if (blocks.length <= 1) return blocks;

    // Sort by (file, startLine)
    const sorted = [...blocks].sort(this.byFileAndLine);
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
  private groupByHash(
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
  private normalizeStructure(code: string): string {
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
   * Extract code blocks from AST
   */
  private extractCodeBlocks(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
    config: DRYAnalyzerConfig
  ): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    
    // Extract functions
    const functions = adapter.extractFunctions(ast);
    for (const func of functions) {
      const node = this.findNodeByLocation(ast.root, func.location.start);
      if (node) {
        const block = this.createCodeBlock(
          ast.filePath,
          node,
          adapter,
          sourceCode,
          config
        );
        if (block && this.isBlockLargeEnough(block, config)) {
          blocks.push(block);
        }
      }
    }
    
    // Extract classes and their methods
    const classes = adapter.extractClasses(ast);
    for (const cls of classes) {
      // Add the class itself
      const classNode = this.findNodeByLocation(ast.root, cls.location.start);
      if (classNode) {
        const block = this.createCodeBlock(
          ast.filePath,
          classNode,
          adapter,
          sourceCode,
          config
        );
        if (block && this.isBlockLargeEnough(block, config)) {
          blocks.push(block);
        }
      }
      
      // Add methods
      for (const method of cls.methods) {
        const methodNode = this.findNodeByLocation(ast.root, method.location.start);
        if (methodNode) {
          const block = this.createCodeBlock(
            ast.filePath,
            methodNode,
            adapter,
            sourceCode,
            config
          );
          if (block && this.isBlockLargeEnough(block, config)) {
            blocks.push(block);
          }
        }
      }
    }
    
    // Extract significant code blocks (loops, conditionals, etc.)
    this.walkAST(ast.root, node => {
      if (this.isSignificantBlock(node, adapter)) {
        const block = this.createCodeBlock(
          ast.filePath,
          node,
          adapter,
          sourceCode,
          config
        );
        if (block && this.isBlockLargeEnough(block, config)) {
          blocks.push(block);
        }
      }
    });
    
    return blocks;
  }
  
  /**
   * Create a code block from an AST node
   */
  private createCodeBlock(
    filePath: string,
    node: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string,
    config: DRYAnalyzerConfig
  ): CodeBlock | null {
    const text = adapter.getNodeText(node, sourceCode);
    if (!text) return null;

    const normalizedText = this.normalizeCode(text, config);
    const lineCount = this.countLines(text);

    // R3.3: Compute structural hash from token-kind sequence
    const structuralNormalized = this.normalizeCodeForStructure(text, config);
    const structuralHash = this.hashCode(structuralNormalized);

    return {
      file: filePath,
      start: node.location.start,
      end: node.location.end,
      text,
      normalizedText,
      hash: this.hashCode(normalizedText),
      structuralHash,
      nodeType: node.type,
      lineCount
    };
  }

  /**
   * R3.3: Normalize code for structural comparison.
   * First applies standard normalization (whitespace/comments), then
   * replaces identifiers and literals with placeholders.
   */
  private normalizeCodeForStructure(code: string, config: DRYAnalyzerConfig): string {
    const normalized = this.normalizeCode(code, config);
    return this.normalizeStructure(normalized);
  }
  
  /**
   * Normalize code for comparison
   */
  private normalizeCode(code: string, config: DRYAnalyzerConfig): string {
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
   * Hash code for comparison
   */
  private hashCode(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }
  
  /**
   * Count lines in text
   */
  private countLines(text: string): number {
    return text.split('\n').filter(line => line.trim().length > 0).length;
  }
  
  /**
   * Check if block is large enough to be considered
   */
  private isBlockLargeEnough(block: CodeBlock, config: DRYAnalyzerConfig): boolean {
    return block.lineCount >= (config.minLineThreshold || 5);
  }
  
  /**
   * Build local index for duplicate detection
   */
  private buildLocalIndex(blocks: CodeBlock[]): CodeIndex {
    const index: CodeIndex = {
      blocks,
      hashMap: new Map(),
      stringLiterals: new Map(),
      imports: new Map()
    };
    
    // Group blocks by hash
    for (const block of blocks) {
      const existing = index.hashMap.get(block.hash) || [];
      existing.push(block);
      index.hashMap.set(block.hash, existing);
    }
    
    return index;
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
        violations.push(this.createViolation(
          ast.filePath,
          locations[0],
          `String literal "${value.substring(0, 30)}..." is duplicated ${locations.length} times`,
          'suggestion',
          'duplicate-string-literal',
          {
            oldText: value,
            newText: '// Consider extracting to a constant'
          }
        ));
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
          'warning',
          'duplicate-import'
        ));
      }
    }
    
    return violations;
  }
  
  /**
   * Helper methods
   */
  private isExcluded(filePath: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return regex.test(filePath);
    });
  }
  
  private findNodeByLocation(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
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
  
  private walkAST(node: ASTNode, callback: (node: ASTNode) => void): void {
    callback(node);
    if (node.children) {
      for (const child of node.children) {
        this.walkAST(child, callback);
      }
    }
  }
  
  private isSignificantBlock(node: ASTNode, adapter: LanguageAdapter): boolean {
    // Check if this is a block-like structure (if, for, while, etc.)
    // Uses exact snake_case matches against tree-sitter node types.
    const blockTypes = new Set([
      'if_statement', 'for_statement', 'for_in_statement',
      'while_statement', 'do_statement', 'switch_statement', 'try_statement',
    ]);
    return blockTypes.has(node.type);
  }

  private isStringLiteral(node: ASTNode, adapter: LanguageAdapter): boolean {
    return node.type === 'string' || node.type === 'template_string';
  }
}