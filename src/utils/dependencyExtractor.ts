/**
 * Dependency extraction utilities for function-level dependency tracking
 */

import * as ts from 'typescript';
import { FunctionCall, ImportMapping, DependencyInfo, UsageInfo } from '../types.js';

/**
 * Extract all function calls within a given AST node
 */
export function extractFunctionCalls(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  importMap: Map<string, ImportMapping>
): FunctionCall[] {
  const calls: FunctionCall[] = [];
  
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callInfo = resolveCallExpression(node, sourceFile, importMap);
      if (callInfo) {
        calls.push(callInfo);
      }
    }
    ts.forEachChild(node, visit);
  }
  
  visit(node);
  return calls;
}

/**
 * Build a map of imports from import statements
 */
export function buildImportMap(sourceFile: ts.SourceFile): Map<string, ImportMapping> {
  const importMap = new Map<string, ImportMapping>();
  
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
      const importClause = node.importClause;
      
      if (importClause) {
        // Default import
        if (importClause.name) {
          const localName = importClause.name.text;
          importMap.set(localName, {
            localName,
            importedName: 'default',
            modulePath: moduleSpecifier,
            importType: 'default',
            isTypeOnly: importClause.isTypeOnly || false
          });
        }
        
        // Named imports
        if (importClause.namedBindings) {
          if (ts.isNamedImports(importClause.namedBindings)) {
            importClause.namedBindings.elements.forEach(element => {
              const localName = element.name.text;
              const importedName = element.propertyName?.text || localName;
              importMap.set(localName, {
                localName,
                importedName,
                modulePath: moduleSpecifier,
                importType: 'named',
                isTypeOnly: importClause.isTypeOnly || element.isTypeOnly || false
              });
            });
          } else if (ts.isNamespaceImport(importClause.namedBindings)) {
            // Namespace import (import * as name from 'module')
            const localName = importClause.namedBindings.name.text;
            importMap.set(localName, {
              localName,
              importedName: '*',
              modulePath: moduleSpecifier,
              importType: 'namespace',
              isTypeOnly: importClause.isTypeOnly || false
            });
          }
        }
      }
    } else if (ts.isVariableStatement(node)) {
      // Handle require statements (CommonJS)
      node.declarationList.declarations.forEach(decl => {
        if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isCallExpression(decl.initializer)) {
          const callExpr = decl.initializer;
          if (ts.isIdentifier(callExpr.expression) && callExpr.expression.text === 'require' &&
              callExpr.arguments.length > 0 && ts.isStringLiteral(callExpr.arguments[0])) {
            const modulePath = callExpr.arguments[0].text;
            if (ts.isIdentifier(decl.name)) {
              const localName = decl.name.text;
              importMap.set(localName, {
                localName,
                importedName: 'default',
                modulePath,
                importType: 'default',
                isTypeOnly: false
              });
            }
          }
        }
      });
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return importMap;
}

/**
 * Resolve a call expression to get call information
 */
export function resolveCallExpression(
  callExpr: ts.CallExpression,
  sourceFile: ts.SourceFile,
  importMap: Map<string, ImportMapping>
): FunctionCall | undefined {
  const expr = callExpr.expression;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(callExpr.getStart());
  
  let callee: string | undefined;
  let callType: 'direct' | 'method' | 'dynamic' = 'direct';
  
  if (ts.isIdentifier(expr)) {
    // Direct function call: functionName()
    callee = expr.text;
    callType = 'direct';
  } else if (ts.isPropertyAccessExpression(expr)) {
    // Method call: object.method()
    callee = resolvePropertyAccess(expr, importMap);
    callType = 'method';
  } else if (ts.isElementAccessExpression(expr)) {
    // Dynamic call: object[property]()
    callee = '[dynamic]';
    callType = 'dynamic';
  }
  
  if (callee) {
    return {
      callee,
      callType,
      line: line + 1, // Convert to 1-based
      column: character + 1,
      arguments: callExpr.arguments.length
    };
  }
  
  return undefined;
}

/**
 * Resolve property access expressions to a string representation
 */
function resolvePropertyAccess(
  expr: ts.PropertyAccessExpression,
  importMap: Map<string, ImportMapping>
): string {
  const parts: string[] = [expr.name.text];
  let current = expr.expression;
  
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  
  if (ts.isIdentifier(current)) {
    const baseName = current.text;
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
  node: ts.Node,
  sourceFile: ts.SourceFile,
  importMap: Map<string, ImportMapping>
): Map<string, UsageInfo> {
  const usageMap = new Map<string, UsageInfo>();
  
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent) && 
        !ts.isPropertyAssignment(node.parent)) {
      const name = node.text;
      
      if (importMap.has(name)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const existing = usageMap.get(name) || {
          usageType: 'direct',
          usageCount: 0,
          lineNumbers: []
        };
        
        existing.usageCount++;
        existing.lineNumbers.push(line + 1);
        
        // Determine usage type
        if (ts.isTypeNode(node.parent) || ts.isTypeReferenceNode(node.parent)) {
          existing.usageType = 'type';
        } else if (ts.isExportSpecifier(node.parent)) {
          existing.usageType = 'reexport';
        }
        
        usageMap.set(name, existing);
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(node);
  return usageMap;
}

/**
 * Get all local function names defined in the file
 */
export function getLocalFunctionNames(sourceFile: ts.SourceFile): Set<string> {
  const functionNames = new Set<string>();
  
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functionNames.add(node.name.text);
    } else if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach(decl => {
        if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) &&
            decl.initializer && (ts.isFunctionExpression(decl.initializer) ||
            ts.isArrowFunction(decl.initializer))) {
          functionNames.add(decl.name.text);
        }
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      functionNames.add(node.name.text);
      // Also add class methods
      node.members.forEach(member => {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
          functionNames.add(`${node.name!.text}.${member.name.text}`);
        }
      });
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
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