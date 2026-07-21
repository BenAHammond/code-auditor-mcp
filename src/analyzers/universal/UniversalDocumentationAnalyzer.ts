/**
 * Universal Documentation Analyzer — Spec 17 R1
 *
 * R1.1: Anonymous/inline callables are skipped entirely (not downgraded).
 * R1.2: Default scope is public API surface only.
 * R1.3: Minimum-size gate (docsMinLines, default 5).
 * R1.4: scope: "all" restores pre-spec-17 behaviour minus R1.1 skips.
 * R1.5: File-header checks default OFF (fileHeaders replaces requireFileDocs).
 * R1.6: Finding messages name the audience reason.
 * R7:   All documentation/* severities are "suggestion".
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../languages/types.js';
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
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_DOCUMENTATION_CONFIG, ...config };

    // Resolve scope: "public" is post-spec-17 default
    const scope = finalConfig.scope ?? 'public';

    // Resolve fileHeaders: prefer new key, fall back to deprecated requireFileDocs
    const fileHeaders = finalConfig.fileHeaders ?? finalConfig.requireFileDocs ?? false;

    // Check if file is exempt (name-based patterns)
    if (this.isExempt(ast.filePath, finalConfig.exemptPatterns)) {
      return violations;
    }

    // File-level documentation header check — R1.5 (defaults OFF)
    if (fileHeaders) {
      const skipGlobs = finalConfig.headerSkipGlobs ?? HEADER_SKIP_GLOBS_DEFAULT;
      if (!this.matchesAnyGlob(ast.filePath, skipGlobs)) {
        const fileDoc = this.getFileDocumentation(ast, adapter);
        if (!fileDoc || fileDoc.length < finalConfig.minDescriptionLength) {
          violations.push(this.createViolation(
            ast.filePath,
            { line: 1, column: 1 },
            'File lacks proper documentation header',
            'suggestion',
            'file-documentation'
          ));
        }
      }
    }

    // Function documentation — R1.1 through R1.4, R1.6
    if (finalConfig.requireFunctionDocs) {
      const functions = adapter.extractFunctions(ast);
      const docsMinLines = finalConfig.docsMinLines ?? 5;

      for (const func of functions) {
        // Find the AST node for this function
        const node = this.findNodeByLocation(ast.root, func.location.start);

        // R1.1 — Skip anonymous/inline callables
        if (node && this.isAnonymousOrCallback(node, adapter)) {
          continue;
        }

        // R1.2 — Scope filter (public API surface only)
        if (scope === 'public') {
          if (!func.isExported) {
            // If not exported and not a public method of exported class, skip
            if (!func.isMethod) {
              // Named function decl nested inside another function — skip at default scope
              if (node && this.isNestedFunction(node, adapter)) {
                continue;
              }
              // Non-exported top-level function — skip
              continue;
            }
            // It's a method — check visibility
            if (node && this.isNonPublicMethod(node, adapter, sourceCode)) {
              continue;
            }
            // Check if the enclosing class is exported
            if (node && !this.isMethodOfExportedClass(node, adapter, ast)) {
              continue;
            }
          }
        }

        // R1.3 — Minimum-size gate
        const bodyLines = (func.location.end.line - func.location.start.line) + 1;
        if (bodyLines < docsMinLines) {
          continue;
        }

        // Skip if function name matches exempt pattern
        if (this.isExempt(func.name, finalConfig.exemptPatterns)) {
          continue;
        }

        const doc = func.jsDoc || '';

        // R1.6 — Audience-reason message
        if (!doc || doc.length < finalConfig.minDescriptionLength) {
          const reason = func.isExported
            ? `exported function '${func.name}' lacks proper documentation`
            : func.isMethod && func.className
              ? `public method '${func.className}.${func.name}' lacks proper documentation`
              : `function '${func.name}' lacks proper documentation`;

          violations.push(this.createViolation(
            ast.filePath,
            func.location.start,
            reason,
            'suggestion',
            'function-documentation'
          ));
        } else {
          // Param docs
          if (finalConfig.requireParamDocs && func.parameters.length > 0) {
            const missingParamDocs = this.checkParameterDocumentation(
              doc,
              func.parameters.map(p => p.name)
            );
            for (const param of missingParamDocs) {
              violations.push(this.createViolation(
                ast.filePath,
                func.location.start,
                `Function '${func.name}' missing documentation for parameter '${param}'`,
                'suggestion',
                'parameter-documentation'
              ));
            }
          }

          // Return docs
          if (finalConfig.requireReturnDocs &&
              func.returnType &&
              func.returnType !== 'void' &&
              !this.hasReturnDocumentation(doc)) {
            violations.push(this.createViolation(
              ast.filePath,
              func.location.start,
              `Function '${func.name}' missing return value documentation`,
              'suggestion',
              'return-documentation'
            ));
          }
        }
      }
    }

    // Class documentation
    if (finalConfig.requireClassDocs) {
      const classes = adapter.extractClasses(ast);

      for (const cls of classes) {
        // Scope filter for classes
        if (scope === 'public' && !cls.isExported) {
          continue;
        }

        if (this.isExempt(cls.name, finalConfig.exemptPatterns)) {
          continue;
        }

        const doc = cls.jsDoc || '';

        if (!doc || doc.length < finalConfig.minDescriptionLength) {
          violations.push(this.createViolation(
            ast.filePath,
            cls.location.start,
            `Class '${cls.name}' lacks proper documentation`,
            'suggestion',
            'class-documentation'
          ));
        }

        // Method documentation
        if (finalConfig.requireFunctionDocs) {
          for (const method of cls.methods) {
            // Method scope filter
            if (scope === 'public') {
              const methodNode = this.findNodeByLocation(ast.root, method.location.start);
              if (methodNode && this.isNonPublicMethod(methodNode, adapter, sourceCode)) {
                continue;
              }
            }

            if (this.isExempt(method.name, finalConfig.exemptPatterns)) {
              continue;
            }

            const methodDoc = method.jsDoc || '';

            if (!methodDoc || methodDoc.length < finalConfig.minDescriptionLength) {
              violations.push(this.createViolation(
                ast.filePath,
                method.location.start,
                `public method '${cls.name}.${method.name}' lacks proper documentation`,
                'suggestion',
                'method-documentation'
              ));
            }
          }
        }
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
  private isAnonymousOrCallback(node: ASTNode, adapter: LanguageAdapter): boolean {
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
      // (a) Call argument — parent is 'arguments' (args to any call expression)
      if (parentType === 'arguments') {
        return true;
      }

      // (b) JSX attribute value (event handlers, render props)
      if (
        parentType === 'jsx_expression' ||
        parentType === 'jsx_attribute' ||
        parentType === 'jsx_self_closing_element' ||
        parentType === 'jsx_opening_element'
      ) {
        return true;
      }

      // (c) Object literal property value in call arguments
      // chain: arrow → pair → object → arguments → call_expression
      if (parentType === 'pair') {
        const gp = adapter.getParent(parent);
        if (gp) {
          const gpType = adapter.getNodeType(gp);
          if (gpType === 'object' || gpType === 'object_pattern') {
            const ggp = adapter.getParent(gp);
            if (ggp && adapter.getNodeType(ggp) === 'arguments') {
              return true;
            }
          }
        }
      }

      // (c) Array element in call arguments
      if (parentType === 'array') {
        const gp = adapter.getParent(parent);
        if (gp && adapter.getNodeType(gp) === 'arguments') {
          return true;
        }
      }

      // (d) IIFE — the function is the callee of a call expression
      if (parentType === 'call_expression') {
        // Check if this node is in the function/callee position (not in arguments)
        const fnChild = this.getFirstChildOfType(parent, [
          'arrow_function',
          'function_expression',
          'function',
          'identifier',
          'member_expression',
          'call_expression',
        ]);
        if (fnChild) {
          // If the first function-ish child is at the same location, this IS the callee
          if (
            fnChild.location.start.line === node.location.start.line &&
            fnChild.location.start.column === node.location.start.column
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Returns true if a function_declaration node is nested inside another function/method
   * (a helper by construction — R1.1).
   */
  private isNestedFunction(node: ASTNode, adapter: LanguageAdapter): boolean {
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
  private isNonPublicMethod(
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
    const propName = this.getMethodName(node, adapter, sourceCode);
    if (propName && (propName.startsWith('#') || propName.startsWith('_'))) {
      return true;
    }

    return false;
  }

  /**
   * Check if a method's enclosing class is exported.
   */
  private isMethodOfExportedClass(
    node: ASTNode,
    adapter: LanguageAdapter,
    ast: AST
  ): boolean {
    let current = adapter.getParent(node);
    while (current) {
      if (adapter.isClass(current)) {
        // Check export by looking at parent of class node
        const classParent = adapter.getParent(current);
        if (classParent) {
          const classParentType = adapter.getNodeType(classParent);
          if (classParentType === 'export_statement') {
            return true;
          }
          // Also check if class declaration itself has export modifier
          const siblings = adapter.getChildren(classParent);
          for (const sib of siblings) {
            if (adapter.getNodeType(sib) === 'export' || adapter.getNodeType(sib) === 'export_statement') {
              // Verify this export wraps our class
              const exportChildren = adapter.getChildren(sib);
              for (const ec of exportChildren) {
                if (
                  adapter.getNodeType(ec) === 'class_declaration' &&
                  ec.location.start.line === current.location.start.line
                ) {
                  return true;
                }
              }
            }
          }
        }
        // Use extractClasses to check isExported
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

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  /**
   * Check if a file path matches any picomatch glob pattern.
   */
  private matchesAnyGlob(filePath: string, globs: string[]): boolean {
    for (const glob of globs) {
      if (picomatch.isMatch(filePath, glob)) {
        return true;
      }
    }
    return false;
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

  /**
   * Get the name of a method definition node.
   */
  private getMethodName(
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
  private getFirstChildOfType(node: ASTNode, types: string[]): ASTNode | null {
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
  private getFileDocumentation(ast: AST, adapter: LanguageAdapter): string | null {
    const firstChild = ast.root.children?.[0];
    if (firstChild) {
      return adapter.getDocumentation(firstChild);
    }
    return null;
  }

  /**
   * Find a node by its location via BFS.
   */
  private findNodeByLocation(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
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
   * Check which parameters are missing documentation.
   */
  private checkParameterDocumentation(doc: string, paramNames: string[]): string[] {
    const missingParams: string[] = [];

    for (const param of paramNames) {
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
  private hasReturnDocumentation(doc: string): boolean {
    return /@returns?\b/i.test(doc);
  }
}
