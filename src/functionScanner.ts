/**
 * Function Scanner
 * Scans directories for functions using AST parsing
 *
 * ## Migration: TypeScript Compiler API → tree-sitter
 *
 * All `ts.Node`/`ts.SourceFile`/`ts.SyntaxKind` usage replaced with tree-sitter `ASTNode`
 * and adapterBridge utilities. The old `import * as ts from 'typescript'` is removed.
 */

import { FunctionMetadata, AuditOptions } from './types.js';
import { discoverFiles } from './utils/fileDiscovery.js';
import { parseTypeScriptFile } from './utils/astParser.js';
import {
  findNodesByKind,
  getNodeText,
  getLineAndColumn,
  getImports,
  getImportsDetailed,
  extractIdentifierUsage,
  isLocalFunction,
  getReExports
} from './utils/astUtils.js';
import { parseFile, walkAST, hasModifier, isExported } from './languages/adapterBridge.js';
import type { AST, ASTNode } from './languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import {
  isReactComponent,
  detectComponentType,
  getComponentName,
  extractHooks,
  extractPropTypes
} from './utils/reactDetection.js';
import {
  buildImportMap,
  extractFunctionCalls,
  getLocalFunctionNames,
  normalizeCallTarget
} from './utils/dependencyExtractor.js';
import { readFile } from 'fs/promises';
import path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get raw text from a tree-sitter node (stored on ASTNode.raw). */
function rawText(node: ASTNode): string {
  return (node.raw as TreeSitterNode)?.text ?? '';
}

/** Find the first child of a given type. */
function findChildOfType(node: ASTNode, type: string): ASTNode | undefined {
  return node.children?.find(c => c.type === type);
}

