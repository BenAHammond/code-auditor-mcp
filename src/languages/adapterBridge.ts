/**
 * Synchronous facade over tree-sitter LanguageAdapter.
 *
 * All public functions assert that tree-sitter parsers have been initialized
 * (entry points MUST call initParsers() first). An uninitialized call is a
 * programmer error and throws — the adapterBridge is never meant to recover.
 *
 * This module replaces the old TypeScript compiler API utils (astParser.ts,
 * astUtils.ts) with tree-sitter-powered equivalents that work through the
 * LanguageAdapter interface.
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { AST, ASTNode, SourceLocation } from './types.js';
import { LanguageRegistry } from './LanguageRegistry.js';
import { toASTNode, isFunctionType, isClassType, isLoopType, isConditionalType } from './tree-sitter/converter.js';
import { getParser, isInitialized } from './tree-sitter/parser.js';

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertInitialized(): void {
  if (!isInitialized()) {
    throw new Error(
      'Tree-sitter parsers not initialized. Call initParsers() before using adapterBridge.'
    );
  }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse a file synchronously into an AST.
 * Returns null on failure (no exceptions for parse errors).
 */
export function parseFile(filePath: string, content: string): AST | null {
  assertInitialized();

  const registry = LanguageRegistry.getInstance();
  const adapter = registry.getAdapterForFile(filePath);
  if (!adapter) return null;

  // adapter.parse() is async per the interface, but the tree-sitter implementation
  // is entirely synchronous. We call it via a sync path through the parser directly.
  return parseWithTreeSitter(filePath, content);
}

/**
 * Direct tree-sitter parse — bypasses the async adapter interface.
 */
function parseWithTreeSitter(filePath: string, content: string): AST | null {
  const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
  const isGo = filePath.endsWith('.go');
  const lang = isGo ? 'go' : isTsx ? 'tsx' : 'typescript';
  const grammarKey = isGo ? 'go' : isTsx ? 'tsx' : 'typescript';

  const parser = getParser(grammarKey, isTsx && !isGo);
  const tree = parser.parse(content);
  if (!tree) return null;

  const root = toASTNode(tree.rootNode, undefined, lang);

  const errors: Array<{ message: string; location: SourceLocation; severity: 'error' | 'warning' }> = [];
  collectErrors(tree.rootNode, errors);

  return { root, language: lang, filePath, errors };
}

