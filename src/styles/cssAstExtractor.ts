/**
 * CSS AST Extractor — Spec 26 Phase 2.
 *
 * Replaces regex-based CSS parsing (styleExtractor.ts extractFromCSS) with
 * AST-based extraction using tree-sitter-css parsed structures.
 *
 * Three pure functions mirror the output of the regex extractors:
 *   1. extractDeclarationsFromCSSAst — NormalizedDeclaration[]
 *   2. extractTokensFromCSSAst       — StyleToken[]
 *   3. extractClassUsageFromCSSAst   — StyleClassUsage[]
 *
 * SCSS is NOT handled here — tree-sitter-css is not an SCSS grammar.
 * SCSS files stay on the regex path in styleExtractor.ts.
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { AST, ASTNode, LanguageAdapter } from '../languages/types.js';
import { normalizeValue, expandShorthand } from './normalizer.js';
import type { NormalizedDeclaration, StyleToken, StyleClassUsage } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a CSS custom property reference from a value like `var(--token)`.
 * Token-level classification (not structure discovery) — the regex reads a
 * known token name from a single value string.
 */
function extractTokenRef(rawValue: string): string | null {
  const match = rawValue.match(/var\(\s*(--[a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Get the text content of a selectors node, stripping block comments.
 * Bug 5 fix: CSS comments are not treated as class names (tree-sitter types
 * comment nodes explicitly, so we filter by type).
 */
function getSelectorText(selectorsNode: ASTNode, sourceCode: string): string {
  const raw = sourceCode.slice(selectorsNode.range[0], selectorsNode.range[1]);
  // Strip block comments — token-level text munging on AST-discovered content
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

/**
 * CSS at-rule node types in tree-sitter-css.
 *
 * tree-sitter-css uses distinct named types for some at-rules (media_statement,
 * supports_statement, keyframes_statement) and generic `at_rule` for everything
 * else (@layer, @import, @apply, etc.).
 */
const AT_RULE_TYPES = new Set([
  'at_rule',
  'media_statement',
  'supports_statement',
  'keyframes_statement',
]);

/**
 * Walk ancestor chain for at-rule nodes and build variant context string.
 */
function getVariantContext(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  const atRules: string[] = [];
  let current = adapter.getParent(node);
  while (current) {
    if (AT_RULE_TYPES.has(current.type)) {
      const text = sourceCode.slice(current.range[0], current.range[1]);
      const braceIdx = text.indexOf('{');
      const atRuleText = braceIdx !== -1 ? text.slice(0, braceIdx).trim() : text.trim();
      atRules.unshift(atRuleText);
    }
    current = adapter.getParent(current);
  }
  return atRules.length > 0 ? atRules.join(', ') : null;
}

/**
 * Extract @apply directives inside a rule_set block.
 *
 * @apply is a Tailwind extension, not standard CSS. tree-sitter-css may emit
 * either ERROR nodes (when the grammar can't make sense of the token),
 * postcss_statement nodes (when the grammar recognizes it as a PostCSS-style
 * at-rule inside a rule set), or at_rule nodes (when parsed structurally as an
 * at-rule with @apply keyword). All three paths produce the same
 * NormalizedDeclaration shape.
 *
 * Bug 2: @apply in rule sets — both `@layer`-wrapped and bare. The old regex
 * parser handled @apply in block text; AST requires explicit child-traversal.
 */
function extractApplyDirectives(
  blockNode: ASTNode,
  sourceCode: string,
  selector: string,
  variantContext: string | null,
  filePath: string,
  declarations: NormalizedDeclaration[],
): void {
  for (const child of blockNode.children ?? []) {
    let applyText: string | null = null;
    let line: number;

    if (child.type === 'ERROR') {
      // Legacy path: @apply unrecognised by grammar → ERROR node.
      const errText = sourceCode.slice(child.range[0], child.range[1]).trim();
      const match = errText.match(/^@apply\s+(.+)$/);
      applyText = match ? match[1].trim() : null;
      line = child.location.start.line;
    } else if (child.type === 'postcss_statement') {
      // Modern path: tree-sitter-css recognises @apply as a PostCSS statement.
      // The full text is "@apply <utilities>;". Strip the keyword and semicolon.
      const fullText = sourceCode.slice(child.range[0], child.range[1]).trim();
      applyText = fullText.replace(/^@apply\s+/, '').replace(/;?\s*$/, '');
      line = child.location.start.line;
    } else if (child.type === 'at_rule') {
      // tree-sitter-css v0.x: @apply parsed as at_rule with at_keyword child.
      const atKeyword = child.children?.find(
        c => c.type === 'at_keyword',
      );
      if (!atKeyword) continue;
      const kwText = sourceCode
        .slice(atKeyword.range[0], atKeyword.range[1])
        .trim();
      if (kwText !== '@apply') continue;
      // The keyword_query child holds the utility names.
      const queryChild = child.children?.find(
        c => c.type === 'keyword_query',
      );
      applyText = queryChild
        ? sourceCode.slice(queryChild.range[0], queryChild.range[1]).trim()
        : null;
      line = child.location.start.line;
    } else {
      continue;
    }

    if (applyText && applyText.length > 0 && !applyText.includes('{')) {
      declarations.push({
        property: 'apply',
        rawValue: applyText,
        normalizedValue: { type: 'literal', value: applyText },
        mechanism: 'css',
        filePath,
        line,
        context: selector,
        variantContext,
        tokenRef: null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Tree-Sitter CSS Node Helpers
// ---------------------------------------------------------------------------

/**
 * tree-sitter-css does NOT use field names (childForFieldName). Children are
 * discovered by type via namedChild iteration on the raw TreeSitterNode.
 * This grammar is distinct from the tree-sitter-typescript one.
 */

/**
 * Find the first named child of a TreeSitterNode with the given type.
 */
function findNamedChild(node: TreeSitterNode, type: string): TreeSitterNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}

/**
 * Get property and raw value from a declaration's raw TreeSitterNode.
 * tree-sitter-css uses `property_name` for the property and various typed
 * children for the value (color_value, integer_value, plain_value,
 * call_expression, etc.). We extract the property from the property_name
 * child and the raw value from the full declaration text after the colon.
 */
function getPropertyAndValue(declRaw: TreeSitterNode): { property: string; rawValue: string } | null {
  const propNode = findNamedChild(declRaw, 'property_name');
  if (!propNode) return null;

  const property = propNode.text.trim();
  if (!property) return null;

  // Extract raw value from the full declaration text after the property + colon
  const fullText = declRaw.text;
  // Find the colon that separates property from value.
  // Use indexOf on the full text — the property_name child's text tells us
  // where the property ends, but the colon might be outside the child span
  // (tree-sitter may or may not include it in property_name).
  // Safe approach: scan from after the property_name child's end offset.
  const propEndInDecl = propNode.endIndex - declRaw.startIndex;
  const afterProp = fullText.slice(propEndInDecl);
  const colonIdx = afterProp.indexOf(':');
  const rawValue = colonIdx !== -1 ? afterProp.slice(colonIdx + 1).replace(/;\s*$/, '').trim() : '';

  return { property, rawValue };
}

// ---------------------------------------------------------------------------
// AST Extraction Helpers
// ---------------------------------------------------------------------------

/**
 * Create a synthetic AST from a subtree node for use with findNodes.
 * findNodes needs an AST object, but we find nodes within subtrees.
 */
function subtreeAST(ast: AST, root: ASTNode): AST {
  return { root, language: ast.language, filePath: ast.filePath, errors: [] };
}

/**
 * Wrap a TreeSitterNode as an ASTNode for use with adapter methods that
 * expect ASTNode input.
 */
function wrapAsASTNode(raw: TreeSitterNode): ASTNode {
  return {
    type: raw.type,
    range: [raw.startIndex, raw.endIndex],
    location: {
      start: {
        line: raw.startPosition.row + 1,
        column: raw.startPosition.column + 1,
      },
      end: {
        line: raw.endPosition.row + 1,
        column: raw.endPosition.column + 1,
      },
    },
    children: raw.namedChildren.map((c) => wrapAsASTNode(c)),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract normalized CSS declarations from a parsed CSS AST.
 *
 * Replaces the regex-based extractFromCSS() + extractRuleSets() + the
 * declaration-extraction part of extractDeclarationsFromBlock() for .css files.
 *
 * Parser bugs eliminated by AST-based approach:
 *   Bug 1: Whitespace before @-rules — @-rules are at_rule nodes, always correct
 *   Bug 3: Nested @-rule closing brace — tree-sitter handles brace matching
 *   Bug 4: findSelectorStart walking past boundaries — no backward scanning needed
 *   Bug 5: CSS comments as class names — comment nodes are typed, filtered out
 */
export function extractDeclarationsFromCSSAst(
  ast: AST,
  adapter: LanguageAdapter,
  filePath: string,
  sourceCode: string,
): NormalizedDeclaration[] {
  const declarations: NormalizedDeclaration[] = [];

  // Find all rule_sets
  const ruleSets = adapter.findNodes(ast, { type: 'rule_set' });

  for (const ruleSet of ruleSets) {
    const rawNode = ruleSet.raw as TreeSitterNode;

    // tree-sitter-css: rule_set has named children 'selectors' and 'block'
    const selectorsRaw = findNamedChild(rawNode, 'selectors');
    if (!selectorsRaw) continue;

    const selectorsAst = wrapAsASTNode(selectorsRaw);
    const selector = getSelectorText(selectorsAst, sourceCode);
    if (!selector) continue;

    // Get variant context from at_rule ancestors
    const variantContext = getVariantContext(ruleSet, adapter, sourceCode);

    // Find declarations inside this rule_set
    const subAST = subtreeAST(ast, ruleSet);
    const declNodes = adapter.findNodes(subAST, { type: 'declaration' });

    for (const decl of declNodes) {
      const raw = decl.raw as TreeSitterNode;
      const pv = getPropertyAndValue(raw);
      if (!pv) continue;

      const { property, rawValue } = pv;
      if (!property || !rawValue) continue;

      const normalizedValue = normalizeValue(rawValue, property);
      const expanded = expandShorthand(property, rawValue, normalizedValue);
      const line = decl.location.start.line;

      // Extract token ref from var() values or custom property names
      const tokenRef = property.startsWith('--')
        ? property
        : (rawValue.trim().startsWith('var(') ? extractTokenRef(rawValue) : null);

      for (const exp of expanded) {
        declarations.push({
          property: exp.property,
          rawValue: exp.rawValue,
          normalizedValue: exp.normalizedValue,
          mechanism: 'css',
          filePath,
          line,
          context: selector,
          variantContext,
          tokenRef,
        });
      }
    }

    // Handle @apply directives (Tailwind extension)
    const blockRaw = findNamedChild(rawNode, 'block');
    if (blockRaw) {
      const blockAst = wrapAsASTNode(blockRaw);
      extractApplyDirectives(blockAst, sourceCode, selector, variantContext, filePath, declarations);
    }
  }

  // Handle @keyframes blocks — tree-sitter-css uses keyframes_statement with
  // keyframe_block_list children, not rule_set.
  const keyframeStmts = adapter.findNodes(ast, { type: 'keyframes_statement' });
  for (const kf of keyframeStmts) {
    const kfRaw = kf.raw as TreeSitterNode;
    const kfName = findNamedChild(kfRaw, 'keyframes_name')?.text ?? 'unknown';
    const kfSubAST = subtreeAST(ast, kf);
    const kfDeclNodes = adapter.findNodes(kfSubAST, { type: 'declaration' });

    for (const decl of kfDeclNodes) {
      // Find which keyframe_block this declaration belongs to
      let parent = adapter.getParent(decl);
      let kfSelector = '(unknown)';
      while (parent && parent.type !== 'keyframes_statement') {
        if (parent.type === 'keyframe_block') {
          const selChild = (parent.raw as TreeSitterNode).namedChildren.find(
            (c: any) =>
              c.type === 'from' || c.type === 'to' || c.type === 'integer_value',
          );
          kfSelector = selChild?.text ?? '(unknown)';
          break;
        }
        parent = adapter.getParent(parent);
      }

      const raw = decl.raw as TreeSitterNode;
      const pv = getPropertyAndValue(raw);
      if (!pv) continue;
      const { property, rawValue } = pv;
      if (!property || !rawValue) continue;

      const normalizedValue = normalizeValue(rawValue, property);
      const expanded = expandShorthand(property, rawValue, normalizedValue);
      const line = decl.location.start.line;

      const tokenRef = property.startsWith('--')
        ? property
        : (rawValue.trim().startsWith('var(') ? extractTokenRef(rawValue) : null);

      for (const exp of expanded) {
        declarations.push({
          property: exp.property,
          rawValue: exp.rawValue,
          normalizedValue: exp.normalizedValue,
          mechanism: 'css',
          filePath,
          line,
          context: kfSelector,
          variantContext: `@keyframes ${kfName}`,
          tokenRef,
        });
      }
    }
  }

  // Handle top-level declarations (not inside a rule_set or keyframe block — valid CSS)
  const allDecls = adapter.findNodes(ast, { type: 'declaration' });
  for (const decl of allDecls) {
    // Skip declarations that are inside a rule_set or keyframe block (already processed above)
    const parent = adapter.getParent(decl);
    let ancestor = parent;
    let inKeyframe = false;
    while (ancestor) {
      if (ancestor.type === 'keyframe_block') { inKeyframe = true; break; }
      ancestor = adapter.getParent(ancestor);
    }
    if (parent?.type === 'rule_set' || parent?.type === 'block' || inKeyframe) continue;

    const raw = decl.raw as TreeSitterNode;
    const pv = getPropertyAndValue(raw);
    if (!pv) continue;

    const { property, rawValue } = pv;
    if (!property || !rawValue) continue;

    const normalizedValue = normalizeValue(rawValue, property);
    const expanded = expandShorthand(property, rawValue, normalizedValue);
    const line = decl.location.start.line;

    for (const exp of expanded) {
      declarations.push({
        property: exp.property,
        rawValue: exp.rawValue,
        normalizedValue: exp.normalizedValue,
        mechanism: 'css',
        filePath,
        line,
        context: '(top-level)',
        variantContext: null,
        tokenRef: property.startsWith('--')
          ? property
          : (rawValue.trim().startsWith('var(') ? extractTokenRef(rawValue) : null),
      });
    }
  }

  return declarations;
}

/**
 * Extract CSS custom property tokens from a parsed CSS AST.
 *
 * Replaces the regex-based extractTokens() for .css files.
 * Finds declarations where the property starts with -- and extracts
 * the token name and value.
 */
export function extractTokensFromCSSAst(
  ast: AST,
  adapter: LanguageAdapter,
  filePath: string,
): StyleToken[] {
  const tokens: StyleToken[] = [];

  const allDecls = adapter.findNodes(ast, { type: 'declaration' });
  for (const decl of allDecls) {
    const raw = decl.raw as TreeSitterNode;
    const pv = getPropertyAndValue(raw);
    if (!pv) continue;

    const { property, rawValue } = pv;
    if (!property.startsWith('--')) continue;

    const name = property.trim();
    const value = rawValue.trim();
    if (name && value) {
      tokens.push({
        name,
        value,
        filePath,
        mechanism: 'css-custom-property',
      });
    }
  }

  return tokens;
}

/**
 * Extract CSS class usage from a parsed CSS AST.
 *
 * Replaces the regex-based class name extraction from selectors for .css files.
 * Finds class_name nodes anywhere in the AST — each represents one CSS class
 * definition. comment nodes are typed and naturally excluded (Bug 5 fix).
 */
export function extractClassUsageFromCSSAst(
  ast: AST,
  adapter: LanguageAdapter,
  filePath: string,
): StyleClassUsage[] {
  const usage: StyleClassUsage[] = [];

  // class_name nodes represent CSS class selectors like .my-class
  // They can appear inside selectors, pseudo-class arguments, etc.
  const classNodes = adapter.findNodes(ast, { type: 'class_name' });

  for (const node of classNodes) {
    // Only extract class_name nodes that are children of class_selector.
    // pseudo_class_selector (:hover, :focus, :nth-child) and
    // pseudo_element_selector (::before, ::after) also contain class_name
    // children — those are pseudo-classes, not CSS class definitions.
    const parent = adapter.getParent(node);
    if (!parent || parent.type !== 'class_selector') continue;

    const raw = node.raw as TreeSitterNode;
    const className = raw.text;
    if (className) {
      usage.push({
        className,
        filePath,
        line: node.location.start.line,
        mechanism: 'class',
        unresolvable: false,
      });
    }
  }

  return usage;
}
