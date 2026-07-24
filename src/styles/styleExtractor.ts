/**
 * Style declaration extractor — Spec 10.
 *
 * Extracts normalized declarations from all five style mechanisms:
 *   1. CSS/SCSS files — tree-sitter-css parsed rule sets
 *   2. Tailwind — className/class attributes in JSX/HTML
 *   3. Inline styles — style={{...}} object expressions
 *   4. CSS-in-JS — styled-components / emotion tagged templates
 *   5. Design tokens — CSS custom property definitions
 *
 * Single entry point: extractDeclarations(filePath, adapter, sourceCode, ast?)
 */

import type { AST, LanguageAdapter, ASTNode } from '../languages/types.js';
import type { NormalizedDeclaration, StyleMechanism, StyleToken } from './types.js';
import { normalizeValue, expandShorthand } from './normalizer.js';
import { expandUtility } from './tailwindExpander.js';
import { loadTailwindConfig, tokensToStyleTokens } from './tailwindConfigLoader.js';
import type { TailwindThemeTokens } from './tailwindConfigLoader.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all style declarations from a file.
 *
 * Dispatches to the correct sub-extractor based on file extension.
 * Returns an empty array for files that don't contain styles.
 *
 * @param filePath - Project-relative file path
 * @param adapter - Language adapter for this file
 * @param sourceCode - Raw file content
 * @param ast - Optional pre-parsed AST (avoids re-parsing)
 * @param tailwindTokens - Optional pre-loaded Tailwind tokens (avoids re-loading per file)
 */
export function extractDeclarations(
  filePath: string,
  adapter: LanguageAdapter,
  sourceCode: string,
  ast?: AST,
  tailwindTokens?: TailwindThemeTokens,
): NormalizedDeclaration[] {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';

  switch (ext) {
    case '.css':
      return extractFromCSS(filePath, sourceCode, 'css');
    case '.scss':
      return extractFromCSS(filePath, sourceCode, 'scss');
    case '.tsx':
    case '.jsx':
    case '.ts':
    case '.js':
      return extractFromTypeScript(filePath, adapter, sourceCode, ast, tailwindTokens);
    case '.html':
    case '.vue':
    case '.svelte':
      // HTML/Vue/Svelte: extract class attributes only (limited support)
      return extractFromHTML(filePath, sourceCode, tailwindTokens);
    default:
      return [];
  }
}

/**
 * Extract CSS custom property definitions from all CSS/SCSS files
 * and produce design tokens.
 */
export function extractTokens(
  filePath: string,
  sourceCode: string,
): StyleToken[] {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
  if (ext !== '.css' && ext !== '.scss') return [];

  const tokens: StyleToken[] = [];
  const varRegex = /--([a-zA-Z0-9_-]+)\s*:\s*([^;};]+)/g;
  let match: RegExpExecArray | null;

  while ((match = varRegex.exec(sourceCode)) !== null) {
    const name = match[1].trim();
    const value = match[2].trim();
    if (name && value) {
      tokens.push({
        name: `--${name}`,
        value,
        filePath,
        mechanism: 'css-custom-property',
      });
    }
  }

  return tokens;
}

/**
 * Load Tailwind tokens, optionally from a cached result.
 */
export function getOrLoadTailwindTokens(
  projectRoot: string,
  existing?: TailwindThemeTokens,
): TailwindThemeTokens {
  if (existing) return existing;
  return loadTailwindConfig(projectRoot).tokens;
}

// ---------------------------------------------------------------------------
// Sub-extractor: CSS / SCSS
// ---------------------------------------------------------------------------

function extractFromCSS(
  filePath: string,
  sourceCode: string,
  mechanism: StyleMechanism,
): NormalizedDeclaration[] {
  const declarations: NormalizedDeclaration[] = [];

  // Extract rule set contents
  // We use regex for extraction because the CSS adapter's AST walk is heavy
  // and we only need declaration extraction, not structural analysis.
  extractRuleSets(sourceCode, filePath, mechanism, declarations);

  return declarations;
}

/**
 * Parse CSS content using regex to extract rule sets and their declarations.
 *
 * This is a pragmatic approach: regex is simpler and faster than full tree-sitter
 * parsing for declaration extraction. The tree-sitter adapter handles structural
 * analysis when needed.
 */
