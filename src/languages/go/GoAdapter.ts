/**
 * Go Language Adapter
 * Provides Go language support for the universal analyzer system
 */

import { 
  LanguageAdapter, 
  AST, 
  ASTNode, 
  FunctionInfo, 
  ClassInfo, 
  ImportInfo, 
  ExportInfo, 
  InterfaceInfo,
  NodePattern, 
  SourceLocation,
  ParseError 
} from '../types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);

export class GoAdapter implements LanguageAdapter {
  readonly name = 'go';
  readonly fileExtensions = ['.go'];

  /**
   * Parse Go source code into an AST
   */
  async parse(filePath: string, content: string): Promise<AST> {
    try {
      console.error('[DEBUG] Go: Parsing file:', filePath);
      
      // For now, create a simple AST structure
      // TODO: Implement actual Go parser integration
      const ast: AST = {
        root: this.createSimpleGoAST(content, filePath),
        language: 'go',
        filePath,
        errors: []
      };
      
      console.error('[DEBUG] Go: AST created successfully');
      return ast;
    } catch (error) {
      console.error('[DEBUG] Go: Parse error:', error);
      return {
        root: { 
          type: 'Program', 
          range: [0, content.length], 
          location: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          raw: null 
        },
        language: 'go',
        filePath,
        errors: [{
          message: error instanceof Error ? error.message : String(error),
          location: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          severity: 'error' as const
        }]
      };
    }
  }

