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

/** Mutable per-file documentation counters, threaded through the node checks. */
interface DocCounters {
  documentedFunctions: number;
  documentedComponents: number;
  functionsWithParams: number;
  paramsDocumented: number;
  functionsWithReturns: number;
  returnsDocumented: number;
}

/** True for nodes the analyzer treats as "function-like" documentation targets. */
function isFunctionLikeNode(node: ASTNode): boolean {
  return node.type === 'function_declaration' ||
    node.type === 'function_expression' ||
    node.type === 'arrow_function' ||
    node.type === 'method_definition';
}

/**
 * Per-file scan context threaded through the documentation check helpers.
 * Bundles the adapter, config, file name, and mutable violation/counter
 * accumulators so the check functions take a single context object.
 */
interface DocScanContext {
  adapter: LanguageAdapter | null;
  config: DocumentationAnalyzerConfig;
  fileName: string;
  violations: Violation[];
  counters: DocCounters;
}

/**
 * Check function-documentation quality for a single function-like node,
 * mutating counters and appending violations.
 */
function checkFunctionDocumentation(node: ASTNode, ctx: DocScanContext): void {
  const { adapter, config, counters } = ctx;

  const nodeExported = adapterIsExported(node);
  if (config.checkExportedOnly && !nodeExported) return;

  const jsDoc = adapter?.getDocumentation(node) ?? null;
  const hasGoodDoc = jsDoc ? jsDoc.length >= config.minDescriptionLength : false;

  if (hasGoodDoc) {
    counters.documentedFunctions++;
  } else if (config.requireFunctionDocs) {
    pushFunctionDocViolation(node, ctx);
  }

  // Parameter and return documentation only apply to declarations/expressions.
  if (node.type !== 'function_declaration' && node.type !== 'function_expression') {
    return;
  }

  checkParamDocumentation(node, ctx, hasGoodDoc);
  checkReturnDocumentation(node, ctx, hasGoodDoc);
}

/** Push a missing-function-documentation violation. */
function pushFunctionDocViolation(node: ASTNode, ctx: DocScanContext): void {
  const { fileName, violations } = ctx;
  const functionName = getNodeName(node) || 'anonymous function';
  const position = getNodePosition(node);

  violations.push({
    file: fileName,
    line: position.line,
    column: position.column,
    severity: 'high',
    rule: 'function-documentation',
    message: `Function '${functionName}' lacks documentation`,
    details: 'Functions should have JSDoc comments describing their purpose',
    suggestion: 'Add JSDoc comment with function description and parameter/return documentation',
    functionName
  });
}

/** Check @param coverage for a function-like node. */
function checkParamDocumentation(node: ASTNode, ctx: DocScanContext, hasGoodDoc: boolean): void {
  const { adapter, config, counters } = ctx;
  const paramAnalysis = analyzeParamDocumentation(node, adapter!);
  if (paramAnalysis.totalParams === 0) return;

  counters.functionsWithParams++;
  if (paramAnalysis.documentedParams === paramAnalysis.totalParams) {
    counters.paramsDocumented++;
  } else if (config.requireParamDocs && hasGoodDoc) {
    const { fileName, violations } = ctx;
    const functionName = getNodeName(node) || 'function';
    const position = getNodePosition(node);

    violations.push({
      file: fileName,
      line: position.line,
      column: position.column,
      severity: 'high',
      rule: 'parameter-documentation',
      message: `Function '${functionName}' has undocumented parameters`,
      details: `${paramAnalysis.documentedParams}/${paramAnalysis.totalParams} parameters documented`,
      suggestion: 'Add @param tags for all function parameters',
      functionName
    });
  }
}

/** Check @returns coverage for a function-like node. */
function checkReturnDocumentation(node: ASTNode, ctx: DocScanContext, hasGoodDoc: boolean): void {
  const { adapter, config, counters } = ctx;

  const hasReturnType = !!findChild(node, 'type_annotation');
  const body = findChild(node, 'statement_block');
  const hasReturnStatements = body
    ? findNodesOfType(body, (n: ASTNode) => n.type === 'return_statement').length > 0
    : false;
  const hasReturn = hasReturnType || hasReturnStatements;

  if (!hasReturn) return;
  counters.functionsWithReturns++;
  if (hasReturnDocumentation(node, adapter!)) {
    counters.returnsDocumented++;
  } else if (config.requireReturnDocs && hasGoodDoc) {
    const { fileName, violations } = ctx;
    const functionName = getNodeName(node) || 'function';
    const position = getNodePosition(node);

    violations.push({
      file: fileName,
      line: position.line,
      column: position.column,
      severity: 'high',
      rule: 'return-documentation',
      message: `Function '${functionName}' missing return documentation`,
      details: 'Functions with return values should document what they return',
      suggestion: 'Add @returns tag describing the return value',
      functionName
    });
  }
}

