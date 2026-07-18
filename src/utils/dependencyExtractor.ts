/**
 * Dependency extraction utilities for function-level dependency tracking
 *
 * ## Migration: TypeScript Compiler API → tree-sitter
 *
 * All `ts.Node`/`ts.SourceFile` parameters have been replaced with `ASTNode`.
 * TS-specific type guards (`ts.is*`) replaced with `node.type` string checks.
 */

import type { ASTNode } from '../languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { walkAST, getLineAndColumn } from '../languages/adapterBridge.js';
import { FunctionCall, ImportMapping, DependencyInfo, UsageInfo } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get raw text from a tree-sitter node (stored on ASTNode.raw). */
function rawText(node: ASTNode): string {
  return (node.raw as TreeSitterNode)?.text ?? '';
}

/** Strip quotes from a string literal node. */
function getStringValue(node: ASTNode): string {
  const text = rawText(node);
  return text.replace(/^["']|["']$/g, '');
}

/** Find the first child of a given type. */
function findChildOfType(node: ASTNode, type: string): ASTNode | undefined {
  return node.children?.find(c => c.type === type);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all function calls within a given AST node
 */
export function extractFunctionCalls(
  node: ASTNode,
  sourceCode: string,
  importMap: Map<string, ImportMapping>
): FunctionCall[] {
  const calls: FunctionCall[] = [];

  walkAST(node, (n) => {
    if (n.type === 'call_expression') {
      const callInfo = resolveCallExpression(n, importMap);
      if (callInfo) {
        calls.push(callInfo);
      }
    }
  });

  return calls;
}

/**
 * Build a map of imports from import statements
 */
export function buildImportMap(root: ASTNode): Map<string, ImportMapping> {
  const importMap = new Map<string, ImportMapping>();

  walkAST(root, (node) => {
    if (node.type === 'import_statement') {
      // Module specifier is the 'string' child
      const stringNode = findChildOfType(node, 'string');
      if (!stringNode) return;

      const moduleSpecifier = getStringValue(stringNode);
      const importClause = findChildOfType(node, 'import_clause');
      if (!importClause) return;

      // Find default import (first identifier child of import_clause before named_imports/namespace_import)
      for (const child of importClause.children ?? []) {
        if (child.type === 'identifier') {
          const localName = rawText(child);
          importMap.set(localName, {
            localName,
            importedName: 'default',
            modulePath: moduleSpecifier,
            importType: 'default',
            isTypeOnly: false
          });
        }

        // Named imports
        if (child.type === 'named_imports') {
          for (const spec of child.children ?? []) {
            if (spec.type !== 'import_specifier') continue;
            // import_specifier: [identifier (imported)] or [identifier (imported), 'as', identifier (local)]
            const identifiers = spec.children?.filter(c => c.type === 'identifier') ?? [];
            if (identifiers.length === 0) continue;
            const importedName = rawText(identifiers[0]);
            const localName = identifiers.length >= 2 ? rawText(identifiers[1]) : importedName;
            importMap.set(localName, {
              localName,
              importedName,
              modulePath: moduleSpecifier,
              importType: 'named',
              isTypeOnly: false
            });
          }
        }

        // Namespace import (import * as name from 'module')
        if (child.type === 'namespace_import') {
          // namespace_import: [*, 'as', identifier]
          const ident = child.children?.find(c => c.type === 'identifier');
          if (ident) {
            const localName = rawText(ident);
            importMap.set(localName, {
              localName,
              importedName: '*',
              modulePath: moduleSpecifier,
              importType: 'namespace',
              isTypeOnly: false
            });
          }
        }
      }
    }

    // Handle require() calls for CommonJS
    // lexical_declaration → variable_declarator → [identifier, call_expression(require, args: string)]
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      const declarator = findChildOfType(node, 'variable_declarator');
      if (!declarator) return;

      const nameNode = findChildOfType(declarator, 'identifier');
      const init = declarator.children?.find(c => c.type === 'call_expression');
      if (!nameNode || !init) return;

      const callee = init.children?.[0];
      if (!callee || callee.type !== 'identifier' || rawText(callee) !== 'require') return;

      const args = findChildOfType(init, 'arguments');
      const firstArg = args?.children?.find(c => c.type === 'string');
      if (!firstArg) return;

      const modulePath = getStringValue(firstArg);
      const localName = rawText(nameNode);
      importMap.set(localName, {
        localName,
        importedName: 'default',
        modulePath,
        importType: 'default',
        isTypeOnly: false
      });
    }
  });

  return importMap;
}

/**
 * Resolve a call expression to get call information
 */
export function resolveCallExpression(
  callExpr: ASTNode,
  importMap: Map<string, ImportMapping>
): FunctionCall | undefined {
  const expr = callExpr.children?.[0]; // expression being called
  if (!expr) return undefined;

  const { line, column } = getLineAndColumn(callExpr);

  let callee: string | undefined;
  let callType: 'direct' | 'method' | 'dynamic' = 'direct';

  if (expr.type === 'identifier') {
    // Direct function call: functionName()
    callee = rawText(expr);
    callType = 'direct';
  } else if (expr.type === 'member_expression') {
    // Method call: object.method()
    callee = resolvePropertyAccess(expr, importMap);
    callType = 'method';
  } else if (expr.type === 'subscript_expression') {
    // Dynamic call: object[property]()
    callee = '[dynamic]';
    callType = 'dynamic';
  }

  if (callee) {
    // Count arguments: find 'arguments' child in callExpr
    const argsNode = callExpr.children?.find(c => c.type === 'arguments');
    const argCount = argsNode?.children?.filter(c => c.type !== '(' && c.type !== ')').length ?? 0;

    return {
      callee,
      callType,
      line: line + 1, // Convert to 1-based
      column: column + 1,
      arguments: argCount
    };
  }

  return undefined;
}

/**
 * Resolve property access expressions to a string representation
 */
function resolvePropertyAccess(
  expr: ASTNode,
  importMap: Map<string, ImportMapping>
): string {
  // member_expression: [object, '.', property_identifier]
  const children = expr.children ?? [];
  const propNode = children[children.length - 1]; // property_identifier is last child
  const objNode = children[0];                    // object is first child

  const parts: string[] = [propNode ? rawText(propNode) : ''];

  let current = objNode;
  while (current?.type === 'member_expression') {
    const cc = current.children ?? [];
    parts.unshift(rawText(cc[cc.length - 1]));
    current = cc[0];
  }

  if (current?.type === 'identifier') {
    const baseName = rawText(current);
    const importInfo = importMap.get(baseName);

    if (importInfo) {
      // Imported module method call
      parts.unshift(`${importInfo.modulePath}#${baseName}`);
    } else {
      // Local object method call
      parts.unshift(baseName);
    }
  }

  return parts.join('.');
}

/**
 * Extract identifier usage within a function to determine which imports are actually used
 */
export function extractIdentifierUsage(
  node: ASTNode,
  sourceCode: string,
  importNames: Set<string>
): Map<string, UsageInfo> {
  const usageMap = new Map<string, UsageInfo>();

  walkAST(node, (n) => {
    if (n.type !== 'identifier') return;

    // Skip identifiers that are property names in member expressions or property assignments
    const parent = n.parent;
    if (parent?.type === 'member_expression') {
      // Check if this identifier is the property part (last child)
      const lastChild = parent.children?.[parent.children.length - 1];
      if (lastChild === n) return;
    }
    if (parent?.type === 'pair' && parent.children?.indexOf(n) === 0) return;

    const name = rawText(n);

    if (!importNames.has(name)) return;

    const { line } = getLineAndColumn(n);
    const existing = usageMap.get(name) || {
      usageType: 'direct' as UsageInfo['usageType'],
      usageCount: 0,
      lineNumbers: [] as number[]
    };

    existing.usageCount++;
    existing.lineNumbers.push(line + 1);

    // Determine usage type from parent context
    if (parent) {
      const parentType = parent.type;
      if (
        parentType === 'type_annotation' ||
        parentType === 'type_identifier' ||
        parentType === 'type_reference' ||
        parentType === 'predefined_type' ||
        parentType === 'generic_type'
      ) {
        existing.usageType = 'type';
      } else if (parentType === 'export_specifier') {
        existing.usageType = 'reexport';
      }
    }

    usageMap.set(name, existing);
  });

  return usageMap;
}

/**
 * Get all local function names defined in the file
 */
export function getLocalFunctionNames(root: ASTNode): Set<string> {
  const functionNames = new Set<string>();

  walkAST(root, (node) => {
    // Function declaration: function_declaration → identifier
    if (node.type === 'function_declaration') {
      const nameNode = findChildOfType(node, 'identifier');
      if (nameNode) {
        functionNames.add(rawText(nameNode));
      }
      return;
    }

    // Variable declaration with function/arrow value
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const child of node.children ?? []) {
        if (child.type !== 'variable_declarator') continue;
        const nameNode = findChildOfType(child, 'identifier');
        const init = child.children?.find(c =>
          c.type === 'arrow_function' || c.type === 'function_expression');
        if (nameNode && init) {
          functionNames.add(rawText(nameNode));
        }
      }
      return;
    }

    // Class declaration
    if (node.type === 'class_declaration') {
      const nameNode = findChildOfType(node, 'identifier');
      if (nameNode) {
        const className = rawText(nameNode);
        functionNames.add(className);

        // Add class methods
        const body = findChildOfType(node, 'class_body');
        if (body) {
          for (const member of body.children ?? []) {
            if (member.type !== 'method_definition') continue;
            const mNameNode = findChildOfType(member, 'identifier');
            if (mNameNode) {
              functionNames.add(`${className}.${rawText(mNameNode)}`);
            }
          }
        }
      }
    }
  });

  return functionNames;
}

/**
 * Normalize a function call target for consistent naming
 */
export function normalizeCallTarget(
  callee: string,
  filePath: string,
  localFunctions: Set<string>
): string {
  // If it's a local function, prefix with file path for uniqueness
  if (localFunctions.has(callee)) {
    return `${filePath}#${callee}`;
  }

  // If it already has a module path, return as-is
  if (callee.includes('#')) {
    return callee;
  }

  // Otherwise, it's an unresolved external call
  return callee;
}
