/**
 * CSS/SCSS AST Extractor — Spec 26 Phase 2.
 *
 * Replaces regex-based CSS/SCSS parsing (styleExtractor.ts) with
 * AST-based extraction using tree-sitter-css and tree-sitter-scss parsed structures.
 *
 * Three pure functions mirror the output of the regex extractors:
 *   1. extractDeclarationsFromCSSAst — NormalizedDeclaration[]
 *   2. extractTokensFromCSSAst       — StyleToken[]
 *   3. extractClassUsageFromCSSAst   — StyleClassUsage[]
 *
 * SCSS files are handled via tree-sitter-scss grammar which extends the CSS
 * grammar. SCSS-specific node types (nesting_selector, _concatenated_identifier,
 * variable, mixin_statement, include_statement) are present in the AST and
 * filtered appropriately by each extraction function.
 */

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
// CSS Node Helpers
// ---------------------------------------------------------------------------

/**
 * Get property and raw value from a declaration node.
 * tree-sitter-css uses `property_name` for the property and various typed
 * children for the value (color_value, integer_value, plain_value,
 * call_expression, etc.). We extract the property from the property_name
 * child and the raw value from the full declaration text after the colon.
 */
function getPropertyAndValue(decl: ASTNode, sourceCode: string): { property: string; rawValue: string } | null {
  const propNode = decl.children?.find(c => c.type === 'property_name');
  if (!propNode) return null;

  const property = sourceCode.slice(propNode.range[0], propNode.range[1]).trim();
  if (!property) return null;

  // Extract raw value from the full declaration text after the property + colon
  const fullText = sourceCode.slice(decl.range[0], decl.range[1]);
  // Find the colon that separates property from value.
  // Use indexOf on the full text — the property_name child's text tells us
  // where the property ends, but the colon might be outside the child span
  // (tree-sitter may or may not include it in property_name).
  // Safe approach: scan from after the property_name child's end offset.
  const propEndInDecl = propNode.range[1] - decl.range[0];
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

// ---------------------------------------------------------------------------
// SCSS & Nesting Resolution
// ---------------------------------------------------------------------------

/**
 * Unresolved nesting count — accumulated during extraction so callers can
 * report how many `&`-involved selectors could not be resolved.
 */
export let unresolvedNestingCount = 0;

/** Reset the global unresolved-nesting counter. Call before extraction. */
export function resetUnresolvedNestingCount(): void {
  unresolvedNestingCount = 0;
}

/**
 * Walk up from a class_selector to find the nearest *outer* rule_set
 * (skipping past the rule_set that directly contains this class_selector),
 * then resolve its class name (handling nested & recursively).
 *
 * Uses ASTNode.parent to walk up the parse tree.
 *
 * Returns null when the class_selector has no resolvable parent (e.g. it is at
 * the top level, or the parent is another &-pattern that itself cannot resolve).
 */
function getParentClassName(
  classSelectorNode: ASTNode,
  sourceCode: string,
): string | null {
  let current: ASTNode | null = classSelectorNode;

  // Step 1: walk up to find the containing (inner) rule_set
  while (current && current.type !== 'rule_set') {
    current = current.parent ?? null;
  }
  if (!current || current.type !== 'rule_set') return null;

  // Step 2: walk up FROM the inner rule_set to find the OUTER rule_set
  current = current.parent ?? null; // block of outer rule_set, or stylesheet
  while (current && current.type !== 'rule_set') {
    current = current.parent ?? null;
  }
  if (!current || current.type !== 'rule_set') return null;

  // Step 3: resolve the outer rule_set's concrete class name (unwinding any
  // nested `&` chains — see resolveRuleSetClassName).
  return resolveRuleSetClassName(current, sourceCode);
}

/**
 * Resolve a rule_set's selectors to a concrete parent class name, unwinding
 * nested `&` chains recursively.
 *
 * - A plain `.btn` selector resolves to `btn`.
 * - A `&-header` selector resolves to `parent + -header` via resolveNestingSelector.
 * - A bare `&` pseudo/attribute selector (`&:focus`, `&:not(...)`, `&[aria-…]`)
 *   has no class name of its own, so the walk continues one level up to the
 *   enclosing rule_set.
 *
 * Returns null when no concrete parent class exists at or above this rule_set.
 */
function resolveRuleSetClassName(ruleSet: ASTNode, sourceCode: string): string | null {
  const selectors = ruleSet.children?.find(c => c.type === 'selectors');
  if (!selectors) return null;

  // Plain or BEM-nested class_selector.
  const classSelector = selectors.children?.find(c => c.type === 'class_selector');
  if (classSelector) {
    const hasNesting = (classSelector.children ?? []).some(
      (c) => c.type === 'nesting_selector',
    );
    if (hasNesting) {
      const resolved = resolveNestingSelector(classSelector, sourceCode);
      if (resolved !== null && resolved.resolvable) return resolved.className;
      return null;
    }
    const cn = classSelector.children?.find(c => c.type === 'class_name');
    if (cn) return sourceCode.slice(cn.range[0], cn.range[1]);
  }

  // Bare `&` in a pseudo_class_selector / attribute_selector — no class name at
  // this level; unwind one more rule_set.
  const hasBareNesting = (selectors.children ?? []).some(c =>
    (c.type === 'pseudo_class_selector' || c.type === 'attribute_selector')
    && (c.children ?? []).some((cc) => cc.type === 'nesting_selector'),
  );
  if (hasBareNesting) {
    let outer: ASTNode | null = ruleSet.parent ?? null;
    while (outer && outer.type !== 'rule_set') outer = outer.parent ?? null;
    if (outer && outer.type === 'rule_set') return resolveRuleSetClassName(outer, sourceCode);
  }

  return null;
}

/**
 * Resolve a class_selector node that contains a nesting_selector (&).
 *
 * Returns:
 *   - { className: 'form-group-header', resolvable: true } for &-suffix / &__element / &--modifier
 *   - { className: 'selected', resolvable: false }     for &.modifier (chained class)
 *   - { className: 'child', resolvable: false }         for & .descendant
 *   - null                                               when no nesting_selector is present
 *
 * BEM conventions handled (no-separator concatenation):
 *   - &-suffix     → parent + -suffix    (block modifier)
 *   - &__element   → parent + __element  (BEM element)
 *   - &--modifier  → parent + --modifier (BEM modifier)
 *
 * Patterns dropped as unresolvable:
 *   - &.modifier   — chained class, can't register as standalone defined class
 *   - & .descendant — descendant combinator
 */
function resolveNestingSelector(
  classSelectorNode: ASTNode,
  sourceCode: string,
): { className: string; resolvable: boolean } | null {
  const children = classSelectorNode.children ?? [];
  const hasNesting = children.some(c => c.type === 'nesting_selector');
  if (!hasNesting) return null;

  // Find siblings of nesting_selector
  const classNames = children.filter(c => c.type === 'class_name');
  const nestedClassSelectors = children.filter(c => c.type === 'class_selector');

  // Case 1: &-suffix or &__element or &--modifier or &.modifier
  for (const cn of classNames) {
    const raw = sourceCode.slice(cn.range[0], cn.range[1]);

    // BEM no-separator concatenation: &-suffix, &__element, &--modifier
    if (raw.startsWith('-') || raw.startsWith('_')) {
      const parentName = getParentClassName(classSelectorNode, sourceCode);
      if (parentName) {
        return { className: parentName + raw, resolvable: true };
      }
      // Parent not resolvable — drop and count
      unresolvedNestingCount++;
      return { className: raw, resolvable: false };
    }

    // &.modifier — chained class, not a standalone definition
    // The class name alone (e.g. "selected") is a valid class but we can't
    // register it as defined just because `.parent.selected` exists.
    if (raw.length > 0) {
      unresolvedNestingCount++;
      return { className: raw, resolvable: false };
    }
  }

  // Case 2: & .descendant — descendant combinator
  for (const nestedCS of nestedClassSelectors) {
    const innerCN = nestedCS.children?.find(c => c.type === 'class_name');
    if (innerCN) {
      const raw = sourceCode.slice(innerCN.range[0], innerCN.range[1]);
      unresolvedNestingCount++;
      return { className: raw, resolvable: false };
    }
  }

  // Unknown nesting pattern — drop and count
  unresolvedNestingCount++;
  return null;
}

/**
 * Resolve `&` nesting in selector context text.
 *
 * When a rule_set's selectors contain nesting_selector patterns (SCSS),
 * replace raw &-suffix text with the resolved parent class concatenation.
 * This ensures declaration context strings are meaningful.
 *
 * e.g. "&-header" inside ".form-group" → "form-group-header"
 *      "&.selected" inside ".btn" stays "&.selected" (unresolvable chained class)
 */
function resolveSelectorContext(
  selectorsNode: ASTNode,
  rawText: string,
  sourceCode: string,
): string {
  const children = selectorsNode.children ?? [];
  const classSelectors = children.filter(c => c.type === 'class_selector');
  const hasNesting = classSelectors.some(cs =>
    (cs.children ?? []).some(cc => cc.type === 'nesting_selector'),
  );

  // Bare `&` selectors — a pseudo_class_selector / attribute_selector whose
  // children include a nesting_selector (`&:focus`, `&:not(...)`, `&[aria-…]`).
  // These were previously left unresolved, collapsing every nested variant into
  // one raw `&…` context key.
  const bareNestingSelectors = children.filter(c =>
    (c.type === 'pseudo_class_selector' || c.type === 'attribute_selector')
    && (c.children ?? []).some(cc => cc.type === 'nesting_selector'),
  );

  if (!hasNesting && bareNestingSelectors.length === 0) return rawText;

  let resolvedText = rawText;
  for (const cs of classSelectors) {
    const resolved = resolveNestingSelector(cs, sourceCode);
    if (resolved !== null && resolved.resolvable) {
      const csRaw = sourceCode.slice(cs.range[0], cs.range[1]);
      resolvedText = resolvedText.replace(csRaw, '.' + resolved.className);
    }
  }

  for (const bs of bareNestingSelectors) {
    const parentName = getParentClassNameFromSelectors(selectorsNode, sourceCode);
    const ns = (bs.children ?? []).find(cc => cc.type === 'nesting_selector');
    if (parentName && ns) {
      const nsRaw = sourceCode.slice(ns.range[0], ns.range[1]); // '&'
      resolvedText = resolvedText.replace(nsRaw, '.' + parentName);
    } else {
      unresolvedNestingCount++;
    }
  }

  return resolvedText;
}

/**
 * Resolve the parent class name for a bare `&` nesting selector, starting from
 * the rule_set's `selectors` node (whose parent is the rule_set itself).
 */
function getParentClassNameFromSelectors(selectorsNode: ASTNode, sourceCode: string): string | null {
  const innerRuleSet = selectorsNode.parent ?? null;
  if (!innerRuleSet || innerRuleSet.type !== 'rule_set') return null;

  let outer: ASTNode | null = innerRuleSet.parent ?? null;
  while (outer && outer.type !== 'rule_set') outer = outer.parent ?? null;
  if (!outer || outer.type !== 'rule_set') return null;

  return resolveRuleSetClassName(outer, sourceCode);
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
    // tree-sitter-css: rule_set has named children 'selectors' and 'block'
    const selectorsAst = ruleSet.children?.find(c => c.type === 'selectors');
    if (!selectorsAst) continue;

    let selector = getSelectorText(selectorsAst, sourceCode);
    if (!selector) continue;

    // SCSS: resolve & nesting in selector context (Bug 2 fix)
    selector = resolveSelectorContext(selectorsAst, selector, sourceCode);

    // Get variant context from at_rule ancestors
    const variantContext = getVariantContext(ruleSet, adapter, sourceCode);

    // Find declarations inside this rule_set
    const subAST = subtreeAST(ast, ruleSet);
    const declNodes = adapter.findNodes(subAST, { type: 'declaration' });

    for (const decl of declNodes) {
      // Skip declarations from nested rule_sets (SCSS nesting):
      // findNodes recurses into descendant rule_sets, so outer .card
      // would see declarations from inner &-header — producing wrong context.
      let declAncestor: ASTNode | null = adapter.getParent(decl);
      while (declAncestor && declAncestor.type !== 'rule_set') {
        declAncestor = adapter.getParent(declAncestor);
      }
      if (declAncestor !== ruleSet) continue;

      const pv = getPropertyAndValue(decl, sourceCode);
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
    const blockAst = ruleSet.children?.find(c => c.type === 'block');
    if (blockAst) {
      extractApplyDirectives(blockAst, sourceCode, selector, variantContext, filePath, declarations);
    }
  }

  // Handle @keyframes blocks — tree-sitter-css uses keyframes_statement with
  // keyframe_block_list children, not rule_set.
  const keyframeStmts = adapter.findNodes(ast, { type: 'keyframes_statement' });
  for (const kf of keyframeStmts) {
    const kfNameNode = kf.children?.find(c => c.type === 'keyframes_name');
    const kfName = kfNameNode
      ? sourceCode.slice(kfNameNode.range[0], kfNameNode.range[1])
      : 'unknown';
    const kfSubAST = subtreeAST(ast, kf);
    const kfDeclNodes = adapter.findNodes(kfSubAST, { type: 'declaration' });

    for (const decl of kfDeclNodes) {
      // Find which keyframe_block this declaration belongs to
      let parent = adapter.getParent(decl);
      let kfSelector = '(unknown)';
      while (parent && parent.type !== 'keyframes_statement') {
        if (parent.type === 'keyframe_block') {
          const selChild = (parent.children ?? []).find(
            (c) => c.type === 'from' || c.type === 'to' || c.type === 'integer_value',
          );
          kfSelector = selChild
            ? sourceCode.slice(selChild.range[0], selChild.range[1])
            : '(unknown)';
          break;
        }
        parent = adapter.getParent(parent);
      }

      const pv = getPropertyAndValue(decl, sourceCode);
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

    const pv = getPropertyAndValue(decl, sourceCode);
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
  sourceCode: string,
): StyleToken[] {
  const tokens: StyleToken[] = [];

  const allDecls = adapter.findNodes(ast, { type: 'declaration' });
  for (const decl of allDecls) {
    const pv = getPropertyAndValue(decl, sourceCode);
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
 *
 * For SCSS: resolves &-suffix / &__element / &--modifier (BEM no-separator
 * concatenation) by walking up to the parent rule_set's class_selector.
 * &.modifier (chained class) and & .descendant patterns are tracked as
 * unresolvable rather than registered as standalone classes — registering
 * them would produce false negatives in the undefined-class detector.
 */
export function extractClassUsageFromCSSAst(
  ast: AST,
  adapter: LanguageAdapter,
  filePath: string,
  sourceCode: string,
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

    const rawName = sourceCode.slice(node.range[0], node.range[1]);
    if (!rawName) continue;

    // SCSS nesting resolution: check if parent class_selector has a nesting_selector
    const resolved = resolveNestingSelector(parent, sourceCode);

    if (resolved !== null) {
      // &-pattern: register the resolved or dropped class name
      usage.push({
        className: resolved.className,
        filePath,
        line: node.location.start.line,
        mechanism: 'class',
        unresolvable: !resolved.resolvable,
      });
    } else {
      // Plain class_selector (no &), or at-rule top-level
      usage.push({
        className: rawName,
        filePath,
        line: node.location.start.line,
        mechanism: 'class',
        unresolvable: false,
      });
    }
  }

  return usage;
}
