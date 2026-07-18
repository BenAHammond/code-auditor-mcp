/**
 * React Component Scanner Module
 * Scans TypeScript/JavaScript files for React components and extracts metadata
 *
 * ## Migration: TypeScript Compiler API → tree-sitter
 *
 * All `ts.Node`/`ts.SourceFile`/`ts.SyntaxKind`/`ts.createProgram` usage replaced with
 * tree-sitter `ASTNode` and adapterBridge utilities. `import * as ts from 'typescript'` removed.
 * TypeChecker-based prop extraction is a documented capability regression (plan Step 2.5).
 */

import { ComponentMetadata, FunctionMetadata } from './types.js';
import {
  isReactComponent,
  detectComponentType,
  getComponentName,
  extractHooks,
  extractPropTypes,
  extractComponentImports,
  isFunctionalComponent,
  isClassComponent
} from './utils/reactDetection.js';
import { parseFile, walkAST, isExported, getLineAndColumn, hasModifier } from './languages/adapterBridge.js';
import type { ASTNode } from './languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { readFile } from 'fs/promises';

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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for component scanning
 */
export interface ComponentScannerOptions {
  includeTests?: boolean;
  includeStories?: boolean;
  extractProps?: boolean;
  extractHooks?: boolean;
  extractImports?: boolean;
  detectComplexity?: boolean;
}

const DEFAULT_OPTIONS: ComponentScannerOptions = {
  includeTests: false,
  includeStories: false,
  extractProps: true,
  extractHooks: true,
  extractImports: true,
  detectComplexity: true
};

/**
 * Result of scanning a file for components
 */
export interface ComponentScanResult {
  filePath: string;
  components: ComponentMetadata[];
  imports: ComponentImport[];
  fileHash?: string;
  parseErrors?: string[];
}

/**
 * Scanner state for tracking context during traversal
 */
interface ScannerState {
  currentFile: string;
  components: ComponentMetadata[];
  imports: ComponentImport[];
  errors: string[];
}

/**
 * Component import information
 */
