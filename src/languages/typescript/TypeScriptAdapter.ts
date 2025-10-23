/**
 * TypeScript language adapter implementation
 */

import ts from 'typescript';
import type {
  LanguageAdapter,
  AST,
  ASTNode,
  NodePattern,
  FunctionInfo,
  ClassInfo,
  InterfaceInfo,
  ImportInfo,
  ExportInfo,
  SourceLocation,
  ParameterInfo,
  PropertyInfo,
  ImportSpecifier
} from '../types.js';

export class TypeScriptAdapter implements LanguageAdapter {
  readonly name = 'typescript';
  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  
  private sourceFiles = new Map<string, ts.SourceFile>();
  
  /**
   * Parse a file into an AST
   */
  async parse(filePath: string, content: string): Promise<AST> {
    const isJsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    
    // Cache source file for later use
    this.sourceFiles.set(filePath, sourceFile);
    
    // Convert to our AST format
    const root = this.convertNode(sourceFile, sourceFile);
    
    return {
      root,
      language: 'typescript',
      filePath,
      errors: [] // TypeScript parse errors would be captured here
    };
  }
  
  /**
   * Check if this adapter supports a file
   */
  supportsFile(filePath: string): boolean {
    const ext = filePath.toLowerCase();
    return this.fileExtensions.some(supported => ext.endsWith(supported));
  }
  
  /**
   * Find nodes matching a pattern
   */
  findNodes(ast: AST, pattern: NodePattern): ASTNode[] {
    const matches: ASTNode[] = [];
    this.walkAST(ast.root, node => {
      if (this.matchesPattern(node, pattern)) {
        matches.push(node);
      }
    });
    return matches;
  }
  
  /**
   * Get parent node
   */
  getParent(node: ASTNode): ASTNode | null {
    return node.parent || null;
  }
  
  /**
   * Get child nodes
   */
  getChildren(node: ASTNode): ASTNode[] {
    return node.children || [];
  }
  
  /**
   * Get sibling nodes
   */
  getSiblings(node: ASTNode): ASTNode[] {
    if (!node.parent || !node.parent.children) return [];
    return node.parent.children.filter(child => child !== node);
  }
  
  /**
   * Get node type
   */
  getNodeType(node: ASTNode): string {
    return node.type;
  }
  
  /**
   * Get node text from source
   */
  getNodeText(node: ASTNode, sourceCode: string): string {
    return sourceCode.substring(node.range[0], node.range[1]);
  }
  
  /**
   * Get node name if applicable
   */
  getNodeName(node: ASTNode): string | null {
    const tsNode = node.raw as ts.Node;
    
    if (ts.isIdentifier(tsNode)) {
      return tsNode.text;
    }
    
    if ('name' in tsNode && tsNode.name && ts.isIdentifier((tsNode as any).name)) {
      return ((tsNode as any).name as ts.Identifier).text;
    }
    
    return null;
  }
  
  /**
   * Get node location
   */
  getNodeLocation(node: ASTNode): SourceLocation {
    return node.location;
  }
  
  /**
   * Extract all functions from AST
   */
  extractFunctions(ast: AST): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    console.log('[DEBUG] TypeScript extractFunctions called for:', ast.filePath);
    
    this.walkAST(ast.root, node => {
      const isFunc = this.isFunction(node);
      const isMeth = this.isMethod(node);
      
      if (isFunc) {
        console.log('[DEBUG] Found function node:', {
          type: node.type,
          isFunction: isFunc,
          isMethod: isMeth,
          line: node.location.start.line
        });
      }
      
      if (isFunc && !isMeth) {
        const func = this.extractFunctionInfo(node);
        if (func) {
          console.log('[DEBUG] Extracted function:', func.name, 'at line', func.location.start.line);
          functions.push(func);
        } else {
          console.log('[DEBUG] Failed to extract function info for node at line', node.location.start.line);
        }
      }
    });
    
