/**
 * Universal Documentation Analyzer — Spec 17 R1
 *
 * R1.1: Anonymous/inline callables are skipped entirely (not downgraded).
 * R1.2: Default scope is public API surface only.
 * R1.3: Minimum-size gate (docsMinLines, default 5).
 * R1.4: scope: "all" restores pre-spec-17 behaviour minus R1.1 skips.
 * R1.5: File-header checks default OFF (fileHeaders replaces requireFileDocs).
 * R1.6: Finding messages name the audience reason.
 * R7:   All documentation/* severities are "warning" (documentation is a real
 *       maintainability obligation, not a stylistic nicety).
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode, ClassInfo, FunctionInfo } from '../../languages/types.js';
import { isTestFile, isTestFunction } from '../../languages/testConventions.js';
import picomatch from 'picomatch';

/**
 * Configuration for documentation analyzer
 */
export interface DocumentationAnalyzerConfig {
  requireFunctionDocs: boolean;
  requireClassDocs: boolean;
  requireFileDocs: boolean;        // DEPRECATED — use fileHeaders instead
  requireParamDocs: boolean;
  requireReturnDocs: boolean;
  minDescriptionLength: number;
  checkExportedOnly: boolean;      // DEPRECATED — use scope instead
  exemptPatterns: string[];
  // Spec-17 additions
  scope?: 'public' | 'all';        // default "public" — R1.2, R1.4
  docsMinLines?: number;           // default 5 — R1.3
  fileHeaders?: boolean;           // default false — R1.5 (replaces requireFileDocs)
  headerSkipGlobs?: string[];      // default spec list — R1.5
}

export const DEFAULT_DOCUMENTATION_CONFIG: DocumentationAnalyzerConfig = {
  requireFunctionDocs: true,
  requireClassDocs: true,
  requireFileDocs: true,
  requireParamDocs: true,
  requireReturnDocs: true,
  minDescriptionLength: 10,
  checkExportedOnly: false,
  exemptPatterns: [
    '\\.test\\.',
    '\\.spec\\.',
    '\\.d\\.ts$',
    'mock',
    'fixture',
    '__tests__',
    '/tests?/',
  ],
  // Spec-17 defaults
  scope: 'public',
  docsMinLines: 5,
  fileHeaders: false,
  headerSkipGlobs: [
    '**/index.{ts,tsx,js}',
    '**/*.{test,spec}.*',
    '**/__tests__/**',
    '**/migrations/**',
    '**/pages/**',
    '**/api/**',
    '**/routes/**',
    '**/*.config.*',
    '**/*.d.ts',
  ],
};

const HEADER_SKIP_GLOBS_DEFAULT = [
  '**/index.{ts,tsx,js}',
  '**/*.{test,spec}.*',
  '**/__tests__/**',
  '**/migrations/**',
  '**/pages/**',
  '**/api/**',
  '**/routes/**',
  '**/*.config.*',
  '**/*.d.ts',
];

/**
 * Languages whose documentation convention uses JSDoc @param/@returns tags.
 * Other languages (e.g. Go) document parameters and return values in prose
 * godoc comments, so the tag-based checks do not apply to them.
 */
const JSDOC_LANGUAGES = new Set(['typescript', 'javascript']);

/**
 * Universal documentation analyzer.
 */
export class UniversalDocumentationAnalyzer extends UniversalAnalyzer {
  readonly name = 'documentation';
  readonly description = 'Analyzes documentation quality across the codebase';
  readonly category = 'documentation';

  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: DocumentationAnalyzerConfig,
    sourceCode: string
  ): Promise<Violation[]> {
    const finalConfig = { ...DEFAULT_DOCUMENTATION_CONFIG, ...config };

    // Resolve scope: "public" is post-spec-17 default
    const scope = finalConfig.scope ?? 'public';

    // Resolve fileHeaders: prefer new key, fall back to deprecated requireFileDocs
    const fileHeaders = finalConfig.fileHeaders ?? finalConfig.requireFileDocs ?? false;

    // Check if file is exempt (name-based patterns) or is a test file under the
    // language's native convention (Go `*_test.go`, TS/JS `.test.`/`.spec.`, …).
    if (this.isExempt(ast.filePath, finalConfig.exemptPatterns) ||
        isTestFile(adapter.name, ast.filePath)) {
      return [];
    }

    const violations: Violation[] = [];

    // File-level documentation header check — R1.5 (defaults OFF)
    violations.push(...checkFileHeader(ast, adapter, finalConfig, fileHeaders));

    // Per-file scan context for the section analyzers below (Spec 34 bundling).
    const scan: DocScanContext = { adapter, sourceCode, config: finalConfig, scope };

    // Function documentation — R1.1 through R1.4, R1.6
    if (finalConfig.requireFunctionDocs) {
      violations.push(...analyzeFunctionDocumentation(ast, scan));
    }

    // Class documentation
    if (finalConfig.requireClassDocs) {
      violations.push(...analyzeClassDocumentation(ast, scan));
    }

    return violations;
  }

  /**
   * Check if a name or path matches any exempt regex patterns.
   */
  private isExempt(name: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
      const regex = new RegExp(pattern, 'i');
      return regex.test(name);
    });
  }
}