/**
 * Check documentation quality for a single React component node.
 */
function checkComponentDocumentation(node: ASTNode, ctx: DocScanContext): void {
  const { adapter, config, fileName, violations, counters } = ctx;

  const componentExported = adapterIsExported(node);
  const shouldCheck = !config.checkExportedOnly || componentExported;

  if (!shouldCheck) return;

  const jsDoc = adapter?.getDocumentation(node) ?? null;
  const hasGoodDoc = jsDoc ? jsDoc.length >= config.minDescriptionLength : false;

  if (hasGoodDoc) {
    counters.documentedComponents++;
  } else if (config.requireComponentDocs) {
    const componentName = getComponentName(node) || 'Component';
    const position = getNodePosition(node);

    violations.push({
      file: fileName,
      line: position.line,
      column: position.column,
      severity: 'high',
      rule: 'class-documentation',
      message: `Component '${componentName}' lacks documentation`,
      details: 'React components should have JSDoc comments describing their purpose and props',
      suggestion: 'Add JSDoc comment with component description and @param tags for props',
      componentName
    });
  }
}

/**
 * Analyzes a single file for documentation quality.
 *
* @param ast - The root ASTNode for the file
* @param filePath - Path to the source file
* @param sourceCode - Full source text of the file
* @param config - Documentation analyzer configuration
 */
function createDocCounters(): DocCounters {
  return {
    documentedFunctions: 0,
    documentedComponents: 0,
    functionsWithParams: 0,
    paramsDocumented: 0,
    functionsWithReturns: 0,
    returnsDocumented: 0,
  };
}

/**
 * Check file-level purpose documentation and push a violation if missing.
 * Returns whether the file has purpose docs (for metric aggregation).
 */
function checkFileDocumentation(
  ast: ASTNode,
  filePath: string,
  config: DocumentationAnalyzerConfig,
  violations: Violation[],
): boolean {
  const hasFileDocs = !!getFilePurpose(ast);
  if (config.requireFileDocs && !hasFileDocs) {
    violations.push({
      file: filePath,
      line: 1,
      column: 1,
      severity: 'high',
      rule: 'file-documentation',
      message: 'File missing purpose documentation',
      details: 'Consider adding @fileoverview or @purpose comment at the top of the file',
      suggestion: "Add file-level documentation explaining the module's purpose"
    });
  }
  return hasFileDocs;
}

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
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(filePath);
  let totalFunctions = 0;
  let totalComponents = 0;
  const counters = createDocCounters();
  const hasFileDocs = checkFileDocumentation(ast, filePath, config, violations);

  const ctx: DocScanContext = { adapter, config, fileName: filePath, violations, counters };
  walkAST(ast, (node: ASTNode) => {
    if (isFunctionLikeNode(node)) {
      totalFunctions++;
      checkFunctionDocumentation(node, ctx);
    }
    if (isReactComponent(node)) {
      totalComponents++;
      checkComponentDocumentation(node, ctx);
    }
  });

  return {
    violations,
    metrics: {
      totalFunctions,
      totalComponents,
      ...counters,
      totalFiles: 1,
      filesWithPurpose: hasFileDocs ? 1 : 0
    }
  };
}

// ---------------------------------------------------------------------------
// Main analyzer function
// ---------------------------------------------------------------------------

/**
 * Aggregate per-file documentation metrics into a single corpus-level result,
 * computing coverage score and classifying well/poorly documented files.
 */
const NUMERIC_METRIC_KEYS: (keyof DocumentationMetrics)[] = [
  'totalFunctions', 'documentedFunctions',
  'totalComponents', 'documentedComponents',
  'functionsWithParams', 'paramsDocumented',
  'functionsWithReturns', 'returnsDocumented',
  'totalFiles', 'filesWithPurpose'
];

/**
 * Accumulate one file's metrics into the aggregated result and classify the
 * file as well/poorly documented based on its per-file coverage ratio.
 */
