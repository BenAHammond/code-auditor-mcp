/**
 * AST Utility Functions
 * Provides helper functions for working with tree-sitter AST nodes
 *
 * ## Migration: TypeScript Compiler API → tree-sitter
 *
 * All functions now use tree-sitter `ASTNode` via the `adapterBridge` facade.
 * The `ts.SourceFile` parameter has been replaced with `ASTNode` (root node).
 * For source-code-dependent operations, `sourceCode: string` is passed separately.
 */

import type { ASTNode, AST, ImportInfo, ImportSpecifier } from '../languages/types.js';
import { ExportInfo, ImportMapping, UsageInfo } from '../types.js';
import {
  walkAST,
  findNodes,
  getNodeText,
  getLineAndColumn as bridgeGetLineAndColumn,
  isExported as bridgeIsExported,
  calculateComplexity as bridgeCalculateComplexity,
  hasModifier,
} from '../languages/adapterBridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the first child of a given type. */
function findChildOfType(node: ASTNode, type: string): ASTNode | undefined {
  return node.children?.find(c => c.type === type);
}

// ---------------------------------------------------------------------------
// Node finding (re-exports from adapterBridge)
// ---------------------------------------------------------------------------

/**
 * Find all nodes matching a predicate in the AST subtree.
 * Replacement for the old `findNodesByKind<T>(node, SyntaxKind)`.
 *
 * @param root - The root AST node to search within.
 * @param predicate - Predicate that returns true for nodes to keep.
 * @returns All nodes for which the predicate returns true.
 */
export function findNodesByType(
  root: ASTNode,
  predicate: (node: ASTNode) => boolean
): ASTNode[] {
  return findNodes(root, predicate);
}

// ---------------------------------------------------------------------------
// Text extraction (re-exports from adapterBridge)
// ---------------------------------------------------------------------------

/**
 * Get the text content of a node.
 * Uses sourceCode if provided; falls back to raw tree-sitter text.
 */
export { getNodeText };

// ---------------------------------------------------------------------------
// Position helpers (re-exports from adapterBridge)
// ---------------------------------------------------------------------------

/**
 * Get line and column number for a tree-sitter ASTNode.
 */
export { bridgeGetLineAndColumn as getLineAndColumn };

// ---------------------------------------------------------------------------
// Export checks (re-exports from adapterBridge)
// ---------------------------------------------------------------------------

export { bridgeIsExported as isExported };

// ---------------------------------------------------------------------------
// Complexity (re-exports from adapterBridge)
// ---------------------------------------------------------------------------

export { bridgeCalculateComplexity as calculateComplexity };

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Extract import statements from an AST root node.
 * Uses tree-sitter import_statement structure:
 *   import_statement → import_clause? → (identifier | named_imports) → string
 *
 * @param root - The root AST node to search for import statements.
 * @param sourceCode - The original source text for name extraction.
 * @returns The list of extracted imports.
 */
