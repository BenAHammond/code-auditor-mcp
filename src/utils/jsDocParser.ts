/**
 * JSDoc Parser Utilities
 * Extracts JSDoc documentation from TypeScript AST nodes
 * 
 * Provides comprehensive extraction of JSDoc comments including:
 * - Description
 * - Parameters (@param)
 * - Return values (@returns, @return)
 * - Thrown exceptions (@throws)
 * - Examples (@example)
 * - Other tags (deprecated, since, see, etc.)
 */

import * as ts from 'typescript';
import { EnhancedFunctionMetadata } from '../types.js';

/**
 * JSDoc information extracted from a node
 */
export interface JSDocInfo {
  description?: string;
  examples?: string[];
  tags?: Record<string, string[]>;
  params?: Array<{
    name: string;
    type?: string;
    description?: string;
    optional?: boolean;
    defaultValue?: string;
  }>;
  returns?: {
    type?: string;
    description?: string;
  };
  throws?: Array<{
    type?: string;
    description?: string;
  }>;
}

/**
 * Extract JSDoc information from a TypeScript node
 * @param node The AST node to extract JSDoc from
 * @param sourceFile The source file containing the node
 * @returns Extracted JSDoc information
 */
export function extractJSDoc(node: ts.Node, sourceFile: ts.SourceFile): JSDocInfo {
  const jsDocInfo: JSDocInfo = {
    tags: {}
  };

  // Get JSDoc comments attached to the node
  const jsDocComments = getJSDocComments(node);
  
  if (jsDocComments.length === 0) {
    return jsDocInfo;
  }

  // Process each JSDoc comment
  for (const jsDoc of jsDocComments) {
    // Extract description
    const description = extractDescription(jsDoc);
    if (description && !jsDocInfo.description) {
      jsDocInfo.description = description;
    }

    // Extract tags
    if (jsDoc.tags) {
      for (const tag of jsDoc.tags) {
        processJSDocTag(tag, jsDocInfo);
      }
    }
  }

  return jsDocInfo;
}

/**
 * Get JSDoc comments from a node
 */
function getJSDocComments(node: ts.Node): ts.JSDoc[] {
  const jsDocNodes: ts.JSDoc[] = [];
  
  // TypeScript provides JSDoc comments through the node
  const jsDocComments = (node as any).jsDoc;
  if (jsDocComments && Array.isArray(jsDocComments)) {
    jsDocNodes.push(...jsDocComments);
  }

  // Alternative method using ts.getJSDocCommentsAndTags
  const commentsAndTags = ts.getJSDocCommentsAndTags(node);
  for (const item of commentsAndTags) {
    if (ts.isJSDoc(item)) {
      jsDocNodes.push(item);
    }
  }

  return jsDocNodes;
}

/**
 * Extract description from JSDoc
 */
function extractDescription(jsDoc: ts.JSDoc): string | undefined {
  if (jsDoc.comment) {
    if (typeof jsDoc.comment === 'string') {
      return jsDoc.comment.trim();
    } else if (Array.isArray(jsDoc.comment)) {
      // Handle NodeArray<JSDocComment>
      return jsDoc.comment.map(c => 
        typeof c === 'string' ? c : c.getText?.() || ''
      ).join('').trim();
    }
  }
  return undefined;
}

/**
 * Process a JSDoc tag and add information to the JSDocInfo object
 */
function processJSDocTag(tag: ts.JSDocTag, jsDocInfo: JSDocInfo): void {
  const tagName = tag.tagName.text.toLowerCase();

  switch (tagName) {
    case 'param':
    case 'parameter':
      processParamTag(tag as ts.JSDocParameterTag, jsDocInfo);
      break;
    
    case 'returns':
    case 'return':
      processReturnTag(tag as ts.JSDocReturnTag, jsDocInfo);
      break;
    
    case 'throws':
    case 'throw':
    case 'exception':
      processThrowsTag(tag as ts.JSDocThrowsTag, jsDocInfo);
      break;
    
    case 'example':
      processExampleTag(tag, jsDocInfo);
      break;
    
    default:
      // Store other tags generically
      processGenericTag(tag, jsDocInfo);
      break;
  }
}

/**
 * Process @param tag
 */
