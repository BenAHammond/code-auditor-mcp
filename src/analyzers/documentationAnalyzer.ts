/**
 * Documentation Quality Analyzer
 * Assesses JSDoc coverage and documentation quality across the codebase
 *
 * Migrated from TypeScript Compiler API to tree-sitter AST patterns.
 */

import type { ASTNode, AST, LanguageAdapter } from '../languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { walkAST, getLineAndColumn, isExported as adapterIsExported } from '../languages/adapterBridge.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import {
  Violation,
  AnalyzerResult,
  AuditOptions,
  ProgressCallback
} from '../types.js';
import { makeVisitorStatus, getFilesProcessed } from '../pipeline.js';
import {
  getNodePosition,
  findNodesOfType,
  getNodeName,
  processFiles
} from './analyzerUtils.js';
import {
  isReactComponent,
  getComponentName,
  detectComponentType
} from '../utils/reactDetection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get raw text from a tree-sitter node stored on ASTNode.raw. */
const rawText = (node: ASTNode): string => (node.raw as TreeSitterNode)?.text ?? '';

/** Find the first child of a given type. */
const findChild = (node: ASTNode, type: string): ASTNode | undefined =>
  node.children?.find(c => c.type === type);


/**
 * Parse @param tag details from JSDoc comment text.
 * Returns array of documented parameter names.
 */