export function getImports(root: ASTNode, sourceCode: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const importNodes = findNodes(root, n => n.type === 'import_statement');

  for (const node of importNodes) {
    // Module specifier (the string literal at the end)
    const moduleNode = findChildOfType(node, 'string');
    if (!moduleNode) continue;
    const source = getNodeText(moduleNode, sourceCode).replace(/^["']|["']$/g, '');

    const specifiers: ImportSpecifier[] = [];
    const importClause = findChildOfType(node, 'import_clause');

    if (importClause) {
      // Default import (identifier child of import_clause that's not the `type` keyword)
      const defaultId = importClause.children?.find(
        c => c.type === 'identifier'
      );
      if (defaultId) {
        specifiers.push({
          name: getNodeText(defaultId, sourceCode),
          isDefault: true,
          isNamespace: false,
        });
      }

      // Named imports
      const namedImports = findChildOfType(importClause, 'named_imports');
      if (namedImports) {
        for (const child of namedImports.children ?? []) {
          if (child.type !== 'import_specifier') continue;
          // import { name } / { name as alias } / { default as name }
          const ids = child.children?.filter(c => c.type === 'identifier') ?? [];
          if (ids.length > 0) {
            const imported = getNodeText(ids[0], sourceCode);
            const local = getNodeText(ids[ids.length - 1], sourceCode);
            specifiers.push({
              name: local,
              alias: imported !== local ? imported : undefined,
              isDefault: imported === 'default',
              isNamespace: false,
            });
          }
        }
      }

      // Namespace import
      const namespaceImport = findChildOfType(importClause, 'namespace_import');
      if (namespaceImport) {
        const nsId = findChildOfType(namespaceImport, 'identifier');
        if (nsId) {
          specifiers.push({
            name: getNodeText(nsId, sourceCode),
            isDefault: false,
            isNamespace: true,
          });
        }
      }
    }

    imports.push({ source, specifiers, location: node.location });
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * Extract export statements from an AST root node.
 * Uses tree-sitter export_statement structure.
 *
 * @param root - The root AST node to search for export statements.
 * @param sourceCode - The original source text for name extraction.
 * @returns The list of extracted exports.
 */
export function getExports(root: ASTNode, sourceCode: string): ExportInfo[] {
  const exports: ExportInfo[] = [];

  // export declarations: export { name1, name2 }
  const exportNodes = findNodes(root, n =>
    n.type === 'export_statement' || n.type === 'export_declaration'
  );

  for (const node of exportNodes) {
    const { line } = bridgeGetLineAndColumn(node);

    // Check for type-only exports
    const isTypeOnly = hasModifier(node, 'type');

    // export clause with named exports (`export { a, b }`) — the `export_clause`
    // holds `export_specifier` children directly (no `named_exports` node).
    const exportClause = findChildOfType(node, 'export_clause');
    if (exportClause) {
      for (const child of exportClause.children ?? []) {
        if (child.type !== 'export_specifier') continue;
        const ids = child.children?.filter(c => c.type === 'identifier') ?? [];
        if (ids.length > 0) {
          exports.push({
            name: getNodeText(ids[ids.length - 1], sourceCode),
            isDefault: false,
            isTypeOnly,
            line
          });
        }
      }
    }

    // Check for `default` keyword — export default X
    const isDefault = hasModifier(node, 'default');
    if (isDefault) {
      const exported = node.children?.find(
        c => c.type === 'identifier' || c.type === 'function_declaration' ||
             c.type === 'class_declaration' || c.type === 'call_expression'
      );
      if (exported) {
        const nameNode = findChildOfType(exported, 'identifier');
        exports.push({
          name: nameNode ? getNodeText(nameNode, sourceCode) : 'default',
          isDefault: true,
          isTypeOnly,
          line
        });
      }
    }
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Function finding
// ---------------------------------------------------------------------------

/**
 * Find all function declarations in the AST.
 */
export function findFunctions(root: ASTNode): ASTNode[] {
  return findNodes(root, n => n.type === 'function_declaration');
}

// ---------------------------------------------------------------------------
// Class finding
// ---------------------------------------------------------------------------

/**
 * Find all class declarations in the AST.
 */
export function findClasses(root: ASTNode): ASTNode[] {
  return findNodes(root, n => n.type === 'class_declaration');
}

// ---------------------------------------------------------------------------
// AST node inspection
// ---------------------------------------------------------------------------

/**
 * Get AST node for inspection/debugging.
 *
 * @param node - The AST node to inspect.
 * @param sourceCode - The original source text for text extraction.
 * @returns A plain-object snapshot of the node and its children.
 */
export function getASTNode(node: ASTNode, sourceCode: string): any {
  return {
    type: node.type,
    text: getNodeText(node, sourceCode),
    children: (node.children ?? []).map(child => getASTNode(child, sourceCode))
  };
}

// ---------------------------------------------------------------------------
// Decorator checks
// ---------------------------------------------------------------------------

/**
 * Check if a node has a specific decorator.
 * Tree-sitter parses decorators as `decorator` nodes.
 *
 * @param node - The AST node to search for decorators.
 * @param decoratorName - The decorator name to match.
 * @param sourceCode - The original source text for name extraction.
 * @returns True if the node carries a matching decorator.
 */
export function hasDecorator(node: ASTNode, decoratorName: string, sourceCode: string): boolean {
  const decorators = findNodes(node, n => n.type === 'decorator');
  return decorators.some(decorator => {
    // decorator → call_expression → identifier (e.g., @Component())
    const callExpr = findChildOfType(decorator, 'call_expression');
    if (callExpr) {
      const callee = callExpr.children?.[0];
      if (callee?.type === 'identifier' && getNodeText(callee, sourceCode) === decoratorName) {
        return true;
      }
    }
    // decorator → identifier (e.g., @deprecated)
    const id = findChildOfType(decorator, 'identifier');
    if (id && getNodeText(id, sourceCode) === decoratorName) {
      return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Class method extraction
// ---------------------------------------------------------------------------

/**
 * Get method names from a class declaration node.
 * Tree-sitter: class_declaration → class_body → method_definition / public_field_definition
 *
 * @param classNode - The class declaration node to inspect.
 * @param sourceCode - The original source text for name extraction.
 * @returns The names of the class's methods and public fields.
 */
export function getClassMethods(classNode: ASTNode, sourceCode: string): string[] {
  const methods: string[] = [];
  const classBody = findChildOfType(classNode, 'class_body');
  if (!classBody) return methods;

  for (const member of classBody.children ?? []) {
    if (member.type === 'method_definition' || member.type === 'public_field_definition') {
      const nameNode = member.children?.find(
        c => c.type === 'identifier' || c.type === 'property_identifier'
      );
      if (nameNode) {
        methods.push(getNodeText(nameNode, sourceCode));
      }
    }
  }

  return methods;
}

// ---------------------------------------------------------------------------
// Line counting
// ---------------------------------------------------------------------------

/**
 * Count lines of code (excluding comments and empty lines).
 * Takes source text directly instead of ts.SourceFile.
 *
 * @param sourceCode - The source text to count lines in.
 * @returns The number of non-comment, non-empty lines.
 */
export function countLinesOfCode(sourceCode: string): number {
  const lines = sourceCode.split('\n');
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')) {
      count++;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Variable declaration finding
// ---------------------------------------------------------------------------

/**
 * Find all variable declarations in the AST.
 * Tree-sitter: variable_declarator nodes.
 */
export function findVariableDeclarations(root: ASTNode): ASTNode[] {
  return findNodes(root, n => n.type === 'variable_declarator');
}

// ---------------------------------------------------------------------------
// Async function check
// ---------------------------------------------------------------------------

/**
 * Check if a function node is async.
 */
export function isAsyncFunction(node: ASTNode): boolean {
  return hasModifier(node, 'async');
}

// ---------------------------------------------------------------------------
// Parameter count
// ---------------------------------------------------------------------------

/**
 * Get parameter count for a function/method node.
 * Tree-sitter: formal_parameters → required_parameter / optional_parameter.
 *
 * @param node - The function or method node to inspect.
 * @returns The number of declared parameters.
 */
export function getParameterCount(node: ASTNode): number {
  const params = findChildOfType(node, 'formal_parameters');
  if (!params) return 0;

  let count = 0;
  for (const child of params.children ?? []) {
    if (child.type === 'required_parameter' || child.type === 'optional_parameter' ||
        child.type === 'rest_parameter') {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Type alias finding
// ---------------------------------------------------------------------------

/**
 * Find all type aliases in the AST.
 * Tree-sitter: type_alias_declaration nodes.
 */
export function findTypeAliases(root: ASTNode): ASTNode[] {
  return findNodes(root, n => n.type === 'type_alias_declaration');
}

// ---------------------------------------------------------------------------
// Interface finding
// ---------------------------------------------------------------------------

/**
 * Find all interface declarations in the AST.
 * Tree-sitter: interface_declaration nodes.
 */
export function findInterfaces(root: ASTNode): ASTNode[] {
  return findNodes(root, n => n.type === 'interface_declaration');
}

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

/**
 * Parse a TypeScript file and return an AST.
 * Uses the adapterBridge parseFile function.
 *
 * @param filePath - The path of the file to parse.
 * @returns The parsed AST plus any parse errors.
 */
export async function parseTypeScriptFile(
  filePath: string
): Promise<{ ast: AST; errors: { message: string; line?: number; column?: number }[] }> {
  // Dynamic import to avoid circular dependency
  const { parseFile } = await import('../languages/adapterBridge.js');
  const fs = await import('fs').then(m => m.promises);
  const content = await fs.readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, content);
  if (!ast) {
    const failLocation = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
    const failAst: AST = { root: { type: 'source_file', range: [0, 0], location: failLocation }, language: 'unknown', filePath, errors: [{ message: 'Failed to parse file', location: failLocation, severity: 'error' }] };
    return { ast: failAst, errors: [{ message: 'Failed to parse file', line: 0, column: 0 }] };
  }
  return { ast, errors: ast.errors ?? [] };
}

// ---------------------------------------------------------------------------
// Detailed imports
// ---------------------------------------------------------------------------

/**
 * Enhanced version of getImports that returns detailed ImportMapping[].
 * Uses tree-sitter import_statement traversal.
 *
 * @param root - The root AST node to search for import statements.
 * @param sourceCode - The original source text for name extraction.
 * @returns The detailed import mappings extracted from the file.
 */
export function getImportsDetailed(root: ASTNode, sourceCode: string): ImportMapping[] {
  const imports: ImportMapping[] = [];
  const importNodes = findNodes(root, n => n.type === 'import_statement');

  for (const node of importNodes) {
    const moduleNode = findChildOfType(node, 'string');
    if (!moduleNode) continue;

    const moduleSpecifier = getNodeText(moduleNode, sourceCode).replace(/^["']|["']$/g, '');

    const importClause = findChildOfType(node, 'import_clause');
    if (!importClause) {
      // Side-effect import (no import clause)
      imports.push({
        localName: `[side-effect]::${moduleSpecifier}`,
        importedName: '[side-effect]',
        modulePath: moduleSpecifier,
        importType: 'namespace' as any, // side-effect imports treated as namespace
        isTypeOnly: false
      });
      continue;
    }

    const isTypeOnly = hasModifier(importClause, 'type');

    // Default import
    const defaultId = importClause.children?.find(c => c.type === 'identifier');
    if (defaultId) {
      imports.push({
        localName: getNodeText(defaultId, sourceCode),
        importedName: 'default',
        modulePath: moduleSpecifier,
        importType: 'default',
        isTypeOnly: isTypeOnly || false
      });
    }

    // Named imports
    const namedImports = findChildOfType(importClause, 'named_imports');
    if (namedImports) {
      for (const child of namedImports.children ?? []) {
        if (child.type !== 'import_specifier') continue;
        const identifiers = child.children?.filter(c => c.type === 'identifier') ?? [];
        if (identifiers.length === 0) continue;

        const localName = getNodeText(identifiers[identifiers.length - 1], sourceCode);
        const importedName = identifiers.length > 1 ? getNodeText(identifiers[0], sourceCode) : localName;

        imports.push({
          localName,
          importedName,
          modulePath: moduleSpecifier,
          importType: 'named',
          isTypeOnly: isTypeOnly || false
        });
      }
    }

    // Namespace import
    const nsImport = findChildOfType(importClause, 'namespace_import');
    if (nsImport) {
      const nsId = findChildOfType(nsImport, 'identifier');
      if (nsId) {
        imports.push({
          localName: getNodeText(nsId, sourceCode),
          importedName: '*',
          modulePath: moduleSpecifier,
          importType: 'namespace',
          isTypeOnly: isTypeOnly || false
        });
      }
    }
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

/**
 * Get re-exports from a source file.
 * Tree-sitter: export_statement → string (module specifier).
 *
 * @param root - The root AST node to search for re-exports.
 * @param sourceCode - The original source text for name extraction.
 * @returns The list of re-exported names and their source modules.
 */
export function getReExports(root: ASTNode, sourceCode: string): Array<{ name: string; module: string }> {
  const reExports: Array<{ name: string; module: string }> = [];
  const exportNodes = findNodes(root, n =>
    n.type === 'export_statement' || n.type === 'export_declaration'
  );

  for (const node of exportNodes) {
    // Check if there's a module specifier (export { x } from './y')
    const moduleNode = findChildOfType(node, 'string');
    if (!moduleNode) continue;
    const moduleSpecifier = getNodeText(moduleNode, sourceCode).replace(/^["']|["']$/g, '');

    const exportClause = findChildOfType(node, 'export_clause');
    if (exportClause) {
      for (const child of exportClause.children ?? []) {
        if (child.type !== 'export_specifier') continue;
        const identifiers = child.children?.filter(c => c.type === 'identifier') ?? [];
        if (identifiers.length > 0) {
          const name = identifiers.length > 1
            ? getNodeText(identifiers[0], sourceCode)
            : getNodeText(identifiers[identifiers.length - 1], sourceCode);
          reExports.push({ name, module: moduleSpecifier });
        }
      }
    } else {
      // export * from './module' — no export clause
      reExports.push({ name: '*', module: moduleSpecifier });
    }
  }

  return reExports;
}

// ---------------------------------------------------------------------------
// Identifier usage extraction
// ---------------------------------------------------------------------------

/**
 * Check whether an identifier node is used in a type-only position.
 *
 * Tree-sitter equivalence mapping for the original TS API checks:
 *
 * | TS API check                       | Tree-sitter equivalent                 |
 * |------------------------------------|----------------------------------------|
 * | ts.isTypeNode(p)                   | p.type === 'type_annotation'           |
 * | ts.isTypeReferenceNode(p)          | p.type === 'type_reference'            |
 * | ts.isTypeQueryNode(p)              | p.type === 'typeof_expression'         |
 * | ts.isQualifiedName(p)              | p.type === 'qualified_name'            |
 * | ts.isExpressionWithTypeArguments(p)| p.type === 'generic_type'              |
 * | ts.isPropertyAccessExpression(p)   | p.type === 'member_expression'         |
 * | ts.isHeritageClause(p)             | p.type === 'heritage_clause'           |
 * | ts.isInterfaceDeclaration(p)       | p.type === 'interface_declaration'     |
 * | ts.isTypeAliasDeclaration(p)       | p.type === 'type_alias_declaration'    |
 * | ts.isClassDeclaration(p)           | p.type === 'class_declaration'         |
 * | ts.isTypeParameterDeclaration(p)   | p.type === 'type_parameter'            |
 * | ts.isVariableDeclaration(p)        | p.type === 'variable_declarator'       |
 * | ts.isAsExpression(p)               | p.type === 'as_expression'             |
 * | ts.isTypeAssertionExpression(p)    | p.type === 'type_assertion'            |
 * | ts.isSatisfiesExpression(p)        | (not directly; check parent)           |
 * | ts.isTypeReferenceNode(p)          | p.type === 'type_identifier'           |
 * | ts.isUnionTypeNode(p)              | p.type === 'union_type'                |
 * | ts.isIntersectionTypeNode(p)       | p.type === 'intersection_type'         |
 * | ts.isConditionalTypeNode(p)        | p.type === 'conditional_type'          |
 * | ts.isMappedTypeNode(p)             | p.type === 'mapped_type_clause'        |
 * | ts.isIndexSignatureDeclaration(p)  | p.type === 'index_signature'           |
 * | ts.isTypePredicateNode(p)          | p.type === 'type_predicate'            |
 * | ts.isMethodDeclaration(p)          | p.type === 'method_definition'         |
 * | ts.isMethodSignature(p)            | p.type === 'method_signature'          |
 * | ts.isPropertyDeclaration(p)        | p.type === 'class_property'            |
 * | ts.isPropertySignature(p)          | p.type === 'property_signature'        |
 * | ts.isGetAccessorDeclaration(p)     | p.type === 'get_accessor'              |
 * | ts.isFunctionDeclaration(p)        | p.type === 'function_declaration'      |
 * | ts.isArrowFunction(p)              | p.type === 'arrow_function'            |
 * | ts.isFunctionExpression(p)         | p.type === 'function_expression'       |
 * | ts.isParameter(p)                  | p.type === 'required_parameter'        |
 * | ts.isCallExpression(p)             | p.type === 'call_expression'           |
 * | ts.isNewExpression(p)              | p.type === 'new_expression'            |
 * | ts.isTaggedTemplateExpression(p)   | p.type === 'tagged_template_literal'   |
 * | ts.isImportDeclaration(p)          | p.type === 'import_statement'          |
 * | ts.isImportSpecifier(p)            | p.type === 'import_specifier'          |
 * | ts.isImportClause(p)               | p.type === 'import_clause'             |
 * | ts.isNamedImports(p)               | p.type === 'named_imports'             |
 * | ts.isExportSpecifier(p)            | p.type === 'export_specifier'          |
 * | ts.isJsxElement(p)                 | p.type === 'jsx_element'               |
 * | ts.isJsxSelfClosingElement(p)      | p.type === 'jsx_self_closing_element'  |
 * | ts.isDecorator(p)                  | p.type === 'decorator'                 |
 * | ts.isSpreadElement(p)              | p.type === 'spread_element'            |
 * | ts.isSpreadAssignment(p)           | p.type === 'spread_element'            |
 * | ts.isShorthandPropertyAssignment(p)| p.type === 'shorthand_property_identifier' |
 * | ts.isPropertyAssignment(p)         | p.type === 'pair' with 'property_identifier' child |
 * | ts.isIdentifier(p)                 | p.type === 'identifier'                |
 * | ts.isElementAccessExpression(p)    | p.type === 'subscript_expression'      |
 */

/** Set of tree-sitter node types that represent type positions */
const TYPE_NODE_TYPES = new Set([
  'type_annotation',
  'type_identifier',
  'nested_identifier',
  'nested_type_identifier',
  'generic_type',
  'union_type',
  'intersection_type',
  'conditional_type',
  'mapped_type_clause',
  'index_signature',
  'type_predicate',
  'predefined_type',
  'object_type',
  'array_type',
  'tuple_type',
  'function_type',
  'constructor_type',
  'type_query',
  'extends_type_clause',
  'implements_clause',
  'template_type',
  'literal_type',
  'lookup_type',
  'this_type',
  'optional_type',
  'rest_type',
]);

/** Set of declaration node types that can have heritage clauses or type params */
const DECLARATION_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'method_signature',
  'arrow_function',
  'function_expression',
  'variable_declarator',
  'class_declaration',
  'interface_declaration',
  'type_alias_declaration',
]);

/** Set of node types that represent spreads */
const SPREAD_TYPES = new Set(['spread_element', 'rest_parameter']);

/** Node types whose direct `type_annotation` child holds an identifier's type
 *  position — parameters, property signatures, index signatures, and type
 *  assertions. Collapsed into one generic check in isTypeOnlyUsage. */
const DIRECT_TYPE_ANNOTATION_PARENTS = new Set([
  'required_parameter',
  'optional_parameter',
  'property_signature',
  'class_property',
  'index_signature',
  'type_assertion',
]);

/**
 * Recursively check if the identifier node is contained within the given type node.
 */
function isNodeInTypePosition(identifier: ASTNode, typeNode: ASTNode): boolean {
  let found = false;

  function checkNode(node: ASTNode): void {
    if (found) return;
    if (node === identifier) {
      found = true;
      return;
    }
    for (const child of node.children ?? []) {
      checkNode(child);
    }
  }

  checkNode(typeNode);
  return found;
}

/**
 * Return true when `identifier` sits inside the `type_arguments` node of
 * `container` (e.g. `Array<SomeType>`). Shared by the direct generic-type
 * position and the call/new/tagged-template type-argument positions.
 */
function isInTypeArguments(identifier: ASTNode, container: ASTNode): boolean {
  const typeArgs = findChildOfType(container, 'type_arguments');
  if (!typeArgs) return false;
  for (const arg of typeArgs.children ?? []) {
    if (isNodeInTypePosition(identifier, arg)) return true;
  }
  return false;
}

/**
 * `function test<T extends SomeType>()` — the identifier is a type-parameter
 * constraint. When a direct `type_annotation` constraint exists it is decisive
 * (return its result, do not fall through to the secondary child scan).
 */
function isTypeParameterConstraintUsage(identifier: ASTNode, parent: ASTNode): boolean {
  if (parent.type !== 'type_parameter') return false;
  const constraint = findChildOfType(parent, 'type_annotation');
  if (constraint) {
    return isNodeInTypePosition(identifier, constraint);
  }
  for (const child of parent.children ?? []) {
    if (child.type !== 'identifier' && child.type !== 'type_parameter') {
      if (isNodeInTypePosition(identifier, child)) return true;
    }
  }
  return false;
}

/**
 * Mapped type (`{ [K in T]: ... }`) — the identifier is a mapped-type constraint
 * or value type.
 */
function isMappedTypeUsage(identifier: ASTNode, parent: ASTNode): boolean {
  if (parent.type !== 'mapped_type_clause') return false;
  const typeParam = findChildOfType(parent, 'type_parameter');
  if (typeParam) {
    const constraint = findChildOfType(typeParam, 'type_annotation');
    if (constraint && isNodeInTypePosition(identifier, constraint)) return true;
  }
  const typeAnnot = findChildOfType(parent, 'type_annotation');
  if (typeAnnot && isNodeInTypePosition(identifier, typeAnnot)) return true;
  return false;
}

/**
 * Type positions reachable through the parent's own parent — type arguments on
 * call/new/tagged-template expressions (tagged templates parse as
 * `call_expression`).
 */
function isAncestorTypeUsage(identifier: ASTNode, parent: ASTNode): boolean {
  if (!parent.parent) return false;
  const grand = parent.parent;
  if (grand.type === 'call_expression' || grand.type === 'new_expression') {
    return isInTypeArguments(identifier, grand);
  }
  return false;
}

/**
 * Check if an identifier node is used only as a type.
 * Uses tree-sitter node type checks instead of TS API's `isTypeNode` etc.
 */
function isTypeOnlyUsage(identifier: ASTNode): boolean {
  const parent = identifier.parent;
  if (!parent) return false;

  // Direct type position — parent is a type_annotation, type_reference, etc.
  if (TYPE_NODE_TYPES.has(parent.type)) return true;

  // Type query: `typeof X`
  if (parent.type === 'type_query') return true;

  // Type alias: `type X = SomeType`
  if (parent.type === 'type_alias_declaration') {
    const typeAnnotation = findChildOfType(parent, 'type_annotation');
    if (typeAnnotation) return isNodeInTypePosition(identifier, typeAnnotation);
  }

  if (isTypeParameterConstraintUsage(identifier, parent)) return true;

  // Type annotations in variable declarations: `const x: SomeType = ...`
  if (parent.type === 'variable_declarator') {
    const typeAnnot = findChildOfType(parent, 'type_annotation');
    if (typeAnnot && isNodeInTypePosition(identifier, typeAnnot)) return true;
  }

  // Type assertions: `value as SomeType` or `<SomeType>value`
  if (parent.type === 'as_expression') {
    const typeNode = parent.children?.find(c => c.type !== 'identifier' && c.type !== 'as');
    if (typeNode && isNodeInTypePosition(identifier, typeNode)) return true;
  }

  // Parameter / property / index-signature / type-assertion parents: a direct
  // `type_annotation` child holds the type position.
  if (DIRECT_TYPE_ANNOTATION_PARENTS.has(parent.type)) {
    const typeAnnot = findChildOfType(parent, 'type_annotation');
    if (typeAnnot && isNodeInTypePosition(identifier, typeAnnot)) return true;
  }

  // Type parameters/arguments: `Array<SomeType>`, `Promise<SomeType>`
  if (parent.type === 'type_identifier' || parent.type === 'generic_type') {
    if (isInTypeArguments(identifier, parent)) return true;
  }

  // Return type annotations: `function test(): SomeType`
  if (DECLARATION_TYPES.has(parent.type)) {
    const typeAnnot = findChildOfType(parent, 'type_annotation');
    if (typeAnnot && isNodeInTypePosition(identifier, typeAnnot)) return true;
  }

  if (isMappedTypeUsage(identifier, parent)) return true;

  // Conditional types: `T extends SomeType ? X : Y`
  if (parent.type === 'conditional_type') {
    for (const child of parent.children ?? []) {
      if (isNodeInTypePosition(identifier, child)) return true;
    }
  }

  // Union and intersection types
  if (parent.type === 'union_type' || parent.type === 'intersection_type') {
    for (const child of parent.children ?? []) {
      if (isNodeInTypePosition(identifier, child)) return true;
    }
  }

  // Type predicate: `function isX(value: any): value is SomeType`
  if (parent.type === 'type_predicate') {
    const annot = findChildOfType(parent, 'type_annotation');
    if (annot && isNodeInTypePosition(identifier, annot)) return true;
  }

  if (isAncestorTypeUsage(identifier, parent)) return true;

  return false;
}

/**
 * Extract identifier usage to track which imports are used.
 * Uses tree-sitter AST traversal with walkAST.
 *
 * @param root - The root AST node to walk.
/**
 * Record a single usage of an imported name in the usage map: increments the
 * count, appends the line, and returns the (possibly freshly-created) entry so
 * callers that classify the usage (type / reexport) can mutate it in place.
 */
function recordUsage(
  usageMap: Map<string, UsageInfo>,
  name: string,
  node: ASTNode
): UsageInfo {
  const { line } = bridgeGetLineAndColumn(node);
  const existing = usageMap.get(name) || {
    usageType: 'direct' as const,
    usageCount: 0,
    lineNumbers: [] as number[],
  };
  existing.usageCount++;
  existing.lineNumbers.push(line);
  usageMap.set(name, existing);
  return existing;
}

/**
 * Plain identifier references. Skips identifiers inside import declarations,
 * and for member/subscript access counts only the leftmost (object) identifier.
 * Classifies the usage as type-only or re-export where applicable.
 */
function recordIdentifierUsage(
  node: ASTNode,
  sourceCode: string,
  importNames: Set<string>,
  usageMap: Map<string, UsageInfo>
): void {
  const name = getNodeText(node, sourceCode);
  if (!importNames.has(name)) return;

  let shouldCount = true;
  let p = node.parent;
  while (p) {
    if (p.type === 'import_statement' || p.type === 'import_specifier' ||
        p.type === 'import_clause' || p.type === 'named_imports') {
      shouldCount = false;
      break;
    }
    p = p.parent;
  }

  // For member expressions, only count the leftmost (object) identifier
  if (shouldCount && node.parent?.type === 'member_expression') {
    shouldCount = node.parent.children?.[0] === node;
  }

  // For subscript expressions (element access), only count expression side
  if (shouldCount && node.parent?.type === 'subscript_expression') {
    shouldCount = node.parent.children?.[0] === node;
  }

  if (!shouldCount) return;

  const existing = recordUsage(usageMap, name, node);
  if (isTypeOnlyUsage(node)) {
    existing.usageType = 'type';
  } else if (node.parent?.type === 'export_specifier') {
    existing.usageType = 'reexport';
  }
}

/**
 * Spread elements (`...Imported`, rest params) whose spread expression is an
 * imported identifier.
 */
function recordSpreadUsage(
  node: ASTNode,
  sourceCode: string,
  importNames: Set<string>,
  usageMap: Map<string, UsageInfo>
): void {
  const expr = node.children?.find(c => c.type !== '...');
  if (expr?.type === 'identifier' && importNames.has(getNodeText(expr, sourceCode))) {
    recordUsage(usageMap, getNodeText(expr, sourceCode), expr);
  }
}

/**
 * JSX elements (`<Button />`, `<Button.Primary />`) whose tag (or the leftmost
 * member of the tag) is an imported identifier.
 */
function recordJsxUsage(
  node: ASTNode,
  sourceCode: string,
  importNames: Set<string>,
  usageMap: Map<string, UsageInfo>
): void {
  let tagNameNode: ASTNode | undefined;
  if (node.type === 'jsx_element') {
    const openTag = findChildOfType(node, 'jsx_opening_element');
    if (openTag) {
      tagNameNode = openTag.children?.find(c =>
        c.type === 'identifier' || c.type === 'member_expression');
    }
  } else {
    tagNameNode = node.children?.find(c =>
      c.type === 'identifier' || c.type === 'member_expression');
  }

  if (!tagNameNode) return;

  if (tagNameNode.type === 'identifier' && importNames.has(getNodeText(tagNameNode, sourceCode))) {
    recordUsage(usageMap, getNodeText(tagNameNode, sourceCode), tagNameNode);
  } else if (tagNameNode.type === 'member_expression') {
    const leftmost = tagNameNode.children?.[0];
    if (leftmost?.type === 'identifier' && importNames.has(getNodeText(leftmost, sourceCode))) {
      recordUsage(usageMap, getNodeText(leftmost, sourceCode), leftmost);
    }
  }
}

/**
 * Decorators (`@withAuth`, `@Component()`): the decorator identifier, or the
 * callee identifier of a call-expression decorator.
 */
function recordDecoratorUsage(
  node: ASTNode,
  sourceCode: string,
  importNames: Set<string>,
  usageMap: Map<string, UsageInfo>
): void {
  const id = findChildOfType(node, 'identifier');
  if (id && importNames.has(getNodeText(id, sourceCode))) {
    recordUsage(usageMap, getNodeText(id, sourceCode), id);
  }

  const callExpr = findChildOfType(node, 'call_expression');
  if (callExpr) {
    const callee = callExpr.children?.[0];
    if (callee?.type === 'identifier' && importNames.has(getNodeText(callee, sourceCode))) {
      recordUsage(usageMap, getNodeText(callee, sourceCode), callee);
    }
  }
}

/**
 * Object-literal property assignments (`{ key: ImportedValue }`): the value
 * identifier when it is an imported name.
 */
function recordPairUsage(
  node: ASTNode,
  sourceCode: string,
  importNames: Set<string>,
  usageMap: Map<string, UsageInfo>
): void {
  const key = node.children?.find(c => c.type === 'property_identifier');
  const value = node.children?.find(c => c.type === 'identifier' && c !== key);
  if (value && importNames.has(getNodeText(value, sourceCode))) {
    recordUsage(usageMap, getNodeText(value, sourceCode), value);
  }
}

/**
 * Shorthand property assignments (`{ ComponentA }`): the identifier child that
 * references the imported name.
 */
function recordShorthandUsage(
  node: ASTNode,
  sourceCode: string,
  importNames: Set<string>,
  usageMap: Map<string, UsageInfo>
): void {
  const ref = node.children?.find(c => c.type === 'identifier');
  if (ref && importNames.has(getNodeText(ref, sourceCode))) {
    recordUsage(usageMap, getNodeText(ref, sourceCode), ref);
  } else if (ref && importNames.has(getNodeText(ref, sourceCode))) {
    // shorthand_property_identifier might itself be just text
    recordUsage(usageMap, getNodeText(node, sourceCode), node);
  }
}

/**
 * Dispatch a single walked node to its usage recorder based on node type.
 */
function recordNodeUsage(
  node: ASTNode,
  sourceCode: string,
  importNames: Set<string>,
  usageMap: Map<string, UsageInfo>
): void {
  if (node.type === 'identifier') {
    recordIdentifierUsage(node, sourceCode, importNames, usageMap);
  } else if (SPREAD_TYPES.has(node.type)) {
    recordSpreadUsage(node, sourceCode, importNames, usageMap);
  } else if (node.type === 'jsx_element' || node.type === 'jsx_self_closing_element') {
    recordJsxUsage(node, sourceCode, importNames, usageMap);
  } else if (node.type === 'decorator') {
    recordDecoratorUsage(node, sourceCode, importNames, usageMap);
  } else if (node.type === 'pair') {
    recordPairUsage(node, sourceCode, importNames, usageMap);
  } else if (node.type === 'shorthand_property_identifier') {
    recordShorthandUsage(node, sourceCode, importNames, usageMap);
  }
}

/**
 * Extract identifier usage to track which imports are used.
 * Uses tree-sitter AST traversal with walkAST.
 *
 * @param root - The root AST node to walk.
 * @param sourceCode - The original source text for name extraction.
 * @param importNames - Set of imported names to track usage for.
 * @returns Map of imported name to its usage information.
 */
export function extractIdentifierUsage(
  root: ASTNode,
  sourceCode: string,
  importNames: Set<string>
): Map<string, UsageInfo> {
  const usageMap = new Map<string, UsageInfo>();

  walkAST(root, (node) => {
    recordNodeUsage(node, sourceCode, importNames, usageMap);
  });

  return usageMap;
}

// ---------------------------------------------------------------------------
// Local function check
// ---------------------------------------------------------------------------

/**
 * Check if a function name is defined locally in the file.
 * Uses tree-sitter instead of TS API.
 *
 * @param name - The function name to look for.
 * @param root - The root AST node to search.
 * @param sourceCode - The original source text for name extraction.
 * @returns True if the name is declared locally.
 */
export function isLocalFunction(name: string, root: ASTNode, sourceCode: string): boolean {
  let found = false;

  walkAST(root, (node) => {
    if (found) return;

    // function declarations
    if (node.type === 'function_declaration') {
      const nameNode = findChildOfType(node, 'identifier');
      if (nameNode && getNodeText(nameNode, sourceCode) === name) {
        found = true;
      }
    }

    // variable declarations with arrow functions or function expressions
    if (node.type === 'variable_declarator') {
      const nameNode = findChildOfType(node, 'identifier');
      const initializer = node.children?.find(
        c => c.type === 'arrow_function' || c.type === 'function_expression'
      );
      if (nameNode && initializer && getNodeText(nameNode, sourceCode) === name) {
        found = true;
      }
    }

    // class declarations
    if (node.type === 'class_declaration') {
      const nameNode = findChildOfType(node, 'identifier');
      if (nameNode && getNodeText(nameNode, sourceCode) === name) {
        found = true;
      }
    }
  });

  return found;
}

// ---------------------------------------------------------------------------
// Call target normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a function call target for consistent naming.
 * No TypeScript dependency — pure string manipulation.
 *
 * @param callee - The callee name as written at the call site.
 * @param filePath - The file path the call occurs in.
 * @returns The normalized call target.
 */
export function normalizeCallTarget(callee: string, filePath: string): string {
  if (callee.includes('#') || callee.includes('.')) {
    return callee;
  }
  return `${filePath}#${callee}`;
}

// ---------------------------------------------------------------------------
// findNodesByKind — backwards compatible alias
// ---------------------------------------------------------------------------

/**
 * Backward-compatible findNodesByKind.
 * For code that used `findNodesByKind<ts.CallExpression>(sourceFile, ts.SyntaxKind.CallExpression)`,
 * the equivalent is `findNodesByKind(root, 'call_expression')`.
 *
 * Note: the type parameter is retained only for backward compatibility with
 * the generic-based call pattern; tree-sitter uses string types, not SyntaxKind enums.
 *
 * @param root - The root AST node to search within.
 * @param nodeType - The tree-sitter node type to match.
 * @returns All matching AST nodes cast to the requested type.
 */
export function findNodesByKind<T extends ASTNode = ASTNode>(
  root: ASTNode,
  nodeType: string
): T[] {
  return findNodes(root, n => n.type === nodeType) as T[];
}
