/**
 * Functional utilities for analyzer development
 * These replace the BaseAnalyzer class with composable functions
 */

import * as ts from 'typescript';
import * as fs from 'fs/promises';
import { Violation, AnalyzerResult, SeverityLevel, AuditOptions } from '../types.js';
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
  sourceFile: ts.SourceFile,
  config: any
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
      const { sourceFile, errors: parseErrors } = await parse(file);
      
      if (parseErrors.length > 0) {
        throw new Error(`Parse errors: ${parseErrors.map(e => e.messageText).join(', ')}`);
      }
      
      // Run analyzer-specific logic
      const fileViolations = await analyzeFile(file, sourceFile, config);
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
 * Get line and column from a TypeScript node
 */
export function getNodePosition(
  sourceFile: ts.SourceFile,
  node: ts.Node
): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { line: line + 1, column: character + 1 };
}

/**
 * Check if a node is exported
 */
export function isNodeExported(node: ts.Node): boolean {
  if (ts.canHaveModifiers(node)) {
    const modifiers = ts.getModifiers(node);
    return !!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  }
  return false;
}

/**
 * Get the name of a node if it has one
 */
export function getNodeName(node: ts.Node): string | undefined {
  if ('name' in node && node.name) {
    const name = node.name as ts.PropertyName;
    if (ts.isIdentifier(name)) {
      return name.text;
    }
  }
  return undefined;
}

/**
 * Count specific node types in a subtree
 */
export function countNodesOfType<T extends ts.Node>(
  node: ts.Node,
  predicate: (node: ts.Node) => node is T
): number {
  let count = 0;
  
  const visit = (node: ts.Node) => {
    if (predicate(node)) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  
  visit(node);
  return count;
}

/**
 * Find all nodes of a specific type
 */
export function findNodesOfType<T extends ts.Node>(
  node: ts.Node,
  predicate: (node: ts.Node) => node is T
): T[] {
  const nodes: T[] = [];
  
  const visit = (node: ts.Node) => {
    if (predicate(node)) {
      nodes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  
  visit(node);
  return nodes;
}

/**
 * Traverse AST with a visitor function
 */
export function traverseAST(
  node: ts.Node,
  visitor: (node: ts.Node) => void
): void {
  visitor(node);
  ts.forEachChild(node, child => traverseAST(child, visitor));
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
  
  const severityOrder = { critical: 3, warning: 2, suggestion: 1 };
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
    const severityOrder = { critical: 3, warning: 2, suggestion: 1 };
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
export function calculateComplexity(node: ts.FunctionLikeDeclaration): number {
  let complexity = 1;
  
  traverseAST(node, (child) => {
    if (
      ts.isIfStatement(child) ||
      ts.isConditionalExpression(child) ||
      ts.isSwitchStatement(child) ||
      ts.isForStatement(child) ||
      ts.isWhileStatement(child) ||
      ts.isDoStatement(child) ||
      ts.isCaseClause(child)
    ) {
      complexity++;
    }
    
    if (ts.isBinaryExpression(child)) {
      const operator = child.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken
      ) {
        complexity++;
      }
    }
  });
  
  return complexity;
}

/**
 * Create a standard analyzer function
 */
export function createAnalyzer(
  name: string,
  fileAnalyzer: FileAnalyzerFunction,
  defaultConfig: any = {}
) {
  return async (files, config, options) => {
    const mergedConfig = { ...defaultConfig, ...config };
    const result = await processFiles(files, fileAnalyzer, name, mergedConfig);
    
    // Apply filtering and sorting
    result.violations = sortViolations(
      filterViolationsBySeverity(result.violations, options?.minSeverity)
    );
    
    return result;
  };
}