/**
 * TypeScript Language Adapter
 * 
 * Wraps existing TypeScript functionality to conform to the LanguageAdapter interface.
 * This maintains backward compatibility while enabling multi-language support.
 */

import * as ts from 'typescript';
import path from 'path';
import {
  LanguageAdapter,
  AST,
  ASTNode,
  NodePattern,
  FunctionInfo,
  ClassInfo,
  ImportInfo,
  ExportInfo,
  SourceLocation,
  ParseError,
  ParameterInfo,
  PropertyInfo,
  ImportItem
} from './LanguageAdapter.js';

export class TypeScriptAdapter implements LanguageAdapter {
  readonly name = 'typescript';
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx'];
  
  private compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    noResolve: true,
  };

  async parse(file: string, content: string): Promise<AST> {
    const sourceFile = ts.createSourceFile(
      file,
      content,
      this.compilerOptions.target || ts.ScriptTarget.Latest,
      true,
      this.getScriptKind(file)
    );

    const errors: ParseError[] = [];
    
    // Convert TypeScript diagnostics to our format
    const diagnostics: readonly ts.Diagnostic[] = [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.file && diagnostic.start !== undefined) {
        const location = this.getLocationFromPosition(sourceFile, diagnostic.start);
        errors.push({
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          location,
          severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : 'warning'
        });
      }
    }

    return {
      root: this.convertNode(sourceFile),
      language: this.name,
      filePath: file,
      errors
    };
  }

  supportsFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.extensions.includes(ext);
  }

  findNodes(ast: AST, pattern: NodePattern): ASTNode[] {
    const results: ASTNode[] = [];
    
    const visit = (node: ASTNode) => {
      if (this.matchesPattern(node, pattern)) {
        results.push(node);
      }
      
      const children = this.getChildren(node);
      children.forEach(visit);
    };
    
    visit(ast.root);
    return results;
  }

  getParent(node: ASTNode): ASTNode | null {
    const tsNode = node.raw as ts.Node;
    if (tsNode.parent) {
      return this.convertNode(tsNode.parent);
    }
    return null;
  }

  getChildren(node: ASTNode): ASTNode[] {
    const tsNode = node.raw as ts.Node;
    const children: ASTNode[] = [];
    
    ts.forEachChild(tsNode, (child) => {
      children.push(this.convertNode(child));
    });
    
    return children;
  }

  getNodeType(node: ASTNode): string {
    return node.type;
  }

  getNodeText(node: ASTNode): string {
    const tsNode = node.raw as ts.Node;
    return tsNode.getFullText();
  }

  getNodeLocation(node: ASTNode): SourceLocation {
    return node.location;
  }

  getNodeName(node: ASTNode): string | null {
    const tsNode = node.raw as ts.Node;
    
    if (ts.isIdentifier(tsNode)) {
      return tsNode.text;
    }
    
    if ('name' in tsNode && tsNode.name && ts.isIdentifier(tsNode.name as ts.Node)) {
      return (tsNode.name as ts.Identifier).text;
    }
    
    return null;
  }

  extractFunctions(ast: AST): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    
    const visit = (node: ASTNode) => {
      if (this.isFunction(node)) {
        const functionInfo = this.extractFunctionInfo(node);
        if (functionInfo) {
          functions.push(functionInfo);
        }
      }
      
      const children = this.getChildren(node);
      children.forEach(visit);
    };
    
    visit(ast.root);
    return functions;
  }

  extractClasses(ast: AST): ClassInfo[] {
    const classes: ClassInfo[] = [];
    
    const visit = (node: ASTNode) => {
      if (this.isClass(node)) {
        const classInfo = this.extractClassInfo(node);
        if (classInfo) {
          classes.push(classInfo);
        }
      }
      
      const children = this.getChildren(node);
      children.forEach(visit);
    };
    
    visit(ast.root);
    return classes;
  }

  extractImports(ast: AST): ImportInfo[] {
    const imports: ImportInfo[] = [];
    
    const visit = (node: ASTNode) => {
      if (this.isImport(node)) {
        const importInfo = this.extractImportInfo(node);
        if (importInfo) {
          imports.push(importInfo);
        }
      }
      
      const children = this.getChildren(node);
      children.forEach(visit);
    };
    
    visit(ast.root);
    return imports;
  }

  extractExports(ast: AST): ExportInfo[] {
    const exports: ExportInfo[] = [];
    
    const visit = (node: ASTNode) => {
      const tsNode = node.raw as ts.Node;
      
      if (ts.isExportDeclaration(tsNode) || ts.isExportAssignment(tsNode)) {
        const exportInfo = this.extractExportInfo(node);
        if (exportInfo) {
          exports.push(exportInfo);
        }
      }
      
      const children = this.getChildren(node);
      children.forEach(visit);
    };
    
    visit(ast.root);
    return exports;
  }

  isClass(node: ASTNode): boolean {
    const tsNode = node.raw as ts.Node;
    return ts.isClassDeclaration(tsNode) || ts.isClassExpression(tsNode);
  }

  isFunction(node: ASTNode): boolean {
    const tsNode = node.raw as ts.Node;
    return ts.isFunctionDeclaration(tsNode) || 
           ts.isFunctionExpression(tsNode) || 
           ts.isArrowFunction(tsNode) || 
           ts.isMethodDeclaration(tsNode);
  }

  isMethod(node: ASTNode): boolean {
    const tsNode = node.raw as ts.Node;
    return ts.isMethodDeclaration(tsNode);
  }

  isInterface(node: ASTNode): boolean {
    const tsNode = node.raw as ts.Node;
    return ts.isInterfaceDeclaration(tsNode);
  }

  isImport(node: ASTNode): boolean {
    const tsNode = node.raw as ts.Node;
    return ts.isImportDeclaration(tsNode);
  }

  isVariable(node: ASTNode): boolean {
    const tsNode = node.raw as ts.Node;
    return ts.isVariableDeclaration(tsNode);
  }

  // Private helper methods
  
  private convertNode(tsNode: ts.Node): ASTNode {
    const sourceFile = tsNode.getSourceFile();
    const start = tsNode.getStart(sourceFile);
    const end = tsNode.getEnd();
    
    return {
      type: ts.SyntaxKind[tsNode.kind],
      range: [start, end],
      location: this.getLocationFromPosition(sourceFile, start, end),
      raw: tsNode
    };
  }

  private getLocationFromPosition(sourceFile: ts.SourceFile, start: number, end?: number): SourceLocation {
    const startPos = sourceFile.getLineAndCharacterOfPosition(start);
    const endPos = end ? sourceFile.getLineAndCharacterOfPosition(end) : startPos;
    
    return {
      start: { line: startPos.line + 1, column: startPos.character + 1 },
      end: { line: endPos.line + 1, column: endPos.character + 1 }
    };
  }

  private getScriptKind(fileName: string): ts.ScriptKind {
    const ext = path.extname(fileName).toLowerCase();
    switch (ext) {
      case '.ts': return ts.ScriptKind.TS;
      case '.tsx': return ts.ScriptKind.TSX;
      case '.jsx': return ts.ScriptKind.JSX;
      case '.js': return ts.ScriptKind.JS;
      default: return ts.ScriptKind.Unknown;
    }
  }

  private matchesPattern(node: ASTNode, pattern: NodePattern): boolean {
    // Type matching
    if (pattern.type) {
      const types = Array.isArray(pattern.type) ? pattern.type : [pattern.type];
      if (!types.includes(node.type)) {
        return false;
      }
    }

    // Name matching
    if (pattern.name) {
      const nodeName = this.getNodeName(node);
      if (!nodeName) return false;
      
      if (typeof pattern.name === 'string') {
        if (nodeName !== pattern.name) return false;
      } else if (pattern.name instanceof RegExp) {
        if (!pattern.name.test(nodeName)) return false;
      }
    }

    // Custom function matching
    if (pattern.custom) {
      if (!pattern.custom(node)) return false;
    }

    // Parent/child pattern matching would be implemented here
    // For now, we'll skip these complex patterns

    return true;
  }

  private extractFunctionInfo(node: ASTNode): FunctionInfo | null {
    const tsNode = node.raw as ts.Node;
    
    if (!this.isFunction(node)) return null;
    
    const name = this.getNodeName(node) || '<anonymous>';
    const location = this.getNodeLocation(node);
    
    let parameters: ParameterInfo[] = [];
    let isAsync = false;
    let isMethod = false;
    let className: string | undefined;
    
    if (ts.isFunctionDeclaration(tsNode) || ts.isFunctionExpression(tsNode) || ts.isArrowFunction(tsNode)) {
      parameters = this.extractParameters(tsNode.parameters);
      isAsync = !!(tsNode.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AsyncKeyword));
    } else if (ts.isMethodDeclaration(tsNode)) {
      parameters = this.extractParameters(tsNode.parameters);
      isAsync = !!(tsNode.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AsyncKeyword));
      isMethod = true;
      
      // Find the containing class
      let parent: ts.Node | undefined = tsNode.parent;
      while (parent && !ts.isClassDeclaration(parent)) {
        parent = parent.parent;
      }
      if (parent && ts.isClassDeclaration(parent) && parent.name) {
        className = parent.name.text;
      }
    }
    
    return {
      name,
      location,
      parameters,
      isAsync,
      isExported: this.hasExportModifier(tsNode),
      isMethod,
      className
    };
  }

  private extractClassInfo(node: ASTNode): ClassInfo | null {
    const tsNode = node.raw as ts.Node;
    
    if (!ts.isClassDeclaration(tsNode) && !ts.isClassExpression(tsNode)) return null;
    
    const name = tsNode.name?.text || '<anonymous>';
    const location = this.getNodeLocation(node);
    
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];
    
    // Extract methods and properties
    for (const member of tsNode.members) {
      if (ts.isMethodDeclaration(member)) {
        const methodNode = this.convertNode(member as ts.Node);
        const methodInfo = this.extractFunctionInfo(methodNode);
        if (methodInfo) {
          methods.push(methodInfo);
        }
      } else if (ts.isPropertyDeclaration(member)) {
        const propInfo = this.extractPropertyInfo(member);
        if (propInfo) {
          properties.push(propInfo);
        }
      }
    }
    
    return {
      name,
      location,
      methods,
      properties,
      extends: [], // Would extract heritage clause
      implements: [], // Would extract implements clause
      isExported: this.hasExportModifier(tsNode),
      isAbstract: !!(tsNode.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AbstractKeyword))
    };
  }

  private extractImportInfo(node: ASTNode): ImportInfo | null {
    const tsNode = node.raw as ts.Node;
    
    if (!ts.isImportDeclaration(tsNode)) return null;
    
    const moduleSpecifier = tsNode.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) return null;
    
    const module = moduleSpecifier.text;
    const location = this.getNodeLocation(node);
    const isTypeOnly = !!(tsNode.importClause?.isTypeOnly);
    
    const items: ImportItem[] = [];
    
    if (tsNode.importClause) {
      // Default import
      if (tsNode.importClause.name) {
        items.push({
          name: tsNode.importClause.name.text,
          isDefault: true
        });
      }
      
      // Named imports
      if (tsNode.importClause.namedBindings) {
        if (ts.isNamedImports(tsNode.importClause.namedBindings)) {
          for (const element of tsNode.importClause.namedBindings.elements) {
            items.push({
              name: element.name.text,
              alias: element.propertyName?.text,
              isDefault: false
            });
          }
        }
      }
    }
    
    return {
      module,
      items,
      location,
      isTypeOnly
    };
  }

  private extractExportInfo(node: ASTNode): ExportInfo | null {
    // Simplified export extraction - would be expanded for full support
    return null;
  }

  private extractParameters(parameters: ts.NodeArray<ts.ParameterDeclaration>): ParameterInfo[] {
    return parameters.map(param => ({
      name: param.name.getText(),
      type: param.type?.getText(),
      optional: !!param.questionToken,
      defaultValue: param.initializer?.getText()
    }));
  }

  private extractPropertyInfo(prop: ts.PropertyDeclaration): PropertyInfo | null {
    const name = prop.name?.getText();
    if (!name) return null;
    
    return {
      name,
      type: prop.type?.getText(),
      location: this.getLocationFromPosition(prop.getSourceFile(), prop.getStart()),
      isStatic: !!(prop.modifiers?.some(mod => mod.kind === ts.SyntaxKind.StaticKeyword)),
      isPrivate: !!(prop.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword)),
      isReadonly: !!(prop.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ReadonlyKeyword))
    };
  }

  private hasExportModifier(node: ts.Node): boolean {
    if ('modifiers' in node && node.modifiers) {
      return (node.modifiers as readonly ts.Modifier[]).some(mod => mod.kind === ts.SyntaxKind.ExportKeyword);
    }
    return false;
  }
}