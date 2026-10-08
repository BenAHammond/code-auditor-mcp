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
import { discoverFiles, getLanguageFromPath } from './utils/fileDiscovery.js';
import { parseTypeScriptFile } from './utils/astParser.js';
import { errorMessage } from './utils/errorMessage.js';
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
import { parseFile, walkAST, hasModifier, isExported, calculateComplexity } from './languages/adapterBridge.js';
import type { AST, ASTNode } from './languages/types.js';
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
 *
 * @param dirPath - Directory to scan for TS/JS files.
 * @param options - Scan options (extensions, includes/excludes, unused-import config).
 * @returns Function metadata for every function found in the directory.
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
    throw new Error(`Failed to scan directory: ${errorMessage(error)}`);
  }
}

/**
 * Extract functions from a single file (convenience wrapper that reads the file).
 *
 * @param filePath - Path of the file to read and extract from.
 * @param options - Optional unused-import config forwarded to extraction.
 * @returns Function metadata for the file's functions.
 */
export async function extractFunctionsFromFile(
  filePath: string,
  options?: { unusedImportsConfig?: AuditOptions['unusedImportsConfig'] }
): Promise<FunctionMetadata[]> {
  const content = await readFile(filePath, 'utf-8');
  return extractFunctionsFromSource(content, filePath, options);
}

/**
 * Extract functions from source content (no file I/O — usable by both the
 * audit runner and the index sync path).
 *
 * @param content - Source text to parse and extract from.
 * @param filePath - Path used to resolve the language and relative imports.
 * @param options - Optional unused-import config.
 * @returns Function metadata extracted from the source.
 */