// ---------------------------------------------------------------------------
// R1 — Per-section analyzers (extracted from analyzeAST to keep it a thin
//     orchestrator). These are module-level so they don't depend on `this`;
//     violations are attributed to this analyzer's fixed name.
// ---------------------------------------------------------------------------

/**
 * Bundled classification for a documentation violation — `severity`, `rule`,
 * and an optional `symbol` travel together so `makeViolation` stays a 4-arg
 * call rather than a 6-arg one (Spec 34 param-count bundling).
 */
interface DocumentationViolationClassification {
  severity: 'critical' | 'warning' | 'suggestion';
  rule: string;
  symbol?: string;
}

/**
 * Per-file documentation scan context — bundles `adapter` / `sourceCode` /
 * `config` / `scope` into one object so the per-section analyzers clear the
 * 4-parameter gate without each defining its own bespoke context type.
 */
interface DocScanContext {
  adapter: LanguageAdapter;
  sourceCode: string;
  config: DocumentationAnalyzerConfig;
  scope: 'public' | 'all';
}

function makeViolation(
  file: string,
  location: { line: number; column: number },
  message: string,
  classification: DocumentationViolationClassification
): Violation {
  const v: Violation = {
    file,
    line: location.line,
    column: location.column,
    severity: classification.severity,
    message,
    rule: classification.rule,
    analyzer: 'documentation'
  };
  if (classification.symbol) v.functionName = classification.symbol;
  return v;
}

/** R1.5 — file-level documentation header check (defaults OFF). */
function checkFileHeader(
  ast: AST,
  adapter: LanguageAdapter,
  config: DocumentationAnalyzerConfig,
  fileHeaders: boolean
): Violation[] {
  const violations: Violation[] = [];
  if (!fileHeaders) return violations;

  const skipGlobs = config.headerSkipGlobs ?? HEADER_SKIP_GLOBS_DEFAULT;
  if (matchesAnyGlob(ast.filePath, skipGlobs)) return violations;

  const fileDoc = getFileDocumentation(ast, adapter);
  if (!fileDoc || fileDoc.length < config.minDescriptionLength) {
    violations.push(makeViolation(
      ast.filePath,
      { line: 1, column: 1 },
      'File lacks proper documentation header',
      { severity: 'warning', rule: 'file-documentation' }
    ));
  }
  return violations;
}

/** R1.1 + R1.2 — true when a function should be skipped before doc checks. */
function shouldSkipFunction(
  node: ASTNode | null,
  func: FunctionInfo,
  scan: DocScanContext,
  ast: AST
): boolean {
  const { adapter, sourceCode, scope } = scan;

  // R1.1 — Skip anonymous/inline callables
  if (node && isAnonymousOrCallback(node, adapter)) {
    return true;
  }

  // Language-native test functions (Go Test*/Benchmark*/Example*/Fuzz*) are
  // exempt from documentation regardless of path or export status — they are
  // test entry points, not public API.
  if (isTestFunction(adapter.name, func.name)) {
    return true;
  }

  // R1.2 — Scope filter (public API surface only)
  if (scope !== 'public' || func.isExported) {
    return false;
  }
  if (!func.isMethod) {
    // Named function decl nested inside another function — skip at default scope
    if (node && isNestedFunction(node, adapter)) {
      return true;
    }
    // Non-exported top-level function — skip
    return true;
  }
  // It's a method — check visibility
  if (node && isNonPublicMethod(node, adapter, sourceCode)) {
    return true;
  }
  // Check if the enclosing class is exported
  return !!(node && !isMethodOfExportedClass(node, adapter, ast));
}