function extractRuleSets(
  css: string,
  filePath: string,
  mechanism: StyleMechanism,
  declarations: NormalizedDeclaration[],
): void {
  // Track current context (selector, at-rule)
  const lines = css.split('\n');

  // Regex approach: find rule blocks with their selectors
  let i = 0;
  let atRuleStack: string[] = [];

  while (i < css.length) {
    // Skip whitespace and comments
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (css[i] === '/' && css[i + 1] === '/') {
      const end = css.indexOf('\n', i);
      if (end === -1) break;
      i = end + 1;
      continue;
    }

    // Detect @-rules
    if (css[i] === '@') {
      const semiIdx = css.indexOf(';', i);
      const braceIdx = css.indexOf('{', i);
      const endIdx = semiIdx !== -1 && semiIdx < (braceIdx !== -1 ? braceIdx : Infinity)
        ? semiIdx : braceIdx;

      if (endIdx !== -1) {
        const atRule = css.slice(i + 1, endIdx).trim().split(/\s+/)[0];
        const afterAt = css.slice(i + 1, endIdx).trim();

        if (braceIdx !== -1 && braceIdx === endIdx) {
          // @media, @supports, @keyframes — has a block
          atRuleStack.push(afterAt);
          i = braceIdx + 1;
        } else {
          // @import, @charset — no block
          i = endIdx + 1;
        }
        continue;
      }
    }

    // Find the start of a rule set: selector { ... }
    const braceOpen = css.indexOf('{', i);
    if (braceOpen === -1) break;

    // Extract the selector (everything between last } and {)
    const selectorStart = findSelectorStart(css, braceOpen);
    const selector = css.slice(selectorStart, braceOpen).trim();

    if (!selector || selector === '}' || selector.startsWith('@')) {
      i = braceOpen + 1;
      continue;
    }

    // Find matching closing brace
    const braceClose = findMatchingBrace(css, braceOpen);
    if (braceClose === -1) {
      i = braceOpen + 1;
      continue;
    }

    // Extract declarations inside this block
    const block = css.slice(braceOpen + 1, braceClose);
    extractDeclarationsFromBlock(
      block,
      filePath,
      mechanism,
      selector,
      atRuleStack.length > 0 ? atRuleStack.join(', ') : null,
      declarations,
      css.slice(0, braceOpen).split('\n').length,
    );

    i = braceClose + 1;
  }
}

function findSelectorStart(css: string, braceOpen: number): number {
  // Walk backwards from braceOpen, skip whitespace
  let i = braceOpen - 1;
  while (i >= 0 && (css[i] === ' ' || css[i] === '\t' || css[i] === '\n' || css[i] === '\r')) {
    i--;
  }
  if (i < 0) return 0;

  // Now find the start of this selector: previous } or start of file
  // Walk backwards finding the start of the line or previous closing brace
  let depth = 0;
  while (i >= 0) {
    if (css[i] === '}') {
      depth++;
      i--;
    } else if (css[i] === '{') {
      depth--;
      if (depth < 0) {
        // We hit an opening brace — selector starts after it
        return i + 1;
      }
      i--;
    } else {
      i--;
    }
  }

  return 0;
}

function findMatchingBrace(css: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;

  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    // Skip strings
    else if (css[i] === '"' || css[i] === "'") {
      const quote = css[i];
      i++;
      while (i < css.length && css[i] !== quote) {
        if (css[i] === '\\') i++;
        i++;
      }
    }
    else if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    i++;
  }

  return depth === 0 ? i - 1 : -1;
}

