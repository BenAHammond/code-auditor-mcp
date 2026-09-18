/**
 * AST Parser Utilities
 * Provides tree-sitter-based AST parsing and analysis utilities
 *
 * Core functionality for parsing TypeScript/JavaScript/Go files and
 * extracting information for code analysis.
 *
 * This module replaces the old TypeScript compiler API with tree-sitter
 * via the adapter bridge. Consumers receive AST/ASTNode instead of
 * ts.SourceFile/ts.Node.
 */

import { promises as fs } from 'fs';
import {
  parseFile,
  getNodeText,
  getLineAndColumn,
  hasModifier,
  calculateComplexity,
  isExported,
  getNodeName,
} from '../languages/adapterBridge.js';
import type { AST, ASTNode } from '../languages/types.js';
import { isFunctionType, isClassType } from '../languages/tree-sitter/converter.js';

// ---------------------------------------------------------------------------
// Re-export adapter bridge functions for consumers that already import from here
// ---------------------------------------------------------------------------
export { getNodeText, getLineAndColumn, hasModifier, calculateComplexity } from '../languages/adapterBridge.js';

// ---------------------------------------------------------------------------
// AST parse result
// ---------------------------------------------------------------------------

export interface ParseResult {
  ast: AST;
  errors: Array<{ message: string; line?: number; column?: number }>;
}

// ---------------------------------------------------------------------------
// Import / Export information (legacy types from astParser.ts)
// ---------------------------------------------------------------------------

export interface ExportInfo {
  name: string;
  type: 'function' | 'class' | 'interface' | 'type' | 'const' | 'let' | 'var' | 'enum';
  isDefault: boolean;
  line: number;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse a TypeScript/JavaScript/Go file and return AST.
 */
export async function parseTypeScriptFile(filePath: string): Promise<ParseResult> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const ast = parseFile(filePath, content);

    if (!ast) {
      return {
        ast: { root: { type: 'program', range: [0, 0], location: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } }, language: 'typescript', filePath, errors: [] },
        errors: [{ message: `Unsupported file type: ${filePath}` }],
      };
    }

    return {
      ast,
      errors: ast.errors.map(e => ({
        message: e.message,
        // collectErrors applies +1 for 0→1-based conversion; positions are 1-based here.
        line: e.location.start.line,
        column: e.location.start.column,
      })),
    };
  } catch (error) {
    return {
      ast: { root: { type: 'program', range: [0, 0], location: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } }, language: 'typescript', filePath, errors: [] },
      errors: [{ message: `Failed to read file: ${error}` }],
    };
  }
}

// ---------------------------------------------------------------------------
// Extract exports
// ---------------------------------------------------------------------------

/**
 * Extract export statements from an AST.
 */
export function getExports(ast: AST, sourceCode: string): ExportInfo[] {
  const exports: ExportInfo[] = [];

  // Walk the AST to find exported nodes
  function visit(node: ASTNode): void {
    // export_statement — covers "export { x }", "export default X", "export const X"
    if (node.type === 'export_statement') {
      for (const child of node.children ?? []) {
        const line = child.location?.start?.line ?? 1;

        // export default expr
        if (child.type === 'function_declaration') {
          const name = child.children?.find((c) => c.type === 'identifier');
          exports.push({
            name: name ? getNodeText(name, sourceCode) : 'default',
            type: 'function',
            isDefault: true,
            line,
          });
        } else if (child.type === 'class_declaration') {
          const name = child.children?.find((c) => c.type === 'identifier' || c.type === 'type_identifier');
          exports.push({
            name: name ? getNodeText(name, sourceCode) : 'default',
            type: 'class',
            isDefault: true,
            line,
          });
        } else if (child.type === 'lexical_declaration') {
          for (const decl of child.children ?? []) {
            if (decl.type === 'variable_declarator') {
              const name = decl.children?.find((c) => c.type === 'identifier');
              if (name) {
                exports.push({ name: getNodeText(name, sourceCode), type: 'const', isDefault: false, line });
              }
            }
          }
        } else if (child.type === 'export_clause') {
          for (const spec of child.children ?? []) {
            if (spec.type === 'export_specifier') {
              const name = spec.children?.find((c) => c.type === 'identifier');
              if (name) {
                exports.push({ name: getNodeText(name, sourceCode), type: 'const', isDefault: false, line: child.location?.start?.line ?? 1 });
              }
            }
          }
        }
      }
    }

    for (const c of node.children ?? []) visit(c);
  }

  visit(ast.root);
  return exports;
}

// ---------------------------------------------------------------------------
// Find nodes by type
// ---------------------------------------------------------------------------

/**
 * Find all ASTNode matching a type string (replaces ts.SyntaxKind enum).
 */
export function findNodesByType(
  ast: ASTNode,
  type: string
): ASTNode[] {
  const results: ASTNode[] = [];

  function walk(node: ASTNode): void {
    if (node.type === type) {
      results.push(node);
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(ast);
  return results;
}

/**
 * Kept for backward compatibility — returns ASTNode[] where each node's type
 * matches one of the provided type strings.
 */
export function findNodesByKind(
  ast: ASTNode,
  kind: string
): ASTNode[] {
  return findNodesByType(ast, kind);
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------
export { isExported } from '../languages/adapterBridge.js';
export { getNodeName };
