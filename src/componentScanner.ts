/**
 * React Component Scanner Module
 * Scans TypeScript/JavaScript files for React components and extracts metadata
 */

import * as ts from 'typescript';
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
import { parseTypeScriptFile } from './utils/astParser.js';

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
 * Scan a single file for React components
 */
export async function scanFile(
  filePath: string,
  options: ComponentScannerOptions = DEFAULT_OPTIONS
): Promise<ComponentScanResult> {
  try {
    const parseResult = await parseTypeScriptFile(filePath);
    if (!parseResult.sourceFile) {
      return {
        filePath,
        components: [],
        imports: [],
        parseErrors: ['Failed to parse file']
      };
    }

    const state: ScannerState = {
      currentFile: filePath,
      components: [],
      imports: [],
      errors: []
    };

    const sourceFile = parseResult.sourceFile;
    
    // Extract component imports if requested
    if (options.extractImports) {
      state.imports = extractComponentImports(sourceFile);
    }

    // Create type checker for prop extraction
    const program = ts.createProgram([filePath], {
      target: ts.ScriptTarget.Latest,
      jsx: ts.JsxEmit.React
    });
    const typeChecker = options.extractProps ? program.getTypeChecker() : undefined;

    // Traverse AST to find components
    traverseNode(sourceFile, sourceFile, state, options, typeChecker);

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

/**
 * Traverse AST node to find React components
 */
function traverseNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  state: ScannerState,
  options: ComponentScannerOptions,
  typeChecker?: ts.TypeChecker
): void {
  // Check if node is a React component
  if (isReactComponent(node)) {
    const componentType = detectComponentType(node);
    
    if (componentType) {
      const componentName = getComponentName(node);
      
      // Skip test/story components if configured
      if (!options.includeTests && componentName.includes('Test')) return;
      if (!options.includeStories && componentName.includes('Story')) return;
      
      const component: ComponentMetadata = {
        name: componentName,
        filePath: state.currentFile,
        lineNumber: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        entityType: 'component',
        componentType,
        dependencies: [], // Will be populated later from imports
        purpose: `React ${componentType} component`,
        context: extractComponentContext(node, sourceFile),
        isExported: isComponentExported(node)
      };
      
      // Extract hooks if functional component
      if (options.extractHooks && (componentType === 'functional' || componentType === 'memo' || componentType === 'forwardRef')) {
        component.hooks = extractHooks(node, sourceFile);
      }
      
      // Extract props
      if (options.extractProps) {
        component.props = extractPropTypes(node, sourceFile, typeChecker);
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
    }
  }
  
  // Continue traversal
  ts.forEachChild(node, child => traverseNode(child, sourceFile, state, options, typeChecker));
}

/**
 * Extract context information about the component
 */
function extractComponentContext(node: ts.Node, sourceFile: ts.SourceFile): string {
  const lines: string[] = [];
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
  const text = sourceFile.text;
  const lineStarts = sourceFile.getLineStarts();
  
  // Get up to 3 lines before the component for context
  for (let i = Math.max(0, startLine - 3); i < startLine; i++) {
    const lineStart = lineStarts[i];
    const lineEnd = i + 1 < lineStarts.length ? lineStarts[i + 1] : text.length;
    const line = text.substring(lineStart, lineEnd).trim();
    if (line && !line.startsWith('//') && !line.startsWith('/*')) {
      lines.push(line);
    }
  }
  
  return lines.join(' ').substring(0, 200);
}

/**
 * Check if component is exported
 */
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

/**
 * Extract JSX elements used within a component
 */
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

/**
 * Calculate component complexity based on various factors
 */
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
 * Check if class component has error boundary methods
 */
function hasErrorBoundaryMethods(node: ts.Node): boolean {
  if (!ts.isClassDeclaration(node)) return false;
  
  const errorBoundaryMethods = ['componentDidCatch', 'getDerivedStateFromError'];
  const methodNames = new Set<string>();
  
  for (const member of node.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      methodNames.add(member.name.text);
    }
  }
  
  return errorBoundaryMethods.some(method => methodNames.has(method));
}

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
 * Component import information
 */
interface ComponentImport {
  name: string;
  path: string;
  isDefault: boolean;
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