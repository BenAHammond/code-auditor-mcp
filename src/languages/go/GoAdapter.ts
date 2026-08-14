/**
 * Go language adapter using tree-sitter-go WASM parser.
 *
 * Provides real AST-based analysis for Go source files. Replaces the previous
 * regex-based stub that returned empty arrays for most queries.
 *
 * The class is split across a small inheritance chain (Spec-33
 * interface-segregation): each link contributes a cohesive slice of the
 * adapter so no single class exceeds the SOLID class-size threshold. The
 * chain is ordered leaf-first (traversal/name/doc/build helpers) so every
 * method's callee lives in an ancestor class.
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

const sourceCodeMap = new WeakMap<AST, string>();

// ---------------------------------------------------------------------------
// Traversal + name/documentation + Go-specific helpers slice (leaf helpers,
// called across later chunks, so they form the base of the chain)
// ---------------------------------------------------------------------------

class GoTraversalHelpers {
  // -- Tree traversal helpers ------------------------------------------------

  protected walk(node: ASTNode, visitor: (node: ASTNode) => void): void {
    visitor(node);
    if (node.children) {
      for (const child of node.children) {
        this.walk(child, visitor);
      }
    }
  }

  protected walkRaw(node: TreeSitterNode, visitor: (node: TreeSitterNode) => void): void {
    visitor(node);
    for (const child of node.children) {
      this.walkRaw(child, visitor);
    }
  }

  protected collectErrors(node: TreeSitterNode, errors: ParseError[]): void {
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

  protected extractName(node: TreeSitterNode): string | null {
    switch (node.type) {
      case 'function_declaration':
      case 'type_spec':
      case 'field_declaration':
      case 'method_spec': {
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
        return null;
      }

      case 'import_spec': {
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
        for (const child of node.namedChildren) {
          if (
            child.type === 'interpreted_string_literal' ||
            child.type === 'raw_string_literal'
          ) {
            return child.text.slice(1, -1);
          }
        }
        return null;
      }

      case 'package_identifier':
      case 'identifier':
        return node.text;

      default:
        return null;
    }
  }

  protected cleanCommentText(comment: string): string {
    if (comment.startsWith('/*')) {
      let inner = comment.slice(2, -2);
      inner = inner
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, ''))
        .join('\n');
      return inner.trim();
    }
    if (comment.startsWith('//')) {
      return comment.replace(/^\/\/\s*/, '').trim();
    }
    return comment.trim();
  }

  protected getOperator(node: TreeSitterNode): string | null {
    for (const child of node.children) {
      if (
        !child.isNamed &&
        ['&&', '||', '+', '-', '*', '/', '%', '==', '!='].includes(child.type)
      ) {
        return child.type;
      }
    }
    return null;
  }

  // -- Go-specific helpers ---------------------------------------------------

  protected isExportedGo(name: string): boolean {
    return name.length > 0 && name[0] === name[0].toUpperCase();
  }

  protected getReceiverType(node: TreeSitterNode): string | undefined {
    const receiver = node.childForFieldName?.('receiver');
    if (!receiver) return undefined;

    for (const child of receiver.namedChildren) {
      if (child.type === 'parameter_declaration') {
        const typeNode = child.childForFieldName?.('type');
        if (typeNode) return typeNode.text;
      }
    }

    return undefined;
  }

  protected getReturnType(node: TreeSitterNode): string | null {
    if (node.type !== 'function_declaration') return null;
    const result = node.childForFieldName?.('result');
    if (result) return result.text.trim();
    return null;
  }

  protected extractParameters(
    node: TreeSitterNode,
    _sourceCode: string
  ): ParameterInfo[] {
    const params: ParameterInfo[] = [];
    const paramList = node.childForFieldName?.('parameters');

    if (!paramList) return params;

    for (const child of paramList.namedChildren) {
      if (child.type === 'parameter_declaration') {
        const nameNode = child.childForFieldName?.('name');
        const typeNode = child.childForFieldName?.('type');
        const name = nameNode?.text ?? typeNode?.text ?? child.text;

        params.push({
          name: name || '<unknown>',
          type: typeNode?.text,
          optional: false,
        });
      }
    }

    return params;
  }

  protected findNamedChildren(node: TreeSitterNode, type: string): TreeSitterNode[] {
    return node.namedChildren.filter((c: TreeSitterNode) => c.type === type);
  }
}