function parseParamTags(jsDocText: string): string[] {
  const params: string[] = [];
  const regex = /@param\s+\{?\w+\}?\s*(?:\[\s*)?(\w+)/g;
  let match;
  while ((match = regex.exec(jsDocText)) !== null) {
    params.push(match[1]);
  }
  return params;
}

/**
 * Count formal parameters on a function-like node.
 */
function countParameters(node: ASTNode): number {
  const params = findChild(node, 'formal_parameters');
  if (!params?.children) return 0;
  return params.children.filter(
    c => c.type === 'required_parameter' ||
      c.type === 'optional_parameter' ||
      c.type === 'rest_parameter'
  ).length;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for documentation analyzer
 */
export interface DocumentationAnalyzerConfig {
  requireFunctionDocs: boolean;
  requireComponentDocs: boolean;
  requireFileDocs: boolean;
  requireParamDocs: boolean;
  requireReturnDocs: boolean;
  minDescriptionLength: number;
  checkExportedOnly: boolean;
  exemptPatterns: string[]; // Regex patterns for files/functions to skip
}

export const DEFAULT_DOCUMENTATION_CONFIG: DocumentationAnalyzerConfig = {
  requireFunctionDocs: true,
  requireComponentDocs: true,
  requireFileDocs: true,
  requireParamDocs: true,
  requireReturnDocs: true,
  minDescriptionLength: 10,
  checkExportedOnly: false,
  exemptPatterns: [
    'test', 'spec', '\\.d\\.ts$', 'mock', 'fixture'
  ]
};

/**
 * Documentation quality metrics for reporting
 */
export interface DocumentationMetrics {
  totalFunctions: number;
  documentedFunctions: number;
  totalComponents: number;
  documentedComponents: number;
  totalFiles: number;
  filesWithPurpose: number;
  functionsWithParams: number;
  paramsDocumented: number;
  functionsWithReturns: number;
  returnsDocumented: number;
  coverageScore: number;
  wellDocumentedFiles: string[];
  poorlyDocumentedFiles: string[];
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

/**
 * Extracts file-level purpose comment.
 * Looks for comment nodes at the top of the file containing
 * @fileoverview or @purpose.
 */
function getFilePurpose(rootNode: ASTNode): string | null {
  if (!rootNode.children) return null;

  for (const child of rootNode.children) {
    if (child.type === 'comment') {
      const text = rawText(child);
      if (text.includes('@fileoverview') || text.includes('@purpose')) {
        return text.replace(/\/\*\*|\*\/|\s*\*\s?/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    // Only check comments at the very top — stop at first non-comment node
    // unless it's an import/export statement (which may precede the file doc)
    if (child.type !== 'comment' &&
        child.type !== 'import_statement' &&
        child.type !== 'export_statement') {
      break;
    }
  }

  return null;
}

/**
 * Analyzes JSDoc parameter documentation for a function-like node.
 */
function analyzeParamDocumentation(
  node: ASTNode,
  adapter: LanguageAdapter,
): { totalParams: number; documentedParams: number } {
  const totalParams = countParameters(node);
  if (totalParams === 0) {
    return { totalParams: 0, documentedParams: 0 };
  }

  const jsDocText = adapter.getDocumentation(node);
  if (!jsDocText) {
    return { totalParams, documentedParams: 0 };
  }

  const documentedParamNames = parseParamTags(jsDocText);
  return {
    totalParams,
    documentedParams: documentedParamNames.length
  };
}

/**
 * Checks if function has @returns or @return documentation in its JSDoc.
 */
function hasReturnDocumentation(node: ASTNode, adapter: LanguageAdapter): boolean {
  const jsDocText = adapter.getDocumentation(node);
  if (!jsDocText) return false;
  return /@returns?\b/i.test(jsDocText);
}

// ---------------------------------------------------------------------------
// File-level analysis
// ---------------------------------------------------------------------------

/**
 * Analyzes a single file for documentation quality.
 *
 * @param ast - The root ASTNode for the file
 * @param filePath - Path to the source file
 * @param sourceCode - Full source text of the file
 * @param config - Documentation analyzer configuration
 */
function analyzeFileDocumentation(
  ast: ASTNode,
  filePath: string,
  sourceCode: string,
  config: DocumentationAnalyzerConfig
): {
  violations: Violation[];
  metrics: Partial<DocumentationMetrics>;
} {
  const violations: Violation[] = [];
  const fileName = filePath;

  // B3: Get the language adapter for this file type
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(filePath);

  let totalFunctions = 0;
  let documentedFunctions = 0;
  let totalComponents = 0;
  let documentedComponents = 0;
  let functionsWithParams = 0;
  let paramsDocumented = 0;
  let functionsWithReturns = 0;
  let returnsDocumented = 0;

  // Check file-level documentation
  const filePurpose = getFilePurpose(ast);
  const hasFileDocs = !!filePurpose;

  if (config.requireFileDocs && !hasFileDocs) {
    violations.push({
      file: fileName,
      line: 1,
      column: 1,
      severity: 'suggestion',
      rule: 'file-documentation',
      message: 'File missing purpose documentation',
      details: 'Consider adding @fileoverview or @purpose comment at the top of the file',
      suggestion: "Add file-level documentation explaining the module's purpose"
    });
  }

  // Walk the AST to find function-like nodes and React components
  walkAST(ast, (node: ASTNode) => {
    // --- Function-like nodes ---
    if (node.type === 'function_declaration' ||
        node.type === 'function_expression' ||
        node.type === 'arrow_function' ||
        node.type === 'method_definition') {

      totalFunctions++;

      const nodeExported = adapterIsExported(node);
      const shouldCheck = !config.checkExportedOnly || nodeExported;

      if (shouldCheck) {
        const jsDoc = adapter?.getDocumentation(node) ?? null;
        const hasGoodDoc = jsDoc ? jsDoc.length >= config.minDescriptionLength : false;

        if (hasGoodDoc) {
          documentedFunctions++;
        } else if (config.requireFunctionDocs) {
          const functionName = getNodeName(node) || 'anonymous function';
          const position = getNodePosition(node);

          violations.push({
            file: fileName,
            line: position.line,
            column: position.column,
            severity: 'suggestion',
            rule: 'function-documentation',
            message: `Function '${functionName}' lacks documentation`,
            details: 'Functions should have JSDoc comments describing their purpose',
            suggestion: 'Add JSDoc comment with function description and parameter/return documentation',
            functionName
          });
        }

        // Check parameter documentation
        if (node.type === 'function_declaration' || node.type === 'function_expression') {
          const paramAnalysis = analyzeParamDocumentation(node, adapter!);
          if (paramAnalysis.totalParams > 0) {
            functionsWithParams++;
            if (paramAnalysis.documentedParams === paramAnalysis.totalParams) {
              paramsDocumented++;
            } else if (config.requireParamDocs && hasGoodDoc) {
              const functionName = getNodeName(node) || 'function';
              const position = getNodePosition(node);

              violations.push({
                file: fileName,
                line: position.line,
                column: position.column,
                severity: 'suggestion',
                rule: 'parameter-documentation',
                message: `Function '${functionName}' has undocumented parameters`,
                details: `${paramAnalysis.documentedParams}/${paramAnalysis.totalParams} parameters documented`,
                suggestion: 'Add @param tags for all function parameters',
                functionName
              });
            }
          }

          // Check return documentation
          const hasReturnType = !!findChild(node, 'type_annotation');
          const body = findChild(node, 'statement_block');
          const hasReturnStatements = body
            ? findNodesOfType(body, (n: ASTNode) => n.type === 'return_statement').length > 0
            : false;
          const hasReturn = hasReturnType || hasReturnStatements;

          if (hasReturn) {
            functionsWithReturns++;
            if (hasReturnDocumentation(node, adapter!)) {
              returnsDocumented++;
            } else if (config.requireReturnDocs && hasGoodDoc) {
              const functionName = getNodeName(node) || 'function';
              const position = getNodePosition(node);

              violations.push({
                file: fileName,
                line: position.line,
                column: position.column,
                severity: 'suggestion',
                rule: 'return-documentation',
                message: `Function '${functionName}' missing return documentation`,
                details: 'Functions with return values should document what they return',
                suggestion: 'Add @returns tag describing the return value',
                functionName
              });
            }
          }
        }
      }
    }

    // --- React components ---
    if (isReactComponent(node)) {
      totalComponents++;

      const componentExported = adapterIsExported(node);
      const shouldCheck = !config.checkExportedOnly || componentExported;

      if (shouldCheck) {
        const jsDoc = adapter?.getDocumentation(node) ?? null;
        const hasGoodDoc = jsDoc ? jsDoc.length >= config.minDescriptionLength : false;

        if (hasGoodDoc) {
          documentedComponents++;
        } else if (config.requireComponentDocs) {
          const componentName = getComponentName(node) || 'Component';
          const position = getNodePosition(node);

          violations.push({
            file: fileName,
            line: position.line,
            column: position.column,
            severity: 'suggestion',
            rule: 'class-documentation',
            message: `Component '${componentName}' lacks documentation`,
            details: 'React components should have JSDoc comments describing their purpose and props',
            suggestion: 'Add JSDoc comment with component description and @param tags for props',
            componentName
          });
        }
      }
    }
  });

  return {
    violations,
    metrics: {
      totalFunctions,
      documentedFunctions,
      totalComponents,
      documentedComponents,
      functionsWithParams,
      paramsDocumented,
      functionsWithReturns,
      returnsDocumented,
      totalFiles: 1,
      filesWithPurpose: hasFileDocs ? 1 : 0
    }
  };
}

// ---------------------------------------------------------------------------
// Main analyzer function
// ---------------------------------------------------------------------------

/**
 * Main documentation analyzer function.
 * Runs across all provided files and aggregates results.
 */
export async function analyzeDocumentation(
  files: string[],
  config: Partial<DocumentationAnalyzerConfig> = {},
  options: AuditOptions = {},
  progressCallback?: ProgressCallback
): Promise<AnalyzerResult> {
  const finalConfig = { ...DEFAULT_DOCUMENTATION_CONFIG, ...config };
  const startTime = Date.now();

  // Filter out exempt files
  const filteredFiles = files.filter(file => {
    return !finalConfig.exemptPatterns.some(pattern =>
      new RegExp(pattern, 'i').test(file)
    );
  });

  const progressReporter = progressCallback ? (current: number, total: number, file: string) => {
    progressCallback({ current, total, analyzer: 'documentation', file });
  } : undefined;

  // Collect per-file metrics in a closure so we only parse each file once
  const allMetrics: Partial<DocumentationMetrics>[] = [];

  const perFileAnalyzer = (
    filePath: string,
    ast: AST,
    _config: any,
    sourceCode?: string
  ): Violation[] => {
    const analysis = analyzeFileDocumentation(
      ast.root,
      filePath,
      sourceCode ?? '',
      finalConfig
    );
    allMetrics.push(analysis.metrics);
    return analysis.violations;
  };

  const result = await processFiles(
    filteredFiles,
    perFileAnalyzer,
    'documentation',
    finalConfig,
    progressReporter
  );

  // Aggregate metrics from all files (single pass — no re-parsing)
  const aggregatedMetrics: DocumentationMetrics = {
    totalFunctions: 0,
    documentedFunctions: 0,
    totalComponents: 0,
    documentedComponents: 0,
    totalFiles: filteredFiles.length,
    filesWithPurpose: 0,
    functionsWithParams: 0,
    paramsDocumented: 0,
    functionsWithReturns: 0,
    returnsDocumented: 0,
    coverageScore: 0,
    wellDocumentedFiles: [],
    poorlyDocumentedFiles: []
  };

  // Combine metrics from all files
  allMetrics.forEach((fileMetrics, index) => {
    if (fileMetrics) {
      // Sum numeric metrics
      const numericKeys: (keyof DocumentationMetrics)[] = [
        'totalFunctions', 'documentedFunctions',
        'totalComponents', 'documentedComponents',
        'functionsWithParams', 'paramsDocumented',
        'functionsWithReturns', 'returnsDocumented',
        'totalFiles', 'filesWithPurpose'
      ];
      for (const key of numericKeys) {
        const val = fileMetrics[key];
        if (typeof val === 'number') {
          (aggregatedMetrics as any)[key] += val;
        }
      }

      // Identify well/poorly documented files
      const fileTotal = (fileMetrics.totalFunctions || 0) +
        (fileMetrics.totalComponents || 0) + 1;
      const fileDocumented = (fileMetrics.documentedFunctions || 0) +
        (fileMetrics.documentedComponents || 0) +
        (fileMetrics.filesWithPurpose || 0);
      const fileCoverage = fileTotal > 0 ? (fileDocumented / fileTotal) : 0;

      const filePath = filteredFiles[index];
      if (fileCoverage >= 0.8) {
        aggregatedMetrics.wellDocumentedFiles.push(filePath);
      } else if (fileCoverage < 0.3) {
        aggregatedMetrics.poorlyDocumentedFiles.push(filePath);
      }
    }
  });

  // Calculate coverage score
  const totalItems = aggregatedMetrics.totalFunctions +
    aggregatedMetrics.totalComponents +
    aggregatedMetrics.totalFiles;
  const documentedItems = aggregatedMetrics.documentedFunctions +
    aggregatedMetrics.documentedComponents +
    aggregatedMetrics.filesWithPurpose;
  aggregatedMetrics.coverageScore = totalItems > 0
    ? Math.round((documentedItems / totalItems) * 100)
    : 100;

  return {
    violations: result.violations,
    status: makeVisitorStatus(getFilesProcessed(result.status)),
    executionTime: Date.now() - startTime,
    errors: result.errors,
    analyzerName: 'documentation',
    metrics: aggregatedMetrics as unknown as Record<string, unknown>
  };
}

