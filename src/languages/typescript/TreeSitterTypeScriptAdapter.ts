/**
 * Tree-sitter TypeScript/JavaScript adapter implementing the LanguageAdapter interface.
 *
 * Uses web-tree-sitter WASM parsers behind the adapter seam — no TypeScript compiler API.
 * Supports .ts, .tsx, .js, and .jsx files.
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { getParser, parseWithRecovery } from '../tree-sitter/parser.js';
import { toASTNode, toSourceLocation } from '../tree-sitter/converter.js';
import type {
  AST,
  ASTNode,
  ClassInfo,
  DynamicPart,
  ExportInfo,
  FunctionInfo,
  ImportInfo,
  ImportSpecifier,
  InterfaceInfo,
  LanguageAdapter,
  NodePattern,
  ParameterInfo,
  ParseError,
  PropertyInfo,
  ResolvedConstant,
  SourceLocation,
} from '../types.js';

// ---------------------------------------------------------------------------
// Source code storage
// ---------------------------------------------------------------------------

/**
 * Source code indexed by AST, so methods that only receive an AST
 * can recover the original source text.
 */
const sourceCodeMap = new WeakMap<AST, string>();

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class TreeSitterTypeScriptAdapter implements LanguageAdapter {
  readonly name = 'typescript';
  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx'];

  // -- File detection -------------------------------------------------------

  supportsFile(filePath: string): boolean {
    return this.fileExtensions.some((ext) => filePath.endsWith(ext));
  }

  // -- Parsing --------------------------------------------------------------

  async parse(filePath: string, content: string): Promise<AST> {
    const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
    const lang = isTsx ? 'tsx' : filePath.endsWith('.go') ? 'go' : 'typescript';

    const tree = await parseWithRecovery(lang, isTsx, content);
    if (!tree) throw new Error(`Failed to parse file: ${filePath}`);

    const errors: ParseError[] = [];

    // Collect ERROR nodes as parse errors
    this.collectErrors(tree.rootNode, errors);

    const root = toASTNode(tree.rootNode, undefined, lang);

    const ast: AST = {
      root,
      language: lang,
      filePath,
      errors,
      dispose: () => tree.delete(),
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
    const syntaxNode = node.raw as TreeSitterNode;
    return this.extractName(syntaxNode);
  }

  getNodeLocation(node: ASTNode): SourceLocation {
    return node.location;
  }

  // -- Language-Specific Extraction -----------------------------------------

  extractFunctions(ast: AST): FunctionInfo[] {
    const sourceCode = sourceCodeMap.get(ast) ?? '';
    const functions: FunctionInfo[] = [];

    this.walk(ast.root, (node) => {
      const syntaxNode = node.raw as TreeSitterNode;
      const type = syntaxNode.type;

      if (
        type === 'function_declaration' ||
        type === 'generator_function_declaration' ||
        type === 'function_expression' ||
        type === 'arrow_function' ||
        type === 'method_definition'
      ) {
        const fn = this.buildFunctionInfo(syntaxNode, sourceCode);
        if (fn) functions.push(fn);
      }
    });

    return functions;
  }

  extractClasses(ast: AST): ClassInfo[] {
    const sourceCode = sourceCodeMap.get(ast) ?? '';
    const classes: ClassInfo[] = [];

    this.walk(ast.root, (node) => {
      const syntaxNode = node.raw as TreeSitterNode;
      if (syntaxNode.type === 'class_declaration') {
        const cls = this.buildClassInfo(syntaxNode, sourceCode);
        if (cls) classes.push(cls);
      }
    });

    return classes;
  }

  extractImports(ast: AST): ImportInfo[] {
    const sourceCode = sourceCodeMap.get(ast) ?? '';
    const imports: ImportInfo[] = [];

    this.walk(ast.root, (node) => {
      const syntaxNode = node.raw as TreeSitterNode;
      if (syntaxNode.type === 'import_statement') {
        const imp = this.buildImportInfo(syntaxNode, sourceCode);
        if (imp) imports.push(imp);
      }
    });

    return imports;
  }

  extractExports(ast: AST): ExportInfo[] {
    const sourceCode = sourceCodeMap.get(ast) ?? '';
    const exports: ExportInfo[] = [];

    this.walk(ast.root, (node) => {
      const syntaxNode = node.raw as TreeSitterNode;
      if (syntaxNode.type === 'export_statement') {
        const ex = this.buildExportInfo(syntaxNode, sourceCode);
        if (ex) exports.push(ex);
      }
    });

    return exports;
  }

  // -- Pattern Matching Helpers ---------------------------------------------

  isClass(node: ASTNode): boolean {
    const type = (node.raw as TreeSitterNode).type;
    return type === 'class_declaration' || type === 'class_expression';
  }

  isFunction(node: ASTNode): boolean {
    const type = (node.raw as TreeSitterNode).type;
    return (
      type === 'function_declaration' ||
      type === 'function_expression' ||
      type === 'arrow_function' ||
      type === 'generator_function_declaration' ||
      type === 'generator_function_expression'
    );
  }

  isMethod(node: ASTNode): boolean {
    return (node.raw as TreeSitterNode).type === 'method_definition';
  }

  isInterface(node: ASTNode): boolean {
    return (node.raw as TreeSitterNode).type === 'interface_declaration';
  }

  isImport(node: ASTNode): boolean {
    return (node.raw as TreeSitterNode).type === 'import_statement';
  }

  isExport(node: ASTNode): boolean {
    return (node.raw as TreeSitterNode).type === 'export_statement';
  }

  isLoop(node: ASTNode): boolean {
    const type = (node.raw as TreeSitterNode).type;
    return (
      type === 'for_statement' ||
      type === 'for_in_statement' ||
      type === 'while_statement' ||
      type === 'do_statement'
    );
  }

  isConditional(node: ASTNode): boolean {
    const type = (node.raw as TreeSitterNode).type;
    return (
      type === 'if_statement' ||
      type === 'switch_statement' ||
      type === 'ternary_expression' ||
      type === 'switch_case'
    );
  }

  isVariableDeclaration(node: ASTNode): boolean {
    const type = (node.raw as TreeSitterNode).type;
    return (
      type === 'variable_declaration' ||
      type === 'lexical_declaration' ||
      type === 'variable_declarator'
    );
  }

  // -- Advanced Features ----------------------------------------------------

  getTypeInfo(node: ASTNode): string | null {
    const syntaxNode = node.raw as TreeSitterNode;
    return this.extractTypeAnnotation(syntaxNode);
  }

  getDocumentation(node: ASTNode): string | null {
    const syntaxNode = node.raw as TreeSitterNode;
    return this.extractDocumentation(syntaxNode);
  }

  getComplexity(node: ASTNode): number {
    const syntaxNode = node.raw as TreeSitterNode;
    return this.calculateCyclomaticComplexity(syntaxNode);
  }

  // -- Optional: Interfaces -------------------------------------------------

  extractInterfaces(ast: AST): InterfaceInfo[] {
    const sourceCode = sourceCodeMap.get(ast) ?? '';
    const interfaces: InterfaceInfo[] = [];

    this.walk(ast.root, (node) => {
      const syntaxNode = node.raw as TreeSitterNode;
      if (syntaxNode.type === 'interface_declaration') {
        const iface = this.buildInterfaceInfo(syntaxNode, sourceCode);
        if (iface) interfaces.push(iface);
      }
    });

    return interfaces;
  }

  // -- Optional: Raw imports (static, dynamic, require) ----------------------

  extractRawImports(
    _filePath: string,
    content: string
  ): Array<{
    moduleSpecifier: string;
    isStatic: boolean;
    isDynamic: boolean;
    isRequire: boolean;
    line: number;
  }> {
    const results: Array<{
      moduleSpecifier: string;
      isStatic: boolean;
      isDynamic: boolean;
      isRequire: boolean;
      line: number;
    }> = [];

    const parser = getParser('typescript');
    const tree = parser.parse(content);
    if (!tree) return results;

    // Static imports
    this.walkRaw(tree.rootNode, (node) => {
      if (node.type === 'import_statement') {
        const source = this.getChildByType(node, 'string');
        if (source) {
          const specifier = source.text.slice(1, -1); // strip quotes
          results.push({
            moduleSpecifier: specifier,
            isStatic: true,
            isDynamic: false,
            isRequire: false,
            line: source.startPosition.row,
          });
        }
      }

      // Dynamic import(): import('...')
      if (node.type === 'call_expression') {
        const fn = node.firstChild;
        if (fn?.type === 'import') {
          const args = this.getChildByType(node, 'arguments');
          if (args) {
            const strNode = this.findFirstNamedChild(args, 'string');
            if (strNode) {
              const specifier = strNode.text.slice(1, -1);
              results.push({
                moduleSpecifier: specifier,
                isStatic: false,
                isDynamic: true,
                isRequire: false,
                line: strNode.startPosition.row,
              });
            }
          }
        }

        // require('...')
        if (fn?.type === 'identifier' && fn.text === 'require') {
          const args = this.getChildByType(node, 'arguments');
          if (args) {
            const strNode = this.findFirstNamedChild(args, 'string');
            if (strNode) {
              const specifier = strNode.text.slice(1, -1);
              results.push({
                moduleSpecifier: specifier,
                isStatic: false,
                isDynamic: false,
                isRequire: true,
                line: strNode.startPosition.row,
              });
            }
          }
        }
      }
    });

    return results;
  }

  // -- Optional: Exported symbol names --------------------------------------

  extractExportedSymbols(ast: AST): Array<{ name: string; line: number }> {
    const symbols: Array<{ name: string; line: number }> = [];

    this.walk(ast.root, (astNode) => {
      const node = astNode.raw as TreeSitterNode;

      if (node.type === 'export_statement') {
        // export function foo / export class Foo / export const x
        const declaration = this.findFirstNamedChild(node, [
          'function_declaration',
          'class_declaration',
          'lexical_declaration',
          'variable_declaration',
          'interface_declaration',
          'type_alias_declaration',
          'enum_declaration',
        ]);

        if (declaration) {
          const name = this.extractName(declaration);
          if (name) {
            symbols.push({ name, line: declaration.startPosition.row });
            return;
          }
        }

        // export { foo, bar } or export { default }
        const clause = this.getChildByType(node, 'export_clause');
        if (clause) {
          for (const child of clause.namedChildren) {
            if (child.type === 'export_specifier') {
              const nameNode = this.getChildByType(child, 'identifier');
              if (nameNode) {
                symbols.push({
                  name: nameNode.text,
                  line: nameNode.startPosition.row,
                });
              }
            }
          }
        }

        // export default <expression>
        if (node.childForFieldName?.('value')) {
          symbols.push({
            name: 'default',
            line: node.startPosition.row,
          });
        }
      }
    });

    return symbols;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Walk all ASTNodes in a tree (depth-first). */
  private walk(node: ASTNode, visitor: (node: ASTNode) => void): void {
    visitor(node);
    if (node.children) {
      for (const child of node.children) {
        this.walk(child, visitor);
      }
    }
  }

  /** Walk all TreeSitterNodes in a tree (depth-first). */
  private walkRaw(node: TreeSitterNode, visitor: (node: TreeSitterNode) => void): void {
    visitor(node);
    for (const child of node.children) {
      this.walkRaw(child, visitor);
    }
  }

  /** Collect ERROR nodes from tree-sitter's error recovery. */
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

  /** Match an ASTNode against a NodePattern. */
  private matchesPattern(node: ASTNode, pattern: NodePattern): boolean {
    const syntaxNode = node.raw as TreeSitterNode;

    // type matching
    if (pattern.type !== undefined) {
      const types = Array.isArray(pattern.type) ? pattern.type : [pattern.type];
      if (!types.includes(syntaxNode.type)) return false;
    }

    // name matching
    if (pattern.name !== undefined) {
      const nodeName = this.extractName(syntaxNode);
      if (nodeName === null) return false;
      if (typeof pattern.name === 'string') {
        if (nodeName !== pattern.name) return false;
      } else if (pattern.name instanceof RegExp) {
        if (!pattern.name.test(nodeName)) return false;
      }
    }

    // hasChild matching
    if (pattern.hasChild !== undefined) {
      const childNodes = node.children ?? [];
      const hasMatch = childNodes.some((c) =>
        this.matchesPattern(c, pattern.hasChild!)
      );
      if (!hasMatch) return false;
    }

    // hasParent matching
    if (pattern.hasParent !== undefined) {
      if (!node.parent) return false;
      if (!this.matchesPattern(node.parent, pattern.hasParent)) return false;
    }

    // custom predicate
    if (pattern.custom !== undefined) {
      if (!pattern.custom(node)) return false;
    }

    return true;
  }

  /** Extract the name/identifier from a tree-sitter TreeSitterNode. */
  private extractName(node: TreeSitterNode): string | null {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
        // Fallback: find first identifier child
        for (const child of node.namedChildren) {
          if (child.type === 'identifier' || child.type === 'type_identifier') {
            return child.text;
          }
        }
        return null;
      }

      case 'method_definition':
      case 'public_field_definition': {
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
        // property_identifier or string
        for (const child of node.namedChildren) {
          if (
            child.type === 'property_identifier' ||
            child.type === 'string'
          ) {
            return child.text.replace(/^["']|["']$/g, '');
          }
        }
        return null;
      }

      case 'variable_declarator': {
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
        return null;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        // Find the declarator child and extract its name
        for (const child of node.namedChildren) {
          if (child.type === 'variable_declarator') {
            return this.extractName(child);
          }
        }
        return null;
      }

      case 'arrow_function': {
        // Check if assigned to a variable: const foo = () => {}
        const parent = node.parent;
        if (parent?.type === 'variable_declarator') {
          return this.extractName(parent);
        }
        return null;
      }

      case 'function_expression': {
        // Might have a name: const foo = function bar() {}
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
        // Check if assigned to a variable
        const parent = node.parent;
        if (parent?.type === 'variable_declarator') {
          return this.extractName(parent);
        }
        return null;
      }

      case 'property_identifier':
        return node.text;

      case 'identifier':
        return node.text;

      default:
        return null;
    }
  }

  /** Extract a type annotation string from a node. */
  private extractTypeAnnotation(node: TreeSitterNode): string | null {
    // Function return type
    if (
      node.type === 'function_declaration' ||
      node.type === 'method_definition' ||
      node.type === 'arrow_function'
    ) {
      const returnType = node.childForFieldName?.('return_type');
      if (returnType) {
        return returnType.text.replace(/^:\s*/, '').trim();
      }
    }

    // Variable / parameter type annotation
    const typeAnnotation = node.childForFieldName?.('type');
    if (typeAnnotation) {
      return typeAnnotation.text.replace(/^:\s*/, '').trim();
    }

    // Named children that are type_annotation
    for (const child of node.namedChildren) {
      if (child.type === 'type_annotation') {
        return child.text.replace(/^:\s*/, '').trim();
      }
    }

    return null;
  }

  /** Extract JSDoc or leading comment from a node. */
  private extractDocumentation(node: TreeSitterNode): string | null {
    const parent = node.parent;
    if (!parent) return null;

    // Find the node's position among its parent's children by using
    // treeSitter's .equals() — reference equality (===) doesn't hold
    // across different access paths (e.g. node.parent gives a different
    // JS wrapper than accessing through the parent's .children array).
    // We hold the parent's children array in `siblings` to get stable
    // wrappers; look backwards from the node's index for comment nodes.
    const siblings = parent.children;
    let myIndex = -1;
    for (let i = 0; i < siblings.length; i++) {
      if (siblings[i].equals(node)) {
        myIndex = i;
        break;
      }
    }

    if (myIndex === -1) return null;

    // Look backwards through siblings for /** JSDoc comment nodes.
    // Only /**-prefixed comments are JSDoc — // and /* are not.
    const comments: string[] = [];
    for (let i = myIndex - 1; i >= 0; i--) {
      const sibling = siblings[i];
      if (sibling.type === 'comment' && sibling.text.trimStart().startsWith('/**')) {
        comments.unshift(sibling.text);
      } else if (sibling.isNamed) {
        // Stop at the first non-comment, named sibling
        break;
      }
      // Continue past non-named tokens (whitespace, semicolons, etc.)
    }

    if (comments.length > 0) {
      const text = comments.join('\n').trim();
      return this.cleanCommentText(text);
    }

    // When the immediate parent is a wrapper like `export_statement`, it won't
    // contain comment nodes — the JSDoc lives at the grandparent (program) level
    // as a sibling of the wrapper. Ascend and check for an adjacent comment.
    // Adjacency guard prevents misattributing file-level comments: only a
    // comment whose end row is immediately before the wrapper's start row
    // (no blank line gap) is treated as JSDoc for the function inside.
    if (parent.type === 'export_statement' && parent.parent) {
      const gpSiblings = parent.parent.children;
      let parentIndex = -1;
      for (let i = 0; i < gpSiblings.length; i++) {
        if (gpSiblings[i].equals(parent)) {
          parentIndex = i;
          break;
        }
      }

      if (parentIndex > 0) {
        // Look backwards from the export_statement in the grandparent's children
        for (let i = parentIndex - 1; i >= 0; i--) {
          const sibling = gpSiblings[i];
          if (sibling.type === 'comment' && sibling.text.trimStart().startsWith('/**')) {
            // Only attribute if comment is adjacent — no blank line gap.
            // Adjacent: comment ends on line L, export_statement starts on L+1.
            if (sibling.endPosition.row + 1 === parent.startPosition.row) {
              return this.cleanCommentText(sibling.text);
            }
            break; // Found a comment but not adjacent — stop looking
          } else if (sibling.isNamed) {
            break; // Stop at named siblings
          }
        }
      }
    }

    return null;
  }

  /** Strip comment syntax markers. */
  private cleanCommentText(comment: string): string {
    // Block comments: /* ... */ or /** ... */
    if (comment.startsWith('/*')) {
      let inner = comment.slice(2, -2);
      // Strip leading asterisks
      inner = inner
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, ''))
        .join('\n');
      return inner.trim();
    }
    // Line comments: //
    if (comment.startsWith('//')) {
      return comment.replace(/^\/\/\s*/, '').trim();
    }
    return comment.trim();
  }

  /**
   * Cyclomatic complexity: count decision points + 1.
   * Decision points: if, for, while, do, switch_case, ternary, &&, ||.
   */
  private calculateCyclomaticComplexity(node: TreeSitterNode): number {
    let complexity = 1;

    this.walkRaw(node, (child) => {
      if (child === node) return; // don't count the root node itself

      switch (child.type) {
        case 'if_statement':
        case 'for_statement':
        case 'for_in_statement':
        case 'while_statement':
        case 'do_statement':
        case 'switch_case':
        case 'ternary_expression':
        case 'catch_clause':
          complexity++;
          break;
        case 'binary_expression': {
          // && and || create branching paths
          const op = this.getOperator(child);
          if (op === '&&' || op === '||') {
            complexity++;
          }
          break;
        }
      }
    });

    return complexity;
  }

  /** Get the operator text from a binary expression node. */
  private getOperator(node: TreeSitterNode): string | null {
    for (const child of node.children) {
      if (
        !child.isNamed &&
        ['&&', '||', '+', '-', '*', '/', '%', '===', '!==', '==', '!='].includes(
          child.type
        )
      ) {
        return child.type;
      }
    }
    return null;
  }

  // -- Extraction helpers ----------------------------------------------------

  private buildFunctionInfo(
    node: TreeSitterNode,
    sourceCode: string
  ): FunctionInfo | null {
    const name = this.extractName(node);
    if (name === null && node.type !== 'arrow_function') return null;

    const isAsync = this.hasModifier(node, 'async');
    const isMethod = node.type === 'method_definition';
    const isExported = this.isNodeExported(node);
    const returnType = this.extractTypeAnnotation(node);
    const jsDoc = this.extractDocumentation(node);
    const className = isMethod ? this.getEnclosingClassName(node) : undefined;

    const parameters = this.extractParameters(node, sourceCode);

    return {
      name: name ?? '<anonymous>',
      location: toSourceLocation(node),
      parameters,
      returnType: returnType ?? undefined,
      isAsync,
      isExported,
      isMethod,
      className,
      jsDoc: jsDoc ?? undefined,
    };
  }

  private buildClassInfo(
    node: TreeSitterNode,
    sourceCode: string
  ): ClassInfo | null {
    const name = this.extractName(node);
    if (!name) return null;

    const isAbstract = this.hasModifier(node, 'abstract');
    const isExported = this.isNodeExported(node);
    const jsDoc = this.extractDocumentation(node);

    // Extract extends
    let extendsName: string | undefined;
    const extendsClause = node.childForFieldName?.('extends');
    if (extendsClause) {
      const firstTypeChild = extendsClause.namedChildren[0];
      if (firstTypeChild) {
        extendsName = firstTypeChild.text;
      }
    }

    // Extract implements
    let implementsList: string[] | undefined;
    const implementsClause = node.childForFieldName?.('implements');
    if (implementsClause) {
      implementsList = implementsClause.namedChildren.map((c: TreeSitterNode) => c.text);
    }

    // Extract methods
    const classBody = node.childForFieldName?.('body');
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    if (classBody) {
      for (const member of classBody.namedChildren) {
        if (member.type === 'method_definition') {
          const fnInfo = this.buildFunctionInfo(member, sourceCode);
          if (fnInfo) {
            fnInfo.className = name;
            fnInfo.isMethod = true;
            methods.push(fnInfo);
          }
        } else if (
          member.type === 'public_field_definition' ||
          member.type === 'field_definition'
        ) {
          const propInfo = this.buildPropertyInfo(member);
          if (propInfo) properties.push(propInfo);
        }
      }
    }

    return {
      name,
      location: toSourceLocation(node),
      methods,
      properties,
      extends: extendsName,
      implements: implementsList,
      isAbstract,
      isExported,
      jsDoc: jsDoc ?? undefined,
    };
  }

  private buildPropertyInfo(node: TreeSitterNode): PropertyInfo | null {
    const name = this.extractName(node);
    if (!name) return null;

    let visibility: 'public' | 'private' | 'protected' | undefined;
    if (this.hasModifier(node, 'private')) visibility = 'private';
    else if (this.hasModifier(node, 'protected')) visibility = 'protected';
    else if (this.hasModifier(node, 'public')) visibility = 'public';

    const isStatic = this.hasModifier(node, 'static');
    const isReadonly = this.hasModifier(node, 'readonly');
    const type = this.extractTypeAnnotation(node);

    return {
      name,
      type: type ?? undefined,
      visibility,
      isStatic,
      isReadonly,
    };
  }

  private buildImportInfo(
    node: TreeSitterNode,
    _sourceCode: string
  ): ImportInfo | null {
    // import source
    const sourceNode = node.childForFieldName?.('source');
    if (!sourceNode) return null;

    const source = sourceNode.text.slice(1, -1); // strip quotes
    const specifiers: ImportSpecifier[] = [];

    // import defaultExport from 'module'
    // import * as namespace from 'module'
    // import { named } from 'module'
    //
    // Tree-sitter nests named imports inside import_clause -> named_imports,
    // so we walk into import_clause children recursively.
    const collectSpecifiers = (child: TreeSitterNode): void => {
      if (child.type === 'import_specifier') {
        const nameNode = child.childForFieldName?.('name');
        const aliasNode = child.childForFieldName?.('alias');
        if (nameNode) {
          specifiers.push({
            name: nameNode.text,
            alias: aliasNode?.text,
            isDefault: false,
            isNamespace: false,
          });
        }
      } else if (child.type === 'namespace_import') {
        const nameNode = child.childForFieldName?.('name');
        if (nameNode) {
          specifiers.push({
            name: nameNode.text,
            isDefault: false,
            isNamespace: true,
          });
        }
      } else if (child.type === 'import_clause') {
        // Default import: `import foo from '...'`
        // import_clause children include an identifier for the default binding
        // and optionally named_imports for mixed imports (`import foo, { bar }`)
        for (const grandchild of child.namedChildren) {
          if (grandchild.type === 'identifier') {
            specifiers.push({
              name: grandchild.text,
              isDefault: true,
              isNamespace: false,
            });
          } else {
            collectSpecifiers(grandchild);
          }
        }
      } else {
        // Recurse into containers: import_clause, named_imports
        for (const grandchild of child.namedChildren) {
          collectSpecifiers(grandchild);
        }
      }
    };
    for (const child of node.namedChildren) {
      collectSpecifiers(child);
    }

    return {
      source,
      specifiers,
      location: toSourceLocation(node),
    };
  }

  private buildExportInfo(
    node: TreeSitterNode,
    _sourceCode: string
  ): ExportInfo | null {
    // export default <expression>
    const isDefault = this.hasChild(node, 'default');

    // export { foo, bar } [from '...']
    const clause = node.childForFieldName?.('clause');
    if (clause?.type === 'export_clause') {
      const sourceNode = node.childForFieldName?.('source');
      const exports: ExportInfo[] = [];

      for (const spec of clause.namedChildren) {
        if (spec.type === 'export_specifier') {
          const nameNode = spec.childForFieldName?.('name');
          if (nameNode) {
            exports.push({
              name: nameNode.text,
              location: toSourceLocation(nameNode),
              isDefault: false,
              source: sourceNode?.text.slice(1, -1),
            });
          }
        }
      }

      // Return first (handled by caller iterating export_statement nodes)
      return exports[0] ?? null;
    }

    // export function/class/const/let/var name
    const declaration = this.findFirstNamedChild(node, [
      'function_declaration',
      'class_declaration',
      'lexical_declaration',
      'variable_declaration',
    ]);

    if (declaration) {
      const name = this.extractName(declaration);
      if (name) {
        return {
          name,
          location: toSourceLocation(node),
          isDefault,
          source: node.childForFieldName?.('source')?.text.slice(1, -1),
        };
      }
    }

    // export default <name> (no declaration)
    if (isDefault) {
      const value = node.childForFieldName?.('value');
      if (value) {
        return {
          name: value.text,
          location: toSourceLocation(node),
          isDefault: true,
        };
      }
    }

    return null;
  }

  private buildInterfaceInfo(
    node: TreeSitterNode,
    _sourceCode: string
  ): InterfaceInfo | null {
    const name = this.extractName(node);
    if (!name) return null;

    const isExported = this.isNodeExported(node);

    // Extends
    let extendsList: string[] | undefined;
    const extendsClause = node.childForFieldName?.('extends');
    if (extendsClause) {
      extendsList = extendsClause.namedChildren.map((c: TreeSitterNode) => c.text);
    }

    // Members
    const body = node.childForFieldName?.('body');
    const members: InterfaceInfo['members'] = [];

    if (body) {
      for (const member of body.namedChildren) {
        if (member.type === 'method_signature') {
          const memberName = member.childForFieldName?.('name')?.text;
          if (memberName) {
            members.push({
              name: memberName,
              type: 'method',
              location: toSourceLocation(member),
            });
          }
        } else if (member.type === 'property_signature') {
          const memberName = member.childForFieldName?.('name')?.text;
          if (memberName) {
            members.push({
              name: memberName,
              type: 'property',
              location: toSourceLocation(member),
            });
          }
        }
      }
    }

    return {
      name,
      location: toSourceLocation(node),
      members,
      extends: extendsList,
      isExported,
    };
  }

  // -- Parameter extraction --------------------------------------------------

  private extractParameters(
    node: TreeSitterNode,
    sourceCode: string
  ): ParameterInfo[] {
    const params: ParameterInfo[] = [];
    const formalParams = node.childForFieldName?.('parameters');

    if (!formalParams) return params;

    for (const child of formalParams.namedChildren) {
      if (child.type === 'required_parameter' || child.type === 'optional_parameter') {
        const paramNode = child.childForFieldName?.('pattern');
        const name = paramNode?.text ?? child.firstNamedChild?.text;
        const isOptional = child.type === 'optional_parameter';
        const typeNode = child.childForFieldName?.('type');
        let defaultValue: string | undefined;

        // Check for a default value
        const valueNode = child.childForFieldName?.('value');
        if (valueNode) {
          defaultValue = valueNode.text;
        }

        if (name) {
          params.push({
            name,
            type: typeNode?.text.replace(/^:\s*/, ''),
            optional: isOptional,
            defaultValue,
          });
        }
      }
    }

    return params;
  }

  // -- Context helpers -------------------------------------------------------

  /** Check if a node has an `async` modifier keyword. */
  private hasModifier(node: TreeSitterNode, modifier: string): boolean {
    for (const child of node.children) {
      if (!child.isNamed && child.type === modifier) return true;
      // tree-sitter may represent modifiers as named decorator/modifier nodes
      if (
        child.isNamed &&
        (child.type === modifier ||
          child.type === 'accessibility_modifier' ||
          child.type === 'override_modifier' ||
          child.type === 'readonly' ||
          child.type === 'static' ||
          child.type === 'abstract')
      ) {
        if (child.text === modifier) return true;
      }
    }
    return false;
  }

  /** Check if a node is under an export_statement. */
  private isNodeExported(node: TreeSitterNode): boolean {
    const parent = node.parent;
    if (parent?.type === 'export_statement') return true;

    // Also check for `export` keyword on the node itself (TS module syntax)
    for (const child of node.children) {
      if (!child.isNamed && child.type === 'export') return true;
    }
    return false;
  }

  /** Get the enclosing class name for a method. */
  private getEnclosingClassName(node: TreeSitterNode): string | undefined {
    let current = node.parent;
    while (current) {
      if (current.type === 'class_declaration') {
        return this.extractName(current) ?? undefined;
      }
      current = current.parent ?? null;
    }
    return undefined;
  }

  // -- Tree traversal helpers ------------------------------------------------

  /** Find first child of node matching one of the given types. */
  private getChildByType(
    node: TreeSitterNode,
    type: string
  ): TreeSitterNode | null {
    for (const child of node.children) {
      if (child.type === type) return child;
    }
    return null;
  }

  /** Find the first named child matching one of the given types. */
  private findFirstNamedChild(
    node: TreeSitterNode,
    types: string | string[]
  ): TreeSitterNode | null {
    const typeSet = Array.isArray(types) ? new Set(types) : new Set([types]);
    for (const child of node.namedChildren) {
      if (typeSet.has(child.type)) return child;
    }
    return null;
  }

  /** Check if node has a direct child (named or anonymous) with the given text. */
  private hasChild(node: TreeSitterNode, text: string): boolean {
    for (const child of node.children) {
      if (child.text === text || child.type === text) return true;
    }
    return false;
  }

  // -- String Construction Capabilities (v3.4.7) ----------------------------

  /**
   * Returns true when the node is a dynamically-constructed string in TS/JS:
   * - template_string with template_substitution children
   * - binary_expression with + operator (string concatenation)
   * - call_expression with .concat() method
   *   String-like identifiers and plain string literals are never dynamic.
   */
  isDynamicStringConstruction(node: ASTNode): boolean {
    const type = (node.raw as TreeSitterNode).type;

    if (type === 'template_string') {
      // template_string is dynamic only if it has template_substitution children
      for (const child of node.children ?? []) {
        if ((child.raw as TreeSitterNode).type === 'template_substitution') {
          return true;
        }
      }
      return false;
    }

    if (type === 'binary_expression') {
      // Check for string concatenation: operands include a string literal
      const children = node.children ?? [];
      const hasStringLiteral = children.some(
        c => (c.raw as TreeSitterNode).type === 'string'
      );
      return hasStringLiteral;
    }

    if (type === 'call_expression') {
      // Check for .concat() calls
      const text = (node.raw as TreeSitterNode).text;
      if (text.includes('.concat(') || text.includes('?.concat(')) return true;

      // Recurse into arguments: query(binaryExpression) where the argument
      // itself is a dynamic string construction.
      for (const child of node.children ?? []) {
        if ((child.raw as TreeSitterNode).type === 'arguments') {
          for (const arg of child.children ?? []) {
            const argType = (arg.raw as TreeSitterNode).type;
            if (argType === '(' || argType === ')' || argType === ',') continue;
            if (this.isDynamicStringConstruction(arg)) return true;
          }
        }
      }
      return false;
    }

    return false;
  }

  /**
   * Extracts dynamic sub-parts from a string construction node.
   * Returns template_substitution text for template literals,
   * non-string-literal operands for binary expressions,
   * and non-literal arguments for concat calls.
   */
  getDynamicParts(node: ASTNode, sourceCode: string): DynamicPart[] {
    const type = (node.raw as TreeSitterNode).type;
    const parts: DynamicPart[] = [];

    // For call_expressions (other than .concat), walk into the first
    // argument that is itself a dynamic string construction.
    if (type === 'call_expression') {
      const text = (node.raw as TreeSitterNode).text;
      // .concat() handled below
      if (!text.includes('.concat(') && !text.includes('?.concat(')) {
        for (const child of node.children ?? []) {
          if ((child.raw as TreeSitterNode).type === 'arguments') {
            for (const arg of child.children ?? []) {
              const argType = (arg.raw as TreeSitterNode).type;
              if (argType === '(' || argType === ')' || argType === ',') continue;
              if (this.isDynamicStringConstruction(arg)) {
                return this.getDynamicParts(arg, sourceCode);
              }
            }
          }
        }
      }
    }

    if (type === 'template_string') {
      for (const child of node.children ?? []) {
        if ((child.raw as TreeSitterNode).type === 'template_substitution') {
          const text = sourceCode.slice(child.range[0], child.range[1]);
          // Strip the ${ } wrapper to get the inner identifier/expression
          // tree-sitter: template_substitution text includes ${ and }
          const inner = text.startsWith('${') ? text.slice(2, -1).trim() : text;
          const isId = /^[$\p{L}_][\p{L}\p{N}_$]*$/u.test(inner);
          // Extract the actual identifier node from inside the template_substitution
          // (tree-sitter nests it as: ${ <identifier> }), so resolveLocalConstant
          // can use its range to extract the raw name.
          let idNode: ASTNode | undefined;
          if (isId) {
            for (const subChild of child.children ?? []) {
              const subType = (subChild.raw as TreeSitterNode).type;
              if (subType === 'identifier') {
                idNode = subChild;
                break;
              }
            }
          }
          parts.push({ text: inner, isIdentifier: isId, node: idNode ?? (isId ? child : undefined) });
        }
      }
      return parts;
    }

    if (type === 'binary_expression') {
      for (const child of node.children ?? []) {
        const childType = (child.raw as TreeSitterNode).type;
        if (childType !== 'string' && childType !== '+' && childType !== 'template_string') {
          const text = sourceCode.slice(child.range[0], child.range[1]);
          const isId = /^[$\p{L}_][\p{L}\p{N}_$]*$/u.test(text.trim());
          parts.push({ text: text.trim(), isIdentifier: isId, node: isId ? child : undefined });
        }
      }
      return parts;
    }

    if (type === 'call_expression') {
      // .concat() — arguments after the first are dynamic
      for (const child of node.children ?? []) {
        if ((child.raw as TreeSitterNode).type === 'arguments') {
          for (const arg of child.children ?? []) {
            const argType = (arg.raw as TreeSitterNode).type;
            if (argType !== '(' && argType !== ')' && argType !== ',') {
              const text = (arg.raw as TreeSitterNode).text.trim();
              const isId = /^[$\p{L}_][\p{L}\p{N}_$]*$/u.test(text);
              parts.push({ text, isIdentifier: isId, node: isId ? arg : undefined });
            }
          }
        }
      }
      return parts;
    }

    return parts;
  }

  /**
   * Resolves a local const/let/var declaration for an identifier node.
   * Searches within the enclosing function scope for the declaration site.
   * Returns null when the identifier is a parameter, complex expression,
   * or cannot be statically resolved.
   */
  resolveLocalConstant(identifierNode: ASTNode, ast: AST, sourceCode: string): ResolvedConstant | null {
    const idName = sourceCode.slice(identifierNode.range[0], identifierNode.range[1]).trim();
    if (!idName) return null;

    // Find the enclosing function or file scope.  First search within
    // the enclosing function; if not found, fall back to the program-level
    // (module) scope — constants declared at module level are accessible
    // inside any function in that module.
    const enclosing = this.findEnclosingScope(identifierNode, ast);
    const scopeRoot = enclosing ?? ast.root;
    let declNode = this.findDeclarationInScope(scopeRoot, idName);
    // If the enclosing scope is a function (not the program) and we didn't
    // find the declaration there, also search the program-level scope.
    if (!declNode && enclosing && enclosing !== ast.root) {
      declNode = this.findDeclarationInScope(ast.root, idName);
    }
    // If still not found in local declarations, check if the identifier
    // is imported (import { X } from … or import X from …).  Imported
    // symbols are compile-time constants — they're resolved at link time,
    // not at runtime, so user input cannot reach them via import bindings.
    if (!declNode) {
      const importResult = this.resolveImportConstant(idName, ast);
      if (importResult) return importResult;

      // tree-sitter-typescript (v0.x) parses both "for…in" and "for…of"
      // as `for_in_statement`.  The loop variable is a bare `identifier`
      // child — NOT wrapped in `variable_declarator` / `lexical_declaration`.
      // Walk up from the identifier to a `for_in_statement` and trace
      // through the iterable to determine static-ness.
      //   const TABLES = ["a", "b"];
      //   for (const table of TABLES) { … `${table}` … }
      const idRaw = identifierNode.raw as TreeSitterNode;
      let tsCurrent: TreeSitterNode | null = idRaw.parent;
      while (tsCurrent) {
        if (tsCurrent.type === 'for_in_statement') {
          const left = (tsCurrent as any).childForFieldName?.('left') as TreeSitterNode | null;
          if (left && left.text === idName) {
            const right = (tsCurrent as any).childForFieldName?.('right') as TreeSitterNode | null;
            if (right && right.type === 'identifier') {
              const iterName = right.text;
              let iterDecl = this.findDeclarationInScope(scopeRoot, iterName);
              if (!iterDecl && enclosing && enclosing !== ast.root) {
                iterDecl = this.findDeclarationInScope(ast.root, iterName);
              }
              if (iterDecl) {
                const iterRaw = iterDecl.raw as TreeSitterNode;
                const iterValue = (iterRaw as any).childForFieldName?.('value') as TreeSitterNode | null;
                const iterLine = iterDecl.location.start.line;
                const iterReassigned = this.hasReassignment(scopeRoot, iterName, iterLine)
                  || (enclosing && enclosing !== ast.root ? this.hasReassignment(ast.root, iterName, iterLine) : false);
                if (!iterReassigned && this.isStaticValueNode(iterValue)) {
                  const initText = iterValue ? sourceCode.slice(iterValue.startIndex, iterValue.endIndex).trim() : '';
                  return { initText, isStatic: true, declLine: iterDecl.location.start.line };
                }
              }
            }
          }
          break;
        }
        tsCurrent = tsCurrent.parent;
      }
      return null;
    }

    // Extract value from AST (handles multiline declarations that the old
    // regex missed — `.` doesn't match `\n` so `.+?` truncated at newlines).
    const raw = declNode.raw as TreeSitterNode;
    const valueNode = (raw as any).childForFieldName?.('value') as TreeSitterNode | null;
    const declLine = declNode.location.start.line;
    // Check for reassignment after declaration
    const reassigned = this.hasReassignment(scopeRoot, idName, declLine);

    // Determine if static by inspecting the value node's AST type.  String
    // literals and substitution-free template strings are compile-time constants
    // regardless of whether they contain `?` placeholders — SQL fragment
    // constants (WHERE clauses, column lists) are just as static as
    // parameterised query strings.
    let isStatic = !reassigned && this.isStaticValueNode(valueNode);

    // For-of / for-in loop variables: the declarator has no `value` field
    // (the iterable is on the for-statement's `right` child).  Trace the
    // iterable to see if all possible loop values are known constants.
    //   const TABLES = ["a", "b"];
    //   for (const table of TABLES) { … `${table}` … }
    if (!isStatic && !valueNode) {
      const forParent = this.findEnclosingForStatement(declNode);
      if (forParent) {
        const forRaw = forParent.raw as TreeSitterNode;
        const iterable = (forRaw as any).childForFieldName?.('right') as TreeSitterNode | null;
        if (iterable && iterable.type === 'identifier') {
          const iterName = iterable.text;
          let iterDecl = this.findDeclarationInScope(scopeRoot, iterName);
          if (!iterDecl && enclosing && enclosing !== ast.root) {
            iterDecl = this.findDeclarationInScope(ast.root, iterName);
          }
          if (iterDecl) {
            const iterRaw = iterDecl.raw as TreeSitterNode;
            const iterValue = (iterRaw as any).childForFieldName?.('value') as TreeSitterNode | null;
            const iterLine = iterDecl.location.start.line;
            const iterReassigned = this.hasReassignment(scopeRoot, iterName, iterLine)
              || (enclosing && enclosing !== ast.root ? this.hasReassignment(ast.root, iterName, iterLine) : false);
            if (!iterReassigned && this.isStaticValueNode(iterValue)) {
              isStatic = true;
            }
          }
        }
      }
    }

    // When the value is a simple identifier (e.g. `table` ← `tables`),
    // trace through to the linked declaration.  This handles patterns like:
    //   const TABLES = ["a", "b"];
    //   for (const table of TABLES) { … `${table}` … }
    // where the variable's value is known at compile time because the
    // iterable is a constant array.
    if (!isStatic && valueNode && valueNode.type === 'identifier') {
      const linkedName = valueNode.text;
      if (linkedName && linkedName !== idName) {
        let linkedDecl = this.findDeclarationInScope(scopeRoot, linkedName);
        if (!linkedDecl && enclosing && enclosing !== ast.root) {
          linkedDecl = this.findDeclarationInScope(ast.root, linkedName);
        }
        if (linkedDecl) {
          const linkedRaw = linkedDecl.raw as TreeSitterNode;
          const linkedValue = (linkedRaw as any).childForFieldName?.('value') as TreeSitterNode | null;
          const linkedLine = linkedDecl.location.start.line;
          const linkedReassigned = this.hasReassignment(scopeRoot, linkedName, linkedLine)
            || (enclosing && enclosing !== ast.root ? this.hasReassignment(ast.root, linkedName, linkedLine) : false);
          if (!linkedReassigned && this.isStaticValueNode(linkedValue)) {
            isStatic = true;
          }
        }
      }
    }

    // Extract init text from the value node; fall back to the full declaration.
    let initText: string;
    if (valueNode) {
      initText = sourceCode.slice(valueNode.startIndex, valueNode.endIndex).trim();
    } else {
      // No initializer node — try regex as a last resort.
      const declText = sourceCode.slice(declNode.range[0], declNode.range[1]);
      const declMatch = declText.match(
        /^(?:const|let|var)\s+(\w+)\s*=\s*(.+?);?\s*$|^(\w+)\s*=\s*(.+?);?\s*$/s,
      );
      initText = declMatch
        ? (declMatch[2] ?? declMatch[4]).replace(/;\s*$/, '').trim()
        : '';
    }

    return { initText, isStatic, declLine };
  }

  /** Determine whether a tree-sitter value node represents a static (compile-time
   *  constant) expression — no variables, function calls, or runtime evaluation. */
  private isStaticValueNode(node: TreeSitterNode | null): boolean {
    if (!node) return false;

    const type = node.type;

    // Literals that are trivially compile-time constants.
    if (type === 'string') return true;
    if (type === 'number') return true;
    if (type === 'true' || type === 'false' || type === 'null' || type === 'undefined') return true;

    // Template strings: static only when they contain no ${…} substitutions.
    if (type === 'template_string') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === 'template_substitution') return false;
      }
      return true;
    }

    // Array literals: static when all elements are compile-time constants.
    // This enables tracing through patterns like:
    //   const TABLES = ["a", "b"];
    //   for (const t of TABLES) { … `${t}` … }
    // where every possible value of `t` is known at compile time.
    if (type === 'array') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        // Skip punctuation (commas, brackets) — only inspect value children.
        if (child && child.type !== ',' && child.type !== '[' && child.type !== ']') {
          if (!this.isStaticValueNode(child)) return false;
        }
      }
      return true;
    }

    // Everything else (identifiers, call expressions, binary expressions,
    // object literals, regexes, etc.) is conservatively treated as non-static.
    return false;
  }

  /** Walk the parent chain to find the enclosing function scope node. */
  private findEnclosingScope(node: ASTNode, ast: AST): ASTNode | null {
    let current: ASTNode | null = node;
    while (current) {
      const type = (current.raw as TreeSitterNode).type;
      if (
        type === 'function_declaration' ||
        type === 'arrow_function' ||
        type === 'function_expression' ||
        type === 'generator_function_declaration' ||
        type === 'method_definition' ||
        type === 'program'
      ) {
        return current;
      }
      current = current.parent ?? null;
    }
    return ast.root; // fallback to file-level
  }

  /** Walk the parent chain from a variable_declarator to find an enclosing
   *  for_of_statement or for_in_statement, if any.  Returns the for-statement
   *  node, or null if the declarator is not a loop variable. */
  private findEnclosingForStatement(declNode: ASTNode): ASTNode | null {
    const parent = declNode.parent;
    if (!parent) return null;
    const pType = (parent.raw as TreeSitterNode).type;
    // The declarator's parent is lexical_declaration; the for-statement
    // is the parent of that.
    if (pType === 'lexical_declaration' || pType === 'variable_declaration') {
      const grandparent = parent.parent;
      if (!grandparent) return null;
      const gpType = (grandparent.raw as TreeSitterNode).type;
      if (gpType === 'for_of_statement' || gpType === 'for_in_statement') {
        return grandparent;
      }
    }
    return null;
  }

  /** Find a variable_declarator node within scopeRoot whose name is targetName. */
  private findDeclarationInScope(scopeRoot: ASTNode, targetName: string): ASTNode | null {
    const results: ASTNode[] = [];
    this.walk(scopeRoot, (astNode) => {
      const t = (astNode.raw as TreeSitterNode).type;
      if (t === 'variable_declarator') {
        const raw = astNode.raw as TreeSitterNode;
        const nameNode = (raw as any).childForFieldName?.('name') ?? null;
        const name = nameNode ? nameNode.text : '?';
        const parent = astNode.parent;
        if (parent) {
          const pType = (parent.raw as TreeSitterNode).type;
          if (pType === 'lexical_declaration' || pType === 'variable_declaration') {
            if (name === targetName) {
              results.push(astNode);
            }
          }
        }
      }
    });
    return results.length > 0 ? results[0] : null;
  }

  /** Resolve an identifier to an imported symbol.  Handles named imports
   *  (`import { FOO } from …`) and default imports (`import FOO from …`).
   *  Imported symbols are compile-time constants — they are resolved at link
   *  time, not at runtime, so user input cannot reach them through import
   *  bindings (ES module bindings are immutable and live-read-only). */
  private resolveImportConstant(name: string, ast: AST): ResolvedConstant | null {
    const results: Array<{ isStatic: true; declLine: number }> = [];
    this.walk(ast.root, (astNode) => {
      // Early exit — first match wins.
      if (results.length > 0) return;

      const raw = astNode.raw as TreeSitterNode;
      const type = raw.type;

      if (type === 'import_specifier') {
        // named import: import { X } from …  or  import { X as Y } from …
        const nameNode = (raw as any).childForFieldName?.('name') as TreeSitterNode | null;
        const aliasNode = (raw as any).childForFieldName?.('alias') as TreeSitterNode | null;
        const resolvedName = aliasNode?.text ?? nameNode?.text;
        if (resolvedName === name) {
          results.push({ isStatic: true, declLine: astNode.location.start.line });
        }
      } else if (type === 'import' && (astNode.parent?.raw as TreeSitterNode)?.type === 'import_clause') {
        // default import: import X from … — the 'import' node is a child of
        // 'import_clause', and its text is the local binding name.
        if (raw.text === name) {
          results.push({ isStatic: true, declLine: astNode.location.start.line });
        }
      }
    });

    if (results.length === 0) return null;

    const r = results[0];
    return {
      initText: '__imported_constant__',
      isStatic: true,
      declLine: r.declLine,
    };
  }

  /** Check if identifier targetName is reassigned in scope after declLine. */
  private hasReassignment(scopeRoot: ASTNode, targetName: string, declLine: number): boolean {
    let found = false;
    this.walk(scopeRoot, (astNode) => {
      if (found) return;
      const t = (astNode.raw as TreeSitterNode).type;
      if (t === 'assignment_expression') {
        if (astNode.location.start.line < declLine) return;
        const raw = astNode.raw as TreeSitterNode;
        const left = (raw as any).childForFieldName?.('left') as TreeSitterNode | null;
        if (left && left.type === 'identifier' && left.text === targetName) {
          found = true;
        }
      }
    });
    return found;
  }

  /** Helper: extract text of arguments from a call_expression node. */
  private getCallArguments(node: ASTNode): string[] {
    const args: string[] = [];
    for (const child of node.children ?? []) {
      if ((child.raw as TreeSitterNode).type === 'arguments') {
        for (const arg of child.children ?? []) {
          const argType = (arg.raw as TreeSitterNode).type;
          if (argType !== '(' && argType !== ')' && argType !== ',') {
            args.push((arg.raw as TreeSitterNode).text);
          }
        }
      }
    }
    return args;
  }
}
