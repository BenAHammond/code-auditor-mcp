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

import type { ASTNode, AST } from '../languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { ImportInfo, ExportInfo, ImportMapping, UsageInfo } from '../types.js';
import {
  walkAST,
  findNodes,
  getNodeText as bridgeGetNodeText,
  getLineAndColumn as bridgeGetLineAndColumn,
  isExported as bridgeIsExported,
  calculateComplexity as bridgeCalculateComplexity,
  hasModifier,
} from '../languages/adapterBridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get raw text from a tree-sitter node (stored on ASTNode.raw). */
function rawText(node: ASTNode): string {
  return (node.raw as TreeSitterNode)?.text ?? '';
}

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
export { bridgeGetNodeText as getNodeText };

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
 */
export function getImports(root: ASTNode): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const importNodes = findNodes(root, n => n.type === 'import_statement');

  for (const node of importNodes) {
    // Module specifier (the string literal at the end)
    const moduleNode = findChildOfType(node, 'string');
    if (!moduleNode) continue;
    const moduleSpecifier = rawText(moduleNode).replace(/^["']|["']$/g, '');
    const importedNames: string[] = [];

    const importClause = findChildOfType(node, 'import_clause');
    let isTypeOnly = false;

    if (importClause) {
      // Check for `type` keyword in import clause
      const raw = importClause.raw as TreeSitterNode;
      isTypeOnly = raw?.children?.some(c => !c.isNamed && c.type === 'type') ?? false;

      // Default import (identifier child of import_clause that's not 'type' modifier)
      const defaultId = importClause.children?.find(
        c => c.type === 'identifier'
      );
      if (defaultId) {
        importedNames.push(rawText(defaultId));
      }

      // Named imports
      const namedImports = findChildOfType(importClause, 'named_imports');
      if (namedImports) {
        for (const child of namedImports.children ?? []) {
          if (child.type !== 'import_specifier') continue;
          // The identifier children — last one is the local name
          const ids = child.children?.filter(c => c.type === 'identifier') ?? [];
          if (ids.length > 0) {
            importedNames.push(rawText(ids[ids.length - 1]));
          }
        }
      }

      // Namespace import
      const namespaceImport = findChildOfType(importClause, 'namespace_import');
      if (namespaceImport) {
        const nsId = findChildOfType(namespaceImport, 'identifier');
        if (nsId) {
          importedNames.push(`* as ${rawText(nsId)}`);
        }
      }
    }

    const { line } = bridgeGetLineAndColumn(node);
    imports.push({ moduleSpecifier, importedNames, isTypeOnly, line });
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * Extract export statements from an AST root node.
 * Uses tree-sitter export_statement structure.
 */
export function getExports(root: ASTNode): ExportInfo[] {
  const exports: ExportInfo[] = [];

  // export declarations: export { name1, name2 }
  const exportNodes = findNodes(root, n =>
    n.type === 'export_statement' || n.type === 'export_declaration'
  );

  for (const node of exportNodes) {
    const { line } = bridgeGetLineAndColumn(node);

    // Check for type-only exports
    const raw = node.raw as TreeSitterNode;
    const isTypeOnly = raw?.children?.some(c => !c.isNamed && c.type === 'type') ?? false;

    // export clause with named exports
    const exportClause = findChildOfType(node, 'export_clause');
    if (exportClause) {
      const namedExports = findChildOfType(exportClause, 'named_exports');
      if (namedExports) {
        for (const child of namedExports.children ?? []) {
          if (child.type !== 'export_specifier') continue;
          const ids = child.children?.filter(c => c.type === 'identifier') ?? [];
          if (ids.length > 0) {
            exports.push({
              name: rawText(ids[ids.length - 1]),
              isDefault: false,
              isTypeOnly,
              line
            });
          }
        }
      }
    }

    // Check for `default` keyword — export default X
    const isDefault = raw?.children?.some(c => !c.isNamed && c.type === 'default') ?? false;
    if (isDefault) {
      const exported = node.children?.find(
        c => c.type === 'identifier' || c.type === 'function_declaration' ||
             c.type === 'class_declaration' || c.type === 'call_expression'
      );
      if (exported) {
        const nameNode = findChildOfType(exported, 'identifier');
        exports.push({
          name: nameNode ? rawText(nameNode) : 'default',
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
 */
export function getASTNode(node: ASTNode): any {
  return {
    type: node.type,
    text: rawText(node),
    children: (node.children ?? []).map(child => getASTNode(child))
  };
}

// ---------------------------------------------------------------------------
// Decorator checks
// ---------------------------------------------------------------------------

/**
 * Check if a node has a specific decorator.
 * Tree-sitter parses decorators as `decorator` nodes.
 */
export function hasDecorator(node: ASTNode, decoratorName: string): boolean {
  const decorators = findNodes(node, n => n.type === 'decorator');
  return decorators.some(decorator => {
    // decorator → call_expression → identifier (e.g., @Component())
    const callExpr = findChildOfType(decorator, 'call_expression');
    if (callExpr) {
      const callee = callExpr.children?.[0];
      if (callee?.type === 'identifier' && rawText(callee) === decoratorName) {
        return true;
      }
    }
    // decorator → identifier (e.g., @deprecated)
    const id = findChildOfType(decorator, 'identifier');
    if (id && rawText(id) === decoratorName) {
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
 */
export function getClassMethods(classNode: ASTNode): string[] {
  const methods: string[] = [];
  const classBody = findChildOfType(classNode, 'class_body');
  if (!classBody) return methods;

  for (const member of classBody.children ?? []) {
    if (member.type === 'method_definition' || member.type === 'public_field_definition') {
      const nameNode = member.children?.find(
        c => c.type === 'identifier' || c.type === 'property_identifier'
      );
      if (nameNode) {
        methods.push(rawText(nameNode));
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
    const failAst: AST = { root: { type: 'source_file', range: [0, 0], location: failLocation, raw: null }, language: 'unknown', filePath, errors: [{ message: 'Failed to parse file', location: failLocation, severity: 'error' }] };
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
 */
export function getImportsDetailed(root: ASTNode): ImportMapping[] {
  const imports: ImportMapping[] = [];
  const importNodes = findNodes(root, n => n.type === 'import_statement');

  for (const node of importNodes) {
    const moduleNode = findChildOfType(node, 'string');
    if (!moduleNode) continue;

    const moduleSpecifier = rawText(moduleNode).replace(/^["']|["']$/g, '');

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

    const raw = importClause.raw as TreeSitterNode;
    const isTypeOnly = raw?.children?.some(c => !c.isNamed && c.type === 'type') ?? false;

    // Default import
    const defaultId = importClause.children?.find(c => c.type === 'identifier');
    if (defaultId) {
      imports.push({
        localName: rawText(defaultId),
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

        const localName = rawText(identifiers[identifiers.length - 1]);
        const importedName = identifiers.length > 1 ? rawText(identifiers[0]) : localName;

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
          localName: rawText(nsId),
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
 */
export function getReExports(root: ASTNode): Array<{ name: string; module: string }> {
  const reExports: Array<{ name: string; module: string }> = [];
  const exportNodes = findNodes(root, n =>
    n.type === 'export_statement' || n.type === 'export_declaration'
  );

  for (const node of exportNodes) {
    // Check if there's a module specifier (export { x } from './y')
    const moduleNode = findChildOfType(node, 'string');
    if (!moduleNode) continue;
    const moduleSpecifier = rawText(moduleNode).replace(/^["']|["']$/g, '');

    const exportClause = findChildOfType(node, 'export_clause');
    if (exportClause) {
      const namedExports = findChildOfType(exportClause, 'named_exports');
      if (namedExports) {
        for (const child of namedExports.children ?? []) {
          if (child.type !== 'export_specifier') continue;
          const identifiers = child.children?.filter(c => c.type === 'identifier') ?? [];
          if (identifiers.length > 0) {
            const name = identifiers.length > 1
              ? rawText(identifiers[0])
              : rawText(identifiers[identifiers.length - 1]);
            reExports.push({ name, module: moduleSpecifier });
          }
        }
      }
    } else if (!exportClause) {
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
  'generic_type',
  'qualified_name',
  'union_type',
  'intersection_type',
  'conditional_type',
  'mapped_type_clause',
  'index_signature',
  'type_predicate',
  'predefined_type',
  'string_type',
  'number_type',
  'boolean_type',
  'object_type',
  'array_type',
  'tuple_type',
  'function_type',
  'constructor_type',
  'typeof_expression',
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
 * Check if an identifier node is used only as a type.
 * Uses tree-sitter node type checks instead of TS API's `isTypeNode` etc.
 */
function isTypeOnlyUsage(identifier: ASTNode): boolean {
  const parent = identifier.parent;
  if (!parent) return false;

  // Direct type position — parent is a type_annotation, type_reference, etc.
  if (TYPE_NODE_TYPES.has(parent.type)) {
    return true;
  }

  // Type query: `typeof X`
  if (parent.type === 'typeof_expression') {
    return true;
  }

  // Qualified name in type position
  if (parent.type === 'qualified_name' && parent.children?.[0] === identifier) {
    return isTypeOnlyUsage(parent);
  }

  // Generic type arguments: `SomeType<X>` where X is the identifier
  if (parent.type === 'generic_type' && parent.children?.[0] === identifier) {
    const heritageClause = parent.parent;
    if (heritageClause?.type === 'heritage_clause') {
      const raw = (heritageClause.raw as TreeSitterNode);
      const isExtends = raw?.children?.some(c => !c.isNamed && c.type === 'extends');
      if (isExtends) {
        const interfaceNode = heritageClause.parent;
        if (interfaceNode?.type === 'interface_declaration') {
          return true;
        }
      }
    }
  }

  // `namespace.Type` in type position — check if left side is identifier
  if (parent.type === 'member_expression' && parent.children?.[0] === identifier) {
    const grandParent = parent.parent;
    if (grandParent?.type === 'generic_type') {
      const heritageClause = grandParent.parent;
      if (heritageClause?.type === 'heritage_clause') {
        const raw = (heritageClause.raw as TreeSitterNode);
        const isExtends = raw?.children?.some(c => !c.isNamed && c.type === 'extends');
        if (isExtends) {
          const interfaceNode = heritageClause.parent;
          if (interfaceNode?.type === 'interface_declaration') {
            return true;
          }
        }
      }
    }
  }

  // Type alias: `type X = SomeType`
  if (parent.type === 'type_alias_declaration') {
    const typeAnnotation = findChildOfType(parent, 'type_annotation');
    if (typeAnnotation) {
      return isNodeInTypePosition(identifier, typeAnnotation);
    }
  }

  // Class implements: `class X implements SomeType`
  if (parent.type === 'class_declaration') {
    for (const child of parent.children ?? []) {
      if (child.type !== 'heritage_clause') continue;
      const raw = (child.raw as TreeSitterNode);
      const isImplements = raw?.children?.some(c => !c.isNamed && c.type === 'implements');
      if (!isImplements) continue;
      for (const typeNode of child.children ?? []) {
        if (typeNode === identifier) return true;
        if (typeNode.type === 'member_expression' && typeNode.children?.[0] === identifier) return true;
        if (typeNode.type === 'generic_type' && typeNode.children?.[0] === identifier) return true;
      }
    }
  }

  // Generic constraints: `function test<T extends SomeType>()`
  if (parent.type === 'type_parameter') {
    const constraint = findChildOfType(parent, 'type_annotation'); // or constraint
    if (constraint) {
      return isNodeInTypePosition(identifier, constraint);
    }
    // Also check for generic_type in constraint position
    for (const child of parent.children ?? []) {
      if (child.type !== 'identifier' && child.type !== 'type_parameter') {
        if (isNodeInTypePosition(identifier, child)) return true;
      }
    }
  }

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
  if (parent.type === 'type_assertion') {
    const typeNode = findChildOfType(parent, 'type_annotation');
    if (typeNode && isNodeInTypePosition(identifier, typeNode)) return true;
  }

  // Type parameters/arguments: `Array<SomeType>`, `Promise<SomeType>`
  if (parent.type === 'type_identifier' || parent.type === 'generic_type') {
    const typeArgs = findChildOfType(parent, 'type_arguments');
    if (typeArgs) {
      for (const arg of typeArgs.children ?? []) {
        if (isNodeInTypePosition(identifier, arg)) return true;
      }
    }
  }

  // Return type annotations: `function test(): SomeType`
  if (DECLARATION_TYPES.has(parent.type)) {
    const typeAnnot = findChildOfType(parent, 'type_annotation');
    if (typeAnnot && isNodeInTypePosition(identifier, typeAnnot)) return true;
  }

  // Parameter type annotations: `function test(x: SomeType)`
  if (parent.type === 'required_parameter' || parent.type === 'optional_parameter') {
    const typeAnnot = findChildOfType(parent, 'type_annotation');
    if (typeAnnot && isNodeInTypePosition(identifier, typeAnnot)) return true;
  }

  // Property type annotations: `{ prop: SomeType }` or `class { prop: SomeType }`
  if (parent.type === 'property_signature' || parent.type === 'class_property') {
    const typeAnnot = findChildOfType(parent, 'type_annotation');
    if (typeAnnot && isNodeInTypePosition(identifier, typeAnnot)) return true;
  }

  // Index signature: `{ [key: string]: SomeType }`
  if (parent.type === 'index_signature') {
    const typeAnnot = findChildOfType(parent, 'type_annotation');
    if (typeAnnot && isNodeInTypePosition(identifier, typeAnnot)) return true;
  }

  // Mapped type constraint or type
  if (parent.type === 'mapped_type_clause') {
    const typeParam = findChildOfType(parent, 'type_parameter');
    if (typeParam) {
      const constraint = findChildOfType(typeParam, 'type_annotation');
      if (constraint && isNodeInTypePosition(identifier, constraint)) return true;
    }
    const typeAnnot = findChildOfType(parent, 'type_annotation');
    if (typeAnnot && isNodeInTypePosition(identifier, typeAnnot)) return true;
  }

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

  // Walk up: if parent is itself in a type position, check further up
  if (parent.parent) {
    // Heritage clauses
    if (parent.type === 'generic_type' && parent.parent.type === 'heritage_clause') {
      return true;
    }

    // Type arguments in call expressions: `func<SomeType>()`
    if (parent.parent.type === 'call_expression') {
      const typeArgs = findChildOfType(parent.parent, 'type_arguments');
      if (typeArgs) {
        for (const arg of typeArgs.children ?? []) {
          if (isNodeInTypePosition(identifier, arg)) return true;
        }
      }
    }

    // Type arguments in new expressions: `new Class<SomeType>()`
    if (parent.parent.type === 'new_expression') {
      const typeArgs = findChildOfType(parent.parent, 'type_arguments');
      if (typeArgs) {
        for (const arg of typeArgs.children ?? []) {
          if (isNodeInTypePosition(identifier, arg)) return true;
        }
      }
    }

    // Type arguments in tagged template expressions
    if (parent.parent.type === 'tagged_template_literal') {
      const typeArgs = findChildOfType(parent.parent, 'type_arguments');
      if (typeArgs) {
        for (const arg of typeArgs.children ?? []) {
          if (isNodeInTypePosition(identifier, arg)) return true;
        }
      }
    }
  }

  return false;
}

/**
 * Extract identifier usage to track which imports are used.
 * Uses tree-sitter AST traversal with walkAST.
 */
export function extractIdentifierUsage(
  root: ASTNode,
  sourceCode: string,
  importNames: Set<string>
): Map<string, UsageInfo> {
  const usageMap = new Map<string, UsageInfo>();

  walkAST(root, (node) => {
    // --- identifiers ---
    if (node.type === 'identifier') {
      const name = rawText(node);

      if (importNames.has(name)) {
        let shouldCount = true;

        // Skip if part of an import declaration
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

        if (shouldCount) {
          const { line } = bridgeGetLineAndColumn(node);
          const existing = usageMap.get(name) || {
            usageType: 'direct' as const,
            usageCount: 0,
            lineNumbers: [] as number[],
          };

          existing.usageCount++;
          existing.lineNumbers.push(line);

          if (isTypeOnlyUsage(node)) {
            existing.usageType = 'type';
          } else if (node.parent?.type === 'export_specifier') {
            existing.usageType = 'reexport';
          }

          usageMap.set(name, existing);
        }
      }
    }

    // --- spread elements ---
    else if (SPREAD_TYPES.has(node.type)) {
      const expr = node.children?.find(c => c.type !== '...');
      if (expr?.type === 'identifier' && importNames.has(rawText(expr))) {
        const { line } = bridgeGetLineAndColumn(expr);
        const existing = usageMap.get(rawText(expr)) || {
          usageType: 'direct' as const,
          usageCount: 0,
          lineNumbers: [] as number[],
        };
        existing.usageCount++;
        existing.lineNumbers.push(line);
        usageMap.set(rawText(expr), existing);
      }
    }

    // --- JSX elements: <Button /> or <Button.Primary /> ---
    else if (node.type === 'jsx_element' || node.type === 'jsx_self_closing_element') {
      let tagNameNode: ASTNode | undefined;

      if (node.type === 'jsx_element') {
        const openTag = findChildOfType(node, 'open_tag');
        if (openTag) {
          tagNameNode = openTag.children?.find(c =>
            c.type === 'identifier' || c.type === 'member_expression');
        }
      } else {
        tagNameNode = node.children?.find(c =>
          c.type === 'identifier' || c.type === 'member_expression');
      }

      if (tagNameNode) {
        if (tagNameNode.type === 'identifier' && importNames.has(rawText(tagNameNode))) {
          const { line } = bridgeGetLineAndColumn(tagNameNode);
          const existing = usageMap.get(rawText(tagNameNode)) || {
            usageType: 'direct' as const,
            usageCount: 0,
            lineNumbers: [] as number[],
          };
          existing.usageCount++;
          existing.lineNumbers.push(line);
          usageMap.set(rawText(tagNameNode), existing);
        } else if (tagNameNode.type === 'member_expression') {
          const leftmost = tagNameNode.children?.[0];
          if (leftmost?.type === 'identifier' && importNames.has(rawText(leftmost))) {
            const { line } = bridgeGetLineAndColumn(leftmost);
            const existing = usageMap.get(rawText(leftmost)) || {
              usageType: 'direct' as const,
              usageCount: 0,
              lineNumbers: [] as number[],
            };
            existing.usageCount++;
            existing.lineNumbers.push(line);
            usageMap.set(rawText(leftmost), existing);
          }
        }
      }
    }

    // --- decorators: @withAuth ---
    else if (node.type === 'decorator') {
      // decorator → identifier (e.g., @deprecated)
      const id = findChildOfType(node, 'identifier');
      if (id && importNames.has(rawText(id))) {
        const { line } = bridgeGetLineAndColumn(id);
        const existing = usageMap.get(rawText(id)) || {
          usageType: 'direct' as const,
          usageCount: 0,
          lineNumbers: [] as number[],
        };
        existing.usageCount++;
        existing.lineNumbers.push(line);
        usageMap.set(rawText(id), existing);
      }

      // decorator → call_expression → identifier (e.g., @Component())
      const callExpr = findChildOfType(node, 'call_expression');
      if (callExpr) {
        const callee = callExpr.children?.[0];
        if (callee?.type === 'identifier' && importNames.has(rawText(callee))) {
          const { line } = bridgeGetLineAndColumn(callee);
          const existing = usageMap.get(rawText(callee)) || {
            usageType: 'direct' as const,
            usageCount: 0,
            lineNumbers: [] as number[],
          };
          existing.usageCount++;
          existing.lineNumbers.push(line);
          usageMap.set(rawText(callee), existing);
        }
      }
    }

    // --- Object literal property assignments: { key: ImportedValue } ---
    else if (node.type === 'pair') {
      const key = node.children?.find(c => c.type === 'property_identifier');
      const value = node.children?.find(c => c.type === 'identifier' && c !== key);
      if (value && importNames.has(rawText(value))) {
        const { line } = bridgeGetLineAndColumn(value);
        const existing = usageMap.get(rawText(value)) || {
          usageType: 'direct' as const,
          usageCount: 0,
          lineNumbers: [] as number[],
        };
        existing.usageCount++;
        existing.lineNumbers.push(line);
        usageMap.set(rawText(value), existing);
      }
    }

    // --- Shorthand property assignments: { ComponentA, ComponentB } ---
    else if (node.type === 'shorthand_property_identifier') {
      // The value node is a reference to an imported name
      const ref = node.children?.find(c => c.type === 'identifier');
      if (ref && importNames.has(rawText(ref))) {
        const { line } = bridgeGetLineAndColumn(ref);
        const existing = usageMap.get(rawText(ref)) || {
          usageType: 'direct' as const,
          usageCount: 0,
          lineNumbers: [] as number[],
        };
        existing.usageCount++;
        existing.lineNumbers.push(line);
        usageMap.set(rawText(ref), existing);
      } else if (ref && importNames.has(rawText(ref))) {
        // shorthand_property_identifier might itself be just text
        const { line } = bridgeGetLineAndColumn(node);
        const existing = usageMap.get(rawText(node)) || {
          usageType: 'direct' as const,
          usageCount: 0,
          lineNumbers: [] as number[],
        };
        existing.usageCount++;
        existing.lineNumbers.push(line);
        usageMap.set(rawText(node), existing);
      }
    }
  });

  return usageMap;
}

// ---------------------------------------------------------------------------
// Local function check
// ---------------------------------------------------------------------------

/**
 * Check if a function name is defined locally in the file.
 * Uses tree-sitter instead of TS API.
 */
export function isLocalFunction(name: string, root: ASTNode): boolean {
  let found = false;

  walkAST(root, (node) => {
    if (found) return;

    // function declarations
    if (node.type === 'function_declaration') {
      const nameNode = findChildOfType(node, 'identifier');
      if (nameNode && rawText(nameNode) === name) {
        found = true;
      }
    }

    // variable declarations with arrow functions or function expressions
    if (node.type === 'variable_declarator') {
      const nameNode = findChildOfType(node, 'identifier');
      const initializer = node.children?.find(
        c => c.type === 'arrow_function' || c.type === 'function_expression'
      );
      if (nameNode && initializer && rawText(nameNode) === name) {
        found = true;
      }
    }

    // class declarations
    if (node.type === 'class_declaration') {
      const nameNode = findChildOfType(node, 'identifier');
      if (nameNode && rawText(nameNode) === name) {
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
 */
export function findNodesByKind<T extends ASTNode = ASTNode>(
  root: ASTNode,
  nodeType: string
): T[] {
  return findNodes(root, n => n.type === nodeType) as T[];
}