function collectErrors(node: TreeSitterNode, errors: AST['errors']): void {
  if (node.isError || node.type === 'ERROR') {
    errors.push({
      message: `Parse error near "${node.text.slice(0, 40)}"`,
      location: {
        start: { line: node.startPosition.row, column: node.startPosition.column },
        end: { line: node.endPosition.row, column: node.endPosition.column },
      },
      severity: 'error',
    });
  }
  for (const child of node.children) {
    collectErrors(child, errors);
  }
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/**
 * Walk an AST depth-first, calling visitor for each node.
 */
export function walkAST(
  root: ASTNode,
  visitor: (node: ASTNode, depth: number) => void,
  depth: number = 0
): void {
  visitor(root, depth);
  if (root.children) {
    for (const child of root.children) {
      walkAST(child, visitor, depth + 1);
    }
  }
}

/**
 * Walk a raw TreeSitterNode depth-first.
 */
export function walkRaw(
  node: TreeSitterNode,
  visitor: (node: TreeSitterNode) => void
): void {
  visitor(node);
  for (const child of node.children) {
    walkRaw(child, visitor);
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Find all ASTNode matching a predicate.
 */
export function findNodes(
  ast: ASTNode,
  predicate: (node: ASTNode) => boolean
): ASTNode[] {
  const results: ASTNode[] = [];
  walkAST(ast, (node) => {
    if (predicate(node)) results.push(node);
  });
  return results;
}

/**
 * Find all TreeSitterNode matching a predicate.
 */
export function findRawNodes(
  node: TreeSitterNode,
  predicate: (node: TreeSitterNode) => boolean
): TreeSitterNode[] {
  const results: TreeSitterNode[] = [];
  walkRaw(node, (n) => {
    if (predicate(n)) results.push(n);
  });
  return results;
}

// ---------------------------------------------------------------------------
// Node information
// ---------------------------------------------------------------------------

/**
 * Get the source text for an ASTNode given the full source code.
 */
export function getNodeText(node: ASTNode, sourceCode: string): string {
  return sourceCode.slice(node.range[0], node.range[1]);
}

/**
 * Get a 1-based line and column from an ASTNode's start position.
 */
export function getLineAndColumn(node: ASTNode): { line: number; column: number } {
  return {
    line: node.location.start.line + 1,
    column: node.location.start.column + 1,
  };
}

/**
 * Get line and column from a byte position in source.
 * This is a fallback for when you don't have an ASTNode.
 */
export function positionToLineColumn(
  sourceCode: string,
  position: number
): { line: number; column: number } {
  const lines = sourceCode.slice(0, position).split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

// ---------------------------------------------------------------------------
// Type checks (string-based — no SyntaxKind enum)
// ---------------------------------------------------------------------------

const FUNCTION_TYPES = new Set([
  'function_declaration', 'function_expression', 'arrow_function',
  'method_definition', 'generator_function_declaration', 'generator_function_expression',
]);

const CLASS_TYPES = new Set(['class_declaration', 'class_expression']);

const IMPORT_TYPES = new Set(['import_statement', 'import']);

const EXPORT_TYPES = new Set(['export_statement']);

const LOOP_TYPES = new Set([
  'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
]);

const CONDITIONAL_TYPES = new Set([
  'if_statement', 'switch_statement', 'ternary_expression', 'switch_case',
]);

const VARIABLE_TYPES = new Set([
  'variable_declaration', 'variable_declarator', 'lexical_declaration',
]);

export function isFunctionNode(node: ASTNode): boolean {
  return FUNCTION_TYPES.has(node.type);
}

export function isClassNode(node: ASTNode): boolean {
  return CLASS_TYPES.has(node.type);
}

export function isImportNode(node: ASTNode): boolean {
  return IMPORT_TYPES.has(node.type);
}

export function isLoopNode(node: ASTNode): boolean {
  return LOOP_TYPES.has(node.type);
}

export function isConditionalNode(node: ASTNode): boolean {
  return CONDITIONAL_TYPES.has(node.type);
}

export function isVariableNode(node: ASTNode): boolean {
  return VARIABLE_TYPES.has(node.type);
}

// ---------------------------------------------------------------------------
// Modifier helpers
// ---------------------------------------------------------------------------

const MODIFIER_KEYWORDS = new Set([
  'export', 'default', 'async', 'static', 'public', 'private', 'protected',
  'readonly', 'abstract', 'declare',
]);

/**
 * Check if an ASTNode has a specific keyword modifier.
 * In tree-sitter, modifiers appear as anonymous child nodes.
 */
export function hasModifier(node: ASTNode, modifier: string): boolean {
  const raw = node.raw as TreeSitterNode;
  if (!raw?.children) return false;

  for (const child of raw.children) {
    if (!child.isNamed && child.type === modifier) return true;
  }
  return false;
}

/**
 * Check if a node is exported.
 */
export function isExported(node: ASTNode): boolean {
  // Check for `export` keyword among the node's own modifiers
  if (hasModifier(node, 'export')) return true;

  // Check if the parent is an export_statement
  const raw = node.raw as TreeSitterNode;
  if (raw?.parent?.type === 'export_statement') return true;

  // Walk up to check for export_statement ancestor
  let p = raw?.parent;
  while (p) {
    if (p.type === 'export_statement') return true;
    p = p.parent;
  }

  return false;
}

/**
 * Check if a node is async.
 */
export function isAsync(node: ASTNode): boolean {
  return hasModifier(node, 'async');
}

// ---------------------------------------------------------------------------
// Node name extraction
// ---------------------------------------------------------------------------

/**
 * Get the name of an ASTNode if it has one.
 * For tree-sitter, looks for a `name` property on the raw node,
 * or finds the first named child that looks like an identifier.
 */
export function getNodeName(node: ASTNode): string | null {
  const raw = node.raw as TreeSitterNode;
  if (!raw) return null;

  // Check for a direct name child
  for (const child of raw.namedChildren) {
    if (child.type === 'identifier' || child.type === 'property_identifier') {
      return child.text;
    }
  }

  // For variable_declarator nodes, the name is the first named child
  if (raw.type === 'variable_declarator') {
    const first = raw.namedChildren[0];
    if (first?.type === 'identifier') return first.text;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parameter count
// ---------------------------------------------------------------------------

/**
 * Count parameters of a function-like node.
 */
export function getParameterCount(node: ASTNode): number {
  const raw = node.raw as TreeSitterNode;
  if (!raw?.namedChildren) return 0;

  for (const child of raw.namedChildren) {
    if (child.type === 'formal_parameters') {
      return child.namedChildren.filter(
        (c: TreeSitterNode) => c.type === 'required_parameter' || c.type === 'optional_parameter'
      ).length;
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Complexity
// ---------------------------------------------------------------------------

/**
 * Calculate cyclomatic complexity by counting decision points.
 */
export function calculateComplexity(node: ASTNode): number {
  let complexity = 1;

  // Walk the tree-sitter subtree
  const raw = node.raw as TreeSitterNode;

  function count(node: TreeSitterNode): void {
    if (LOOP_TYPES.has(node.type) || CONDITIONAL_TYPES.has(node.type)) {
      complexity++;
    }
    // Logical operators (&&, ||) add complexity
    if (node.type === '&&' || node.type === '||') {
      complexity++;
    }
    for (const child of node.children) {
      count(child);
    }
  }

  // Start from the function body if possible
  const body = raw.namedChildren.find((c: TreeSitterNode) => c.type === 'statement_block');
  if (body) {
    count(body);
  } else {
    count(raw);
  }

  return complexity;
}

// ---------------------------------------------------------------------------
// Body text extraction
// ---------------------------------------------------------------------------

/**
 * Get the body text of a function-like node.
 */
export function getFunctionBody(node: ASTNode, sourceCode: string): string | undefined {
  const raw = node.raw as TreeSitterNode;
  if (!raw) return undefined;

  const body = raw.namedChildren.find((c: TreeSitterNode) =>
    c.type === 'statement_block'
  );
  if (body) {
    return sourceCode.slice(body.startIndex, body.endIndex);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Import extraction (synchronous convenience)
// ---------------------------------------------------------------------------

/**
 * Extract import info from source content.
 * Uses tree-sitter directly to find import statements.
 */
export function extractImports(
  filePath: string,
  content: string
): Array<{
  moduleSpecifier: string;
  importedNames: string[];
  isDefaultImport: boolean;
  isNamespaceImport: boolean;
  line: number;
}> {
  assertInitialized();
  const results: ReturnType<typeof extractImports> = [];

  const ast = parseFile(filePath, content);
  if (!ast) return results;

  // Find import_statement nodes
  const importNodes = findNodes(ast.root, (n) => n.type === 'import_statement');

  for (const imp of importNodes) {
    const raw = imp.raw as TreeSitterNode;
    const importedNames: string[] = [];
    let isDefault = false;
    let isNamespace = false;

    // Get module specifier (the string argument)
    const stringNodes = raw.namedChildren.filter((c: TreeSitterNode) => c.type === 'string');
    const moduleSpecifier = stringNodes.length > 0
      ? stringNodes[0].text.replace(/^["']|["']$/g, '')
      : '';

    // Get import clause
    const importClause = raw.namedChildren.find((c: TreeSitterNode) =>
      c.type === 'import_clause'
    );

    if (importClause) {
      for (const child of importClause.namedChildren) {
        if (child.type === 'identifier') {
          importedNames.push(child.text);
          isDefault = true;
        } else if (child.type === 'namespace_import') {
          const ident = child.namedChildren.find((c: TreeSitterNode) => c.type === 'identifier');
          if (ident) {
            importedNames.push(ident.text);
            isNamespace = true;
          }
        } else if (child.type === 'named_imports') {
          for (const spec of child.namedChildren) {
            if (spec.type === 'import_specifier') {
              const name = spec.namedChildren.find((c: TreeSitterNode) => c.type === 'identifier');
              if (name) importedNames.push(name.text);
            }
          }
        }
      }
    }

    results.push({
      moduleSpecifier,
      importedNames,
      isDefaultImport: isDefault,
      isNamespaceImport: isNamespace,
      line: raw.startPosition.row + 1,
    });
  }

  return results;
}