/** Check if a node type is a variable/lexical declaration. */
function isVariableDecl(type: string): boolean {
  return type === 'lexical_declaration' || type === 'variable_declaration';
}

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

  // Read content and parse
  const content = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, content);
  if (!ast) return functions;

  const root = ast.root;

  // Get file dependencies
  const imports = getImports(root);
  const dependencies = imports
    .map(imp => imp.moduleSpecifier)
    .filter(spec => !spec.startsWith('.') && !spec.startsWith('/'))
    .filter((v, i, a) => a.indexOf(v) === i); // Unique only

  // Build import map for dependency tracking
  const importMap = buildImportMap(root);
  const detailedImports = getImportsDetailed(root);
  const localFunctions = getLocalFunctionNames(root);

  // Track import usage across the file
  const importNames = new Set(detailedImports.map(imp => imp.localName));
  const fileUsageMap = extractIdentifierUsage(root, content, importNames);

  // Track re-exports - these imports are used even if not referenced in code
  const reExports = getReExports(root);
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
  const functionDeclarations = findNodesByKind(root, 'function_declaration');
  for (const func of functionDeclarations) {
    const nameNode = findChildOfType(func, 'identifier');
    if (!nameNode) continue;

    const { line } = getLineAndColumn(func);

    // Extract function calls
    const body = findChildOfType(func, 'statement_block');
    const functionCalls = body ? extractFunctionCalls(body, content, importMap) : [];
    const normalizedCalls = functionCalls.map(call =>
      normalizeCallTarget(call.callee, filePath, localFunctions)
    );

    // Track which imports this function uses
    const functionUsageMap = extractIdentifierUsage(func, content, importNames);
    const usedImports = Array.from(functionUsageMap.keys());

    // Apply unused imports configuration
    const config = options?.unusedImportsConfig;
    let unusedImports = detailedImports
      .filter(imp => {
        // Skip side-effect imports - they're never "unused"
        if ((imp.importType as any) === 'side-effect') return false;

        // Check if import is used in this function OR at module level
        if (functionUsageMap.has(imp.localName) || fileUsageMap.has(imp.localName)) return false;

        // Apply type-only configuration
        if (!config?.includeTypeOnlyImports && imp.isTypeOnly) return false;

        // Apply ignore patterns
        if (config?.ignorePatterns?.some(pattern =>
          imp.localName.match(new RegExp(pattern)))) return false;

        return true;
      })
      .map(imp => imp.localName);

    // Get parameter count from formal_parameters
    const params = findChildOfType(func, 'formal_parameters');
    const paramCount = params?.children?.filter(c =>
      c.type === 'required_parameter' || c.type === 'optional_parameter' || c.type === 'rest_parameter'
    ).length ?? 0;

    functions.push({
      name: rawText(nameNode),
      filePath,
      lineNumber: line,
      language: getLanguageFromPath(filePath),
      dependencies,
      purpose: `Function ${rawText(nameNode)} implementation`,
      context: `Located in ${path.basename(filePath)}`,
      metadata: {
        kind: 'function',
        isAsync: hasModifier(func, 'async'),
        isExported: isExported(func),
        parameterCount: paramCount,
        functionCalls: normalizedCalls,
        usedImports,
        unusedImports: unusedImports.length > 0 ? unusedImports : undefined,
        body: body ? rawText(body) : undefined
      }
    });
  }

  // Find arrow functions assigned to variables
  const varStmts: ASTNode[] = [
    ...findNodesByKind(root, 'lexical_declaration'),
    ...findNodesByKind(root, 'variable_declaration')
  ];
  for (const varStmt of varStmts) {
    for (const varDecl of varStmt.children ?? []) {
      if (varDecl.type !== 'variable_declarator') continue;

      const nameNode = findChildOfType(varDecl, 'identifier');
      const arrowFunc = varDecl.children?.find(c => c.type === 'arrow_function');
      if (!nameNode || !arrowFunc) continue;

      const { line } = getLineAndColumn(varDecl);

      // Extract function calls
      const body = findChildOfType(arrowFunc, 'statement_block');
      const functionCalls = body ? extractFunctionCalls(body, content, importMap) : [];
      const normalizedCalls = functionCalls.map(call =>
        normalizeCallTarget(call.callee, filePath, localFunctions)
      );

      // Track which imports this function uses
      const functionUsageMap = extractIdentifierUsage(arrowFunc, content, importNames);
      const usedImports = Array.from(functionUsageMap.keys());

      // Apply unused imports configuration
      const fConfig = options?.unusedImportsConfig;
      let unusedImports = detailedImports
        .filter(imp => {
          if ((imp.importType as any) === 'side-effect') return false;
          if (functionUsageMap.has(imp.localName) || fileUsageMap.has(imp.localName)) return false;
          if (!fConfig?.includeTypeOnlyImports && imp.isTypeOnly) return false;
          if (fConfig?.ignorePatterns?.some(pattern =>
            imp.localName.match(new RegExp(pattern)))) return false;
          return true;
        })
        .map(imp => imp.localName);

      const arrowParams = findChildOfType(arrowFunc, 'formal_parameters');
      const arrowParamCount = arrowParams?.children?.filter(c =>
        c.type === 'required_parameter' || c.type === 'optional_parameter' || c.type === 'rest_parameter'
      ).length ?? 0;

      functions.push({
        name: rawText(nameNode),
        filePath,
        lineNumber: line,
        language: getLanguageFromPath(filePath),
        dependencies,
        purpose: `Arrow function ${rawText(nameNode)}`,
        context: `Defined in ${path.basename(filePath)}`,
        metadata: {
          kind: 'arrow',
          isAsync: hasModifier(arrowFunc, 'async'),
          isExported: isExported(varStmt),
          parameterCount: arrowParamCount,
          functionCalls: normalizedCalls,
          usedImports,
          unusedImports: unusedImports.length > 0 ? unusedImports : undefined,
          body: body ? rawText(body) : undefined
        }
      });
    }
  }

  // Find class methods
  const classDeclarations = findNodesByKind(root, 'class_declaration');
  for (const classDecl of classDeclarations) {
    const classNameNode = findChildOfType(classDecl, 'identifier');
    const className = classNameNode ? rawText(classNameNode) : 'AnonymousClass';
    const classBody = findChildOfType(classDecl, 'class_body');
    const methods = classBody?.children?.filter(m => m.type === 'method_definition') ?? [];

    for (const method of methods) {
      const methodNameNode = findChildOfType(method, 'identifier');
      if (!methodNameNode) continue;

      const { line } = getLineAndColumn(method);

      // Extract function calls
      const body = findChildOfType(method, 'statement_block');
      const functionCalls = body ? extractFunctionCalls(body, content, importMap) : [];
      const normalizedCalls = functionCalls.map(call =>
        normalizeCallTarget(call.callee, filePath, localFunctions)
      );

      // Track which imports this method uses
      const functionUsageMap = extractIdentifierUsage(method, content, importNames);
      const usedImports = Array.from(functionUsageMap.keys());

      // Apply unused imports configuration
      const mConfig = options?.unusedImportsConfig;
      let unusedImports = detailedImports
        .filter(imp => {
          if ((imp.importType as any) === 'side-effect') return false;
          if (functionUsageMap.has(imp.localName) || fileUsageMap.has(imp.localName)) return false;
          if (!mConfig?.includeTypeOnlyImports && imp.isTypeOnly) return false;
          if (mConfig?.ignorePatterns?.some(pattern =>
            imp.localName.match(new RegExp(pattern)))) return false;
          return true;
        })
        .map(imp => imp.localName);

      const methodParams = findChildOfType(method, 'formal_parameters');
      const methodParamCount = methodParams?.children?.filter(c =>
        c.type === 'required_parameter' || c.type === 'optional_parameter' || c.type === 'rest_parameter'
      ).length ?? 0;

      functions.push({
        name: `${className}.${rawText(methodNameNode)}`,
        filePath,
        lineNumber: line,
        language: getLanguageFromPath(filePath),
        dependencies,
        purpose: `Method ${rawText(methodNameNode)} of class ${className}`,
        context: `Class method in ${path.basename(filePath)}`,
        metadata: {
          kind: 'method',
          className,
          isAsync: hasModifier(method, 'async'),
          isStatic: hasModifier(method, 'static'),
          isPrivate: hasModifier(method, 'private'),
          parameterCount: methodParamCount,
          functionCalls: normalizedCalls,
          usedImports,
          unusedImports: unusedImports.length > 0 ? unusedImports : undefined,
          body: body ? rawText(body) : undefined
        }
      });
    }
  }

  // Check if this is a React file and scan for components
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ||
      (filePath.endsWith('.js') && dependencies.includes('react'))) {

    // Walk all nodes for React components
    walkAST(root, (node) => {
      if (!isReactComponent(node)) return;

      const componentType = detectComponentType(node);
      if (!componentType) return;

      const componentName = getComponentName(node);
      const { line } = getLineAndColumn(node);
      const endLine = node.location?.end?.line ?? line;

      // Determine which node to use for prop extraction
      // For arrow functions, use the parent variable declarator
      let nodeForProps = node;
      if (node.type === 'arrow_function' &&
          node.parent && (node.parent.type === 'variable_declarator' ||
            isVariableDecl(node.parent.type))) {
        nodeForProps = node.parent;
      }

      // Track which imports this component uses
      const componentUsageMap = extractIdentifierUsage(node, content, importNames);
      const usedImports = Array.from(componentUsageMap.keys());

      // Apply unused imports configuration
      const cConfig = options?.unusedImportsConfig;
      let unusedImports = detailedImports
        .filter(imp => {
          if ((imp.importType as any) === 'side-effect') return false;
          if (componentUsageMap.has(imp.localName) || fileUsageMap.has(imp.localName)) return false;
          if (!cConfig?.includeTypeOnlyImports && imp.isTypeOnly) return false;
          if (cConfig?.ignorePatterns?.some(pattern =>
            imp.localName.match(new RegExp(pattern)))) return false;
          return true;
        })
        .map(imp => imp.localName);

      // Check if we already indexed this as a regular function
      const existingFunc = functions.find(f => f.name === componentName && f.lineNumber === line);
      if (existingFunc) {
        // Update the existing function with component metadata
        existingFunc.purpose = `React ${componentType} component`;

        existingFunc.metadata = {
          ...existingFunc.metadata,
          entityType: 'component',
          componentType,
          props: extractPropTypes(nodeForProps),
          hooks: extractHooks(node),
          jsxElements: extractJSXElements(node),
          isExported: isComponentExported(node),
          complexity: calculateComponentComplexity(node),
          body: getComponentBody(node)
        };
      } else {
        // Add new component
        functions.push({
          name: componentName,
          filePath,
          lineNumber: line,
          startLine: line,
          endLine,
          language: getLanguageFromPath(filePath),
          dependencies,
          purpose: `React ${componentType} component`,
          context: `Located in ${path.basename(filePath)}`,
          metadata: {
            entityType: 'component',
            componentType,
            props: extractPropTypes(nodeForProps),
            hooks: extractHooks(node),
            jsxElements: extractJSXElements(node),
            isExported: isComponentExported(node),
            complexity: calculateComponentComplexity(node),
            body: getComponentBody(node),
            usedImports,
            unusedImports: unusedImports.length > 0 ? unusedImports : undefined,
            calledBy: []
          }
        });
      }
    });
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
    const flConfig = options.unusedImportsConfig;
    const fileUnusedImports = detailedImports
      .filter(imp => {
        if (allUsedImports.has(imp.localName)) return false;
        if (!flConfig?.includeTypeOnlyImports && imp.isTypeOnly) return false;
        if (flConfig?.ignorePatterns?.some(pattern =>
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

// ---------------------------------------------------------------------------
// Helper functions for React component extraction
// ---------------------------------------------------------------------------

function extractJSXElements(node: ASTNode): string[] {
  const elements = new Set<string>();

  walkAST(node, (child) => {
    if (child.type === 'jsx_element') {
      const openTag = findChildOfType(child, 'open_tag');
      if (openTag) {
        const tagNameNode = openTag.children?.find(c =>
          c.type === 'identifier' || c.type === 'member_expression');
        if (tagNameNode) {
          if (tagNameNode.type === 'identifier') {
            elements.add(rawText(tagNameNode));
          } else if (tagNameNode.type === 'member_expression') {
            elements.add(rawText(tagNameNode));
          }
        }
      }
    } else if (child.type === 'jsx_self_closing_element') {
      const tagNameNode = child.children?.find(c =>
        c.type === 'identifier' || c.type === 'member_expression');
      if (tagNameNode) {
        if (tagNameNode.type === 'identifier') {
          elements.add(rawText(tagNameNode));
        } else if (tagNameNode.type === 'member_expression') {
          elements.add(rawText(tagNameNode));
        }
      }
    }
  });

  return Array.from(elements);
}

function isComponentExported(node: ASTNode): boolean {
  // Check for export modifier on the node itself
  if (isExported(node)) {
    return true;
  }

  // Check if parent is an export statement
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'export_statement' || parent.type === 'export_declaration') {
      return true;
    }
    parent = parent.parent;
  }

  return false;
}

function calculateComponentComplexity(node: ASTNode): number {
  let complexity = 1; // Base complexity

  walkAST(node, (child) => {
    // Control flow statements
    if (child.type === 'if_statement' || child.type === 'ternary_expression') {
      complexity++;
    } else if (child.type === 'for_statement' || child.type === 'for_in_statement' ||
               child.type === 'while_statement') {
      complexity += 2;
    } else if (child.type === 'switch_statement') {
      // Count switch_case children in switch body
      const body = findChildOfType(child, 'switch_body');
      if (body) {
        const cases = body.children?.filter(c =>
          c.type === 'switch_case' || c.type === 'switch_default') ?? [];
        complexity += cases.length;
      }
    }

    // Callbacks and event handlers
    if (child.type === 'call_expression') {
      const expr = child.children?.[0];
      if (expr?.type === 'member_expression') {
        const propNode = expr.children?.[expr.children.length - 1];
        if (propNode && rawText(propNode) === 'map') {
          complexity++;
        }
      }
    }
  });

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
    const functions: FunctionMetadata[] = [];

    // Parse content directly via tree-sitter
    const ast = parseFile(filePath, content);
    if (!ast) return functions;
    const root = ast.root;

    // Get file dependencies
    const imports = getImports(root);
    const dependencies = imports
      .map(imp => imp.moduleSpecifier)
      .filter(spec => !spec.startsWith('.') && !spec.startsWith('/'))
      .filter((v, i, a) => a.indexOf(v) === i); // Unique only

    // Build import map for dependency tracking
    const importMap = buildImportMap(root);

    // Find all function declarations
    for (const func of findNodesByKind(root, 'function_declaration')) {
      const nameNode = findChildOfType(func, 'identifier');
      if (!nameNode) continue;

      const { line } = getLineAndColumn(func);

      const params = findChildOfType(func, 'formal_parameters');
      const paramCount = params?.children?.filter(c =>
        c.type === 'required_parameter' || c.type === 'optional_parameter' || c.type === 'rest_parameter'
      ).length ?? 0;

      // Build signature: text up to the statement block (before first '{' of body)
      const bodyNode = findChildOfType(func, 'statement_block');
      const fullText = rawText(func);
      const signature = fullText.split('{')[0]?.trim() ?? undefined;

      functions.push({
        name: rawText(nameNode),
        filePath,
        lineNumber: line,
        language,
        dependencies,
        purpose: `Function ${rawText(nameNode)} implementation`,
        context: `Located in ${path.basename(filePath)}`,
        metadata: {
          kind: 'function',
          isAsync: hasModifier(func, 'async'),
          isExported: isExported(func),
          parameterCount: paramCount,
          signature,
          body: bodyNode ? rawText(bodyNode) : undefined,
        }
      });
    }

    // Find arrow functions and variable declarations
    for (const varStmt of [
      ...findNodesByKind(root, 'lexical_declaration'),
      ...findNodesByKind(root, 'variable_declaration')
    ]) {
      for (const declaration of varStmt.children ?? []) {
        if (declaration.type !== 'variable_declarator') continue;
        const nameNode = findChildOfType(declaration, 'identifier');
        const init = declaration.children?.find(c => c.type === 'arrow_function');
        if (!nameNode || !init) continue;

        const { line } = getLineAndColumn(declaration);

        const arrowParams = findChildOfType(init, 'formal_parameters');
        const arrowParamCount = arrowParams?.children?.filter(c =>
          c.type === 'required_parameter' || c.type === 'optional_parameter' || c.type === 'rest_parameter'
        ).length ?? 0;

        const fullText = rawText(init);
        const signature = fullText.split('{')[0]?.trim() ?? undefined;
        const bodyNode = findChildOfType(init, 'statement_block');

        functions.push({
          name: rawText(nameNode),
          filePath,
          lineNumber: line,
          language,
          dependencies,
          purpose: `Arrow function ${rawText(nameNode)}`,
          context: `Defined in ${path.basename(filePath)}`,
          metadata: {
            kind: 'arrow',
            isAsync: hasModifier(init, 'async'),
            isExported: isExported(varStmt),
            parameterCount: arrowParamCount,
            signature,
            body: bodyNode ? rawText(bodyNode) : undefined,
          }
        });
      }
    }

    // Find class methods
    for (const classDecl of findNodesByKind(root, 'class_declaration')) {
      const nameNode = findChildOfType(classDecl, 'identifier');
      if (!nameNode) continue;

      const className = rawText(nameNode);
      const classBody = findChildOfType(classDecl, 'class_body');

      for (const member of classBody?.children ?? []) {
        if (member.type !== 'method_definition') continue;
        const mNameNode = findChildOfType(member, 'identifier');
        if (!mNameNode) continue;

        const { line } = getLineAndColumn(member);

        const methodParams = findChildOfType(member, 'formal_parameters');
        const methodParamCount = methodParams?.children?.filter(c =>
          c.type === 'required_parameter' || c.type === 'optional_parameter' || c.type === 'rest_parameter'
        ).length ?? 0;

        const fullText = rawText(member);
        const signature = fullText.split('{')[0]?.trim() ?? undefined;
        const bodyNode = findChildOfType(member, 'statement_block');

        functions.push({
          name: `${className}.${rawText(mNameNode)}`,
          filePath,
          lineNumber: line,
          language,
          dependencies,
          purpose: `Method ${rawText(mNameNode)} of class ${className}`,
          context: `Class method in ${path.basename(filePath)}`,
          metadata: {
            kind: 'method',
            className,
            isAsync: hasModifier(member, 'async'),
            isStatic: hasModifier(member, 'static'),
            isPrivate: hasModifier(member, 'private'),
            parameterCount: methodParamCount,
            signature,
            body: bodyNode ? rawText(bodyNode) : undefined,
          }
        });
      }
    }

    return functions;
  }
}

// ---------------------------------------------------------------------------
// Helper function to get component body
// ---------------------------------------------------------------------------

function getComponentBody(node: ASTNode): string | undefined {
  if (node.type === 'function_declaration' || node.type === 'function_expression') {
    const body = findChildOfType(node, 'statement_block');
    return body ? rawText(body) : undefined;
  } else if (node.type === 'arrow_function') {
    const body = findChildOfType(node, 'statement_block');
    return body ? rawText(body) : undefined;
  } else if (node.type === 'class_declaration') {
    // For class components, get the render method body
    const classBody = findChildOfType(node, 'class_body');
    if (!classBody) return undefined;

    for (const member of classBody.children ?? []) {
      if (member.type !== 'method_definition') continue;
      const mNameNode = findChildOfType(member, 'identifier');
      if (mNameNode && rawText(mNameNode) === 'render') {
        const body = findChildOfType(member, 'statement_block');
        return body ? rawText(body) : undefined;
      }
    }
  }

  return undefined;
}
