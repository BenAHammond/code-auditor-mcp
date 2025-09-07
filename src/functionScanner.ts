/**
 * Function Scanner
 * Scans directories for functions using AST parsing
 */

import { FunctionMetadata } from './types.js';
import { discoverFiles } from './utils/fileDiscovery.js';
import { parseTypeScriptFile } from './utils/astParser.js';
import { findNodesByKind, getNodeText, getLineAndColumn } from './utils/astUtils.js';
import { getImports } from './utils/astUtils.js';
import * as ts from 'typescript';
import path from 'path';

export interface ScanOptions {
  excludePaths?: string[];
  includePaths?: string[];
  fileExtensions?: string[];
}

/**
 * Scan directory for functions
 */
export async function scanDirectoryForFunctions(
  dirPath: string,
  options?: ScanOptions
): Promise<FunctionMetadata[]> {
  const functions: FunctionMetadata[] = [];
  
  try {
    // Discover TypeScript and JavaScript files
    const fileExtensions = options?.fileExtensions || ['.ts', '.js', '.tsx', '.jsx'];
    const files = await discoverFiles(
      dirPath,
      {
        includePaths: options?.includePaths || ['**/*'],
        excludePaths: options?.excludePaths || ['**/node_modules/**', '**/dist/**', '**/build/**']
      }
    );
    
    // Filter by extensions
    const targetFiles = files.filter(file => 
      fileExtensions.some(ext => file.endsWith(ext))
    );
    
    // Process each file
    for (const filePath of targetFiles) {
      try {
        const fileFunctions = await extractFunctionsFromFile(filePath);
        functions.push(...fileFunctions);
      } catch (error) {
        console.error(`Error processing ${filePath}:`, error);
      }
    }
    
    return functions;
  } catch (error) {
    throw new Error(`Failed to scan directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Extract functions from a single file
 */
export async function extractFunctionsFromFile(filePath: string): Promise<FunctionMetadata[]> {
  const functions: FunctionMetadata[] = [];
  
  // Parse file
  const parseResult = await parseTypeScriptFile(filePath);
  if (!parseResult.sourceFile) {
    return functions;
  }
  
  const sourceFile = parseResult.sourceFile;
  
  // Get file dependencies
  const imports = getImports(sourceFile);
  const dependencies = imports
    .map(imp => imp.moduleSpecifier)
    .filter(spec => !spec.startsWith('.') && !spec.startsWith('/'))
    .filter((v, i, a) => a.indexOf(v) === i); // Unique only
  
  // Find all function declarations
  const functionDeclarations = findNodesByKind(sourceFile, ts.SyntaxKind.FunctionDeclaration);
  for (const func of functionDeclarations) {
    const funcDecl = func as ts.FunctionDeclaration;
    if (funcDecl.name) {
      const { line } = getLineAndColumn(sourceFile, func.getStart());
      functions.push({
        name: funcDecl.name.text,
        filePath,
        lineNumber: line,
        language: getLanguageFromPath(filePath),
        dependencies,
        purpose: `Function ${funcDecl.name.text} implementation`,
        context: `Located in ${path.basename(filePath)}`,
        metadata: {
          kind: 'function',
          isAsync: !!funcDecl.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
          isExported: !!funcDecl.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword),
          parameterCount: funcDecl.parameters.length
        }
      });
    }
  }
  
  // Find arrow functions assigned to variables
  const variableStatements = findNodesByKind(sourceFile, ts.SyntaxKind.VariableStatement);
  for (const varStmt of variableStatements) {
    const varDeclarations = (varStmt as ts.VariableStatement).declarationList.declarations;
    for (const varDecl of varDeclarations) {
      if (varDecl.initializer && 
          varDecl.initializer.kind === ts.SyntaxKind.ArrowFunction &&
          ts.isIdentifier(varDecl.name)) {
        const { line } = getLineAndColumn(sourceFile, varDecl.getStart());
        const arrowFunc = varDecl.initializer as ts.ArrowFunction;
        const varStmtNode = varStmt as ts.VariableStatement;
        functions.push({
          name: varDecl.name.text,
          filePath,
          lineNumber: line,
          language: getLanguageFromPath(filePath),
          dependencies,
          purpose: `Arrow function ${varDecl.name.text}`,
          context: `Defined in ${path.basename(filePath)}`,
          metadata: {
            kind: 'arrow',
            isAsync: arrowFunc.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) || false,
            isExported: varStmtNode.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || false,
            parameterCount: arrowFunc.parameters.length
          }
        });
      }
    }
  }
  
  // Find class methods
  const classDeclarations = findNodesByKind(sourceFile, ts.SyntaxKind.ClassDeclaration);
  for (const classDecl of classDeclarations) {
    const className = (classDecl as ts.ClassDeclaration).name?.text || 'AnonymousClass';
    const methods = (classDecl as ts.ClassDeclaration).members.filter(
      member => member.kind === ts.SyntaxKind.MethodDeclaration
    ) as ts.MethodDeclaration[];
    
    for (const method of methods) {
      if (ts.isIdentifier(method.name)) {
        const { line } = getLineAndColumn(sourceFile, method.getStart());
        functions.push({
          name: `${className}.${method.name.text}`,
          filePath,
          lineNumber: line,
          language: getLanguageFromPath(filePath),
          dependencies,
          purpose: `Method ${method.name.text} of class ${className}`,
          context: `Class method in ${path.basename(filePath)}`,
          metadata: {
            kind: 'method',
            className,
            isAsync: !!method.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
            isStatic: !!method.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword),
            isPrivate: !!method.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword),
            parameterCount: method.parameters.length
          }
        });
      }
    }
  }
  
  return functions;
}

/**
 * Get language from file path
 */
function getLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
      return 'javascript';
    default:
      return 'unknown';
  }
}

// Aliases for MCP server compatibility
export const scanFunctionsInFile = extractFunctionsFromFile;

export async function scanFunctionsInDirectory(
  dirPath: string,
  options?: { recursive?: boolean; fileTypes?: string[] }
): Promise<FunctionMetadata[]> {
  return scanDirectoryForFunctions(dirPath, {
    fileExtensions: options?.fileTypes,
    includePaths: options?.recursive !== false ? ['**/*'] : ['*']
  });
}

/**
 * Function Scanner class for compatibility
 */
export class FunctionScanner {
  async scanFunctions(
    content: string,
    filePath: string,
    language: string
  ): Promise<FunctionMetadata[]> {
    // Parse the content directly
    const functions: FunctionMetadata[] = [];
    
    // Create a TypeScript source file from content
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );
    
    // Get file dependencies
    const imports = getImports(sourceFile);
    const dependencies = imports
      .map(imp => imp.moduleSpecifier)
      .filter(spec => !spec.startsWith('.') && !spec.startsWith('/'))
      .filter((v, i, a) => a.indexOf(v) === i); // Unique only
    
    // Find all function declarations
    const functionDeclarations = findNodesByKind(sourceFile, ts.SyntaxKind.FunctionDeclaration);
    for (const func of functionDeclarations) {
      const funcNode = func as ts.FunctionDeclaration;
      if (!funcNode.name) continue;
      
      const { line } = getLineAndColumn(sourceFile, funcNode.getStart());
      
      functions.push({
        name: funcNode.name.text,
        filePath: filePath,
        lineNumber: line,
        language: language,
        dependencies,
        purpose: `Function ${funcNode.name.text} implementation`,
        context: `Located in ${path.basename(filePath)}`,
        metadata: {
          kind: 'function',
          isAsync: !!funcNode.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
          isExported: !!funcNode.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword),
          parameterCount: funcNode.parameters.length
        }
      });
    }
    
    // Find arrow functions and variable declarations
    const varDeclarations = findNodesByKind(sourceFile, ts.SyntaxKind.VariableStatement);
    for (const varStmt of varDeclarations) {
      const varStmtNode = varStmt as ts.VariableStatement;
      for (const declaration of varStmtNode.declarationList.declarations) {
        if (declaration.initializer && 
            declaration.initializer.kind === ts.SyntaxKind.ArrowFunction &&
            ts.isIdentifier(declaration.name)) {
          const arrowFunc = declaration.initializer as ts.ArrowFunction;
          const { line } = getLineAndColumn(sourceFile, declaration.getStart());
          
          functions.push({
            name: declaration.name.text,
            filePath: filePath,
            lineNumber: line,
            language: language,
            dependencies,
            purpose: `Arrow function ${declaration.name.text}`,
            context: `Defined in ${path.basename(filePath)}`,
            metadata: {
              kind: 'arrow',
              isAsync: !!arrowFunc.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
              isExported: !!varStmtNode.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword),
              parameterCount: arrowFunc.parameters.length
            }
          });
        }
      }
    }
    
    // Find class methods
    const classDeclarations = findNodesByKind(sourceFile, ts.SyntaxKind.ClassDeclaration);
    for (const classDecl of classDeclarations) {
      const classNode = classDecl as ts.ClassDeclaration;
      if (!classNode.name) continue;
      
      const className = classNode.name.text;
      
      for (const member of classNode.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          const method = member as ts.MethodDeclaration;
          const { line } = getLineAndColumn(sourceFile, method.getStart());
          
          functions.push({
            name: `${className}.${(method.name as ts.Identifier).text}`,
            filePath: filePath,
            lineNumber: line,
            language: language,
            dependencies,
            purpose: `Method ${(method.name as ts.Identifier).text} of class ${className}`,
            context: `Class method in ${path.basename(filePath)}`,
            metadata: {
              kind: 'method',
              className,
              isAsync: !!method.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
              isStatic: !!method.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword),
              isPrivate: !!method.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword),
              parameterCount: method.parameters.length
            }
          });
        }
      }
    }
    
    return functions;
  }
}