export function extractFunctionsFromSource(
  content: string,
  filePath: string,
  options?: { unusedImportsConfig?: AuditOptions['unusedImportsConfig'] }
): FunctionMetadata[] {
  const functions: FunctionMetadata[] = [];

  // Parse content
  const ast = parseFile(filePath, content);
  if (!ast) return functions;

  const root = ast.root;

  // Get file dependencies
  const imports = getImports(root, content);
  const dependencies = imports
    .map(imp => imp.source)
    .filter(spec => !spec.startsWith('.') && !spec.startsWith('/'))
    .filter((v, i, a) => a.indexOf(v) === i); // Unique only

  // Build import map for dependency tracking
  const importMap = buildImportMap(root, content);
  const detailedImports = getImportsDetailed(root, content);
  const localFunctions = getLocalFunctionNames(root, content);

  // Track import usage across the file
  const importNames = new Set(detailedImports.map(imp => imp.localName));
  const fileUsageMap = extractIdentifierUsage(root, content, importNames);

  // Track re-exports - these imports are used even if not referenced in code
  const reExports = getReExports(root, content);
  markReExports(fileUsageMap, reExports, detailedImports);

  // ── Shared extraction for the three function-like scans ────────────────
  // Function declarations, arrow functions, and class methods repeat the same
  // call-extraction + import-usage + unused-import + parameter-count derivation
  // and the same record push; only the label and kind-specific metadata vary.
  const deriveFunctionData = (node: ASTNode) => {
    const body = findChildOfType(node, 'statement_block');
    const functionCalls = body ? extractFunctionCalls(body, content, importMap) : [];
    const normalizedCalls = functionCalls.map(call =>
      normalizeCallTarget(call.callee, filePath, localFunctions)
    );

    const functionUsageMap = extractIdentifierUsage(node, content, importNames);
    const usedImports = Array.from(functionUsageMap.keys());

    const config = options?.unusedImportsConfig;
    const unusedImports = detailedImports
      .filter(imp => {
        // Skip side-effect imports - they're never "unused".
        if ((imp.importType as any) === 'side-effect') return false;
        // Used in this function OR at module level.
        if (functionUsageMap.has(imp.localName) || fileUsageMap.has(imp.localName)) return false;
        // Apply type-only configuration.
        if (!config?.includeTypeOnlyImports && imp.isTypeOnly) return false;
        // Apply ignore patterns.
        if (config?.ignorePatterns?.some(pattern =>
          imp.localName.match(new RegExp(pattern)))) return false;
        return true;
      })
      .map(imp => imp.localName);

    const params = findChildOfType(node, 'formal_parameters');
    const parameterCount = params?.children?.filter(c =>
      c.type === 'required_parameter' || c.type === 'optional_parameter'
    ).length ?? 0;

    return {
      body,
      functionCalls: normalizedCalls,
      usedImports,
      unusedImports: unusedImports.length > 0 ? unusedImports : undefined,
      parameterCount,
    };
  };

  const pushScannedFunction = (opts: {
    name: string;
    line: number;
    endLine: number;
    node: ASTNode;
    kind: 'function' | 'arrow' | 'method';
    purpose: string;
    context: string;
    extraMetadata: Record<string, unknown>;
  }) => {
    const { name, line, endLine, node, kind, purpose, context, extraMetadata } = opts;
    const d = deriveFunctionData(node);
    functions.push({
      name,
      filePath,
      lineNumber: line,
      startLine: line,
      endLine,
      language: getLanguageFromPath(filePath),
      dependencies,
      purpose,
      context,
      body: d.body ? getNodeText(d.body, content) : undefined,
      metadata: {
        kind,
        ...extraMetadata,
        parameterCount: d.parameterCount,
        functionCalls: d.functionCalls,
        usedImports: d.usedImports,
        unusedImports: d.unusedImports,
        complexity: calculateComplexity(node),
        dependencies
      }
    });
  };

  // Find all function declarations
  const functionDeclarations = findNodesByKind(root, 'function_declaration');
  for (const func of functionDeclarations) {
    const nameNode = findChildOfType(func, 'identifier');
    if (!nameNode) continue;
    const { line } = getLineAndColumn(func);
    const name = getNodeText(nameNode, content);
    pushScannedFunction({
      name, line,
      endLine: func.location?.end?.line ?? line,
      node: func,
      kind: 'function',
      purpose: `Function ${name} implementation`,
      context: `Located in ${path.basename(filePath)}`,
      extraMetadata: { isAsync: hasModifier(func, 'async'), isExported: isExported(func) },
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
      const name = getNodeText(nameNode, content);
      pushScannedFunction({
        name, line,
        endLine: arrowFunc.location?.end?.line ?? line,
        node: arrowFunc,
        kind: 'arrow',
        purpose: `Arrow function ${name}`,
        context: `Defined in ${path.basename(filePath)}`,
        extraMetadata: { isAsync: hasModifier(arrowFunc, 'async'), isExported: isExported(varStmt) },
      });
    }
  }

  // Find class methods
  const classDeclarations = findNodesByKind(root, 'class_declaration');
  for (const classDecl of classDeclarations) {
    const classNameNode = findChildOfType(classDecl, 'identifier');
    const className = classNameNode ? getNodeText(classNameNode, content) : 'AnonymousClass';
    const classBody = findChildOfType(classDecl, 'class_body');
    const methods = classBody?.children?.filter(m => m.type === 'method_definition') ?? [];

    for (const method of methods) {
      const methodNameNode = findChildOfType(method, 'identifier');
      if (!methodNameNode) continue;
      const { line } = getLineAndColumn(method);
      const methodName = getNodeText(methodNameNode, content);
      pushScannedFunction({
        name: `${className}.${methodName}`,
        line,
        endLine: method.location?.end?.line ?? line,
        node: method,
        kind: 'method',
        purpose: `Method ${methodName} of class ${className}`,
        context: `Class method in ${path.basename(filePath)}`,
        extraMetadata: {
          className,
          isAsync: hasModifier(method, 'async'),
          isStatic: hasModifier(method, 'static'),
          isPrivate: hasModifier(method, 'private')
        },
      });
    }
  }

  // Check if this is a React file and scan for components
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ||
      (filePath.endsWith('.js') && dependencies.includes('react'))) {
    scanReactComponents(functions, { root, content, filePath, dependencies, importNames, detailedImports, fileUsageMap, options });
  }

  // Add file-level unused import analysis if configured
  if (options?.unusedImportsConfig?.checkLevel === 'file' && functions.length > 0) {
    scanFileLevelUnusedImports(functions, detailedImports, filePath, dependencies, options.unusedImportsConfig);
  }

  return functions;
}

/**
 * Mark imports that match re-exported names as used (reexport). Mutates the
 * file-level usage map in place.
 */
function markReExports(
  fileUsageMap: Map<string, any>,
  reExports: any[],
  detailedImports: any[],
): void {
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
}

/**
 * Scan a React file for components, folding each into the functions list
 * (updating an existing function when the component was already indexed as a
 * regular function, otherwise appending a new entry).
 */
