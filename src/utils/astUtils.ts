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
      } else {
        // Side-effect import (no import clause) - e.g., import './polyfills'
        imports.push({
          localName: `[side-effect]::${moduleSpecifier}`,
          importedName: '[side-effect]',
          modulePath: moduleSpecifier,
          importType: 'side-effect' as any,
          isTypeOnly: false
        });
      }
    }
  });
  
  return imports;
}

/**
 * Get re-exports from a source file
 */
export function getReExports(sourceFile: ts.SourceFile): Array<{name: string; module: string}> {
  const reExports: Array<{name: string; module: string}> = [];
  
  ts.forEachChild(sourceFile, node => {
    // Handle export declarations with module specifier - e.g., export { x } from './y'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
      
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        node.exportClause.elements.forEach(element => {
          reExports.push({
            name: element.propertyName?.text || element.name.text,
            module: moduleSpecifier
          });
        });
      } else if (!node.exportClause) {
        // export * from './module'
        reExports.push({
          name: '*',
          module: moduleSpecifier
        });
      }
    }
  });
  
  return reExports;
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
    // Handle identifiers (most common case)
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
        
        // Handle element access (dynamic property access) - e.g., config[key]
        if (shouldCount && ts.isElementAccessExpression(node.parent)) {
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
          
          // Determine usage type - comprehensive type usage detection
          if (isTypeOnlyUsage(node)) {
            existing.usageType = 'type';
          } else if (ts.isExportSpecifier(node.parent)) {
            existing.usageType = 'reexport';
          }
          
          usageMap.set(name, existing);
        }
      }
    }
    
    // Handle spread operators - e.g., {...defaults}
    else if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && importNames.has(expr.text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
        const existing = usageMap.get(expr.text) || {
          usageType: 'direct',
          usageCount: 0,
          lineNumbers: []
        };
        existing.usageCount++;
        existing.lineNumbers.push(line + 1);
        usageMap.set(expr.text, existing);
      }
    }
    
    // Handle JSX elements - e.g., <Button /> or <Button.Primary />
    else if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
      
      if (ts.isIdentifier(tagName) && importNames.has(tagName.text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(tagName.getStart());
        const existing = usageMap.get(tagName.text) || {
          usageType: 'direct',
          usageCount: 0,
          lineNumbers: []
        };
        existing.usageCount++;
        existing.lineNumbers.push(line + 1);
        usageMap.set(tagName.text, existing);
      } else if (ts.isPropertyAccessExpression(tagName)) {
        // Handle compound components like <Button.Primary />
        if (ts.isIdentifier(tagName.expression) && importNames.has(tagName.expression.text)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(tagName.expression.getStart());
          const existing = usageMap.get(tagName.expression.text) || {
            usageType: 'direct',
            usageCount: 0,
            lineNumbers: []
          };
          existing.usageCount++;
          existing.lineNumbers.push(line + 1);
          usageMap.set(tagName.expression.text, existing);
        }
      }
    }
    
    // Handle decorators - e.g., @withAuth
    else if (ts.isDecorator(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && importNames.has(expr.text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
        const existing = usageMap.get(expr.text) || {
          usageType: 'direct',
          usageCount: 0,
          lineNumbers: []
        };
        existing.usageCount++;
        existing.lineNumbers.push(line + 1);
        usageMap.set(expr.text, existing);
      } else if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && 
                 importNames.has(expr.expression.text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(expr.expression.getStart());
        const existing = usageMap.get(expr.expression.text) || {
          usageType: 'direct',
          usageCount: 0,
          lineNumbers: []
        };
        existing.usageCount++;
        existing.lineNumbers.push(line + 1);
        usageMap.set(expr.expression.text, existing);
      }
    }
    
    // Handle object literal property assignments for factory patterns
    else if (ts.isPropertyAssignment(node)) {
      // Check if the initializer is an imported identifier
      if (ts.isIdentifier(node.initializer) && importNames.has(node.initializer.text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.initializer.getStart());
        const existing = usageMap.get(node.initializer.text) || {
          usageType: 'direct',
          usageCount: 0,
          lineNumbers: []
        };
        existing.usageCount++;
        existing.lineNumbers.push(line + 1);
        usageMap.set(node.initializer.text, existing);
      }
    }
    
    // Handle shorthand property assignments - e.g., { ComponentA, ComponentB }
    else if (ts.isShorthandPropertyAssignment(node)) {
      if (importNames.has(node.name.text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.name.getStart());
        const existing = usageMap.get(node.name.text) || {
          usageType: 'direct',
          usageCount: 0,
          lineNumbers: []
        };
        existing.usageCount++;
        existing.lineNumbers.push(line + 1);
        usageMap.set(node.name.text, existing);
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  /**
   * Comprehensive check for type-only usage patterns
   */
  function isTypeOnlyUsage(node: ts.Identifier): boolean {
    let parent = node.parent;
    
    // Direct type node checks
    if (ts.isTypeNode(parent) || ts.isTypeReferenceNode(parent)) {
      return true;
    }
    
    // Type query (typeof X)
    if (ts.isTypeQueryNode(parent)) {
      return true;
    }
    
    // Qualified name in type position
    if (ts.isQualifiedName(parent) && parent.left === node) {
      return isTypeOnlyUsage(parent as any);
    }
    
    // Interface extension: interface X extends BaseType
    // Check if this identifier is used in an interface extends clause
    if (ts.isExpressionWithTypeArguments(parent) && parent.expression === node) {
      const heritageClause = parent.parent;
      if (ts.isHeritageClause(heritageClause) && heritageClause.token === ts.SyntaxKind.ExtendsKeyword) {
        const interfaceDecl = heritageClause.parent;
        if (ts.isInterfaceDeclaration(interfaceDecl)) {
          return true;
        }
      }
    }
    
    // Also handle property access in interface extension: interface X extends Namespace.BaseType
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const grandParent = parent.parent;
      if (ts.isExpressionWithTypeArguments(grandParent) && grandParent.expression === parent) {
        const heritageClause = grandParent.parent;
        if (ts.isHeritageClause(heritageClause) && heritageClause.token === ts.SyntaxKind.ExtendsKeyword) {
          const interfaceDecl = heritageClause.parent;
          if (ts.isInterfaceDeclaration(interfaceDecl)) {
            return true;
          }
        }
      }
    }
    
    // Type alias: type X = BaseType | BaseType & Other
    if (ts.isTypeAliasDeclaration(parent) && parent.type) {
      return isNodeInTypePosition(node, parent.type);
    }
    
    // Class implements: class X implements BaseType
    if (ts.isClassDeclaration(parent) && parent.heritageClauses) {
      for (const clause of parent.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
          for (const type of clause.types) {
            if (type.expression === node || 
                (ts.isPropertyAccessExpression(type.expression) && type.expression.expression === node)) {
              return true;
            }
          }
        }
      }
    }
    
    // Generic constraints: function test<T extends BaseType>()
    if (ts.isTypeParameterDeclaration(parent) && parent.constraint) {
      return isNodeInTypePosition(node, parent.constraint);
    }
    
    // Type annotations in variable declarations: const x: BaseType = ...
    if (ts.isVariableDeclaration(parent) && parent.type) {
      return isNodeInTypePosition(node, parent.type);
    }
    
    // Type assertions: value as BaseType or <BaseType>value
    if (ts.isAsExpression(parent) && parent.type) {
      return isNodeInTypePosition(node, parent.type);
    }
    if (ts.isTypeAssertionExpression(parent) && parent.type) {
      return isNodeInTypePosition(node, parent.type);
    }
    
    // Satisfies expressions: expression satisfies Type
    if (ts.isSatisfiesExpression && ts.isSatisfiesExpression(parent) && parent.type) {
      return isNodeInTypePosition(node, parent.type);
    }
    
    // Type parameters/arguments: Array<BaseType>, Promise<BaseType>
    if (ts.isTypeReferenceNode(parent) && parent.typeArguments) {
      for (const arg of parent.typeArguments) {
        if (isNodeInTypePosition(node, arg)) {
          return true;
        }
      }
    }
    
    // Return type annotations: function test(): BaseType
    if ((ts.isFunctionDeclaration(parent) || 
         ts.isMethodDeclaration(parent) || 
         ts.isArrowFunction(parent) || 
         ts.isFunctionExpression(parent) ||
         ts.isGetAccessorDeclaration(parent) ||
         ts.isMethodSignature(parent)) && 
        parent.type) {
      return isNodeInTypePosition(node, parent.type);
    }
    
    // Parameter type annotations: function test(x: BaseType)
    if (ts.isParameter(parent) && parent.type) {
      return isNodeInTypePosition(node, parent.type);
    }
    
    // Property type annotations: { prop: BaseType } or class { prop: BaseType }
    if ((ts.isPropertyDeclaration(parent) || 
         ts.isPropertySignature(parent)) && 
        parent.type) {
      return isNodeInTypePosition(node, parent.type);
    }
    
    // Index signature types: { [key: string]: BaseType }
    if (ts.isIndexSignatureDeclaration(parent) && parent.type) {
      return isNodeInTypePosition(node, parent.type);
    }
    
    // Mapped type constraint or type: { [K in keyof BaseType]: ... }
    if (ts.isMappedTypeNode(parent)) {
      if (parent.typeParameter && parent.typeParameter.constraint) {
        return isNodeInTypePosition(node, parent.typeParameter.constraint);
      }
      if (parent.type) {
        return isNodeInTypePosition(node, parent.type);
      }
    }
    
    // Conditional types: T extends BaseType ? X : Y
    if (ts.isConditionalTypeNode(parent)) {
      return isNodeInTypePosition(node, parent.checkType) || 
             isNodeInTypePosition(node, parent.extendsType) ||
             isNodeInTypePosition(node, parent.trueType) ||
             isNodeInTypePosition(node, parent.falseType);
    }
    
    // Union and intersection types: BaseType | Other, BaseType & Other
    if (ts.isUnionTypeNode(parent) || ts.isIntersectionTypeNode(parent)) {
      for (const type of parent.types) {
        if (isNodeInTypePosition(node, type)) {
          return true;
        }
      }
    }
    
    // Type predicate: function isX(value: any): value is BaseType
    if (ts.isTypePredicateNode(parent) && parent.type) {
      return isNodeInTypePosition(node, parent.type);
    }
    
    // Check if we need to traverse up the tree
    if (parent.parent) {
      // For nested type structures, check if parent is in type position
      if (ts.isTypeNode(parent)) {
        return true;
      }
      
      // Check grandparent for certain patterns
      const grandparent = parent.parent;
      
      // Heritage clauses (extends/implements) with property access
      if (ts.isExpressionWithTypeArguments(parent) && 
          ts.isHeritageClause(grandparent)) {
        return true;
      }
      
      // Type arguments in call expressions: func<BaseType>()
      if (ts.isCallExpression(grandparent) && 
          grandparent.typeArguments) {
        for (const arg of grandparent.typeArguments) {
          if (isNodeInTypePosition(node, arg)) {
            return true;
          }
        }
      }
      
      // Type arguments in new expressions: new Class<BaseType>()
      if (ts.isNewExpression(grandparent) && 
          grandparent.typeArguments) {
        for (const arg of grandparent.typeArguments) {
          if (isNodeInTypePosition(node, arg)) {
            return true;
          }
        }
      }
      
      // Tagged template type arguments: tag<BaseType>`...`
      if (ts.isTaggedTemplateExpression(grandparent) && 
          grandparent.typeArguments) {
        for (const arg of grandparent.typeArguments) {
          if (isNodeInTypePosition(node, arg)) {
            return true;
          }
        }
      }
    }
    
    return false;
  }
  
  /**
   * Helper to check if a node is within a type node
   */
  function isNodeInTypePosition(identifier: ts.Identifier, typeNode: ts.Node): boolean {
    let found = false;
    
    function checkNode(node: ts.Node): void {
      if (found) return;
      
      if (node === identifier) {
        found = true;
        return;
      }
      
      ts.forEachChild(node, checkNode);
    }
    
    checkNode(typeNode);
    return found;
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