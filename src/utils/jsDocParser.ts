/**
 * JSDoc Parser Utilities
 * Extracts JSDoc documentation from tree-sitter AST nodes
 *
 * ## Migration: TypeScript Compiler API → tree-sitter
 *
 * Tree-sitter treats comments as real grammar nodes (`comment` type). JSDoc content
 * (@tags, descriptions) is parsed textually from comment text — the same effective
 * approach the TS API used (it walked JSDoc trivia). One path, no fallback.
 *
 * All `ts.Node`/`ts.SourceFile`/`ts.JSDoc`/`ts.JSDocTag` usage replaced with
 * tree-sitter `ASTNode` + plain-text parsing of comment content.
 */

import type { ASTNode } from '../languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { EnhancedFunctionMetadata } from '../types.js';

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
// Types
// ---------------------------------------------------------------------------

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
 * Parsed JSDoc tag from comment text
 */
interface ParsedTag {
  tagName: string;
  type?: string;
  name?: string;
  description?: string;
  isOptional?: boolean;
  defaultValue?: string;
}

// ---------------------------------------------------------------------------
// Comment location & text parsing
// ---------------------------------------------------------------------------

/**
 * Find JSDoc comments that immediately precede a node.
 * In tree-sitter, comments are `comment` type sibling nodes in the parent's children array.
 */
function getPrecedingComments(node: ASTNode): ASTNode[] {
  const parent = node.parent;
  if (!parent || !parent.children) return [];

  const nodeIndex = parent.children.indexOf(node);
  if (nodeIndex <= 0) return [];

  const comments: ASTNode[] = [];
  // Walk backwards through siblings to collect consecutive comment nodes
  for (let i = nodeIndex - 1; i >= 0; i--) {
    const sibling = parent.children![i];
    if (sibling.type === 'comment') {
      comments.unshift(sibling);
    } else {
      break; // Stop when we hit a non-comment sibling
    }
  }

  return comments;
}

/**
 * Clean JSDoc comment text by stripping delimiters and leading asterisks.
 * e.g., "/**\n * Description\n * @param x\n *\/" → "Description\n@param x"
 */
function cleanCommentText(raw: string): string {
  // Remove /** and */
  let text = raw
    .replace(/^\/\*\*?\s*/, '')  // Remove opening /** or /*
    .replace(/\s*\*\/\s*$/, '');  // Remove closing */
  // Remove leading * from each line
  text = text
    .split('\n')
    .map(line => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
  return text;
}

/**
 * Parse JSDoc tags from cleaned comment text.
 * Extracts all @tag annotations and the description text before the first tag.
 */
function parseJSDocTags(commentText: string): {
  description?: string;
  tags: ParsedTag[];
} {
  const tags: ParsedTag[] = [];
  let description: string | undefined;

  // Split by @tag markers. Each match captures: the tag name, and the content until next @tag or end.
  const tagRegex = /@(\w+)([\s\S]*?)(?=@\w+\s|$)/g;
  const tagMatches: Array<{ tagName: string; content: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(commentText)) !== null) {
    tagMatches.push({
      tagName: match[1].toLowerCase(),
      content: match[2].trim(),
    });
  }

  // Extract description: everything before the first @tag
  const firstTagIndex = commentText.search(/@\w+\s/);
  if (firstTagIndex >= 0) {
    const descText = commentText.substring(0, firstTagIndex).trim();
    if (descText) description = descText;
  } else {
    // No tags at all — the entire comment is the description
    if (commentText.trim()) description = commentText.trim();
  }

  // Parse each tag
  for (const tm of tagMatches) {
    tags.push(parseTag(tm.tagName, tm.content));
  }

  return { description, tags };
}

/**
 * Parse a single tag's content into a ParsedTag.
 */