  /**
   * Create a simple Go AST from source code using regex patterns
   * This is a basic implementation that will be enhanced later
   */
  private createSimpleGoAST(content: string, filePath: string): ASTNode {
    const lines = content.split('\n');
    const children: ASTNode[] = [];
    
    // Extract functions using regex
    const functionPattern = /^func\s+(\w+)\s*\([^)]*\)\s*(\([^)]*\))?\s*\{/gm;
    let match;
    
    while ((match = functionPattern.exec(content)) !== null) {
      const functionName = match[1];
      const startPos = match.index;
      const startLine = content.substring(0, startPos).split('\n').length;
      
      children.push({
        type: 'FunctionDeclaration',
        range: [startPos, startPos + match[0].length],
        location: {
          start: { line: startLine, column: 0 },
          end: { line: startLine, column: match[0].length }
        },
        raw: {
          name: functionName,
          match: match[0]
        }
      });
    }

    // Extract structs using regex  
    const structPattern = /^type\s+(\w+)\s+struct\s*\{/gm;
    while ((match = structPattern.exec(content)) !== null) {
      const structName = match[1];
      const startPos = match.index;
      const startLine = content.substring(0, startPos).split('\n').length;
      
      children.push({
        type: 'StructDeclaration',
        range: [startPos, startPos + match[0].length],
        location: {
          start: { line: startLine, column: 0 },
          end: { line: startLine, column: match[0].length }
        },
        raw: {
          name: structName,
          match: match[0]
        }
      });
    }

    // Extract interfaces using regex with member parsing
    const interfacePattern = /type\s+(\w+)\s+interface\s*\{([\s\S]*?)\}/gm;
    while ((match = interfacePattern.exec(content)) !== null) {
      const interfaceName = match[1];
      const interfaceBody = match[2];
      const startPos = match.index;
      const startLine = content.substring(0, startPos).split('\n').length;
      
      // Count interface methods - look for method signatures
      const methodMatches = interfaceBody.match(/^\s*\w+\s*\([^)]*\)\s*(\([^)]*\))?\s*(\w+)?\s*$/gm) || [];
      const memberCount = methodMatches.length;
      
      console.error(`[DEBUG] Go: Interface ${interfaceName} body:`, JSON.stringify(interfaceBody.substring(0, 200)));
      console.error(`[DEBUG] Go: Interface ${interfaceName} method matches:`, methodMatches.length, methodMatches.slice(0, 3));
      
      children.push({
        type: 'InterfaceDeclaration',
        range: [startPos, startPos + match[0].length],
        location: {
          start: { line: startLine, column: 0 },
          end: { line: startLine, column: match[0].length }
        },
        raw: {
          name: interfaceName,
          match: match[0],
          memberCount: memberCount,
          methods: methodMatches
        }
      });
    }

    return {
      type: 'Program',
      range: [0, content.length],
      location: {
        start: { line: 1, column: 0 },
        end: { line: lines.length, column: lines[lines.length - 1]?.length || 0 }
      },
      children,
      raw: { content, filePath }
    };
  }

  /**
   * Check if this adapter supports a file
   */
  supportsFile(filePath: string): boolean {
    return this.fileExtensions.some(ext => filePath.endsWith(ext));
  }

  // AST Navigation
  findNodes(ast: AST, pattern: NodePattern): ASTNode[] {
    const results: ASTNode[] = [];
    this.walkAST(ast.root, node => {
      if (this.matchesPattern(node, pattern)) {
        results.push(node);
      }
    });
    return results;
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
    return true;
  }

  getParent(node: ASTNode): ASTNode | null {
    return node.parent || null;
  }

  getChildren(node: ASTNode): ASTNode[] {
    return node.children || [];
  }

  getSiblings(node: ASTNode): ASTNode[] {
    const parent = this.getParent(node);
    if (!parent) return [];
    return this.getChildren(parent).filter(child => child !== node);
  }

  // Node Information
  getNodeType(node: ASTNode): string {
    return node.type;
  }

  getNodeText(node: ASTNode, sourceCode: string): string {
    const [start, end] = node.range;
    return sourceCode.substring(start, end);
  }

  getNodeName(node: ASTNode): string | null {
    if (node.raw && node.raw.name) {
      return node.raw.name;
    }
    return null;
  }

  getNodeLocation(node: ASTNode): SourceLocation {
    return node.location;
  }

  // Language-Specific Extraction
  extractFunctions(ast: AST): FunctionInfo[] {
    console.error('[DEBUG] Go: extractFunctions called for:', ast.filePath);
    const functions: FunctionInfo[] = [];
    
    this.walkAST(ast.root, node => {
      if (this.isFunction(node)) {
        const func = this.extractFunctionInfo(node);
        if (func) {
          console.error('[DEBUG] Go: Extracted function:', func.name, 'at line', func.location.start.line);
          functions.push(func);
        }
      }
    });
    
    console.error('[DEBUG] Go: Total functions extracted:', functions.length);
    return functions;
  }

  private extractFunctionInfo(node: ASTNode): FunctionInfo | null {
    if (!this.isFunction(node) || !node.raw?.name) return null;

    return {
      name: node.raw.name,
      parameters: [], // TODO: Parse parameters from function signature
      returnType: 'unknown', // TODO: Parse return type
      location: node.location,
      isAsync: false, // Go doesn't have async/await like JS
      isExported: this.isExportedFunction(node.raw.name),
      isMethod: false, // TODO: Detect if this is a method (has receiver)
      className: undefined, // TODO: Extract receiver type for methods
      jsDoc: undefined // Go uses different comment format
    };
  }

  private isExportedFunction(name: string): boolean {
    // In Go, exported functions start with uppercase letter
    return name.length > 0 && name[0] === name[0].toUpperCase();
  }

  extractClasses(ast: AST): ClassInfo[] {
    console.error('[DEBUG] Go: extractClasses called (Note: Go uses structs, not classes)');
    const structs: ClassInfo[] = [];
    
    this.walkAST(ast.root, node => {
      if (this.isStruct(node)) {
        const struct = this.extractStructInfo(node);
        if (struct) {
          structs.push(struct);
        }
      }
    });
    
    console.error('[DEBUG] Go: Total structs extracted:', structs.length);
    return structs;
  }

  private extractStructInfo(node: ASTNode): ClassInfo | null {
    if (!this.isStruct(node) || !node.raw?.name) return null;

    return {
      name: node.raw.name,
      location: node.location,
      methods: [], // TODO: Extract methods associated with this struct
      properties: [], // TODO: Extract struct fields
      extends: undefined, // Go doesn't have inheritance
      implements: [], // TODO: Check if struct implements interfaces
      isAbstract: false, // Go doesn't have abstract structs
      isExported: this.isExportedStruct(node.raw.name),
      jsDoc: undefined
    };
  }

  private isExportedStruct(name: string): boolean {
    return name.length > 0 && name[0] === name[0].toUpperCase();
  }

  extractImports(ast: AST): ImportInfo[] {
    console.error('[DEBUG] Go: extractImports called');
    const imports: ImportInfo[] = [];
    
    // TODO: Parse Go import statements
    // Go imports look like: import "fmt" or import ( "fmt" "os" )
    
    console.error('[DEBUG] Go: Total imports extracted:', imports.length);
    return imports;
  }

  extractExports(ast: AST): ExportInfo[] {
    console.error('[DEBUG] Go: extractExports called');
    // Go doesn't have explicit exports - exported items are those starting with uppercase
    return [];
  }

  // Optional interface extraction for SOLID analysis
  extractInterfaces?(ast: AST): InterfaceInfo[] {
    console.error('[DEBUG] Go: extractInterfaces called for:', ast.filePath);
    const interfaces: InterfaceInfo[] = [];
    
    this.walkAST(ast.root, node => {
      if (this.isInterface(node)) {
        const iface = this.extractInterfaceInfo(node);
        if (iface) {
          console.error('[DEBUG] Go: Extracted interface:', iface.name, 'with', iface.members?.length, 'members');
          interfaces.push(iface);
        }
      }
    });
    
    console.error('[DEBUG] Go: Total interfaces extracted:', interfaces.length);
    return interfaces;
  }

  private extractInterfaceInfo(node: ASTNode): InterfaceInfo | null {
    if (!this.isInterface(node) || !node.raw?.name) return null;

    // Create member objects from the parsed methods
    const members = [];
    if (node.raw.methods && Array.isArray(node.raw.methods)) {
      for (let i = 0; i < node.raw.methods.length; i++) {
        members.push({
          name: `method${i + 1}`, // Simple naming since we can't parse method names easily with regex
          type: 'method' as const,
          location: node.location // Use interface location as approximation
        });
      }
    }

    return {
      name: node.raw.name,
      location: node.location,
      members: members,
      extends: [], // Go interfaces can embed other interfaces
      isExported: this.isExportedInterface(node.raw.name)
    };
  }

  private isExportedInterface(name: string): boolean {
    return name.length > 0 && name[0] === name[0].toUpperCase();
  }

  // Pattern Matching Helpers
  isClass(node: ASTNode): boolean {
    return this.isStruct(node); // In Go, structs are like classes
  }

  isStruct(node: ASTNode): boolean {
    return node.type === 'StructDeclaration';
  }

  isFunction(node: ASTNode): boolean {
    return node.type === 'FunctionDeclaration';
  }

  isMethod(node: ASTNode): boolean {
    // TODO: Detect methods (functions with receivers)
    return false;
  }

  isInterface(node: ASTNode): boolean {
    return node.type === 'InterfaceDeclaration';
  }

  isImport(node: ASTNode): boolean {
    return node.type === 'ImportDeclaration';
  }

  isExport(node: ASTNode): boolean {
    // Go doesn't have explicit exports
    return false;
  }

  isLoop(node: ASTNode): boolean {
    return ['ForStatement', 'RangeStatement'].includes(node.type);
  }

  isConditional(node: ASTNode): boolean {
    return ['IfStatement', 'SwitchStatement', 'TypeSwitchStatement'].includes(node.type);
  }

  isVariableDeclaration(node: ASTNode): boolean {
    return ['VarDeclaration', 'ConstDeclaration'].includes(node.type);
  }

  // Advanced Features
  getTypeInfo(node: ASTNode): string | null {
    // TODO: Extract type information from Go AST
    return null;
  }

  getDocumentation(node: ASTNode): string | null {
    // TODO: Extract Go comments (// or /* */)
    return null;
  }

  getComplexity(node: ASTNode): number {
    // TODO: Calculate complexity based on control flow
    return 1;
  }
}