interface ComponentImport {
  name: string;
  path: string;
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

/**
 * Scan a single file for React components
 */
export async function scanFile(
  filePath: string,
  options: ComponentScannerOptions = DEFAULT_OPTIONS
): Promise<ComponentScanResult> {
  try {
    // Read file content and parse via tree-sitter
    const content = await readFile(filePath, 'utf-8');
    const ast = parseFile(filePath, content);

    if (!ast) {
      return {
        filePath,
        components: [],
        imports: [],
        parseErrors: ['Failed to parse file']
      };
    }

    const root = ast.root;
    const state: ScannerState = {
      currentFile: filePath,
      components: [],
      imports: [],
      errors: []
    };

    // Extract component imports if requested
    if (options.extractImports) {
      state.imports = extractComponentImports(root);
    }

    // Walk the AST and scan for React components
    // walkAST visits every node recursively — no manual recursion needed
    walkAST(root, (node) => {
      if (!isReactComponent(node)) return;

      const componentType = detectComponentType(node);
      if (!componentType) return;

      const componentName = getComponentName(node);

      // Skip test/story components if configured
      if (!options.includeTests && componentName.includes('Test')) return;
      if (!options.includeStories && componentName.includes('Story')) return;

      const { line } = getLineAndColumn(node);
      const endLine = node.location?.end?.line ?? line;

      const component: ComponentMetadata = {
        name: componentName,
        filePath: state.currentFile,
        lineNumber: line + 1, // Convert to 1-based
        startLine: line + 1,
        endLine: endLine + 1,
        entityType: 'component',
        componentType,
        dependencies: [], // Will be populated later from imports
        purpose: `React ${componentType} component`,
        context: extractComponentContext(node, content),
        isExported: isComponentExported(node)
      };

      // Extract hooks if functional component
      if (options.extractHooks && (componentType === 'functional' || componentType === 'memo' || componentType === 'forwardRef')) {
        component.hooks = extractHooks(node);
      }

      // Extract props (tree-sitter: no TypeChecker — capability regression per plan Step 2.5)
      if (options.extractProps) {
        component.props = extractPropTypes(node);
      }

      // Extract JSX elements used
      component.jsxElements = extractJSXElements(node);

      // Calculate complexity if requested
      if (options.detectComplexity) {
        component.complexity = calculateComponentComplexity(node);
      }

      // Check for error boundary (class components)
      if (componentType === 'class') {
        component.hasErrorBoundary = hasErrorBoundaryMethods(node);
      }

      state.components.push(component);
    });

    // Calculate file hash for change detection
    const fileHash = undefined; // TODO: implement file hash calculation

    return {
      filePath,
      components: state.components,
      imports: state.imports,
      fileHash,
      parseErrors: state.errors.length > 0 ? state.errors : undefined
    };
  } catch (error) {
    return {
      filePath,
      components: [],
      imports: [],
      parseErrors: [`Scan error: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

/**
 * Scan multiple files for React components
 */
export async function scanFiles(
  filePaths: string[],
  options: ComponentScannerOptions = DEFAULT_OPTIONS,
  progressCallback?: (current: number, total: number) => void
): Promise<ComponentScanResult[]> {
  const results: ComponentScanResult[] = [];

  for (let i = 0; i < filePaths.length; i++) {
    if (progressCallback) {
      progressCallback(i + 1, filePaths.length);
    }

    const result = await scanFile(filePaths[i], options);
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Extract context information about the component
 */
function extractComponentContext(node: ASTNode, sourceText: string): string {
  const { line } = getLineAndColumn(node);
  const allLines = sourceText.split('\n');

  const contextLines: string[] = [];
  // Get up to 3 lines before the component for context
  for (let i = Math.max(0, line - 3); i < line; i++) {
    const textLine = allLines[i]?.trim();
    if (textLine && !textLine.startsWith('//') && !textLine.startsWith('/*')) {
      contextLines.push(textLine);
    }
  }

  return contextLines.join(' ').substring(0, 200);
}

/**
 * Check if component is exported
 */
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

/**
 * Extract JSX elements used within a component
 */
function extractJSXElements(node: ASTNode): string[] {
  const elements = new Set<string>();

  walkAST(node, (child) => {
    if (child.type === 'jsx_element') {
      const openTag = findChildOfType(child, 'open_tag');
      if (openTag) {
        const tagNameNode = openTag.children?.find(c =>
          c.type === 'identifier' || c.type === 'member_expression');
        if (tagNameNode) {
          elements.add(rawText(tagNameNode));
        }
      }
    } else if (child.type === 'jsx_self_closing_element') {
      const tagNameNode = child.children?.find(c =>
        c.type === 'identifier' || c.type === 'member_expression');
      if (tagNameNode) {
        elements.add(rawText(tagNameNode));
      }
    }
  });

  return Array.from(elements);
}

/**
 * Calculate component complexity based on various factors
 */
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
 * Check if class component has error boundary methods
 */
function hasErrorBoundaryMethods(node: ASTNode): boolean {
  if (node.type !== 'class_declaration') return false;

  const errorBoundaryMethods = ['componentDidCatch', 'getDerivedStateFromError'];
  const methodNames = new Set<string>();

  const classBody = findChildOfType(node, 'class_body');
  for (const member of classBody?.children ?? []) {
    if (member.type !== 'method_definition') continue;
    const nameNode = findChildOfType(member, 'identifier');
    if (nameNode) {
      methodNames.add(rawText(nameNode));
    }
  }

  return errorBoundaryMethods.some(method => methodNames.has(method));
}

// ---------------------------------------------------------------------------
// Dependency tree & conversion
// ---------------------------------------------------------------------------

/**
 * Create a component dependency tree from scan results
 */
export function buildComponentTree(scanResults: ComponentScanResult[]): Map<string, Set<string>> {
  const tree = new Map<string, Set<string>>();

  // Build a map of component name to file path
  const componentToFile = new Map<string, string>();
  for (const result of scanResults) {
    for (const component of result.components) {
      componentToFile.set(component.name, result.filePath);
    }
  }

  // Build dependency relationships
  for (const result of scanResults) {
    for (const component of result.components) {
      const dependencies = new Set<string>();

      // Find components used in JSX
      if (component.jsxElements) {
        for (const element of component.jsxElements) {
          // Skip HTML elements
          if (element[0] === element[0].toLowerCase()) continue;

          // Check if it's an imported component
          const importedComponent = result.imports.find(imp => imp.name === element);
          if (importedComponent) {
            dependencies.add(element);
          }
        }
      }

      tree.set(component.name, dependencies);
    }
  }

  return tree;
}

/**
 * Convert component metadata to function metadata for indexing
 */
export function componentToFunctionMetadata(component: ComponentMetadata): FunctionMetadata {
  const { entityType, componentType, props, hooks, jsxElements, imports, hasErrorBoundary, isExported, ...base } = component;

  return {
    ...base,
    metadata: {
      entityType,
      componentType,
      props,
      hooks,
      jsxElements,
      imports,
      hasErrorBoundary,
      isExported
    }
  };
}