// ---------------------------------------------------------------------------
// Pattern matching + documentation/complexity + build helpers slice
// ---------------------------------------------------------------------------

class GoAnalysis extends GoTraversalHelpers {
  protected matchesPattern(node: ASTNode, pattern: NodePattern): boolean {
    const syntaxNode = node.raw as TreeSitterNode;

    if (pattern.type !== undefined) {
      const types = Array.isArray(pattern.type) ? pattern.type : [pattern.type];
      if (!types.includes(syntaxNode.type)) return false;
    }

    if (pattern.name !== undefined) {
      const nodeName = this.extractName(syntaxNode);
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

  protected extractDocumentation(node: TreeSitterNode): string | null {
    const parent = node.parent;
    if (!parent) return null;

    const siblings = parent.children;
    let myIndex = -1;
    for (let i = 0; i < siblings.length; i++) {
      if (siblings[i].equals(node)) {
        myIndex = i;
        break;
      }
    }

    if (myIndex === -1) return null;

    const comments: string[] = [];
    for (let i = myIndex - 1; i >= 0; i--) {
      const sibling = siblings[i];
      if (sibling.type === 'comment') {
        comments.unshift(sibling.text);
      } else if (sibling.isNamed) {
        break;
      }
    }

    if (comments.length === 0) return null;

    return this.cleanCommentText(comments.join('\n').trim());
  }

  protected calculateComplexity(node: TreeSitterNode): number {
    let complexity = 1;

    this.walkRaw(node, (child) => {
      if (child === node) return;

      switch (child.type) {
        case 'if_statement':
        case 'for_statement':
        case 'switch_statement':
        case 'expression_switch_statement':
        case 'type_switch_statement':
        case 'select_statement':
        case 'type_case_clause':
        case 'expression_case_clause':
        case 'default_case':
        case 'communication_case':
          complexity++;
          break;
        case 'binary_expression': {
          const op = this.getOperator(child);
          if (op === '&&' || op === '||') complexity++;
          break;
        }
      }
    });

    return complexity;
  }

  // -- Build helpers ---------------------------------------------------------

  protected buildFunctionInfo(
    node: TreeSitterNode,
    sourceCode: string
  ): FunctionInfo | null {
    const name = this.extractName(node);
    const isMethod = node.childForFieldName?.('receiver') != null;
    const isExported = name ? this.isExportedGo(name) : false;
    const className = isMethod ? this.getReceiverType(node) : undefined;
    const returnType = this.getReturnType(node);
    const jsDoc = this.extractDocumentation(node);
    const parameters = this.extractParameters(node, sourceCode);

    return {
      name: name ?? '<anonymous>',
      location: toSourceLocation(node),
      parameters,
      returnType: returnType ?? undefined,
      isAsync: false,
      isExported,
      isMethod,
      className,
      jsDoc: jsDoc ?? undefined,
    };
  }

  protected buildStructAsClass(
    _typeSpec: TreeSitterNode,
    nameNode: TreeSitterNode,
    typeNode: TreeSitterNode,
    allFunctions: FunctionInfo[],
    _sourceCode: string
  ): ClassInfo | null {
    const name = nameNode.text;
    const isExported = this.isExportedGo(name);
    // A single `type Foo struct { ... }` declaration carries its doc comment
    // as a sibling of the enclosing `type_declaration`; a grouped
    // `type ( ... )` declaration carries it as a sibling of the `type_spec`.
    // Try the `type_spec` level first, then fall back to the `type_declaration`.
    let jsDoc = this.extractDocumentation(_typeSpec);
    if (!jsDoc && _typeSpec.parent?.type === 'type_declaration') {
      jsDoc = this.extractDocumentation(_typeSpec.parent);
    }

    // Collect fields as properties
    const properties: PropertyInfo[] = [];
    for (const field of this.findNamedChildren(typeNode, 'field_declaration')) {
      const propName = this.extractName(field);
      const typeNode_ = field.childForFieldName?.('type');
      if (propName) {
        properties.push({
          name: propName,
          type: typeNode_?.text,
          visibility: this.isExportedGo(propName) ? 'public' : 'private',
          isStatic: false,
          isReadonly: false,
        });
      }
    }

    // Match methods with this receiver type
    const methods: FunctionInfo[] = allFunctions.filter(
      (fn) => fn.className === name || fn.className === `*${name}`
    );

    return {
      name,
      location: toSourceLocation(nameNode),
      methods,
      properties,
      isAbstract: false,
      isExported,
      jsDoc: jsDoc ?? undefined,
    };
  }

  protected buildImportInfo(spec: TreeSitterNode): ImportInfo | null {
    let source = '';
    let alias: string | undefined;

    for (const child of spec.namedChildren) {
      if (
        child.type === 'interpreted_string_literal' ||
        child.type === 'raw_string_literal'
      ) {
        source = child.text.slice(1, -1);
      } else if (
        child.type === 'package_identifier' ||
        child.type === 'identifier'
      ) {
        alias = child.text;
      }
    }

    if (!source) return null;

    return {
      source,
      specifiers: [
        {
          name: source,
          alias,
          isDefault: false,
          isNamespace: false,
        },
      ],
      location: toSourceLocation(spec),
    };
  }

  protected buildInterfaceInfo(
    nameNode: TreeSitterNode,
    typeNode: TreeSitterNode
  ): InterfaceInfo | null {
    const name = nameNode.text;
    const isExported = this.isExportedGo(name);
    const members: InterfaceInfo['members'] = [];

    for (const member of typeNode.namedChildren) {
      if (member.type === 'method_spec') {
        const memberNameNode = member.childForFieldName?.('name');
        if (memberNameNode) {
          members.push({
            name: memberNameNode.text,
            type: 'method' as const,
            location: toSourceLocation(member),
          });
        }
      } else if (member.type === 'type_elem') {
        const embeddedName =
          member.childForFieldName?.('name')?.text ?? member.text;
        if (embeddedName) {
          members.push({
            name: embeddedName,
            type: 'property' as const,
            location: toSourceLocation(member),
          });
        }
      }
    }

    return {
      name,
      location: toSourceLocation(nameNode),
      members,
      isExported,
    };
  }
}

// ---------------------------------------------------------------------------
// Parsing + AST navigation slice
// ---------------------------------------------------------------------------

class GoParserCore extends GoAnalysis {
  readonly name = 'go';
  readonly fileExtensions = ['.go'];

  // -- File detection -------------------------------------------------------

  supportsFile(filePath: string): boolean {
    return filePath.endsWith('.go');
  }

  // -- Parsing --------------------------------------------------------------

  async parse(filePath: string, content: string): Promise<AST> {
    const tree = await parseWithRecovery('go', false, content);
    if (!tree) throw new Error(`Failed to parse Go file: ${filePath}`);

    const errors: ParseError[] = [];
    this.collectErrors(tree.rootNode, errors);

    const root = toASTNode(tree.rootNode, undefined, 'go');

    const ast: AST = {
      root,
      language: 'go',
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
    return this.extractName(node.raw as TreeSitterNode);
  }

  getNodeLocation(node: ASTNode): SourceLocation {
    return node.location;
  }
}

// ---------------------------------------------------------------------------
// Language-specific extraction slice
// ---------------------------------------------------------------------------

class GoExtraction extends GoParserCore {
  extractFunctions(ast: AST): FunctionInfo[] {
    const sourceCode = sourceCodeMap.get(ast) ?? '';
    const functions: FunctionInfo[] = [];

    this.walk(ast.root, (astNode) => {
      const node = astNode.raw as TreeSitterNode;
      if (node.type === 'function_declaration') {
        const fn = this.buildFunctionInfo(node, sourceCode);
        if (fn) functions.push(fn);
      }
    });

    return functions;
  }

  extractClasses(ast: AST): ClassInfo[] {
    const sourceCode = sourceCodeMap.get(ast) ?? '';
    const classes: ClassInfo[] = [];

    // Collect all function_declarations so we can match methods to structs
    const allFunctions = this.extractFunctions(ast);

    this.walk(ast.root, (astNode) => {
      const node = astNode.raw as TreeSitterNode;
      if (node.type === 'type_declaration') {
        const specs = this.findNamedChildren(node, 'type_spec');
        for (const spec of specs) {
          const nameNode = spec.childForFieldName?.('name');
          if (!nameNode) continue;

          const typeNode = spec.childForFieldName?.('type');
          if (!typeNode || typeNode.type !== 'struct_type') continue;

          const structInfo = this.buildStructAsClass(
            spec,
            nameNode,
            typeNode,
            allFunctions,
            sourceCode
          );
          if (structInfo) classes.push(structInfo);
        }
      }
    });

    return classes;
  }

  extractImports(ast: AST): ImportInfo[] {
    const imports: ImportInfo[] = [];

    this.walk(ast.root, (astNode) => {
      const node = astNode.raw as TreeSitterNode;
      if (node.type === 'import_declaration') {
        for (const spec of node.namedChildren) {
          if (spec.type === 'import_spec') {
            const imp = this.buildImportInfo(spec);
            if (imp) imports.push(imp);
          }
        }
      }
    });

    return imports;
  }

  extractExports(ast: AST): ExportInfo[] {
    const exports: ExportInfo[] = [];

    this.walk(ast.root, (astNode) => {
      const node = astNode.raw as TreeSitterNode;

      if (node.type === 'function_declaration') {
        const name = this.extractName(node);
        if (name && this.isExportedGo(name)) {
          exports.push({
            name,
            location: toSourceLocation(node),
            isDefault: false,
          });
        }
      } else if (node.type === 'type_declaration') {
        for (const spec of this.findNamedChildren(node, 'type_spec')) {
          const nameNode = spec.childForFieldName?.('name');
          if (nameNode && this.isExportedGo(nameNode.text)) {
            exports.push({
              name: nameNode.text,
              location: toSourceLocation(nameNode),
              isDefault: false,
            });
          }
        }
      } else if (node.type === 'var_declaration') {
        for (const spec of this.findNamedChildren(node, 'var_spec')) {
          const nameNode = spec.childForFieldName?.('name');
          if (nameNode && this.isExportedGo(nameNode.text)) {
            exports.push({
              name: nameNode.text,
              location: toSourceLocation(nameNode),
              isDefault: false,
            });
          }
        }
      }
    });

    return exports;
  }
}

// ---------------------------------------------------------------------------
// Predicates + advanced-features slice
// ---------------------------------------------------------------------------

class GoPredicates extends GoExtraction {
  isClass(node: ASTNode): boolean {
    const n = node.raw as TreeSitterNode;
    if (n.type === 'type_spec') {
      const typeNode = n.childForFieldName?.('type');
      return typeNode?.type === 'struct_type';
    }
    return n.type === 'struct_type';
  }

  isFunction(node: ASTNode): boolean {
    return (node.raw as TreeSitterNode).type === 'function_declaration';
  }

  isMethod(node: ASTNode): boolean {
    const n = node.raw as TreeSitterNode;
    if (n.type !== 'function_declaration') return false;
    return n.childForFieldName?.('receiver') != null;
  }

  isInterface(node: ASTNode): boolean {
    const n = node.raw as TreeSitterNode;
    if (n.type === 'type_spec') {
      const typeNode = n.childForFieldName?.('type');
      return typeNode?.type === 'interface_type';
    }
    return n.type === 'interface_type';
  }

  isImport(node: ASTNode): boolean {
    return (node.raw as TreeSitterNode).type === 'import_declaration';
  }

  isExport(node: ASTNode): boolean {
    return false; // Go has no export keyword
  }

  isLoop(node: ASTNode): boolean {
    return (node.raw as TreeSitterNode).type === 'for_statement';
  }

  isConditional(node: ASTNode): boolean {
    const t = (node.raw as TreeSitterNode).type;
    return (
      t === 'if_statement' ||
      t === 'switch_statement' ||
      t === 'expression_switch_statement' ||
      t === 'type_switch_statement'
    );
  }

  isVariableDeclaration(node: ASTNode): boolean {
    const t = (node.raw as TreeSitterNode).type;
    return (
      t === 'var_declaration' ||
      t === 'short_var_declaration' ||
      t === 'var_spec' ||
      t === 'const_declaration'
    );
  }

  // -- Advanced Features ----------------------------------------------------

  getTypeInfo(node: ASTNode): string | null {
    const n = node.raw as TreeSitterNode;

    if (n.type === 'function_declaration') {
      const result = n.childForFieldName?.('result');
      if (result) return result.text.trim();
    }

    if (n.type === 'var_spec' || n.type === 'const_spec') {
      const typeNode = n.childForFieldName?.('type');
      if (typeNode) return typeNode.text.trim();
    }

    if (n.type === 'field_declaration') {
      const typeNode = n.childForFieldName?.('type');
      if (typeNode) return typeNode.text.trim();
    }

    return null;
  }

  getDocumentation(node: ASTNode): string | null {
    return this.extractDocumentation(node.raw as TreeSitterNode);
  }

  getComplexity(node: ASTNode): number {
    return this.calculateComplexity(node.raw as TreeSitterNode);
  }
}

// ---------------------------------------------------------------------------
// Optional capabilities slice
// ---------------------------------------------------------------------------

class GoOptionalCapabilities extends GoPredicates {
  extractInterfaces(ast: AST): InterfaceInfo[] {
    const interfaces: InterfaceInfo[] = [];

    this.walk(ast.root, (astNode) => {
      const node = astNode.raw as TreeSitterNode;
      if (node.type === 'type_declaration') {
        const specs = this.findNamedChildren(node, 'type_spec');
        for (const spec of specs) {
          const nameNode = spec.childForFieldName?.('name');
          const typeNode = spec.childForFieldName?.('type');

          if (nameNode && typeNode?.type === 'interface_type') {
            const ifaceInfo = this.buildInterfaceInfo(nameNode, typeNode);
            if (ifaceInfo) interfaces.push(ifaceInfo);
          }
        }
      }
    });

    return interfaces;
  }

  // -- Optional: Raw imports ------------------------------------------------

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

    const parser = getParser('go');
    const tree = parser.parse(content);
    if (!tree) return results;

    this.walkRaw(tree.rootNode, (node) => {
      if (node.type === 'import_declaration') {
        for (const spec of node.namedChildren) {
          if (spec.type === 'import_spec') {
            for (const child of spec.namedChildren) {
              if (
                child.type === 'interpreted_string_literal' ||
                child.type === 'raw_string_literal'
              ) {
                results.push({
                  moduleSpecifier: child.text.slice(1, -1),
                  isStatic: true,
                  isDynamic: false,
                  isRequire: false,
                  line: child.startPosition.row,
                });
              }
            }
          }
        }
      }
    });

    return results;
  }

  // -- Optional: Exported symbols -------------------------------------------

  extractExportedSymbols(ast: AST): Array<{ name: string; line: number }> {
    return this.extractExports(ast).map((e) => ({
      name: e.name,
      line: e.location.start.line,
    }));
  }
}

// ---------------------------------------------------------------------------
// Adapter (composes the slices above)
// ---------------------------------------------------------------------------

/**
 * Tree sitter go adapter.
 */
export class TreeSitterGoAdapter extends GoOptionalCapabilities implements LanguageAdapter {
  // -- String Construction Capabilities (v3.4.7) ----------------------------

  /**
   * Returns true when the node is a dynamically-constructed string in Go:
   * - call_expression with fmt.Sprintf / fmt.Sprint / fmt.Sprintf / strings.Join
   * - binary_expression with + operator (string concatenation)
   * Plain string literals (interpreted_string_literal, raw_string_literal)
   * are never dynamic.
   * @param node
   * @returns
   */
  isDynamicStringConstruction(node: ASTNode): boolean {
    const raw = node.raw as TreeSitterNode;
    const type = raw.type;

    if (type === 'call_expression') {
      const func = raw.childForFieldName?.('function');
      if (!func) return false;

      // fmt.Sprintf("format", args...) — dynamic
      // strings.Join(parts, "sep") — dynamic
      // fmt.Sprint(args...) — dynamic
      const funcText = func.text;
      if (funcText === 'fmt.Sprintf' || funcText === 'fmt.Sprintf' ||
          funcText === 'fmt.Sprint' || funcText === 'fmt.Sprintln' ||
          funcText === 'fmt.Appendf' || funcText === 'fmt.Appendln' ||
          funcText === 'fmt.Append' || funcText === 'fmt.Errorf' ||
          funcText === 'fmt.Fprintf' || funcText === 'fmt.Fprintln' ||
          funcText === 'fmt.Fprint' || funcText === 'strings.Join' ||
          funcText === 'fmt.Scanf') {
        return true;
      }

      // Also check for selector_expression patterns: pkg.Symbol()
      const selectorMatch = /^(.*?\.)?(Sprintf|Sprintf|Sprint|Sprintln|Join|Appendf|Errorf|Fprintf)$/.test(funcText);
      if (selectorMatch) {
        // Verify it's actually fmt.* or strings.*
        return funcText.startsWith('fmt.') || funcText.startsWith('strings.');
      }

      // Recurse into arguments: query(fmt.Sprintf(...)) where the outer
      // call isn't itself a format function but passes a dynamic argument.
      for (const child of node.children ?? []) {
        if ((child.raw as TreeSitterNode).type === 'argument_list') {
          for (const arg of child.children ?? []) {
            const argType = (arg.raw as TreeSitterNode).type;
            if (argType === '(' || argType === ')' || argType === ',') continue;
            if (this.isDynamicStringConstruction(arg)) return true;
          }
        }
      }

      return false;
    }

    if (type === 'binary_expression') {
      // String concatenation: has + operator with a string literal operand
      const children = node.children ?? [];
      const hasStringLiteral = children.some(
        c => (c.raw as TreeSitterNode).type === 'interpreted_string_literal' ||
             (c.raw as TreeSitterNode).type === 'raw_string_literal'
      );
      const hasOperator = children.some(
        c => (c.raw as TreeSitterNode).type === '+'
      );
      return hasStringLiteral && hasOperator;
    }

    return false;
  }

  /**
   * Gets the dynamic parts of a Go string construction.
   * - For fmt.Sprintf: args after the format string are dynamic
   * - For binary +: non-literal operands are dynamic
   * - For strings.Join: the parts slice is dynamic
   * @param node
   * @param sourceCode
   * @returns
   */
  getDynamicParts(node: ASTNode, sourceCode: string): DynamicPart[] {
    const raw = node.raw as TreeSitterNode;
    const type = raw.type;
    const parts: DynamicPart[] = [];

    // For call_expressions that aren't known fmt/strings functions,
    // walk into the first argument that is itself a dynamic string construction.
    if (type === 'call_expression') {
      const funcText = raw.childForFieldName?.('function')?.text ?? '';
      const isKnownFormatter = /^(fmt\.|strings\.)(Sprintf|Fprintf|Errorf|Appendf|Sprint|Sprintln|Append|Appendln|Join|Scanf|Fprint|Fprintln|Sscanf)$/u.test(funcText);
      if (!isKnownFormatter) {
        for (const child of node.children ?? []) {
          if ((child.raw as TreeSitterNode).type === 'argument_list') {
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

    if (type === 'call_expression') {
      const argsNode = raw.childForFieldName?.('arguments');
      if (!argsNode) return parts;

      const namedChildren = argsNode.namedChildren;

      // fmt.Sprintf("format", arg1, arg2...): skip format string (first arg)
      // strings.Join(parts, "sep"): first arg is dynamic
      const funcText = raw.childForFieldName?.('function')?.text ?? '';
      const isFormatFunc = /^fmt\.(Sprintf|Fprintf|Errorf|Appendf)$/u.test(funcText);

      const startIdx = isFormatFunc ? 1 : 0;

      for (let i = startIdx; i < namedChildren.length; i++) {
        const arg = namedChildren[i];
        const argType = arg.type;
        // Skip string literals (they're the separator or static parts)
        if (argType === 'interpreted_string_literal' || argType === 'raw_string_literal') continue;
        const text = sourceCode.slice(arg.startIndex, arg.endIndex);
        const isId = /^[\p{L}_][\p{L}\p{N}_]*$/u.test(text.trim());
        const idNode = isId ? {
          type: argType,
          range: [arg.startIndex, arg.endIndex] as [number, number],
          location: {
            start: { line: arg.startPosition.row, column: arg.startPosition.column },
            end: { line: arg.endPosition.row, column: arg.endPosition.column },
          },
          raw: arg,
        } : undefined;
        parts.push({ text: text.trim(), isIdentifier: isId, node: idNode });
      }
      return parts;
    }

    if (type === 'binary_expression') {
      for (const child of node.children ?? []) {
        const childType = (child.raw as TreeSitterNode).type;
        if (childType === 'interpreted_string_literal' ||
            childType === 'raw_string_literal' ||
            childType === '+') continue;
        const text = sourceCode.slice(child.range[0], child.range[1]);
        const isId = /^[\p{L}_][\p{L}\p{N}_]*$/u.test(text.trim());
        parts.push({ text: text.trim(), isIdentifier: isId, node: isId ? child : undefined });
      }
      return parts;
    }

    return parts;
  }

  /**
   * Resolves a Go local constant declaration for an identifier node.
   * Searches within the enclosing function scope for var/const/:=
   * declarations. Returns null for unresolvable identifiers.
   * @param ast
   * @param identifierNode
   * @param sourceCode
   * @returns
   */
  resolveLocalConstant(identifierNode: ASTNode, ast: AST, sourceCode: string): ResolvedConstant | null {
    const idName = sourceCode.slice(identifierNode.range[0], identifierNode.range[1]).trim();
    if (!idName) return null;

    // Find enclosing function scope
    const enclosing = this.findEnclosingScopeGo(identifierNode);
    const scopeRoot = enclosing ?? ast.root;

    // Search for declaration: var name = ..., name := ..., const name = ...
    const declNode = this.findDeclInScopeGo(scopeRoot, idName);
    if (!declNode) return null;

    const declText = sourceCode.slice(declNode.range[0], declNode.range[1]);

    // Go forms: "name := value" or "var name = value" or "const name = value"
    // For short_var_declaration: the whole "name := value" is one node
    // For var_spec/const_spec: "name = value" or "name type = value"
    let initText = '';
    const rawDecl = declNode.raw as TreeSitterNode;

    if (rawDecl.type === 'short_var_declaration') {
      // "name := value" — extract right side
      const match = declText.match(/:=s*(.+?)$/);
      if (match) initText = match[1].trim();
    } else if (rawDecl.type === 'var_spec' || rawDecl.type === 'const_spec') {
      // "name = value" or "name type = value"
      const value = (rawDecl as any).childForFieldName?.('value');
      if (value) {
        initText = sourceCode.slice(value.startIndex, value.endIndex).trim();
      }
    } else if (rawDecl.type === 'assignment_statement' || rawDecl.type === 'expression_statement') {
      // Could be ":=" parsed differently
      const match = declText.match(/:=s*(.+?)$|=\s*(.+?)$/);
      if (match) initText = (match[1] ?? match[2]).trim();
    }

    if (!initText) return null;

    const declLine = declNode.location.start.line;

    // Check for reassignment
    const reassigned = this.hasReassignmentGo(scopeRoot, idName, declLine);

    // Is it static? Check if init contains placeholder literals only
    const isStatic = initText === '""' || initText === '""' ||
      (/^["'\s?,\[\]\(\)\.\w]+$/.test(initText) &&
       (initText.includes('"?"') || initText.includes("'?'")));

    return { initText, isStatic: isStatic && !reassigned, declLine };
  }

  /** Walk parent chain to find enclosing function scope in Go. */
  protected findEnclosingScopeGo(node: ASTNode): ASTNode | null {
    let current: ASTNode | null = node;
    while (current) {
      const t = (current.raw as TreeSitterNode).type;
      if (t === 'function_declaration' || t === 'method_declaration' ||
          t === 'source_file') {
        return current;
      }
      current = current.parent ?? null;
    }
    return null;
  }

  /** Find declaration of targetName within scopeRoot. */
  protected findDeclInScopeGo(scopeRoot: ASTNode, targetName: string): ASTNode | null {
    let result: ASTNode | null = null;
    this.walk(scopeRoot, (astNode) => {
      if (result) return;
      const t = (astNode.raw as TreeSitterNode).type;
      if (t === 'short_var_declaration') {
        // Check left side for identifier match
        const raw = astNode.raw as TreeSitterNode;
        const left = (raw as any).childForFieldName?.('left') as TreeSitterNode;
        if (left && left.text === targetName) {
          result = astNode;
        }
      } else if (t === 'var_spec' || t === 'const_spec') {
        const raw = astNode.raw as TreeSitterNode;
        const name = (raw as any).childForFieldName?.('name') as TreeSitterNode;
        if (name && name.text === targetName) {
          result = astNode;
        }
      }
    });
    return result;
  }

  /** Check for reassignment (bare = without :=) of targetName after declLine. */
  protected hasReassignmentGo(scopeRoot: ASTNode, targetName: string, declLine: number): boolean {
    let found = false;
    this.walk(scopeRoot, (astNode) => {
      if (found) return;
      const t = (astNode.raw as TreeSitterNode).type;
      if (t === 'assignment_statement') {
        if (astNode.location.start.line < declLine) return;
        const raw = astNode.raw as TreeSitterNode;
        const left = (raw as any).childForFieldName?.('left');
        if (left && left.text === targetName) {
          found = true;
        }
      }
    });
    return found;
  }
}