function parseTag(tagName: string, content: string): ParsedTag {
  const tag: ParsedTag = { tagName };

  switch (tagName) {
    case 'param':
    case 'parameter': {
      // @param {Type} [name=default] Description
      const paramMatch = content.match(
        /^\s*(?:\{([^}]+)\}\s*)?(?:\[\s*(\w+)\s*(?:=\s*([^\]]+))?\s*\]|(\w+))?\s*(.*)$/s
      );
      if (paramMatch) {
        tag.type = paramMatch[1];
        tag.isOptional = !!paramMatch[2];
        tag.name = paramMatch[2] || paramMatch[4];
        tag.defaultValue = paramMatch[3];
        tag.description = paramMatch[5]?.trim() || undefined;
      }
      break;
    }
    case 'returns':
    case 'return': {
      // @returns {Type} Description
      const retMatch = content.match(/^\s*(?:\{([^}]+)\}\s*)?([\s\S]*)$/);
      if (retMatch) {
        tag.type = retMatch[1];
        tag.description = retMatch[2]?.trim() || undefined;
      }
      break;
    }
    case 'throws':
    case 'throw':
    case 'exception': {
      // @throws {Type} Description
      const throwsMatch = content.match(/^\s*(?:\{([^}]+)\}\s*)?([\s\S]*)$/);
      if (throwsMatch) {
        tag.type = throwsMatch[1];
        tag.description = throwsMatch[2]?.trim() || undefined;
      }
      break;
    }
    case 'example': {
      tag.description = content.trim() || undefined;
      break;
    }
    default: {
      // Generic tag: @deprecated Description, @since 1.0, etc.
      tag.description = content.trim() || undefined;
      break;
    }
  }

  return tag;
}

// ---------------------------------------------------------------------------
// Public API — JSDoc extraction
// ---------------------------------------------------------------------------

/**
 * Extract JSDoc information from a tree-sitter AST node.
 * @param node The AST node to extract JSDoc from
 * @returns Extracted JSDoc information
 */
export function extractJSDoc(node: ASTNode): JSDocInfo {
  const jsDocInfo: JSDocInfo = {
    tags: {}
  };

  // Find JSDoc comments preceding the node
  const comments = getPrecedingComments(node);
  if (comments.length === 0) return jsDocInfo;

  // Process each comment's text
  for (const comment of comments) {
    const commentText = rawText(comment);
    if (!commentText) continue;

    // Only process JSDoc-style comments (/** ... */)
    if (!commentText.startsWith('/**')) continue;

    const cleaned = cleanCommentText(commentText);
    if (!cleaned) continue;

    const { description, tags } = parseJSDocTags(cleaned);

    if (description && !jsDocInfo.description) {
      jsDocInfo.description = description;
    }

    for (const tag of tags) {
      applyParsedTag(tag, jsDocInfo);
    }
  }

  return jsDocInfo;
}

/**
 * Apply a parsed tag to the JSDocInfo object.
 */
function applyParsedTag(tag: ParsedTag, jsDocInfo: JSDocInfo): void {
  switch (tag.tagName) {
    case 'param':
    case 'parameter':
      if (!jsDocInfo.params) jsDocInfo.params = [];
      jsDocInfo.params.push({
        name: tag.name || 'unknown',
        type: tag.type,
        description: tag.description,
        optional: tag.isOptional,
        defaultValue: tag.defaultValue,
      });
      break;

    case 'returns':
    case 'return':
      jsDocInfo.returns = {
        type: tag.type,
        description: tag.description,
      };
      break;

    case 'throws':
    case 'throw':
    case 'exception':
      if (!jsDocInfo.throws) jsDocInfo.throws = [];
      jsDocInfo.throws.push({
        type: tag.type,
        description: tag.description,
      });
      break;

    case 'example':
      if (!jsDocInfo.examples) jsDocInfo.examples = [];
      if (tag.description) {
        jsDocInfo.examples.push(tag.description);
      }
      break;

    default:
      if (!jsDocInfo.tags) jsDocInfo.tags = {};
      if (!jsDocInfo.tags[tag.tagName]) {
        jsDocInfo.tags[tag.tagName] = [];
      }
      jsDocInfo.tags[tag.tagName].push(tag.description || '');
      break;
  }
}

// ---------------------------------------------------------------------------
// Public API — function-level JSDoc
// ---------------------------------------------------------------------------

/**
 * Extract JSDoc for function-like declarations.
 * @param node Function declaration, method definition, or arrow function AST node
 * @returns JSDoc information formatted for EnhancedFunctionMetadata
 */
