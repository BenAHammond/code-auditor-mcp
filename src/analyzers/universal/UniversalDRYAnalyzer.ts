/**
 * Universal DRY (Don't Repeat Yourself) Analyzer
 * Works across multiple programming languages using the adapter pattern
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
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
}

export const DEFAULT_DRY_CONFIG: DRYAnalyzerConfig = {
  minLineThreshold: 5,
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
    
    // Store blocks for cross-file comparison
    // Note: In a real implementation, we'd need to aggregate blocks across all files
    // For now, we'll just detect duplicates within the same file
    const localIndex = this.buildLocalIndex(blocks);
    
    // Find duplicates
    for (const [hash, duplicateBlocks] of localIndex.hashMap) {
      if (duplicateBlocks.length > 1) {
        // Report all but the first occurrence
        for (let i = 1; i < duplicateBlocks.length; i++) {
          const block = duplicateBlocks[i];
          const original = duplicateBlocks[0];
          
          violations.push(this.createViolation(
            block.file,
            block.start,
            `Duplicate code block detected (${block.lineCount} lines). First occurrence at line ${original.start.line}`,
            'warning',
            'exact-duplicate',
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
    
    return {
      file: filePath,
      start: node.location.start,
      end: node.location.end,
      text,
      normalizedText,
      hash: this.hashCode(normalizedText),
      nodeType: node.type,
      lineCount
    };
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
    const blockTypes = ['Block', 'IfStatement', 'ForStatement', 'WhileStatement', 
                       'DoWhileStatement', 'SwitchStatement', 'TryStatement'];
    return blockTypes.some(type => node.type.includes(type));
  }
  
  private isStringLiteral(node: ASTNode, adapter: LanguageAdapter): boolean {
    return node.type.includes('StringLiteral') || node.type.includes('TemplateLiteral');
  }
}