function extractDeclarationsFromBlock(
  block: string,
  filePath: string,
  mechanism: StyleMechanism,
  selector: string,
  variantContext: string | null,
  declarations: NormalizedDeclaration[],
  baseLine: number,
): void {
  const lines = block.split('\n');

  // Parse each line for property: value; declarations
  let lineInBlock = 0;
  let buffer = '';
  let inComment = false;

  for (const line of lines) {
    lineInBlock++;
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      if (buffer) {
        // Multi-line value continuation
        buffer += ' ';
        continue;
      }
      continue;
    }

    // Handle block comments inside the block
    if (inComment) {
      const end = trimmed.indexOf('*/');
      if (end !== -1) {
        buffer = trimmed.slice(end + 2).trim();
        inComment = false;
      } else {
        continue;
      }
    }

    // Check for comment starts
    const commentStart = trimmed.indexOf('/*');
    if (commentStart !== -1) {
      const before = trimmed.slice(0, commentStart).trim();
      if (before) buffer += (buffer ? ' ' : '') + before;
      const afterComment = trimmed.indexOf('*/', commentStart + 2);
      if (afterComment !== -1) {
        const after = trimmed.slice(afterComment + 2).trim();
        if (after) buffer += (buffer ? ' ' : '') + after;
      } else {
        inComment = true;
        continue;
      }
    }

    buffer += (buffer ? ' ' : '') + trimmed;

    // Check if this buffer contains a complete declaration
    if (buffer.includes(':')) {
      const semiIdx = buffer.indexOf(';');
      if (semiIdx !== -1) {
        const decl = buffer.slice(0, semiIdx).trim();
        const rest = buffer.slice(semiIdx + 1).trim();
        buffer = rest;

        const colonIdx = decl.indexOf(':');
        if (colonIdx !== -1) {
          const property = decl.slice(0, colonIdx).trim();
          const rawValue = decl.slice(colonIdx + 1).trim();

          if (property && rawValue && !property.includes('{') && !rawValue.includes('{')) {
            const normalizedValue = normalizeValue(rawValue, property);

            // Expand shorthands
            const expanded = expandShorthand(property, rawValue, normalizedValue);
            for (const exp of expanded) {
              declarations.push({
                property: exp.property,
                rawValue: exp.rawValue,
                normalizedValue: exp.normalizedValue,
                mechanism,
                filePath,
                line: baseLine + lineInBlock,
                context: selector,
                variantContext,
                tokenRef: rawValue.startsWith('var(--') ? extractTokenRef(rawValue) : null,
              });
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-extractor: TypeScript / JSX
// ---------------------------------------------------------------------------

function extractFromTypeScript(
  filePath: string,
  adapter: LanguageAdapter,
  sourceCode: string,
  ast?: AST,
  tailwindTokens?: TailwindThemeTokens,
): NormalizedDeclaration[] {
  const declarations: NormalizedDeclaration[] = [];
  if (!ast) return declarations;

  // Walk the AST to find style-related nodes
  walkASTNodes(ast.root, (node) => {
    const nodeType = node.type;

    // 1. className/class attributes → Tailwind
    if (extractFromClassName(node, sourceCode, filePath, tailwindTokens, declarations)) return;

    // 2. style={{...}} attributes → Inline styles
    if (extractFromInlineStyle(node, sourceCode, filePath, declarations)) return;

    // 3. styled.div`...` / css`...` → CSS-in-JS
    if (extractFromCSSinJS(node, sourceCode, filePath, declarations)) return;
  });

  return declarations;
}

// ---------------------------------------------------------------------------
// Tailwind (className/class)
// ---------------------------------------------------------------------------

function extractFromClassName(
  node: ASTNode,
  sourceCode: string,
  filePath: string,
  tailwindTokens: TailwindThemeTokens | undefined,
  declarations: NormalizedDeclaration[],
): boolean {
  if (node.type !== 'jsx_attribute') return false;

  // Get the attribute name
  const attrName = getJSXAttributeName(node, sourceCode);
  if (!attrName || !['className', 'class', 'classname'].includes(attrName)) return false;

  // Get the attribute value
  const valueNode = findChildByType(node, 'string');
  if (valueNode) {
    // Static string: className="flex bg-red-500"
    let rawValue = sourceCode.slice(valueNode.range[0], valueNode.range[1]);
    // Strip quotes
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
      rawValue = rawValue.slice(1, -1);
    }

    const classNames = rawValue.split(/\s+/).filter(Boolean);
    const line = getLine(sourceCode, valueNode.range[0]);

    if (tailwindTokens) {
      for (const className of classNames) {
        const expanded = expandUtility(className, tailwindTokens, filePath, line);
        declarations.push(...expanded);
      }
    } else {
      // Without tokens, record class usage for later token resolution
      for (const className of classNames) {
        declarations.push({
          property: 'class',
          rawValue: className,
          normalizedValue: { type: 'literal', value: className },
          mechanism: 'tailwind',
          filePath,
          line,
          context: null,
          variantContext: null,
          tokenRef: null,
        });
      }
    }
  } else {
    // Dynamic expression: className={clsx(...)} or className={`...`}
    const exprNode = findChildByType(node, 'jsx_expression');
    if (exprNode) {
      const line = getLine(sourceCode, node.range[0]);
      const exprText = sourceCode.slice(exprNode.range[0], exprNode.range[1]);
      const classNames = extractStaticStringsFromExpression(exprText);

      if (tailwindTokens && classNames.length > 0) {
        for (const className of classNames) {
          const expanded = expandUtility(className, tailwindTokens, filePath, line);
          declarations.push(...expanded);
        }
      }

      // Mark as potentially unresolvable (for R3.3 exempt handling)
      if (exprText.includes('clsx') || exprText.includes('classnames') || exprText.includes('`')) {
        // Record the unresolvable marker as a declaration with null normalized value
        declarations.push({
          property: 'class',
          rawValue: exprText.length > 80 ? exprText.slice(0, 77) + '...' : exprText,
          normalizedValue: null,
          mechanism: 'tailwind',
          filePath,
          line,
          context: null,
          variantContext: null,
          tokenRef: null,
        });
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Inline styles (style={{...}})
// ---------------------------------------------------------------------------

function extractFromInlineStyle(
  node: ASTNode,
  sourceCode: string,
  filePath: string,
  declarations: NormalizedDeclaration[],
): boolean {
  if (node.type !== 'jsx_attribute') return false;

  const attrName = getJSXAttributeName(node, sourceCode);
  if (attrName !== 'style') return false;

  const exprNode = findChildByType(node, 'jsx_expression');
  if (!exprNode) return false;

  const line = getLine(sourceCode, node.range[0]);
  const exprText = sourceCode.slice(exprNode.range[0], exprNode.range[1]);

  // Strip { } wrapping
  const inner = exprText.slice(1, -1).trim();

  // Extract static property: value pairs from the object expression
  const propertyPairs = parseStyleObjectExpression(inner);
  for (const { property, value } of propertyPairs) {
    const camelToCss = camelToKebab(property);
    const normalizedValue = normalizeValue(value, camelToCss);

    declarations.push({
      property: camelToCss,
      rawValue: value,
      normalizedValue,
      mechanism: 'inline',
      filePath,
      line,
      context: null,
      variantContext: null,
      tokenRef: value.startsWith('var(--') ? extractTokenRef(value) : null,
    });
  }

  // If there were dynamic parts (template literals, variables), mark them
  if (inner.includes('${') || inner.includes('?') || inner.includes('&&')) {
    declarations.push({
      property: 'style',
      rawValue: inner.length > 80 ? inner.slice(0, 77) + '...' : inner,
      normalizedValue: null,
      mechanism: 'inline',
      filePath,
      line,
      context: null,
      variantContext: null,
      tokenRef: null,
    });
  }

  return true;
}

function parseStyleObjectExpression(expr: string): Array<{ property: string; value: string }> {
  const pairs: Array<{ property: string; value: string }> = [];

  // Simple regex-based property: value extraction from JS object expressions
  // Handles: property: 'value', property: "value", property: 42, property: 3.14
  const propRegex = /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(?:'([^']*)'|"([^"]*)"|([\d.]+))/g;
  let match: RegExpExecArray | null;

  while ((match = propRegex.exec(expr)) !== null) {
    const property = match[1];
    const value = match[2] ?? match[3] ?? match[4];

    if (property && value !== undefined) {
      pairs.push({ property, value });
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// CSS-in-JS (styled-components / emotion)
// ---------------------------------------------------------------------------

function extractFromCSSinJS(
  node: ASTNode,
  sourceCode: string,
  filePath: string,
  declarations: NormalizedDeclaration[],
): boolean {
  // Tagged template expression: styled.div`...` or css`...`
  if (node.type !== 'tagged_template_expression') return false;

  const nodeText = sourceCode.slice(node.range[0], node.range[1]);
  const line = getLine(sourceCode, node.range[0]);

  // Check for styled.xxx or css tag
  const tagMatch = nodeText.match(/^(styled\.[a-zA-Z]+|css|keyframes|createGlobalStyle)\s*(?:\()?\s*`/);
  if (!tagMatch) return false;

  // Extract the template literal content
  const templateStart = nodeText.indexOf('`');
  if (templateStart === -1) return false;

  // Find the closing backtick (accounting for escape sequences)
  let templateEnd = templateStart + 1;
  while (templateEnd < nodeText.length) {
    if (nodeText[templateEnd] === '`' && nodeText[templateEnd - 1] !== '\\') {
      break;
    }
    templateEnd++;
  }

  const template = nodeText.slice(templateStart + 1, templateEnd);

  // Replace template expressions ${expr} with placeholders for parsing
  const cleanedTemplate = template.replace(/\$\{[^}]*\}/g, '/* dynamic */');

  // Parse the CSS template content
  if (cleanedTemplate.includes(':')) {
    const block = cleanedTemplate;
    extractDeclarationsFromBlock(
      block,
      filePath,
      'css-in-js',
      `styled`,
      null,
      declarations,
      line,
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Sub-extractor: HTML (limited)
// ---------------------------------------------------------------------------

function extractFromHTML(
  filePath: string,
  sourceCode: string,
  tailwindTokens?: TailwindThemeTokens,
): NormalizedDeclaration[] {
  const declarations: NormalizedDeclaration[] = [];

  // Simple class attribute extraction from HTML
  const classRegex = /class(Name)?\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = classRegex.exec(sourceCode)) !== null) {
    const classValue = match[2];
    const line = sourceCode.slice(0, match.index).split('\n').length;
    const classNames = classValue.split(/\s+/).filter(Boolean);

    if (tailwindTokens) {
      for (const className of classNames) {
        const expanded = expandUtility(className, tailwindTokens, filePath, line);
        declarations.push(...expanded);
      }
    } else {
      for (const className of classNames) {
        declarations.push({
          property: 'class',
          rawValue: className,
          normalizedValue: { type: 'literal', value: className },
          mechanism: 'tailwind',
          filePath,
          line,
          context: null,
          variantContext: null,
          tokenRef: null,
        });
      }
    }
  }

  // Inline style attributes
  const styleRegex = /style\s*=\s*"([^"]*)"/g;
  while ((match = styleRegex.exec(sourceCode)) !== null) {
    const styleValue = match[1];
    const line = sourceCode.slice(0, match.index).split('\n').length;

    // Parse CSS declarations from the style attribute
    const parts = styleValue.split(';').filter(Boolean);
    for (const part of parts) {
      const colonIdx = part.indexOf(':');
      if (colonIdx !== -1) {
        const property = part.slice(0, colonIdx).trim();
        const value = part.slice(colonIdx + 1).trim();
        if (property && value) {
          const normalizedValue = normalizeValue(value, property);
          declarations.push({
            property,
            rawValue: value,
            normalizedValue,
            mechanism: 'inline',
            filePath,
            line,
            context: null,
            variantContext: null,
            tokenRef: null,
          });
        }
      }
    }
  }

  return declarations;
}

// ---------------------------------------------------------------------------
// AST Helpers
// ---------------------------------------------------------------------------

function walkASTNodes(node: ASTNode, visitor: (node: ASTNode) => void): void {
  visitor(node);
  if (node.children) {
    for (const child of node.children) {
      walkASTNodes(child, visitor);
    }
  }
}

function findChildByType(node: ASTNode, type: string): ASTNode | null {
  if (!node.children) return null;
  for (const child of node.children) {
    if (child.type === type) return child;
  }
  return null;
}

function getJSXAttributeName(node: ASTNode, sourceCode: string): string | null {
  // The attribute name is typically stored in a property_identifier child
  if (!node.children) return null;

  for (const child of node.children) {
    if (child.type === 'property_identifier' || child.type === 'identifier') {
      return sourceCode.slice(child.range[0], child.range[1]);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Miscellaneous Helpers
// ---------------------------------------------------------------------------

function getLine(sourceCode: string, offset: number): number {
  return sourceCode.slice(0, offset).split('\n').length;
}

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function extractTokenRef(rawValue: string): string | null {
  const match = rawValue.match(/var\((--[a-zA-Z0-9_-]+)\)/);
  return match ? match[1] : null;
}

function extractStaticStringsFromExpression(expr: string): string[] {
  const strings: string[] = [];

  // Extract static string literals from template literals and clsx calls
  const strRegex = /'([^']*)'|"([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = strRegex.exec(expr)) !== null) {
    const str = match[1] ?? match[2];
    if (str) {
      const parts = str.split(/\s+/).filter(Boolean);
      strings.push(...parts);
    }
  }

  return strings;
}