/** R1.4/R1.6 — emit function/parameter/return documentation violations for one function. */
function checkFunctionDocumentation(
  ast: AST,
  adapter: LanguageAdapter,
  config: DocumentationAnalyzerConfig,
  func: FunctionInfo
): Violation[] {
  const violations: Violation[] = [];
  const doc = func.jsDoc || '';

  if (!doc || doc.length < config.minDescriptionLength) {
    // Methods lacking any documentation are reported by the class loop as
    // method-documentation — skip here so a public method is not
    // double-reported as both function-documentation and method-documentation.
    if (func.isMethod) {
      return violations;
    }

    // R1.6 — Audience-reason message
    const reason = func.isExported
      ? `exported function '${func.name}' lacks proper documentation`
      : `function '${func.name}' lacks proper documentation`;

    violations.push(makeViolation(
      ast.filePath,
      func.location.start,
      reason,
      { severity: 'warning', rule: 'function-documentation', symbol: func.name }
    ));
    return violations;
  }

  return checkFunctionDocTags(ast.filePath, adapter, config, func);
}

/** R1 — parameter and return documentation (JSDoc tags, JSDoc languages only). */
function checkFunctionDocTags(
  file: string,
  adapter: LanguageAdapter,
  config: DocumentationAnalyzerConfig,
  func: FunctionInfo
): Violation[] {
  const violations: Violation[] = [];
  const doc = func.jsDoc || '';

  // Param docs — JSDoc @param tags only apply to JSDoc languages.
  const checkJsDocTags = JSDOC_LANGUAGES.has(adapter.name);
  if (checkJsDocTags && config.requireParamDocs && func.parameters.length > 0) {
    const missingParamDocs = checkParameterDocumentation(
      doc,
      func.parameters.map(p => p.name)
    );
    for (const param of missingParamDocs) {
      violations.push(makeViolation(
        file,
        func.location.start,
        `Function '${func.name}' missing documentation for parameter '${param}'`,
        { severity: 'warning', rule: 'parameter-documentation', symbol: func.name }
      ));
    }
  }

  // Return docs — JSDoc @returns tags only apply to JSDoc languages.
  if (checkJsDocTags &&
      config.requireReturnDocs &&
      func.returnType &&
      func.returnType !== 'void' &&
      !hasReturnDocumentation(doc)) {
    violations.push(makeViolation(
      file,
      func.location.start,
      `Function '${func.name}' missing return value documentation`,
      { severity: 'warning', rule: 'return-documentation', symbol: func.name }
    ));
  }

  return violations;
}

/** R1.1–R1.4, R1.6 — function/parameter/return documentation. */
function analyzeFunctionDocumentation(
  ast: AST,
  scan: DocScanContext
): Violation[] {
  const { adapter, config } = scan;
  const violations: Violation[] = [];
  const functions = adapter.extractFunctions(ast);
  const docsMinLines = config.docsMinLines ?? 5;

  for (const func of functions) {
    // Find the AST node for this function
    const node = findNodeByLocation(ast.root, func.location.start);

    if (shouldSkipFunction(node, func, scan, ast)) {
      continue;
    }

    // R1.3 — Minimum-size gate
    const bodyLines = (func.location.end.line - func.location.start.line) + 1;
    if (bodyLines < docsMinLines) {
      continue;
    }

    violations.push(...checkFunctionDocumentation(ast, adapter, config, func));
  }

  return violations;
}

/** Class + method documentation. */
function analyzeClassDocumentation(
  ast: AST,
  scan: DocScanContext
): Violation[] {
  const { adapter, config, scope } = scan;
  const violations: Violation[] = [];
  const classes = adapter.extractClasses(ast);

  for (const cls of classes) {
    // Scope filter for classes
    if (scope === 'public' && !cls.isExported) {
      continue;
    }

    const doc = cls.jsDoc || '';
    if (!doc || doc.length < config.minDescriptionLength) {
      violations.push(makeViolation(
        ast.filePath,
        cls.location.start,
        `Class '${cls.name}' lacks proper documentation`,
        { severity: 'warning', rule: 'class-documentation', symbol: cls.name }
      ));
    }

    // Method documentation
    violations.push(...checkClassMethodDocumentation(ast, cls, scan));
  }

  return violations;
}

