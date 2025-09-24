/**
 * AST Utility Functions
 * Provides helper functions for working with TypeScript AST nodes
 */

import * as ts from 'typescript';
import { ImportInfo, ExportInfo, ImportMapping, UsageInfo } from '../types.js';

/**
 * Find all nodes of a specific kind in the AST
 */
export function findNodesByKind<T extends ts.Node>(
  node: ts.Node,
  kind: ts.SyntaxKind
): T[] {
  const results: T[] = [];
  
  function visit(node: ts.Node) {
    if (node.kind === kind) {
      results.push(node as T);
    }
    ts.forEachChild(node, visit);
  }
  
  visit(node);
  return results;
}

/**
 * Get the text content of a node
 */
export function getNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile);
}

/**
 * Get line and column number for a position
 */
export function getLineAndColumn(
  sourceFile: ts.SourceFile,
  position: number
): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: line + 1, column: character + 1 };
}

/**
 * Extract import statements from a source file
 */
export function getImports(sourceFile: ts.SourceFile): ImportInfo[] {
  const imports: ImportInfo[] = [];
  
  ts.forEachChild(sourceFile, node => {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
      const importedNames: string[] = [];
      const isTypeOnly = node.importClause?.isTypeOnly || false;
      
      if (node.importClause) {
        // Default import
        if (node.importClause.name) {
          importedNames.push(node.importClause.name.text);
        }
        
        // Named imports
        if (node.importClause.namedBindings) {
          if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            importedNames.push(`* as ${node.importClause.namedBindings.name.text}`);
          } else if (ts.isNamedImports(node.importClause.namedBindings)) {
            node.importClause.namedBindings.elements.forEach(element => {
              importedNames.push(element.name.text);
            });
          }
        }
      }
      
      const { line } = getLineAndColumn(sourceFile, node.getStart());
      imports.push({
        moduleSpecifier,
        importedNames,
        isTypeOnly,
        line
      });
    }
  });
  
  return imports;
}

/**
 * Extract export statements from a source file
 */
export function getExports(sourceFile: ts.SourceFile): ExportInfo[] {
  const exports: ExportInfo[] = [];
  
  ts.forEachChild(sourceFile, node => {
    if (ts.isExportDeclaration(node)) {
      const isTypeOnly = node.isTypeOnly || false;
      const { line } = getLineAndColumn(sourceFile, node.getStart());
      
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        node.exportClause.elements.forEach(element => {
          exports.push({
            name: element.name.text,
            isDefault: false,
            isTypeOnly,
            line
          });
        });
      }
    } else if (ts.isExportAssignment(node)) {
      const { line } = getLineAndColumn(sourceFile, node.getStart());
      exports.push({
        name: 'default',
        isDefault: true,
        isTypeOnly: false,
        line
      });
    }
  });
  
  return exports;
}

/**
 * Check if a node is exported
 */
export function isExported(node: ts.Node): boolean {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0
  );
}

/**
 * Find all function declarations
 */
export function findFunctions(sourceFile: ts.SourceFile): ts.FunctionDeclaration[] {
  return findNodesByKind<ts.FunctionDeclaration>(
    sourceFile,
    ts.SyntaxKind.FunctionDeclaration
  );
}

/**
 * Find all class declarations
 */
export function findClasses(sourceFile: ts.SourceFile): ts.ClassDeclaration[] {
  return findNodesByKind<ts.ClassDeclaration>(
    sourceFile,
    ts.SyntaxKind.ClassDeclaration
  );
}

/**
 * Get AST node for inspection
 */
export function getASTNode(node: ts.Node): any {
  return {
    kind: ts.SyntaxKind[node.kind],
    text: node.getText?.() || '',
    children: node.getChildren?.().map(child => getASTNode(child)) || []
  };
}

/**
 * Calculate cyclomatic complexity of a function/method
 */
