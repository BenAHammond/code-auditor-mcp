/**
 * AST Parser Utilities
 * Provides TypeScript AST parsing and analysis utilities
 * 
 * Core functionality for parsing TypeScript/JavaScript files and
 * extracting information for code analysis
 */

import * as ts from 'typescript';
import { promises as fs } from 'fs';

/**
 * Parse options for TypeScript compiler
 */
const PARSE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.React,
  allowJs: true,
  esModuleInterop: true,
  skipLibCheck: true,
  strict: false,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  noResolve: true,
  isolatedModules: true,
  allowSyntheticDefaultImports: true,
  lib: ['lib.es2022.d.ts']
};

/**
 * AST parse result
 */
export interface ParseResult {
  sourceFile: ts.SourceFile;
  program?: ts.Program;
  errors: ts.Diagnostic[];
}

/**
 * Import information
 */
export interface ImportInfo {
  moduleSpecifier: string;
  importedNames: string[];
  isDefaultImport: boolean;
  isNamespaceImport: boolean;
  line: number;
}

/**
 * Export information
 */
export interface ExportInfo {
  name: string;
  type: 'function' | 'class' | 'interface' | 'type' | 'const' | 'let' | 'var' | 'enum';
  isDefault: boolean;
  line: number;
}

/**
 * Parse a TypeScript file and return AST
 */
export async function parseTypeScriptFile(filePath: string): Promise<ParseResult> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Determine script kind based on file extension
    let scriptKind = ts.ScriptKind.TS;
    if (filePath.endsWith('.tsx')) {
      scriptKind = ts.ScriptKind.TSX;
    } else if (filePath.endsWith('.jsx')) {
      scriptKind = ts.ScriptKind.JSX;
    } else if (filePath.endsWith('.js')) {
      scriptKind = ts.ScriptKind.JS;
    }
    
    // Create source file without type checking
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true, // setParentNodes
      scriptKind
    );
    
    // No errors for pure AST parsing
    const errors: ts.Diagnostic[] = [];
    
    return {
      sourceFile,
      program: undefined,
      errors
    };
  } catch (error) {
    // Return error as diagnostic
    const diagnostic: ts.Diagnostic = {
      file: undefined,
      start: 0,
      length: 0,
      messageText: `Failed to read file: ${error}`,
      category: ts.DiagnosticCategory.Error,
      code: 9999
    };
    
    // Create empty source file for consistency
    const sourceFile = ts.createSourceFile(
      filePath,
      '',
      ts.ScriptTarget.Latest,
      true
    );
    
    return {
      sourceFile,
      errors: [diagnostic]
    };
  }
}

/**
 * Extract import statements from AST
 */
export function getImports(sourceFile: ts.SourceFile): ImportInfo[] {
  const imports: ImportInfo[] = [];
  
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
      const importClause = node.importClause;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      
      const importInfo: ImportInfo = {
        moduleSpecifier,
        importedNames: [],
        isDefaultImport: false,
        isNamespaceImport: false,
        line
      };
      
      if (importClause) {
        // Default import
        if (importClause.name) {
          importInfo.isDefaultImport = true;
          importInfo.importedNames.push(importClause.name.text);
        }
        
        // Named imports
        if (importClause.namedBindings) {
          if (ts.isNamespaceImport(importClause.namedBindings)) {
            importInfo.isNamespaceImport = true;
            importInfo.importedNames.push(importClause.namedBindings.name.text);
          } else if (ts.isNamedImports(importClause.namedBindings)) {
            importClause.namedBindings.elements.forEach(element => {
              importInfo.importedNames.push(element.name.text);
            });
          }
        }
      }
      
      imports.push(importInfo);
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return imports;
}

/**
 * Extract export statements from AST
 */
export function getExports(sourceFile: ts.SourceFile): ExportInfo[] {
  const exports: ExportInfo[] = [];
  
  function visit(node: ts.Node) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    
    // Export declarations
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        node.exportClause.elements.forEach(element => {
          exports.push({
            name: element.name.text,
            type: 'const', // Generic type for re-exports
            isDefault: false,
            line
          });
        });
      }
    }
    
    // Function/const/class/interface with export keyword
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      let name = '';
      let type: ExportInfo['type'] = 'const';
      let isDefault = modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
      
      if (ts.isFunctionDeclaration(node)) {
        name = node.name?.text || (isDefault ? 'default' : 'anonymous');
        type = 'function';
      } else if (ts.isClassDeclaration(node)) {
        name = node.name?.text || (isDefault ? 'default' : 'anonymous');
        type = 'class';
      } else if (ts.isInterfaceDeclaration(node)) {
        name = node.name.text;
        type = 'interface';
      } else if (ts.isTypeAliasDeclaration(node)) {
        name = node.name.text;
        type = 'type';
      } else if (ts.isEnumDeclaration(node)) {
        name = node.name.text;
        type = 'enum';
      } else if (ts.isVariableStatement(node)) {
        const declaration = node.declarationList.declarations[0];
        if (declaration.name && ts.isIdentifier(declaration.name)) {
          name = declaration.name.text;
          type = node.declarationList.flags & ts.NodeFlags.Const ? 'const' : 
                 node.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
        }
      }
      
      if (name) {
        exports.push({ name, type, isDefault, line });
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return exports;
}

/**
 * Find nodes by kind in AST
 */
export function findNodesByKind<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  kind: ts.SyntaxKind
): T[] {
  const nodes: T[] = [];
  
  function visit(node: ts.Node) {
    if (node.kind === kind) {
      nodes.push(node as T);
    }
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return nodes;
}

/**
 * Get the text content of a node
 */
export function getNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile);
}

/**
 * Get line and column for a position
 */
export function getLineAndColumn(
  sourceFile: ts.SourceFile,
  position: number
): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: line + 1, column: character + 1 };
}

/**
 * Check if a node has a specific modifier
 */
export function hasModifier(node: ts.Node, modifier: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some(m => m.kind === modifier) || false;
}

/**
 * Get function/method complexity (simplified cyclomatic complexity)
 */
export function calculateComplexity(node: ts.FunctionLikeDeclaration): number {
  let complexity = 1; // Base complexity
  
  function visit(node: ts.Node) {
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.CaseClause:
        complexity++;
        break;
      case ts.SyntaxKind.BinaryExpression:
        const binaryExpr = node as ts.BinaryExpression;
        if (binaryExpr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            binaryExpr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
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