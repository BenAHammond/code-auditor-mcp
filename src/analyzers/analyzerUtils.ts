/**
 * Functional utilities for analyzer development
 * These replace the BaseAnalyzer class with composable functions
 */

import type { AST, ASTNode } from '../languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import * as fs from 'fs/promises';
import { Violation, AnalyzerResult, SeverityLevel, AuditOptions } from '../types.js';
import {
  walkAST,
  isExported,
  getNodeName as bridgeGetNodeName,
  calculateComplexity as bridgeCalculateComplexity,
  getLineAndColumn as bridgeGetLineAndColumn,
} from '../languages/adapterBridge.js';

// Re-export utilities from other modules
export { parseTypeScriptFile } from '../utils/astParser.js';
export {
  getLineAndColumn,
  getNodeText,
  getImports,
  findNodesByKind
} from '../utils/astUtils.js';

/**
 * File analyzer function - processes a single file
 */
export type FileAnalyzerFunction = (
  filePath: string,
  ast: AST,
  config: any,
  sourceCode?: string
) => Promise<Violation[]> | Violation[];

/**
 * Progress reporter function
 */
export type ProgressReporter = (current: number, total: number, file: string) => void;

/**
 * Standard file processing function
 * Handles file reading, parsing, error handling, and progress reporting
 */
export async function processFiles(
  files: string[],
  analyzeFile: FileAnalyzerFunction,
  analyzerName: string,
  config: any = {},
  progressReporter?: ProgressReporter
): Promise<AnalyzerResult> {
  const violations: Violation[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let processedFiles = 0;
  const startTime = Date.now();

  for (const file of files) {
    try {
      // Report progress
      if (progressReporter) {
        progressReporter(processedFiles, files.length, file);
      }

      // Read and parse file
      const { parseTypeScriptFile: parse } = await import('../utils/astParser.js');
      const content = await fs.readFile(file, 'utf-8');
      const { ast, errors: parseErrors } = await parse(file);

      if (parseErrors.length > 0) {
        throw new Error(`Parse errors: ${parseErrors.map(e => e.message).join(', ')}`);
      }

      // Run analyzer-specific logic (pass source code for text extraction)
      const fileViolations = await analyzeFile(file, ast, config, content);
      violations.push(...fileViolations);

      processedFiles++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push({ file, error: errorMessage });
      console.error(`Error analyzing ${file}:`, error);
    }
  }

  const result: AnalyzerResult = {
    violations,
    filesProcessed: processedFiles,
    executionTime: Date.now() - startTime,
    analyzerName
  };

  if (errors.length > 0) {
    result.errors = errors;
  }

  return result;
}

/**
 * Create a violation object with defaults
 */
export function createViolation(
  data: Violation
): Violation {
  return data;
}

/**
 * Get line and column from an ASTNode
 */
export function getNodePosition(
  node: ASTNode
): { line: number; column: number } {
  const loc = bridgeGetLineAndColumn(node);
  return { line: loc.line, column: loc.column };
}

/**
 * Check if a node is exported
 */
export function isNodeExported(node: ASTNode): boolean {
  return isExported(node);
}

/**
 * Get the name of a node if it has one
 */
export function getNodeName(node: ASTNode): string | undefined {
  return bridgeGetNodeName(node) ?? undefined;
}

/**
 * Count specific node types in a subtree
 */
export function countNodesOfType(
  node: ASTNode,
  predicate: (node: ASTNode) => boolean
): number {
  let count = 0;
  walkAST(node, (n) => {
    if (predicate(n)) count++;
  });
  return count;
}

/**
 * Find all nodes of a specific type
 */
export function findNodesOfType(
  node: ASTNode,
  predicate: (node: ASTNode) => boolean
): ASTNode[] {
  const nodes: ASTNode[] = [];
  walkAST(node, (n) => {
    if (predicate(n)) nodes.push(n);
  });
  return nodes;
}

/**
 * Traverse AST with a visitor function
 */
export function traverseAST(
  node: ASTNode,
  visitor: (node: ASTNode) => void
): void {
  walkAST(node, visitor);
}

/**
 * Filter violations by severity
 */
export function filterViolationsBySeverity(
  violations: Violation[],
  minSeverity?: SeverityLevel
): Violation[] {
  if (!minSeverity) {
    return violations;
  }

  const severityOrder = { critical: 3, warning: 2, suggestion: 1, off: 0 };
  const minLevel = severityOrder[minSeverity] || 0;

  return violations.filter(v =>
    severityOrder[v.severity] >= minLevel
  );
}

/**
 * Sort violations by severity, file, and line
 */
export function sortViolations(violations: Violation[]): Violation[] {
  return violations.sort((a, b) => {
    // Sort by severity first
    const severityOrder = { critical: 3, warning: 2, suggestion: 1, off: 0 };
    const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
    if (severityDiff !== 0) return severityDiff;

    // Then by file
    const fileDiff = a.file.localeCompare(b.file);
    if (fileDiff !== 0) return fileDiff;

    // Then by line
    return (a.line || 0) - (b.line || 0);
  });
}

/**
 * Calculate cyclomatic complexity of a function
 */
export function calculateComplexity(node: ASTNode): number {
  return bridgeCalculateComplexity(node);
}

/**
 * Create a standard analyzer function
 */
export function createAnalyzer(
  name: string,
  fileAnalyzer: FileAnalyzerFunction,
  defaultConfig: any = {}
) {
  return async (files: string[], config: Record<string, unknown>, options?: { minSeverity?: string }) => {
    const mergedConfig = { ...defaultConfig, ...config };
    const result = await processFiles(files, fileAnalyzer, name, mergedConfig);

    // Apply filtering and sorting
    result.violations = sortViolations(
      filterViolationsBySeverity(result.violations, options?.minSeverity as SeverityLevel | undefined)
    );

    return result;
  };
}