export function calculateComplexity(node: ts.FunctionLikeDeclaration): number {
  let complexity = 1; // Base complexity
  
  function visit(node: ts.Node) {
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.CaseClause:
        complexity++;
        break;
      case ts.SyntaxKind.BinaryExpression:
        const binary = node as ts.BinaryExpression;
        if (
          binary.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          binary.operatorToken.kind === ts.SyntaxKind.BarBarToken
        ) {
          complexity++;
        }
        break;
    }
    ts.forEachChild(node, visit);
  }
  
  if (node.body) {
    visit(node.body);
  }
  
  return complexity;
}

/**
 * Check if a node has a specific decorator
 */
export function hasDecorator(node: ts.Node, decoratorName: string): boolean {
  if (!ts.canHaveDecorators(node)) {
    return false;
  }
  
  const decorators = ts.getDecorators(node);
  if (!decorators) {
    return false;
  }
  
  return decorators.some(decorator => {
    if (ts.isCallExpression(decorator.expression)) {
      const expression = decorator.expression.expression;
      return ts.isIdentifier(expression) && expression.text === decoratorName;
    }
    return ts.isIdentifier(decorator.expression) && 
           decorator.expression.text === decoratorName;
  });
}

/**
 * Get method names from a class
 */
export function getClassMethods(classNode: ts.ClassDeclaration): string[] {
  const methods: string[] = [];
  
  classNode.members.forEach(member => {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      methods.push(member.name.text);
    }
  });
  
  return methods;
}

/**
 * Count lines of code (excluding comments and empty lines)
 */
export function countLinesOfCode(sourceFile: ts.SourceFile): number {
  const text = sourceFile.getFullText();
  const lines = text.split('\n');
  let count = 0;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
      count++;
    }
  }
  
  return count;
}

/**
 * Find all variable declarations
 */
export function findVariableDeclarations(
  sourceFile: ts.SourceFile
): ts.VariableDeclaration[] {
  const declarations: ts.VariableDeclaration[] = [];
  
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return declarations;
}

/**
 * Check if a function is async
 */
export function isAsyncFunction(node: ts.FunctionLikeDeclaration): boolean {
  return !!(node.modifiers?.some(
    modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword
  ));
}

/**
 * Get parameter count for a function
 */
export function getParameterCount(node: ts.FunctionLikeDeclaration): number {
  return node.parameters.length;
}

/**
 * Find all type aliases
 */
export function findTypeAliases(sourceFile: ts.SourceFile): ts.TypeAliasDeclaration[] {
  return findNodesByKind<ts.TypeAliasDeclaration>(
    sourceFile,
    ts.SyntaxKind.TypeAliasDeclaration
  );
}

/**
 * Find all interfaces
 */
export function findInterfaces(sourceFile: ts.SourceFile): ts.InterfaceDeclaration[] {
  return findNodesByKind<ts.InterfaceDeclaration>(
    sourceFile,
    ts.SyntaxKind.InterfaceDeclaration
  );
}

/**
 * Parse a TypeScript file
 */
export async function parseTypeScriptFile(
  filePath: string
): Promise<{ sourceFile: ts.SourceFile; errors: ts.Diagnostic[] }> {
  const fs = await import('fs').then(m => m.promises);
  const content = await fs.readFile(filePath, 'utf-8');
  
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.React,
    lib: ['es2020', 'dom'],
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    allowJs: true,
    checkJs: false,
    strict: false,
    noResolve: true,
    noLib: false,
    moduleResolution: ts.ModuleResolutionKind.NodeJs
  };
  
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );
  
  // For now, just return the source file without full type checking
  // This avoids the need for a full TypeScript compiler host setup
  const errors: ts.Diagnostic[] = [];
  
  // Check for basic syntax errors by walking the AST
  function checkSyntax(node: ts.Node) {
    if (node.kind === ts.SyntaxKind.Unknown) {
      errors.push({
        file: sourceFile,
        start: node.getStart(),
        length: node.getWidth(),
        messageText: 'Syntax error',
        category: ts.DiagnosticCategory.Error,
        code: 1000
      });
    }
    ts.forEachChild(node, checkSyntax);
  }
  
  checkSyntax(sourceFile);
  
  return { sourceFile, errors };
}