function processParamTag(tag: ts.JSDocParameterTag, jsDocInfo: JSDocInfo): void {
  if (!jsDocInfo.params) {
    jsDocInfo.params = [];
  }

  const param: JSDocInfo['params'][0] = {
    name: tag.name.getText(),
    optional: tag.isBracketed || false
  };

  // Extract type if available
  if (tag.typeExpression) {
    param.type = tag.typeExpression.type.getText();
  }

  // Extract description
  if (tag.comment) {
    param.description = extractTagComment(tag.comment);
  }

  // Check for default value in description (common pattern: @param {type} [name=default])
  const nameText = tag.name.getText();
  if (nameText.includes('=')) {
    const [name, defaultValue] = nameText.split('=');
    param.name = name.trim();
    param.defaultValue = defaultValue.trim();
    param.optional = true;
  }

  jsDocInfo.params.push(param);
}

/**
 * Process @returns tag
 */
function processReturnTag(tag: ts.JSDocReturnTag, jsDocInfo: JSDocInfo): void {
  if (!jsDocInfo.returns) {
    jsDocInfo.returns = {};
  }

  // Extract type if available
  if (tag.typeExpression) {
    jsDocInfo.returns.type = tag.typeExpression.type.getText();
  }

  // Extract description
  if (tag.comment) {
    jsDocInfo.returns.description = extractTagComment(tag.comment);
  }
}

/**
 * Process @throws tag
 */
function processThrowsTag(tag: ts.JSDocThrowsTag, jsDocInfo: JSDocInfo): void {
  if (!jsDocInfo.throws) {
    jsDocInfo.throws = [];
  }

  const throwsInfo: JSDocInfo['throws'][0] = {};

  // Extract type if available
  if (tag.typeExpression) {
    throwsInfo.type = tag.typeExpression.type.getText();
  }

  // Extract description
  if (tag.comment) {
    throwsInfo.description = extractTagComment(tag.comment);
  }

  jsDocInfo.throws.push(throwsInfo);
}

/**
 * Process @example tag
 */
function processExampleTag(tag: ts.JSDocTag, jsDocInfo: JSDocInfo): void {
  if (!jsDocInfo.examples) {
    jsDocInfo.examples = [];
  }

  if (tag.comment) {
    const example = extractTagComment(tag.comment);
    if (example) {
      jsDocInfo.examples.push(example);
    }
  }
}

/**
 * Process generic tags (deprecated, since, see, etc.)
 */
function processGenericTag(tag: ts.JSDocTag, jsDocInfo: JSDocInfo): void {
  const tagName = tag.tagName.text.toLowerCase();
  
  if (!jsDocInfo.tags[tagName]) {
    jsDocInfo.tags[tagName] = [];
  }

  if (tag.comment) {
    const comment = extractTagComment(tag.comment);
    if (comment) {
      jsDocInfo.tags[tagName].push(comment);
    }
  } else {
    // Some tags don't have comments (e.g., @deprecated without description)
    jsDocInfo.tags[tagName].push('');
  }
}

/**
 * Extract comment text from JSDoc comment
 */
function extractTagComment(comment: string | ts.NodeArray<ts.JSDocComment>): string {
  if (typeof comment === 'string') {
    return comment.trim();
  } else if (Array.isArray(comment)) {
    return comment.map(c => 
      typeof c === 'string' ? c : c.getText?.() || ''
    ).join('').trim();
  }
  return '';
}

/**
 * Extract JSDoc for function-like declarations
 * @param node Function declaration, method declaration, or arrow function
 * @param sourceFile The source file containing the node
 * @returns JSDoc information formatted for EnhancedFunctionMetadata
 */
