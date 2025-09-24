/**
 * Function Scanner
 * Scans directories for functions using AST parsing
 */

import { FunctionMetadata, AuditOptions } from './types.js';
import { discoverFiles } from './utils/fileDiscovery.js';
import { parseTypeScriptFile } from './utils/astParser.js';
import { findNodesByKind, getNodeText, getLineAndColumn } from './utils/astUtils.js';
import { getImports, getImportsDetailed, extractIdentifierUsage, isLocalFunction, getReExports } from './utils/astUtils.js';
import { 
  isReactComponent, 
  detectComponentType, 
  getComponentName, 
  extractHooks, 
  extractPropTypes,
  extractComponentImports
} from './utils/reactDetection.js';
import {
  buildImportMap,
  extractFunctionCalls,
  getLocalFunctionNames,
  normalizeCallTarget
} from './utils/dependencyExtractor.js';
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
  options?: ScanOptions & { unusedImportsConfig?: AuditOptions['unusedImportsConfig'] }
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
        const fileFunctions = await extractFunctionsFromFile(filePath, {
          unusedImportsConfig: options?.unusedImportsConfig
        });
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
export async function extractFunctionsFromFile(
  filePath: string,
  options?: { unusedImportsConfig?: AuditOptions['unusedImportsConfig'] }
): Promise<FunctionMetadata[]> {
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
  
  // Build import map for dependency tracking
  const importMap = buildImportMap(sourceFile);
  const detailedImports = getImportsDetailed(sourceFile);
  const localFunctions = getLocalFunctionNames(sourceFile);
  
  // Track import usage across the file
  const importNames = new Set(detailedImports.map(imp => imp.localName));
  const fileUsageMap = extractIdentifierUsage(sourceFile, sourceFile, importNames);
  
  // Track re-exports - these imports are used even if not referenced in code
  const reExports = getReExports(sourceFile);
  for (const reExport of reExports) {
    // Find imports that match re-exported names
    for (const imp of detailedImports) {
      if (imp.importedName === reExport.name || 
          (reExport.name === '*' && imp.modulePath === reExport.module)) {
        // Mark this import as used for re-export
        if (!fileUsageMap.has(imp.localName)) {
          fileUsageMap.set(imp.localName, {
            usageType: 'reexport',
            usageCount: 1,
            lineNumbers: []
          });
        } else {
          const usage = fileUsageMap.get(imp.localName)!;
          if (usage.usageType !== 'reexport') {
            usage.usageType = 'reexport';
          }
        }
      }
    }
  }
  
  // Find all function declarations
  const functionDeclarations = findNodesByKind(sourceFile, ts.SyntaxKind.FunctionDeclaration);
  for (const func of functionDeclarations) {
    const funcDecl = func as ts.FunctionDeclaration;
    if (funcDecl.name) {
      const { line } = getLineAndColumn(sourceFile, func.getStart());
      
      // Extract function calls
      const functionCalls = funcDecl.body ? extractFunctionCalls(funcDecl.body, sourceFile, importMap) : [];
      const normalizedCalls = functionCalls.map(call => 
        normalizeCallTarget(call.callee, filePath, localFunctions)
      );
      
      // Track which imports this function uses
      const functionUsageMap = funcDecl.body ? 
        extractIdentifierUsage(funcDecl.body, sourceFile, importNames) : new Map();
      const usedImports = Array.from(functionUsageMap.keys());
      
      // Apply unused imports configuration
      const config = options?.unusedImportsConfig;
      let unusedImports = detailedImports
        .filter(imp => {
          // Skip side-effect imports - they're never "unused"
          if ((imp.importType as any) === 'side-effect') return false;
          
          // Check if import is used
          if (functionUsageMap.has(imp.localName)) return false;
          
          // Apply type-only configuration
          if (!config?.includeTypeOnlyImports && imp.isTypeOnly) return false;
          
          // Apply ignore patterns
          if (config?.ignorePatterns?.some(pattern => 
            imp.localName.match(new RegExp(pattern)))) return false;
          
          return true;
        })
        .map(imp => imp.localName);
      
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
          parameterCount: funcDecl.parameters.length,
          functionCalls: normalizedCalls,
          usedImports,
          unusedImports: unusedImports.length > 0 ? unusedImports : undefined,
          body: funcDecl.body ? funcDecl.body.getText(sourceFile) : undefined
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
        
        // Extract function calls
        const functionCalls = arrowFunc.body ? extractFunctionCalls(arrowFunc.body, sourceFile, importMap) : [];
        const normalizedCalls = functionCalls.map(call => 
          normalizeCallTarget(call.callee, filePath, localFunctions)
        );
        
        // Track which imports this function uses
        const functionUsageMap = arrowFunc.body ? 
          extractIdentifierUsage(arrowFunc.body, sourceFile, importNames) : new Map();
        const usedImports = Array.from(functionUsageMap.keys());
        
        // Apply unused imports configuration
        const config = options?.unusedImportsConfig;
        let unusedImports = detailedImports
          .filter(imp => {
            // Skip side-effect imports - they're never "unused"
            if ((imp.importType as any) === 'side-effect') return false;
            
            // Check if import is used
            if (functionUsageMap.has(imp.localName)) return false;
            
            // Apply type-only configuration
            if (!config?.includeTypeOnlyImports && imp.isTypeOnly) return false;
            
            // Apply ignore patterns
            if (config?.ignorePatterns?.some(pattern => 
              imp.localName.match(new RegExp(pattern)))) return false;
            
            return true;
          })
          .map(imp => imp.localName);
        
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
            parameterCount: arrowFunc.parameters.length,
            functionCalls: normalizedCalls,
            usedImports,
            unusedImports: unusedImports.length > 0 ? unusedImports : undefined,
            body: arrowFunc.body ? arrowFunc.body.getText(sourceFile) : undefined
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
        
        // Extract function calls
        const functionCalls = method.body ? extractFunctionCalls(method.body, sourceFile, importMap) : [];
        const normalizedCalls = functionCalls.map(call => 
          normalizeCallTarget(call.callee, filePath, localFunctions)
        );
        
        // Track which imports this method uses
        const functionUsageMap = method.body ? 
          extractIdentifierUsage(method.body, sourceFile, importNames) : new Map();
        const usedImports = Array.from(functionUsageMap.keys());
        
        // Apply unused imports configuration
        const config = options?.unusedImportsConfig;
        let unusedImports = detailedImports
          .filter(imp => {
            // Skip side-effect imports - they're never "unused"
            if ((imp.importType as any) === 'side-effect') return false;
            
            // Check if import is used
            if (functionUsageMap.has(imp.localName)) return false;
            
            // Apply type-only configuration
            if (!config?.includeTypeOnlyImports && imp.isTypeOnly) return false;
            
            // Apply ignore patterns
            if (config?.ignorePatterns?.some(pattern => 
              imp.localName.match(new RegExp(pattern)))) return false;
            
            return true;
          })
          .map(imp => imp.localName);
        
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
            parameterCount: method.parameters.length,
            functionCalls: normalizedCalls,
            usedImports,
            unusedImports: unusedImports.length > 0 ? unusedImports : undefined,
            body: method.body ? method.body.getText(sourceFile) : undefined
          }
        });
      }
    }
  }
  
  // Check if this is a React file and scan for components
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || 
      (filePath.endsWith('.js') && dependencies.includes('react'))) {
    
    // Check all nodes for React components
    const checkNode = (node: ts.Node) => {
      if (isReactComponent(node)) {
        const componentType = detectComponentType(node);
        const componentName = getComponentName(node);
        const { line } = getLineAndColumn(sourceFile, node.getStart());
        const endLine = getLineAndColumn(sourceFile, node.getEnd()).line;
        
        // Skip if we already indexed this as a regular function
        if (functions.some(f => f.name === componentName && f.lineNumber === line)) {
          // Update the existing function with component metadata
          const existingFunc = functions.find(f => f.name === componentName && f.lineNumber === line)!;
          existingFunc.purpose = `React ${componentType} component`;
          
          // For arrow functions, we need to check the parent variable declaration for types
          let nodeForProps = node;
          if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent)) {
            nodeForProps = node.parent;
          }
          
          existingFunc.metadata = {
            ...existingFunc.metadata,
            entityType: 'component',
            componentType,
            props: extractPropTypes(nodeForProps, sourceFile),
            hooks: extractHooks(node, sourceFile),
            jsxElements: extractJSXElements(node),
            isExported: isComponentExported(node),
            complexity: calculateComponentComplexity(node),
            body: getComponentBody(node, sourceFile)
          };
        } else {
          // Add new component
          functions.push({
            name: componentName,
            filePath,
            lineNumber: line,
            startLine: line,
            endLine: endLine,
            language: getLanguageFromPath(filePath),
            dependencies,
            purpose: `React ${componentType} component`,
            context: `Located in ${path.basename(filePath)}`,
            metadata: {
              entityType: 'component',
              componentType,
              props: extractPropTypes(node, sourceFile),
              hooks: extractHooks(node, sourceFile),
              jsxElements: extractJSXElements(node),
              isExported: isComponentExported(node),
              complexity: calculateComponentComplexity(node),
              body: getComponentBody(node, sourceFile),
              calledBy: []
            }
          });
        }
      }
      
      ts.forEachChild(node, checkNode);
    };
    
    checkNode(sourceFile);
  }
  
  // Add file-level unused import analysis if configured
  if (options?.unusedImportsConfig?.checkLevel === 'file' && functions.length > 0) {
    // Get all imports used across all functions in the file
    const allUsedImports = new Set<string>();
    for (const func of functions) {
      if (func.metadata?.usedImports) {
        for (const imp of func.metadata.usedImports) {
          allUsedImports.add(imp);
        }
      }
    }
    
    // Calculate file-level unused imports
    const config = options.unusedImportsConfig;
    const fileUnusedImports = detailedImports
      .filter(imp => {
        // Check if import is used anywhere in the file
        if (allUsedImports.has(imp.localName)) return false;
        
        // Apply type-only configuration
        if (!config?.includeTypeOnlyImports && imp.isTypeOnly) return false;
        
        // Apply ignore patterns
        if (config?.ignorePatterns?.some(pattern => 
          imp.localName.match(new RegExp(pattern)))) return false;
        
        return true;
      })
      .map(imp => imp.localName);
    
    // Add a special file-level entry if there are unused imports
    if (fileUnusedImports.length > 0) {
      functions.push({
        name: `[File-Level Analysis] ${path.basename(filePath)}`,
        filePath,
        lineNumber: 1,
        language: getLanguageFromPath(filePath),
        dependencies,
        purpose: 'File-level unused imports analysis',
        context: `File ${path.basename(filePath)} has unused imports at the file level`,
        metadata: {
          kind: 'file-analysis',
          unusedImports: fileUnusedImports,
          totalImports: detailedImports.length,
          usedImportsCount: allUsedImports.size
        }
      });
    }
  }
  
  return functions;
}

