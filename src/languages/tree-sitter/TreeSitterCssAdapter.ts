/**
 * CSS/SCSS language adapter using tree-sitter-css WASM parser.
 *
 * CSS and SCSS files have no functions, classes, imports, or exports —
 * those methods return empty arrays. The adapter exists to enable AST-based
 * style declaration extraction for the style intelligence system (Spec 10).
 *
 * SCSS files are parsed with the CSS grammar. SCSS is a superset of CSS;
 * SCSS-specific constructs ($variables, @mixin, @include, @each, @for, @if)
 * will appear as parse errors but basic CSS declarations within rule sets
 * parse correctly.
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { getParser } from './parser.js';
import { toASTNode, toSourceLocation } from './converter.js';
import type {
  AST,
  ASTNode,
  ClassInfo,
  ExportInfo,
  FunctionInfo,
  ImportInfo,
  InterfaceInfo,
  LanguageAdapter,
  NodePattern,
  ParameterInfo,
  ParseError,
  PropertyInfo,
  SourceLocation,
} from '../types.js';

// ---------------------------------------------------------------------------
// Source code storage
// ---------------------------------------------------------------------------

const sourceCodeMap = new WeakMap<AST, string>();

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class TreeSitterCssAdapter implements LanguageAdapter {
  readonly name = 'css';
  readonly fileExtensions = ['.css', '.scss'];

  // -- File detection -------------------------------------------------------

  supportsFile(filePath: string): boolean {
    return filePath.endsWith('.css') || filePath.endsWith('.scss');
  }

  // -- Parsing --------------------------------------------------------------

  async parse(filePath: string, content: string): Promise<AST> {
    const parser = getParser('css');
    const tree = parser.parse(content);
    if (!tree) throw new Error(`Failed to parse CSS/SCSS file: ${filePath}`);

    const errors: ParseError[] = [];
    this.collectErrors(tree.rootNode, errors);

    const root = toASTNode(tree.rootNode, undefined, 'css');

    const ast: AST = {
      root,
      language: 'css',
      filePath,
      errors,
    };

    sourceCodeMap.set(ast, content);
    return ast;
  }

  // -- AST Navigation -------------------------------------------------------

  findNodes(ast: AST, pattern: NodePattern): ASTNode[] {
    const results: ASTNode[] = [];
    this.walk(ast.root, (node) => {
      if (this.matchesPattern(node, pattern)) {
        results.push(node);
      }
    });
    return results;
  }

  getParent(node: ASTNode): ASTNode | null {
    return node.parent ?? null;
  }

  getChildren(node: ASTNode): ASTNode[] {
    return node.children ?? [];
  }

  getSiblings(node: ASTNode): ASTNode[] {
    if (!node.parent?.children) return [];
    return node.parent.children.filter((c) => c !== node);
  }

  // -- Node Information -----------------------------------------------------

  getNodeType(node: ASTNode): string {
    return node.type;
  }

  getNodeText(node: ASTNode, sourceCode: string): string {
    return sourceCode.slice(node.range[0], node.range[1]);
  }

  getNodeName(node: ASTNode): string | null {
    const n = node.raw as TreeSitterNode;

    // CSS rule sets don't have named children in the tree-sitter sense,
    // but we can extract meaningful names for certain node types.
    switch (n.type) {
      case 'at_rule': {
        // @media, @supports, @keyframes, etc. — the keyword child has the name
        const keyword = n.childForFieldName?.('keyword');
        if (keyword) return `@${keyword.text}`;
        return null;
      }
      case 'declaration': {
        // property: value — extract the property name
        const prop = n.childForFieldName?.('property');
        if (prop) return prop.text;
        return null;
      }
      case 'class_name':
      case 'id_name':
      case 'tag_name':
      case 'feature_name':
      case 'keyframe_block_name':
        return n.text;
      default:
        return null;
    }
  }

  getNodeLocation(node: ASTNode): SourceLocation {
    return node.location;
  }

  // -- Language-Specific Extraction -----------------------------------------
  // CSS/SCSS has no functions, classes, imports, or exports.

  extractFunctions(_ast: AST): FunctionInfo[] {
    return [];
  }

  extractClasses(_ast: AST): ClassInfo[] {
    return [];
  }

  extractImports(_ast: AST): ImportInfo[] {
    return [];
  }

  extractExports(_ast: AST): ExportInfo[] {
    return [];
  }

  // -- Pattern Matching Helpers ---------------------------------------------
  // CSS/SCSS has none of these programming-language constructs.

  isClass(_node: ASTNode): boolean {
    return false;
  }

  isFunction(_node: ASTNode): boolean {
    return false;
  }

  isMethod(_node: ASTNode): boolean {
    return false;
  }

  isInterface(_node: ASTNode): boolean {
    return false;
  }

  isImport(_node: ASTNode): boolean {
    return false;
  }

  isExport(_node: ASTNode): boolean {
    return false;
  }

  isLoop(_node: ASTNode): boolean {
    return false;
  }

  isConditional(_node: ASTNode): boolean {
    return false;
  }

  isVariableDeclaration(_node: ASTNode): boolean {
    return false;
  }

  // -- Advanced Features ----------------------------------------------------

  getTypeInfo(_node: ASTNode): string | null {
    return null;
  }

  getDocumentation(_node: ASTNode): string | null {
    // CSS/SCSS uses comments, but they're not attached to any particular node
    // in a way that maps cleanly to "documentation for this node".
    return null;
  }

  getComplexity(_node: ASTNode): number {
    return 0;
  }

  // -- Optional: Interfaces -------------------------------------------------

  extractInterfaces(_ast: AST): InterfaceInfo[] {
    return [];
  }

  // -- Optional: Raw imports ------------------------------------------------

  extractRawImports(
    _filePath: string,
    _content: string,
  ): Array<{
    moduleSpecifier: string;
    isStatic: boolean;
    isDynamic: boolean;
    isRequire: boolean;
    line: number;
  }> {
    return [];
  }

  // -- Optional: Exported symbols -------------------------------------------

  extractExportedSymbols(_ast: AST): Array<{ name: string; line: number }> {
    return [];
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private walk(node: ASTNode, visitor: (node: ASTNode) => void): void {
    visitor(node);
    if (node.children) {
      for (const child of node.children) {
        this.walk(child, visitor);
      }
    }
  }

  private collectErrors(node: TreeSitterNode, errors: ParseError[]): void {
    if (node.type === 'ERROR' || node.isError) {
      errors.push({
        message: `Parse error near "${node.text.slice(0, 50)}"`,
        location: toSourceLocation(node),
        severity: 'error',
      });
    }
    for (const child of node.children) {
      this.collectErrors(child, errors);
    }
  }

  private matchesPattern(node: ASTNode, pattern: NodePattern): boolean {
    const syntaxNode = node.raw as TreeSitterNode;

    if (pattern.type !== undefined) {
      const types = Array.isArray(pattern.type) ? pattern.type : [pattern.type];
      if (!types.includes(syntaxNode.type)) return false;
    }

    if (pattern.name !== undefined) {
      const nodeName = this.getNodeName(node);
      if (nodeName === null) return false;
      if (typeof pattern.name === 'string') {
        if (nodeName !== pattern.name) return false;
      } else if (pattern.name instanceof RegExp) {
        if (!pattern.name.test(nodeName)) return false;
      }
    }

    if (pattern.hasChild !== undefined) {
      const childNodes = node.children ?? [];
      if (!childNodes.some((c) => this.matchesPattern(c, pattern.hasChild!))) {
        return false;
      }
    }

    if (pattern.hasParent !== undefined) {
      if (!node.parent) return false;
      if (!this.matchesPattern(node.parent, pattern.hasParent)) return false;
    }

    if (pattern.custom !== undefined) {
      if (!pattern.custom(node)) return false;
    }

    return true;
  }
}
