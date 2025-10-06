/**
 * Documentation Quality Analyzer
 * Assesses JSDoc coverage and documentation quality across the codebase
 */

import * as ts from 'typescript';
import { promises as fs } from 'fs';
import { 
  Violation, 
  AnalyzerDefinition, 
  AnalyzerResult,
  AuditOptions,
  ProgressCallback
} from '../types.js';
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
    'test', 'spec', '\.d\.ts$', 'mock', 'fixture'
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

/**
 * Extracts JSDoc comment for a node
 */
function getJSDoc(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const jsDocTags = ts.getJSDocTags(node);
  const jsDocComments = ts.getJSDocCommentsAndTags(node);
  
  if (jsDocComments.length > 0) {
    const comment = jsDocComments[0];
    if (ts.isJSDoc(comment)) {
      return comment.comment ? ts.getTextOfJSDocComment(comment.comment) || '' : '';
    }
  }
  
  // Fallback: look for leading comments
  const fullText = sourceFile.getFullText();
  const leadingComments = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  
  if (leadingComments) {
    for (const comment of leadingComments) {
      const commentText = fullText.substring(comment.pos, comment.end);
      if (commentText.includes('/**')) {
        return commentText.replace(/\/\*\*|\*\/|\s*\*/g, '').trim();
      }
    }
  }
  
  return null;
}

/**
 * Checks if a node is exported
 */
function isExported(node: ts.Node): boolean {
  if ('modifiers' in node && node.modifiers) {
    return (node.modifiers as ts.NodeArray<ts.ModifierLike>).some(modifier => 
      modifier.kind === ts.SyntaxKind.ExportKeyword
    );
  }
  return false;
}

/**
 * Extracts file-level purpose comment
 */
function getFilePurpose(sourceFile: ts.SourceFile): string | null {
  const fullText = sourceFile.getFullText();
  const leadingComments = ts.getLeadingCommentRanges(fullText, 0);
  
  if (leadingComments) {
    for (const comment of leadingComments) {
      const commentText = fullText.substring(comment.pos, comment.end);
      if (commentText.includes('@fileoverview') || commentText.includes('@purpose')) {
        return commentText.replace(/\/\*\*|\*\/|\s*\*/g, '').trim();
      }
    }
  }
  
  return null;
}

/**
 * Analyzes JSDoc parameters documentation
 */
function analyzeParamDocumentation(node: ts.FunctionLikeDeclaration): {
  totalParams: number;
  documentedParams: number;
} {
  const parameters = node.parameters || [];
  const jsDocTags = ts.getJSDocTags(node);
  const paramTags = jsDocTags.filter(tag => tag.tagName.text === 'param');
  
  return {
    totalParams: parameters.length,
    documentedParams: paramTags.length
  };
}

/**
 * Checks if function has return documentation
 */
function hasReturnDocumentation(node: ts.FunctionLikeDeclaration): boolean {
  const jsDocTags = ts.getJSDocTags(node);
  return jsDocTags.some(tag => 
    tag.tagName.text === 'returns' || tag.tagName.text === 'return'
  );
}

/**
 * Analyzes a single file for documentation quality
 */