function accumulateFileMetrics(
  aggregated: DocumentationMetrics,
  fileMetrics: Partial<DocumentationMetrics>,
  filePath: string,
): void {
  for (const key of NUMERIC_METRIC_KEYS) {
    const val = fileMetrics[key];
    if (typeof val === 'number') {
      (aggregated as any)[key] += val;
    }
  }

  const fileTotal = (fileMetrics.totalFunctions || 0) +
    (fileMetrics.totalComponents || 0) + 1;
  const fileDocumented = (fileMetrics.documentedFunctions || 0) +
    (fileMetrics.documentedComponents || 0) +
    (fileMetrics.filesWithPurpose || 0);
  const fileCoverage = fileTotal > 0 ? (fileDocumented / fileTotal) : 0;

  if (fileCoverage >= 0.8) {
    aggregated.wellDocumentedFiles.push(filePath);
  } else if (fileCoverage < 0.3) {
    aggregated.poorlyDocumentedFiles.push(filePath);
  }
}

/** Compute the overall documentation coverage score (0-100). */
function computeCoverageScore(aggregated: DocumentationMetrics): number {
  const totalItems = aggregated.totalFunctions +
    aggregated.totalComponents +
    aggregated.totalFiles;
  const documentedItems = aggregated.documentedFunctions +
    aggregated.documentedComponents +
    aggregated.filesWithPurpose;
  return totalItems > 0
    ? Math.round((documentedItems / totalItems) * 100)
    : 100;
}

function aggregateDocumentationMetrics(
  allMetrics: Partial<DocumentationMetrics>[],
  filteredFiles: string[]
): DocumentationMetrics {
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

  allMetrics.forEach((fileMetrics, index) => {
    if (fileMetrics) {
      accumulateFileMetrics(aggregatedMetrics, fileMetrics, filteredFiles[index]);
    }
  });

  aggregatedMetrics.coverageScore = computeCoverageScore(aggregatedMetrics);
  return aggregatedMetrics;
}

/**
 * Main documentation analyzer function.
 * Runs across all provided files and aggregates results.
 * @param config
 * @param files
 * @param options
 * @param progressCallback
 * @returns
 */
/** Build the per-file analyzer callback that collects metrics into `allMetrics`. */
function makePerFileAnalyzer(
  allMetrics: Partial<DocumentationMetrics>[],
  finalConfig: DocumentationAnalyzerConfig,
): (filePath: string, ast: AST, _config: any, sourceCode?: string) => Violation[] {
  return (filePath, ast, _config, sourceCode) => {
    const analysis = analyzeFileDocumentation(
      ast.root,
      filePath,
      sourceCode ?? '',
      finalConfig
    );
    allMetrics.push(analysis.metrics);
    return analysis.violations;
  };
}

/**
 * Run the documentation analyzer across the given files.
 *
 * @param files Source file paths to analyze.
 * @param config Documentation analyzer configuration overrides.
 * @param options Audit options (progress reporting, project root, etc.).
 * @param progressCallback Optional progress callback invoked per file.
 * @returns The documentation analyzer result with violations and metrics.
 */
export async function analyzeDocumentation(
  files: string[],
  config: Partial<DocumentationAnalyzerConfig> = {},
  options: AuditOptions = {},
  progressCallback?: ProgressCallback
): Promise<AnalyzerResult> {
  const finalConfig = { ...DEFAULT_DOCUMENTATION_CONFIG, ...config };
  const startTime = Date.now();

  const filteredFiles = files.filter(file =>
    !finalConfig.exemptPatterns.some(pattern =>
      new RegExp(pattern, 'i').test(file)
    )
  );

  const progressReporter = progressCallback ? (current: number, total: number, file: string) => {
    progressCallback({ current, total, analyzer: 'documentation', file });
  } : undefined;

  const allMetrics: Partial<DocumentationMetrics>[] = [];
  const perFileAnalyzer = makePerFileAnalyzer(allMetrics, finalConfig);

  const result = await processFiles(
    filteredFiles,
    perFileAnalyzer,
    'documentation',
    { config: finalConfig, progressReporter }
  );

  const aggregatedMetrics = aggregateDocumentationMetrics(allMetrics, filteredFiles);

  return {
    violations: result.violations,
    status: makeVisitorStatus(getFilesProcessed(result.status)),
    executionTime: Date.now() - startTime,
    errors: result.errors,
    analyzerName: 'documentation',
    metrics: aggregatedMetrics as unknown as Record<string, unknown>
  };
}