export function extractFunctionJSDoc(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile
): EnhancedFunctionMetadata['jsDoc'] {
  const jsDocInfo = extractJSDoc(node, sourceFile);
  
  // Convert to EnhancedFunctionMetadata format
  const result: EnhancedFunctionMetadata['jsDoc'] = {};

  if (jsDocInfo.description) {
    result.description = jsDocInfo.description;
  }

  if (jsDocInfo.examples && jsDocInfo.examples.length > 0) {
    result.examples = jsDocInfo.examples;
  }

  if (jsDocInfo.tags && Object.keys(jsDocInfo.tags).length > 0) {
    result.tags = jsDocInfo.tags;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Extract parameter information including JSDoc
 * @param node Function-like declaration
 * @param sourceFile The source file containing the node
 * @returns Array of parameter information
 */
export function extractParameters(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile
): EnhancedFunctionMetadata['parameters'] {
  const jsDocInfo = extractJSDoc(node, sourceFile);
  const parameters: EnhancedFunctionMetadata['parameters'] = [];

  // Extract parameters from the function signature
  for (const param of node.parameters) {
    const paramName = param.name.getText(sourceFile);
    const paramInfo: EnhancedFunctionMetadata['parameters'][0] = {
      name: paramName,
      optional: !!param.questionToken || !!param.initializer
    };

    // Get type from TypeScript
    if (param.type) {
      paramInfo.type = param.type.getText(sourceFile);
    }

    // Get default value
    if (param.initializer) {
      paramInfo.defaultValue = param.initializer.getText(sourceFile);
    }

    // Find matching JSDoc param
    const jsDocParam = jsDocInfo.params?.find(p => p.name === paramName);
    if (jsDocParam) {
      if (jsDocParam.description) {
        paramInfo.description = jsDocParam.description;
      }
      // JSDoc type takes precedence if TypeScript type is not available
      if (!paramInfo.type && jsDocParam.type) {
        paramInfo.type = jsDocParam.type;
      }
      if (jsDocParam.defaultValue) {
        paramInfo.defaultValue = jsDocParam.defaultValue;
      }
    }

    parameters.push(paramInfo);
  }

  // Add any JSDoc params that aren't in the signature (e.g., for JavaScript files)
  if (jsDocInfo.params) {
    for (const jsDocParam of jsDocInfo.params) {
      if (!parameters.find(p => p.name === jsDocParam.name)) {
        parameters.push({
          name: jsDocParam.name,
          type: jsDocParam.type,
          description: jsDocParam.description,
          optional: jsDocParam.optional,
          defaultValue: jsDocParam.defaultValue
        });
      }
    }
  }

  return parameters;
}

/**
 * Extract return type information including JSDoc
 * @param node Function-like declaration
 * @param sourceFile The source file containing the node  
 * @returns Return type string or undefined
 */
export function extractReturnType(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile
): string | undefined {
  // First try to get the TypeScript return type
  if (node.type) {
    return node.type.getText(sourceFile);
  }

  // Fall back to JSDoc return type
  const jsDocInfo = extractJSDoc(node, sourceFile);
  if (jsDocInfo.returns?.type) {
    return jsDocInfo.returns.type;
  }

  return undefined;
}

/**
 * Check if a function has JSDoc documentation
 * @param node Function-like declaration
 * @returns True if the function has JSDoc
 */
export function hasJSDoc(node: ts.Node): boolean {
  const jsDocComments = getJSDocComments(node);
  return jsDocComments.length > 0;
}

/**
 * Extract all JSDoc tags from a node
 * @param node The AST node
 * @returns Map of tag names to their values
 */
export function extractAllJSDocTags(node: ts.Node): Record<string, string[]> {
  const jsDocInfo = extractJSDoc(node, node.getSourceFile());
  const allTags: Record<string, string[]> = { ...jsDocInfo.tags };

  // Add structured tags to the result
  if (jsDocInfo.params && jsDocInfo.params.length > 0) {
    allTags.param = jsDocInfo.params.map(p => 
      `${p.name}${p.type ? ` {${p.type}}` : ''}${p.description ? ` - ${p.description}` : ''}`
    );
  }

  if (jsDocInfo.returns) {
    allTags.returns = [
      `${jsDocInfo.returns.type || ''}${jsDocInfo.returns.description ? ` - ${jsDocInfo.returns.description}` : ''}`.trim()
    ];
  }

  if (jsDocInfo.throws && jsDocInfo.throws.length > 0) {
    allTags.throws = jsDocInfo.throws.map(t => 
      `${t.type || ''}${t.description ? ` - ${t.description}` : ''}`.trim()
    );
  }

  if (jsDocInfo.examples && jsDocInfo.examples.length > 0) {
    allTags.example = jsDocInfo.examples;
  }

  return allTags;
}

/**
 * Create a searchable text representation of JSDoc
 * @param jsDoc JSDoc information
 * @returns Searchable text string
 */
export function createSearchableJSDocText(jsDoc: EnhancedFunctionMetadata['jsDoc']): string {
  if (!jsDoc) return '';

  const parts: string[] = [];

  if (jsDoc.description) {
    parts.push(jsDoc.description);
  }

  if (jsDoc.examples) {
    parts.push(...jsDoc.examples);
  }

  if (jsDoc.tags) {
    for (const [tagName, values] of Object.entries(jsDoc.tags)) {
      parts.push(`@${tagName}`, ...values);
    }
  }

  return parts.join(' ').toLowerCase();
}