function analyzeFileDocumentation(
  sourceFile: ts.SourceFile,
  config: DocumentationAnalyzerConfig
): {
  violations: Violation[];
  metrics: Partial<DocumentationMetrics>;
} {
  const violations: Violation[] = [];
  const fileName = sourceFile.fileName;
  
  let totalFunctions = 0;
  let documentedFunctions = 0;
  let totalComponents = 0;
  let documentedComponents = 0;
  let functionsWithParams = 0;
  let paramsDocumented = 0;
  let functionsWithReturns = 0;
  let returnsDocumented = 0;

  // Check file-level documentation
  const filePurpose = getFilePurpose(sourceFile);
  const hasFileDocs = !!filePurpose;
  
  if (config.requireFileDocs && !hasFileDocs) {
    violations.push({
      file: fileName,
      line: 1,
      column: 1,
      severity: 'suggestion',
      message: 'File missing purpose documentation',
      details: 'Consider adding @fileoverview or @purpose comment at the top of the file',
      suggestion: 'Add file-level documentation explaining the module\'s purpose'
    });
  }

  // Analyze functions and components
  ts.forEachChild(sourceFile, function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) || 
        ts.isFunctionExpression(node) || 
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) {
      
      totalFunctions++;
      
      const isExportedNode = isExported(node);
      const shouldCheck = !config.checkExportedOnly || isExportedNode;
      
      if (shouldCheck) {
        const jsDoc = getJSDoc(node, sourceFile);
        const hasGoodDoc = jsDoc && jsDoc.length >= config.minDescriptionLength;
        
        if (hasGoodDoc) {
          documentedFunctions++;
        } else if (config.requireFunctionDocs) {
          const functionName = getNodeName(node) || 'anonymous function';
          const position = getNodePosition(sourceFile, node);
          
          violations.push({
            file: fileName,
            line: position.line,
            column: position.column,
            severity: 'suggestion',
            message: `Function '${functionName}' lacks documentation`,
            details: 'Functions should have JSDoc comments describing their purpose',
            suggestion: 'Add JSDoc comment with function description and parameter/return documentation'
          });
        }
        
        // Check parameter documentation
        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
          const paramAnalysis = analyzeParamDocumentation(node);
          if (paramAnalysis.totalParams > 0) {
            functionsWithParams++;
            if (paramAnalysis.documentedParams === paramAnalysis.totalParams) {
              paramsDocumented++;
            } else if (config.requireParamDocs && hasGoodDoc) {
              const functionName = getNodeName(node) || 'function';
              const position = getNodePosition(sourceFile, node);
              
              violations.push({
                file: fileName,
                line: position.line,
                column: position.column,
                severity: 'suggestion',
                message: `Function '${functionName}' has undocumented parameters`,
                details: `${paramAnalysis.documentedParams}/${paramAnalysis.totalParams} parameters documented`,
                suggestion: 'Add @param tags for all function parameters'
              });
            }
          }
          
          // Check return documentation
          const hasReturn = node.type || 
            (ts.isFunctionDeclaration(node) && node.body && 
             findNodesOfType(node.body, ts.isReturnStatement).length > 0);
          
          if (hasReturn) {
            functionsWithReturns++;
            if (hasReturnDocumentation(node)) {
              returnsDocumented++;
            } else if (config.requireReturnDocs && hasGoodDoc) {
              const functionName = getNodeName(node) || 'function';
              const position = getNodePosition(sourceFile, node);
              
              violations.push({
                file: fileName,
                line: position.line,
                column: position.column,
                severity: 'suggestion',
                message: `Function '${functionName}' missing return documentation`,
                details: 'Functions with return values should document what they return',
                suggestion: 'Add @returns tag describing the return value'
              });
            }
          }
        }
      }
    }
    
    // Check React components
    if (isReactComponent(node)) {
      totalComponents++;
      
      const isExportedComponent = isExported(node);
      const shouldCheck = !config.checkExportedOnly || isExportedComponent;
      
      if (shouldCheck) {
        const jsDoc = getJSDoc(node, sourceFile);
        const hasGoodDoc = jsDoc && jsDoc.length >= config.minDescriptionLength;
        
        if (hasGoodDoc) {
          documentedComponents++;
        } else if (config.requireComponentDocs) {
          const componentName = getComponentName(node) || 'Component';
          const position = getNodePosition(sourceFile, node);
          
          violations.push({
            file: fileName,
            line: position.line,
            column: position.column,
            severity: 'suggestion',
            message: `Component '${componentName}' lacks documentation`,
            details: 'React components should have JSDoc comments describing their purpose and props',
            suggestion: 'Add JSDoc comment with component description and @param tags for props'
          });
        }
      }
    }
    
    ts.forEachChild(node, visit);
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

/**
 * Main documentation analyzer function
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

  const result = await processFiles(
    filteredFiles,
    (filePath, sourceFile, config) => analyzeFileDocumentation(sourceFile, finalConfig).violations,
    'documentation',
    finalConfig,
    progressReporter
  );

  // Get metrics separately by re-running the analysis (not ideal but works for now)
  const metricsResults = await Promise.all(
    filteredFiles.map(async (file) => {
      const sourceFile = ts.createSourceFile(
        file,
        await fs.readFile(file, 'utf-8'),
        ts.ScriptTarget.Latest,
        true
      );
      return analyzeFileDocumentation(sourceFile, finalConfig).metrics;
    })
  );

  // Aggregate metrics
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
  metricsResults.forEach((fileMetrics) => {
    if (fileMetrics) {
      Object.keys(fileMetrics).forEach(key => {
        if (typeof aggregatedMetrics[key as keyof DocumentationMetrics] === 'number' && 
            typeof fileMetrics[key] === 'number') {
          (aggregatedMetrics as any)[key] += fileMetrics[key];
        }
      });
    }
  });

  // Calculate coverage score
  const totalItems = aggregatedMetrics.totalFunctions + aggregatedMetrics.totalComponents + aggregatedMetrics.totalFiles;
  const documentedItems = aggregatedMetrics.documentedFunctions + aggregatedMetrics.documentedComponents + aggregatedMetrics.filesWithPurpose;
  aggregatedMetrics.coverageScore = totalItems > 0 ? Math.round((documentedItems / totalItems) * 100) : 100;

  // Identify well/poorly documented files
  filteredFiles.forEach((file, index) => {
    const fileMetrics = metricsResults[index];
    if (fileMetrics) {
      const fileTotal = (fileMetrics.totalFunctions || 0) + (fileMetrics.totalComponents || 0) + 1;
      const fileDocumented = (fileMetrics.documentedFunctions || 0) + (fileMetrics.documentedComponents || 0) + (fileMetrics.filesWithPurpose || 0);
      const fileCoverage = fileTotal > 0 ? (fileDocumented / fileTotal) : 0;
      
      if (fileCoverage >= 0.8) {
        aggregatedMetrics.wellDocumentedFiles.push(file);
      } else if (fileCoverage < 0.3) {
        aggregatedMetrics.poorlyDocumentedFiles.push(file);
      }
    }
  });

  return {
    violations: result.violations,
    filesProcessed: result.filesProcessed,
    executionTime: Date.now() - startTime,
    errors: result.errors,
    analyzerName: 'documentation',
    metrics: aggregatedMetrics
  };
}

/**
 * Documentation analyzer definition for the registry
 */
export const documentationAnalyzer: AnalyzerDefinition = {
  name: 'documentation',
  analyze: analyzeDocumentation,
  description: 'Analyzes JSDoc coverage and documentation quality',
  category: 'quality'
};