// Helper functions for React component extraction
function extractJSXElements(node: ts.Node): string[] {
  const elements = new Set<string>();
  
  function visit(child: ts.Node): void {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      const tagName = ts.isJsxElement(child) 
        ? child.openingElement.tagName 
        : child.tagName;
      
      if (ts.isIdentifier(tagName)) {
        elements.add(tagName.text);
      } else if (ts.isPropertyAccessExpression(tagName)) {
        elements.add(tagName.getText());
      }
    }
    
    ts.forEachChild(child, visit);
  }
  
  ts.forEachChild(node, visit);
  return Array.from(elements);
}

function isComponentExported(node: ts.Node): boolean {
  // Check for export modifier
  if (ts.canHaveModifiers(node)) {
    const modifiers = ts.getModifiers(node);
    if (modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      return true;
    }
  }
  
  // Check if parent is an export statement
  let parent = node.parent;
  while (parent) {
    if (ts.isExportAssignment(parent) || ts.isExportDeclaration(parent)) {
      return true;
    }
    parent = parent.parent;
  }
  
  return false;
}

function calculateComponentComplexity(node: ts.Node): number {
  let complexity = 1; // Base complexity
  
  function visit(child: ts.Node): void {
    // Control flow statements
    if (ts.isIfStatement(child) || ts.isConditionalExpression(child)) {
      complexity++;
    } else if (ts.isForStatement(child) || ts.isForInStatement(child) || 
               ts.isForOfStatement(child) || ts.isWhileStatement(child)) {
      complexity += 2;
    } else if (ts.isSwitchStatement(child)) {
      complexity += child.caseBlock.clauses.length;
    }
    
    // Callbacks and event handlers
    if (ts.isCallExpression(child)) {
      const expression = child.expression;
      if (ts.isPropertyAccessExpression(expression) && 
          expression.name.text === 'map') {
        complexity++;
      }
    }
    
    ts.forEachChild(child, visit);
  }
  
  ts.forEachChild(node, visit);
  return complexity;
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

// Helper function to get component body
function getComponentBody(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return node.body ? node.body.getText(sourceFile) : undefined;
  } else if (ts.isArrowFunction(node)) {
    return node.body ? node.body.getText(sourceFile) : undefined;
  } else if (ts.isClassDeclaration(node)) {
    // For class components, get the render method body
    const renderMethod = (node as ts.ClassDeclaration).members.find(
      member => ts.isMethodDeclaration(member) && 
      member.name && ts.isIdentifier(member.name) && 
      member.name.text === 'render'
    ) as ts.MethodDeclaration | undefined;
    
    return renderMethod?.body ? renderMethod.body.getText(sourceFile) : undefined;
  }
  
  return undefined;
}