/**
 * Enhanced version of getImports that returns detailed ImportMapping[]
 */
export function getImportsDetailed(sourceFile: ts.SourceFile): ImportMapping[] {
  const imports: ImportMapping[] = [];
  
  ts.forEachChild(sourceFile, node => {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
      const importClause = node.importClause;
      
      if (importClause) {
        // Default import
        if (importClause.name) {
          imports.push({
            localName: importClause.name.text,
            importedName: 'default',
            modulePath: moduleSpecifier,
            importType: 'default',
            isTypeOnly: importClause.isTypeOnly || false
          });
        }
        
        // Named imports
        if (importClause.namedBindings) {
          if (ts.isNamespaceImport(importClause.namedBindings)) {
            imports.push({
              localName: importClause.namedBindings.name.text,
              importedName: '*',
              modulePath: moduleSpecifier,
              importType: 'namespace',
              isTypeOnly: importClause.isTypeOnly || false
            });
          } else if (ts.isNamedImports(importClause.namedBindings)) {
            importClause.namedBindings.elements.forEach(element => {
              imports.push({
                localName: element.name.text,
                importedName: element.propertyName?.text || element.name.text,
                modulePath: moduleSpecifier,
                importType: 'named',
                isTypeOnly: importClause.isTypeOnly || element.isTypeOnly || false
              });
            });
          }
        }
      }
    }
  });
  
  return imports;
}

/**
 * Extract identifier usage to track which imports are used
 */
export function extractIdentifierUsage(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  importNames: Set<string>
): Map<string, UsageInfo> {
  const usageMap = new Map<string, UsageInfo>();
  
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      
      if (importNames.has(name)) {
        // Check if this identifier should be counted as usage
        let shouldCount = true;
        
        // Skip if this is part of an import declaration
        let parent = node.parent;
        while (parent) {
          if (ts.isImportDeclaration(parent) || ts.isImportSpecifier(parent) || 
              ts.isImportClause(parent) || ts.isNamedImports(parent)) {
            shouldCount = false;
            break;
          }
          parent = parent.parent;
        }
        
        // For property access expressions, only count the leftmost identifier
        if (shouldCount && ts.isPropertyAccessExpression(node.parent)) {
          // Only count if this identifier is the expression (left side), not the name (right side)
          shouldCount = node.parent.expression === node;
        }
        
        if (shouldCount) {
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
          } else if (ts.isTypeQueryNode(node.parent) || 
                     (ts.isQualifiedName(node.parent) && node.parent.left === node)) {
            existing.usageType = 'type';
          }
          
          usageMap.set(name, existing);
        }
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(node);
  return usageMap;
}

/**
 * Check if a function name is defined locally in the file
 */
export function isLocalFunction(name: string, sourceFile: ts.SourceFile): boolean {
  let found = false;
  
  function visit(node: ts.Node): void {
    if (found) return;
    
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) {
      found = true;
    } else if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach(decl => {
        if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && 
            decl.name.text === name && decl.initializer &&
            (ts.isFunctionExpression(decl.initializer) || ts.isArrowFunction(decl.initializer))) {
          found = true;
        }
      });
    } else if (ts.isClassDeclaration(node) && node.name && node.name.text === name) {
      found = true;
    }
    
    if (!found) {
      ts.forEachChild(node, visit);
    }
  }
  
  visit(sourceFile);
  return found;
}

/**
 * Normalize a function call target for consistent naming
 */
export function normalizeCallTarget(callee: string, filePath: string): string {
  // If it already has a module path separator, return as-is
  if (callee.includes('#') || callee.includes('.')) {
    return callee;
  }
  
  // Otherwise, prefix with file path
  return `${filePath}#${callee}`;
}