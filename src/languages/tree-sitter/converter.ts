/**
 * Convert tree-sitter TreeSitterNode → ASTNode
 *
 * Maps tree-sitter's S-expression node types (e.g. "function_declaration") to
 * the language-agnostic ASTNode format used by the LanguageAdapter interface.
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { ASTNode, SourceLocation } from '../types.js';

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a tree-sitter TreeSitterNode to an ASTNode.
 * The raw TreeSitterNode reference is preserved so adapters can access
 * tree-sitter-specific properties when needed.
 */
export function toASTNode(
  node: TreeSitterNode,
  parent?: ASTNode,
  language: string = 'typescript'
): ASTNode {
  const astNode: ASTNode = {
    type: node.type,
    range: [node.startIndex, node.endIndex],
    location: toSourceLocation(node),
    raw: node,
  };

  if (parent) {
    astNode.parent = parent;
  }

  // Build children recursively from named + significant children
  const childNodes = node.children.filter(
    (c: TreeSitterNode) => c.isNamed || isSignificantAnonymous(c)
  );

  if (childNodes.length > 0) {
    astNode.children = childNodes.map((c: TreeSitterNode) => toASTNode(c, astNode, language));
  }

  return astNode;
}

/**
 * Convert a tree-sitter node to a SourceLocation.
 */
export function toSourceLocation(node: TreeSitterNode): SourceLocation {
  return {
    start: {
      line: node.startPosition.row,
      // tree-sitter positions are 0-based; convert to 1-based columns
      column: node.startPosition.column,
    },
    end: {
      line: node.endPosition.row,
      column: node.endPosition.column,
    },
  };
}

// ---------------------------------------------------------------------------
// Node type classification
// ---------------------------------------------------------------------------

/**
 * Check if a S-expression type string represents a function-like node.
 */
export function isFunctionType(type: string): boolean {
  switch (type) {
    case 'function_declaration':
    case 'function_expression':
    case 'arrow_function':
    case 'method_definition':
    case 'generator_function_declaration':
    case 'generator_function_expression':
      return true;
    default:
      return false;
  }
}

/**
 * Check if a S-expression type string represents a class-like node.
 */
export function isClassType(type: string): boolean {
  switch (type) {
    case 'class_declaration':
    case 'class_expression':
      return true;
    default:
      return false;
  }
}

/**
 * Check if a S-expression type string represents an import statement.
 */
export function isImportType(type: string): boolean {
  switch (type) {
    case 'import_statement':
    case 'import':
      return true;
    default:
      return false;
  }
}

/**
 * Check if a S-expression type string represents an export statement.
 */
export function isExportType(type: string): boolean {
  switch (type) {
    case 'export_statement':
      return true;
    default:
      return false;
  }
}

/**
 * Check if a S-expression type string represents a loop node.
 */
export function isLoopType(type: string): boolean {
  switch (type) {
    case 'for_statement':
    case 'for_in_statement':
    case 'while_statement':
    case 'do_statement':
      return true;
    default:
      return false;
  }
}

/**
 * Check if a S-expression type string represents a conditional.
 */
export function isConditionalType(type: string): boolean {
  switch (type) {
    case 'if_statement':
    case 'switch_statement':
    case 'ternary_expression':
    case 'switch_case':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Some anonymous (unnamed) nodes are significant for analysis —
 * operators, keywords, delimiters that carry semantic meaning.
 */
const SIGNIFICANT_ANONYMOUS_TYPES = new Set([
  '+', '-', '*', '/', '%', '**',
  '+=', '-=', '*=', '/=',
  '&&', '||', '??',
  '===', '!==', '==', '!=', '<', '>', '<=', '>=',
  ':', ';', ',',
  'async', 'await', 'export', 'default', 'static',
  'readonly', 'public', 'private', 'protected',
  '?', '.', '?.', '...',
]);

function isSignificantAnonymous(node: TreeSitterNode): boolean {
  return SIGNIFICANT_ANONYMOUS_TYPES.has(node.type);
}