function scanReactComponents(
  functions: FunctionMetadata[],
  ctx: {
    root: ASTNode;
    content: string;
    filePath: string;
    dependencies: string[];
    importNames: Set<string>;
    detailedImports: any[];
    fileUsageMap: Map<string, any>;
    options?: { unusedImportsConfig?: AuditOptions['unusedImportsConfig'] };
  },
): void {
  const { root, content, filePath, dependencies, importNames, detailedImports, fileUsageMap, options } = ctx;

  // Walk all nodes for React components
  walkAST(root, (node) => {
    if (!isReactComponent(node, content)) return;

    const componentType = detectComponentType(node, content);
    if (!componentType) return;

    const componentName = getComponentName(node, content);
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

      existingFunc.body = getComponentBody(node, content);
      existingFunc.metadata = {
        ...existingFunc.metadata,
        entityType: 'component',
        componentType,
        props: extractPropTypes(nodeForProps, content),
        hooks: extractHooks(node, content),
        jsxElements: extractJSXElements(node, content),
        isExported: isComponentExported(node),
        complexity: calculateComplexity(node),
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
        body: getComponentBody(node, content),
        metadata: {
          entityType: 'component',
          componentType,
          props: extractPropTypes(nodeForProps, content),
          hooks: extractHooks(node, content),
          jsxElements: extractJSXElements(node, content),
          isExported: isComponentExported(node),
          complexity: calculateComplexity(node),
          usedImports,
          unusedImports: unusedImports.length > 0 ? unusedImports : undefined,
          calledBy: [],
          dependencies
        }
      });
    }
  });
}

/**
 * Append a file-level unused-imports analysis entry when configured.
 */
function scanFileLevelUnusedImports(
  functions: FunctionMetadata[],
  detailedImports: any[],
  filePath: string,
  dependencies: string[],
  flConfig: NonNullable<AuditOptions['unusedImportsConfig']>,
): void {
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
        usedImportsCount: allUsedImports.size,
        dependencies
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Helper functions for React component extraction
// ---------------------------------------------------------------------------

function extractJSXElements(node: ASTNode, content: string): string[] {
  const elements = new Set<string>();

  walkAST(node, (child) => {
    if (child.type === 'jsx_element') {
      const openTag = findChildOfType(child, 'jsx_opening_element');
      if (openTag) {
        const tagNameNode = openTag.children?.find(c =>
          c.type === 'identifier' || c.type === 'member_expression');
        if (tagNameNode) {
          if (tagNameNode.type === 'identifier') {
            elements.add(getNodeText(tagNameNode, content));
          } else if (tagNameNode.type === 'member_expression') {
            elements.add(getNodeText(tagNameNode, content));
          }
        }
      }
    } else if (child.type === 'jsx_self_closing_element') {
      const tagNameNode = child.children?.find(c =>
        c.type === 'identifier' || c.type === 'member_expression');
      if (tagNameNode) {
        if (tagNameNode.type === 'identifier') {
          elements.add(getNodeText(tagNameNode, content));
        } else if (tagNameNode.type === 'member_expression') {
          elements.add(getNodeText(tagNameNode, content));
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
    if (parent.type === 'export_statement') {
      return true;
    }
    parent = parent.parent;
  }

  return false;
}

// Aliases for MCP server compatibility
export const scanFunctionsInFile = extractFunctionsFromFile;

/**
 * Scan a directory for functions using a compatibility-friendly option shape.
 * Delegates to {@link scanDirectoryForFunctions}, translating `recursive` and
 * `fileTypes` into its include-path and extension options.
 *
 * @param dirPath - Directory to scan.
 * @param options - Optional recursion toggle and file-type filter.
 * @returns Function metadata for every function found.
 */
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
  /**
   * Extract functions from source content via the shared extraction path.
   *
   * @param content - Source text to parse and extract from.
   * @param filePath - Path used to resolve the language.
   * @returns Function metadata for the source's functions.
   */
  async scanFunctions(
    content: string,
    filePath: string
  ): Promise<FunctionMetadata[]> {
    // Delegate to the shared extraction logic — this ensures the index sync
    // path produces the same relational data (functionCalls, usedImports,
    // complexity, etc.) as the audit runner path. Language is resolved inside
    // extractFunctionsFromSource via getLanguageFromPath (the same selector
    // the pipeline uses) — there is no separate language argument to drift.
    return extractFunctionsFromSource(content, filePath);
  }
}

// ---------------------------------------------------------------------------
// Helper function to get component body
// ---------------------------------------------------------------------------

function getComponentBody(node: ASTNode, content: string): string | undefined {
  if (node.type === 'function_declaration' || node.type === 'function_expression') {
    const body = findChildOfType(node, 'statement_block');
    return body ? getNodeText(body, content) : undefined;
  } else if (node.type === 'arrow_function') {
    const body = findChildOfType(node, 'statement_block');
    return body ? getNodeText(body, content) : undefined;
  } else if (node.type === 'class_declaration') {
    // For class components, get the render method body
    const classBody = findChildOfType(node, 'class_body');
    if (!classBody) return undefined;

    for (const member of classBody.children ?? []) {
      if (member.type !== 'method_definition') continue;
      const mNameNode = findChildOfType(member, 'identifier');
      if (mNameNode && getNodeText(mNameNode, content) === 'render') {
        const body = findChildOfType(member, 'statement_block');
        return body ? getNodeText(body, content) : undefined;
      }
    }
  }

  return undefined;
}