    console.log('[DEBUG] Total functions extracted:', functions.length);
    return functions;
  }
  
  /**
   * Extract all classes from AST
   */
  extractClasses(ast: AST): ClassInfo[] {
    const classes: ClassInfo[] = [];
    
    this.walkAST(ast.root, node => {
      if (this.isClass(node)) {
        const classInfo = this.extractClassInfo(node);
        if (classInfo) classes.push(classInfo);
      }
    });
    
    return classes;
  }
  
  /**
   * Extract all imports from AST
   */
  extractImports(ast: AST): ImportInfo[] {
    const imports: ImportInfo[] = [];
    
    this.walkAST(ast.root, node => {
      if (this.isImport(node)) {
        const importInfo = this.extractImportInfo(node);
        if (importInfo) imports.push(importInfo);
      }
    });
    
    return imports;
  }
  
  /**
   * Extract all exports from AST
   */
  extractExports(ast: AST): ExportInfo[] {
    const exports: ExportInfo[] = [];
    
    this.walkAST(ast.root, node => {
      if (this.isExport(node)) {
        const exportInfo = this.extractExportInfo(node);
        if (exportInfo) exports.push(exportInfo);
      }
    });
    
    return exports;
  }
  
  // Pattern matching helpers
  
  isClass(node: ASTNode): boolean {
    return node.type === 'ClassDeclaration' || node.type === 'ClassExpression';
  }
  
  isFunction(node: ASTNode): boolean {
    const funcTypes = [
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunction',
      'MethodDeclaration'
    ];
    return funcTypes.includes(node.type);
  }
  
  isMethod(node: ASTNode): boolean {
    return node.type === 'MethodDeclaration';
  }
  
  isInterface(node: ASTNode): boolean {
    const result = node.type === 'InterfaceDeclaration';
    if (result) {
      console.error('[DEBUG] isInterface found interface node:', node.type);
    }
    return result;
  }
  
  isImport(node: ASTNode): boolean {
    return node.type === 'ImportDeclaration';
  }
  
  isExport(node: ASTNode): boolean {
    const tsNode = node.raw as ts.Node;
    return ts.isExportDeclaration(tsNode) || ts.isExportAssignment(tsNode) ||
           (ts.isModifierLike(tsNode) && tsNode.kind === ts.SyntaxKind.ExportKeyword);
  }
  
  isLoop(node: ASTNode): boolean {
    const loopTypes = [
      'ForStatement',
      'ForInStatement',
      'ForOfStatement',
      'WhileStatement',
      'DoWhileStatement'
    ];
    return loopTypes.includes(node.type);
  }
  
  isConditional(node: ASTNode): boolean {
    return node.type === 'IfStatement' || 
           node.type === 'ConditionalExpression' ||
           node.type === 'SwitchStatement';
  }
  
  isVariableDeclaration(node: ASTNode): boolean {
    return node.type === 'VariableDeclaration' ||
           node.type === 'VariableStatement';
  }
  
  /**
   * Get type information for a node
   */
  getTypeInfo(node: ASTNode): string | null {
    const tsNode = node.raw as ts.Node;
    
    if ('type' in tsNode && tsNode.type) {
      return this.typeToString(tsNode.type as ts.TypeNode);
    }
    
    return null;
  }
  
  /**
   * Get documentation comment for a node
   */
  getDocumentation(node: ASTNode): string | null {
    const tsNode = node.raw as ts.Node;
    const sourceFile = this.getSourceFileForNode(tsNode);
    
    if (!sourceFile) return null;
    
    // Get JSDoc comments
    const jsDocs = ts.getJSDocCommentsAndTags(tsNode);
    if (jsDocs.length > 0) {
      return jsDocs.map(doc => doc.getText(sourceFile)).join('\n');
    }
    
    return null;
  }
  
  /**
   * Calculate cyclomatic complexity for a node
   */
  getComplexity(node: ASTNode): number {
    let complexity = 1;
    
    this.walkAST(node, child => {
      // Each decision point adds to complexity
      if (this.isConditional(child) || this.isLoop(child)) {
        complexity++;
      }
      
      // Logical operators also add complexity
      if (child.type === 'BinaryExpression') {
        const op = (child.raw as any).operatorToken?.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken ||
            op === ts.SyntaxKind.BarBarToken) {
          complexity++;
        }
      }
    });
    
    return complexity;
  }
  
  // Private helper methods
  
  private convertNode(tsNode: ts.Node, sourceFile: ts.SourceFile, parent?: ASTNode): ASTNode {
    const start = tsNode.getStart(sourceFile);
    const end = tsNode.getEnd();
    const startPos = sourceFile.getLineAndCharacterOfPosition(start);
    const endPos = sourceFile.getLineAndCharacterOfPosition(end);
    
    const node: ASTNode = {
      type: ts.SyntaxKind[tsNode.kind],
      range: [start, end],
      location: {
        start: { line: startPos.line + 1, column: startPos.character + 1 },
        end: { line: endPos.line + 1, column: endPos.character + 1 }
      },
      parent,
      raw: tsNode
    };
    
    // Convert children
    const children: ASTNode[] = [];
    tsNode.forEachChild(child => {
      children.push(this.convertNode(child, sourceFile, node));
    });
    
    if (children.length > 0) {
      node.children = children;
    }
    
    return node;
  }
  
  private walkAST(node: ASTNode, callback: (node: ASTNode) => void): void {
    callback(node);
    if (node.children) {
      for (const child of node.children) {
        this.walkAST(child, callback);
      }
    }
  }
  
  private matchesPattern(node: ASTNode, pattern: NodePattern): boolean {
    if (pattern.type) {
      const types = Array.isArray(pattern.type) ? pattern.type : [pattern.type];
      if (!types.includes(node.type)) return false;
    }
    
    if (pattern.name) {
      const nodeName = this.getNodeName(node);
      if (!nodeName) return false;
      
      if (pattern.name instanceof RegExp) {
        if (!pattern.name.test(nodeName)) return false;
      } else {
        if (nodeName !== pattern.name) return false;
      }
    }
    
    if (pattern.hasChild) {
      const hasMatchingChild = (node.children || []).some(child =>
        this.matchesPattern(child, pattern.hasChild!)
      );
      if (!hasMatchingChild) return false;
    }
    
    if (pattern.hasParent && node.parent) {
      if (!this.matchesPattern(node.parent, pattern.hasParent)) return false;
    }
    
    if (pattern.custom && !pattern.custom(node)) return false;
    
    return true;
  }
  
  private extractFunctionInfo(node: ASTNode): FunctionInfo | null {
    const tsNode = node.raw as ts.Node;
    
    if (!ts.isFunctionLike(tsNode)) return null;
    
    const name = this.getNodeName(node) || '<anonymous>';
    const params = this.extractParameters(tsNode);
    const jsDoc = this.getDocumentation(node);
    
    return {
      name,
      location: node.location,
      parameters: params,
      returnType: tsNode.type ? this.typeToString(tsNode.type) : undefined,
      isAsync: !!(tsNode as any).modifiers?.some(
        (m: ts.Modifier) => m.kind === ts.SyntaxKind.AsyncKeyword
      ),
      isExported: this.hasExportModifier(tsNode),
      isMethod: ts.isMethodDeclaration(tsNode),
      jsDoc: jsDoc || undefined
    };
  }
  
  private extractClassInfo(node: ASTNode): ClassInfo | null {
    const tsNode = node.raw as ts.Node;
    
    if (!ts.isClassLike(tsNode)) return null;
    
    const name = this.getNodeName(node) || '<anonymous>';
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];
    const jsDoc = this.getDocumentation(node);
    
    // Extract methods and properties
    tsNode.members.forEach(member => {
      if (ts.isMethodDeclaration(member)) {
        // Create a temporary ASTNode wrapper for the method
        const sourceFile = this.getSourceFileForNode(member);
        if (sourceFile) {
          const methodNode = this.convertNode(member, sourceFile, node);
          const methodInfo = this.extractFunctionInfo(methodNode);
          if (methodInfo) methods.push(methodInfo);
        }
      } else if (ts.isPropertyDeclaration(member)) {
        const propInfo = this.extractPropertyInfo(member);
        if (propInfo) properties.push(propInfo);
      }
    });
    
    return {
      name,
      location: node.location,
      methods,
      properties,
      extends: this.getExtendsClause(tsNode),
      implements: this.getImplementsClause(tsNode),
      isAbstract: !!(tsNode as any).modifiers?.some(
        (m: ts.Modifier) => m.kind === ts.SyntaxKind.AbstractKeyword
      ),
      isExported: this.hasExportModifier(tsNode),
      jsDoc: jsDoc || undefined
    };
  }
  
  private extractImportInfo(node: ASTNode): ImportInfo | null {
    const tsNode = node.raw as ts.Node;
    
    if (!ts.isImportDeclaration(tsNode)) return null;
    
    const source = (tsNode.moduleSpecifier as ts.StringLiteral).text;
    const specifiers: ImportSpecifier[] = [];
    
    if (tsNode.importClause) {
      // Default import
      if (tsNode.importClause.name) {
        specifiers.push({
          name: tsNode.importClause.name.text,
          isDefault: true,
          isNamespace: false
        });
      }
      
      // Named imports
      if (tsNode.importClause.namedBindings) {
        if (ts.isNamespaceImport(tsNode.importClause.namedBindings)) {
          specifiers.push({
            name: tsNode.importClause.namedBindings.name.text,
            isDefault: false,
            isNamespace: true
          });
        } else if (ts.isNamedImports(tsNode.importClause.namedBindings)) {
          tsNode.importClause.namedBindings.elements.forEach(element => {
            specifiers.push({
              name: element.propertyName?.text || element.name.text,
              alias: element.propertyName ? element.name.text : undefined,
              isDefault: false,
              isNamespace: false
            });
          });
        }
      }
    }
    
    return {
      source,
      specifiers,
      location: node.location
    };
  }
  
  private extractExportInfo(node: ASTNode): ExportInfo | null {
    const tsNode = node.raw as ts.Node;
    const name = this.getNodeName(node) || '<anonymous>';
    
    return {
      name,
      location: node.location,
      isDefault: ts.isExportAssignment(tsNode)
    };
  }
  
  private extractParameters(node: ts.SignatureDeclaration): ParameterInfo[] {
    return node.parameters.map(param => ({
      name: ts.isIdentifier(param.name) ? param.name.text : '<complex>',
      type: param.type ? this.typeToString(param.type) : undefined,
      optional: !!param.questionToken,
      defaultValue: param.initializer ? param.initializer.getText() : undefined
    }));
  }
  
  private extractPropertyInfo(node: ts.PropertyDeclaration): PropertyInfo | null {
    const name = ts.isIdentifier(node.name) ? node.name.text : '<computed>';
    
    return {
      name,
      type: node.type ? this.typeToString(node.type) : undefined,
      visibility: this.getVisibility(node),
      isStatic: !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword),
      isReadonly: !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword)
    };
  }
  
  private getVisibility(node: ts.Node): 'public' | 'private' | 'protected' {
    // getModifiers requires specific node types, use type assertion
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node as ts.HasModifiers) : undefined;
    if (!modifiers) return 'public';
    
    if (modifiers.some(m => m.kind === ts.SyntaxKind.PrivateKeyword)) return 'private';
    if (modifiers.some(m => m.kind === ts.SyntaxKind.ProtectedKeyword)) return 'protected';
    return 'public';
  }
  
  private hasExportModifier(node: ts.Node): boolean {
    // getModifiers requires specific node types, use type assertion
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node as ts.HasModifiers) : undefined;
    return !!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  }
  
  private typeToString(type: ts.TypeNode): string {
    // Simple string representation of types
    return type.getText();
  }
  
  private getExtendsClause(node: ts.ClassLikeDeclaration): string | undefined {
    if (!node.heritageClauses) return undefined;
    
    const extendsClause = node.heritageClauses.find(
      clause => clause.token === ts.SyntaxKind.ExtendsKeyword
    );
    
    if (extendsClause && extendsClause.types.length > 0) {
      return extendsClause.types[0].expression.getText();
    }
    
    return undefined;
  }
  
  private getImplementsClause(node: ts.ClassLikeDeclaration): string[] {
    if (!node.heritageClauses) return [];
    
    const implementsClause = node.heritageClauses.find(
      clause => clause.token === ts.SyntaxKind.ImplementsKeyword
    );
    
    if (implementsClause) {
      return implementsClause.types.map(type => type.expression.getText());
    }
    
    return [];
  }
  
  private findNodeByRaw(root: ASTNode, tsNode: ts.Node): ASTNode | null {
    if (root.raw === tsNode) return root;
    
    if (root.children) {
      for (const child of root.children) {
        const found = this.findNodeByRaw(child, tsNode);
        if (found) return found;
      }
    }
    
    return null;
  }
  
  private getSourceFileForNode(node: ts.Node): ts.SourceFile | null {
    let current: ts.Node = node;
    while (current.parent) {
      current = current.parent;
    }
    return ts.isSourceFile(current) ? current : null;
  }
  
  /**
   * Extract all interfaces from AST
   */
  extractInterfaces?(ast: AST): InterfaceInfo[] {
    console.error('[DEBUG] TypeScript extractInterfaces called for:', ast.filePath);
    const interfaces: InterfaceInfo[] = [];
    
    this.walkAST(ast.root, node => {
      if (this.isInterface(node)) {
        console.error('[DEBUG] Found interface node:', node.type);
        const interfaceInfo = this.extractInterfaceInfo(node);
        if (interfaceInfo) {
          console.error('[DEBUG] Extracted interface:', interfaceInfo.name, 'with', interfaceInfo.members?.length, 'members');
          interfaces.push(interfaceInfo);
        }
      }
    });
    
    console.error('[DEBUG] Total interfaces extracted:', interfaces.length);
    return interfaces;
  }
  
  private extractInterfaceInfo(node: ASTNode): InterfaceInfo | null {
    const tsNode = node.raw as ts.Node;
    
    if (!ts.isInterfaceDeclaration(tsNode)) return null;
    
    const name = tsNode.name.text;
    const members: Array<{ name: string; type: 'method' | 'property'; location: SourceLocation }> = [];
    
    const sourceFile = tsNode.getSourceFile();
    
    tsNode.members.forEach(member => {
      const start = member.getStart(sourceFile);
      const end = member.getEnd();
      const startPos = sourceFile.getLineAndCharacterOfPosition(start);
      const endPos = sourceFile.getLineAndCharacterOfPosition(end);
      
      const memberLocation: SourceLocation = {
        start: { line: startPos.line + 1, column: startPos.character + 1 },
        end: { line: endPos.line + 1, column: endPos.character + 1 }
      };
      
      if (ts.isMethodSignature(member)) {
        const methodName = member.name && ts.isIdentifier(member.name) ? member.name.text : '<computed>';
        members.push({ name: methodName, type: 'method', location: memberLocation });
      } else if (ts.isPropertySignature(member)) {
        const propName = member.name && ts.isIdentifier(member.name) ? member.name.text : '<computed>';
        members.push({ name: propName, type: 'property', location: memberLocation });
      }
    });
    
    return {
      name,
      location: node.location,
      members,
      extends: tsNode.heritageClauses?.find(c => c.token === ts.SyntaxKind.ExtendsKeyword)
        ?.types.map(t => t.expression.getText()) || [],
      isExported: this.hasExportModifier(tsNode)
    };
  }
}