export function extractFunctionJSDoc(
  node: ASTNode
): EnhancedFunctionMetadata['jsDoc'] {
  // Also check the parent for JSDoc that might be attached to a variable declarator
  // (e.g., const x = () => {} where JSDoc is above the variable statement)
  let jsDocInfo = extractJSDoc(node);

  // If no JSDoc found directly, check parent (for variable declarations with JSDoc)
  if (!jsDocInfo.description && !jsDocInfo.params?.length && !jsDocInfo.returns &&
      node.parent && (node.parent.type === 'variable_declarator' ||
        node.parent.type === 'lexical_declaration' || node.parent.type === 'variable_declaration')) {
    jsDocInfo = extractJSDoc(node.parent);
  }

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
 * Extract parameter information including JSDoc.
 * @param node Function-like declaration AST node
 * @returns Array of parameter information
 */
export function extractParameters(
  node: ASTNode
): EnhancedFunctionMetadata['parameters'] {
  const jsDocInfo = extractJSDoc(node);
  const parameters: EnhancedFunctionMetadata['parameters'] = [];

  // Extract parameters from formal_parameters child
  const formalParams = findChildOfType(node, 'formal_parameters');
  const paramNodes = formalParams?.children?.filter(c =>
    c.type === 'required_parameter' || c.type === 'optional_parameter' || c.type === 'rest_parameter'
  ) ?? [];

  for (const param of paramNodes) {
    // Find the parameter name (first identifier or rest_pattern child)
    let nameNode: ASTNode | undefined;
    if (param.type === 'rest_parameter') {
      // rest_parameter: ['...', identifier]
      nameNode = param.children?.find(c => c.type === 'identifier');
    } else {
      // required_parameter / optional_parameter: [identifier] or [identifier, ':', type]
      nameNode = param.children?.find(c => c.type === 'identifier');
    }
    if (!nameNode) continue;

    const paramName = rawText(nameNode);

    // Check for optional (has '?' token)
    let isOptional = param.type === 'optional_parameter';

    // Check for initializer (default value) — parameter has '=' child followed by value
    let defaultValue: string | undefined;
    const eqIndex = param.children?.findIndex(c => c.type === '=');
    if (eqIndex !== undefined && eqIndex >= 0) {
      const defaultNode = param.children![eqIndex + 1];
      if (defaultNode) {
        defaultValue = rawText(defaultNode);
        isOptional = true;
      }
    }

    const paramInfo: EnhancedFunctionMetadata['parameters'][0] = {
      name: paramName,
      optional: isOptional,
    };

    // Get type annotation
    const typeAnnot = findChildOfType(param, 'type_annotation');
    if (typeAnnot) {
      paramInfo.type = rawText(typeAnnot).replace(/^:\s*/, '').trim();
    }

    if (defaultValue) {
      paramInfo.defaultValue = defaultValue;
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
 * Extract return type information including JSDoc.
 * @param node Function-like declaration AST node
 * @returns Return type string or undefined
 */
export function extractReturnType(node: ASTNode): string | undefined {
  // First try to get the TypeScript return type annotation
  const typeAnnot = findChildOfType(node, 'type_annotation');
  if (typeAnnot) {
    return rawText(typeAnnot).replace(/^:\s*/, '').trim();
  }

  // Fall back to JSDoc return type
  const jsDocInfo = extractJSDoc(node);
  if (jsDocInfo.returns?.type) {
    return jsDocInfo.returns.type;
  }

  return undefined;
}

/**
 * Check if a function has JSDoc documentation.
 * @param node The AST node
 * @returns True if the function has JSDoc
 */
export function hasJSDoc(node: ASTNode): boolean {
  const comments = getPrecedingComments(node);
  return comments.some(c => rawText(c).startsWith('/**'));
}

/**
 * Extract all JSDoc tags from a node.
 * @param node The AST node
 * @returns Map of tag names to their values
 */
export function extractAllJSDocTags(node: ASTNode): Record<string, string[]> {
  const jsDocInfo = extractJSDoc(node);
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
 * Create a searchable text representation of JSDoc.
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