/** R1.2 — method-documentation for each public method of a class. */
function checkClassMethodDocumentation(
  ast: AST,
  cls: ClassInfo,
  scan: DocScanContext
): Violation[] {
  const { adapter, config, sourceCode, scope } = scan;
  const violations: Violation[] = [];
  if (!config.requireFunctionDocs) return violations;

  for (const method of cls.methods) {
    // Method scope filter
    if (scope === 'public') {
      const methodNode = findNodeByLocation(ast.root, method.location.start);
      if (methodNode && isNonPublicMethod(methodNode, adapter, sourceCode)) {
        continue;
      }
    }

    const methodDoc = method.jsDoc || '';
    if (!methodDoc || methodDoc.length < config.minDescriptionLength) {
      violations.push(makeViolation(
        ast.filePath,
        method.location.start,
        `public method '${cls.name}.${method.name}' lacks proper documentation`,
        { severity: 'warning', rule: 'method-documentation', symbol: `${cls.name}.${method.name}` }
      ));
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// R1.1 — Anonymous / inline callable detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the node is an anonymous arrow/function expression used as:
 * (a) a call argument (any callee — no name whitelist)
 * (b) a JSX attribute value
 * (c) an object-literal property value or array element passed as an argument
 * (d) an IIFE
 */
function isAnonymousOrCallback(node: ASTNode, adapter: LanguageAdapter): boolean {
  const nodeType = adapter.getNodeType(node);
  const parent = adapter.getParent(node);
  if (!parent) return false;

  const parentType = adapter.getNodeType(parent);

  // Arrow functions and function expressions
  if (
    nodeType === 'arrow_function' ||
    nodeType === 'function_expression' ||
    nodeType === 'generator_function_expression'
  ) {
    // (a)/(c) Call argument — direct, or via object/array literal container.
    if (isInlineInCallArguments(parent, adapter)) return true;

    // (b) JSX attribute value (event handlers, render props)
    if (isJsxAttributeValue(parentType)) return true;

    // (d) IIFE — the function is the callee of a call expression
    if (parentType === 'call_expression' && isIifeCallee(node, parent, adapter)) return true;
  }

  return false;
}

/** (a)/(c) — true when `parent` positions the inline callable as a call argument. */
function isInlineInCallArguments(parent: ASTNode, adapter: LanguageAdapter): boolean {
  const parentType = adapter.getNodeType(parent);
  if (parentType === 'arguments') return true;

  // Object literal property value in call arguments: arrow → pair → object → arguments
  if (parentType === 'pair') {
    const gp = adapter.getParent(parent);
    if (gp && (adapter.getNodeType(gp) === 'object' || adapter.getNodeType(gp) === 'object_pattern')) {
      const ggp = adapter.getParent(gp);
      return !!(ggp && adapter.getNodeType(ggp) === 'arguments');
    }
  }

  // Array element in call arguments: arrow → array → arguments
  if (parentType === 'array') {
    const gp = adapter.getParent(parent);
    return !!(gp && adapter.getNodeType(gp) === 'arguments');
  }

  return false;
}

/** (b) — true when the parent type is a JSX attribute/expression value. */
function isJsxAttributeValue(parentType: string): boolean {
  return (
    parentType === 'jsx_expression' ||
    parentType === 'jsx_attribute' ||
    parentType === 'jsx_self_closing_element' ||
    parentType === 'jsx_opening_element'
  );
}

/** (d) — true when `node` is the callee (not an argument) of the call expression. */
function isIifeCallee(node: ASTNode, parent: ASTNode, adapter: LanguageAdapter): boolean {
  const fnChild = getFirstChildOfType(parent, [
    'arrow_function',
    'function_expression',
    'function',
    'identifier',
    'member_expression',
    'call_expression',
  ]);
  if (!fnChild) return false;
  return (
    fnChild.location.start.line === node.location.start.line &&
    fnChild.location.start.column === node.location.start.column
  );
}

/**
 * Returns true if a function_declaration node is nested inside another function/method
 * (a helper by construction — R1.1).
 */
function isNestedFunction(node: ASTNode, adapter: LanguageAdapter): boolean {
  const nodeType = adapter.getNodeType(node);
  if (nodeType !== 'function_declaration' && nodeType !== 'generator_function_declaration') {
    return false;
  }

  let current = adapter.getParent(node);
  while (current) {
    const type = adapter.getNodeType(current);
    // Skip enclosing blocks/statement blocks
    if (
      type === 'statement_block' ||
      type === 'block' ||
      type === 'program' ||
      type === 'export_statement'
    ) {
      current = adapter.getParent(current);
      continue;
    }
    // Found enclosing function or method → this is nested
    if (adapter.isFunction(current) || adapter.isMethod(current)) {
      return true;
    }
    // Hit something else (class body, module, etc.) → not nested in a function
    break;
  }
  return false;
}

// ---------------------------------------------------------------------------
// R1.2 — Method visibility helpers
// ---------------------------------------------------------------------------

/**
 * A method is non-public if it is private, protected, #-named, or _-prefixed.
 */
function isNonPublicMethod(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string
): boolean {
  const type = adapter.getNodeType(node);
  if (type !== 'method_definition' && type !== 'public_field_definition') {
    return false;
  }

  // Check for tree-sitter accessibility modifiers in children
  if (node.children) {
    for (const child of node.children) {
      const childType = adapter.getNodeType(child);
      if (
        childType === 'accessibility_modifier' ||
        childType === 'private' ||
        childType === 'protected'
      ) {
        const text = adapter.getNodeText(child, sourceCode).trim();
        if (text === 'private' || text === 'protected') {
          return true;
        }
      }
    }
  }

  // Check property/method name for #-prefix (JS private) or _-prefix (convention)
  const propName = getMethodName(node, adapter, sourceCode);
  if (propName && (propName.startsWith('#') || propName.startsWith('_'))) {
    return true;
  }

  return false;
}

/**
 * Check if a method's enclosing class is exported.
 */
function isMethodOfExportedClass(
  node: ASTNode,
  adapter: LanguageAdapter,
  ast: AST
): boolean {
  let current = adapter.getParent(node);
  while (current) {
    if (adapter.isClass(current)) {
      if (isClassDirectlyExported(current, adapter)) return true;
      break;
    }
    current = adapter.getParent(current);
  }

  // Fallback: check extractClasses for isExported
  const classes = adapter.extractClasses(ast);
  for (const cls of classes) {
    // Find the class containing this method
    if (
      node.location.start.line >= cls.location.start.line &&
      node.location.start.line <= cls.location.end.line &&
      cls.isExported
    ) {
      return true;
    }
  }
  return false;
}

/** True when the class declaration node is directly wrapped in an export. */
function isClassDirectlyExported(classNode: ASTNode, adapter: LanguageAdapter): boolean {
  const classParent = adapter.getParent(classNode);
  if (!classParent) return false;
  if (adapter.getNodeType(classParent) === 'export_statement') return true;

  // Also check if the class declaration itself has an export modifier.
  const siblings = adapter.getChildren(classParent);
  for (const sib of siblings) {
    const sibType = adapter.getNodeType(sib);
    if (sibType !== 'export' && sibType !== 'export_statement') continue;
    const exportChildren = adapter.getChildren(sib);
    for (const ec of exportChildren) {
      if (
        adapter.getNodeType(ec) === 'class_declaration' &&
        ec.location.start.line === classNode.location.start.line
      ) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Check if a file path matches any picomatch glob pattern.
 */
function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  for (const glob of globs) {
    if (picomatch.isMatch(filePath, glob)) {
      return true;
    }
  }
  return false;
}

/**
 * Get the name of a method definition node.
 */
function getMethodName(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string
): string | null {
  if (node.children) {
    for (const child of node.children) {
      const type = adapter.getNodeType(child);
      if (type === 'property_identifier' || type === 'identifier') {
        return adapter.getNodeText(child, sourceCode).trim();
      }
    }
  }
  return null;
}

/**
 * Get the first child node matching one of the given types.
 */
function getFirstChildOfType(node: ASTNode, types: string[]): ASTNode | null {
  if (!node.children) return null;
  for (const child of node.children) {
    if (types.includes(child.type)) {
      return child;
    }
  }
  return null;
}

/**
 * Get file-level documentation (usually at the top).
 */
function getFileDocumentation(ast: AST, adapter: LanguageAdapter): string | null {
  const firstChild = ast.root.children?.[0];
  if (firstChild) {
    return adapter.getDocumentation(firstChild);
  }
  return null;
}

/**
 * Find a node by its location via BFS.
 */
function findNodeByLocation(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
  const queue: ASTNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;

    if (
      node.location.start.line === location.line &&
      node.location.start.column === location.column
    ) {
      return node;
    }

    if (node.children) {
      queue.push(...node.children);
    }
  }

  return null;
}

/**
 * True when `name` is a plain identifier (valid @param target). Destructured
 * parameters surface in `ParameterInfo.name` as their raw pattern text (e.g.
 * `{ children }` or `[first, second]`), which cannot match an `@param` tag and
 * is never a legitimately documentable parameter name — so skip them.
 */
function isPlainIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/**
 * Check which parameters are missing documentation.
 */
function checkParameterDocumentation(doc: string, paramNames: string[]): string[] {
  const missingParams: string[] = [];

  for (const param of paramNames) {
    // Destructured object/array-pattern params (e.g. `({ children })`) have no
    // single name to document via @param — skip rather than flag a false positive.
    if (!isPlainIdentifierName(param)) {
      continue;
    }

    const paramRegex = new RegExp(`@param\\s+(?:\\{[^}]+\\}\\s+)?${param}\\b`, 'i');
    if (!paramRegex.test(doc)) {
      missingParams.push(param);
    }
  }

  return missingParams;
}

/**
 * Check if documentation contains return value documentation.
 */
function hasReturnDocumentation(doc: string): boolean {
  return /@returns?\b/i.test(doc);
}
