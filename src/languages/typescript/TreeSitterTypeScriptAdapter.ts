/**
 * Tree-sitter TypeScript/JavaScript adapter implementing the LanguageAdapter interface.
 *
 * Uses web-tree-sitter WASM parsers behind the adapter seam — no TypeScript compiler API.
 * Supports .ts, .tsx, .js, and .jsx files.
 *
 * The adapter is split across a leaf-first inheritance chain (Spec-33
 * interface-segregation): each link contributes a cohesive slice of the
 * adapter so no single class exceeds the SOLID class-size threshold.
 * Ancestors hold the tree-traversal, extraction, and scope-resolution
 * primitives; descendants compose them into the public LanguageAdapter
 * surface. The mutually-recursive cross-function safety cluster is
 * co-located in TsSafetyAnalysis (TypeScript forbids a base class calling a
 * subclass method, so those must live in one class).
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

/** A raw import/require record extracted directly from a syntax tree. */
interface RawImport {
  moduleSpecifier: string;
  isStatic: boolean;
  isDynamic: boolean;
  isRequire: boolean;
  line: number;
}

// ---------------------------------------------------------------------------
// Source code storage
// ---------------------------------------------------------------------------

/**
 * Source code indexed by AST, so methods that only receive an AST
 * can recover the original source text.
 */
const sourceCodeMap = new WeakMap<AST, string>();

/**
 * A sentinel ASTNode standing in for a provably-constant string.  Used when
 * binding `.map()` callback element parameters (which iterate a static array)
 * during cross-function safety analysis: the element is unknown but its value
 * is constrained to the array's compile-time elements, so it is safe to embed
 * in a SQL fragment the same way a literal is.
 */
const SAFE_STRING_NODE: ASTNode = {
  type: 'string',
  range: [-1, -1],
  location: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
  raw: {
    type: 'string',
    text: "''",
    startIndex: -1,
    endIndex: -1,
  } as unknown as TreeSitterNode,
};

// ---------------------------------------------------------------------------
// Traversal + primitive helpers
// ---------------------------------------------------------------------------

class TsTraversalHelpers {
  /** Walk all ASTNodes in a tree (depth-first). */
  protected walk(node: ASTNode, visitor: (node: ASTNode) => void): void {
    visitor(node);
    if (node.children) {
      for (const child of node.children) {
        this.walk(child, visitor);
      }
    }
  }

  /** Walk all TreeSitterNodes in a tree (depth-first). */
  protected walkRaw(node: TreeSitterNode, visitor: (node: TreeSitterNode) => void): void {
    visitor(node);
    for (const child of node.children) {
      this.walkRaw(child, visitor);
    }
  }

  /** Collect ERROR nodes from tree-sitter's error recovery. */
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

  /** Find first child of node matching one of the given types. */
  protected getChildByType(
    node: TreeSitterNode,
    type: string
  ): TreeSitterNode | null {
    for (const child of node.children) {
      if (child.type === type) return child;
    }
    return null;
  }

  /** Find the first named child matching one of the given types. */
  protected findFirstNamedChild(
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
  protected hasChild(node: TreeSitterNode, text: string): boolean {
    for (const child of node.children) {
      if (child.text === text || child.type === text) return true;
    }
    return false;
  }

  /** Get the operator text from a binary expression node. */
  protected getOperator(node: TreeSitterNode): string | null {
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

  /** Check if a node has an `async` modifier keyword. */
  protected hasModifier(node: TreeSitterNode, modifier: string): boolean {
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
  protected isNodeExported(node: TreeSitterNode): boolean {
    const parent = node.parent;
    if (parent?.type === 'export_statement') return true;

    // Also check for `export` keyword on the node itself (TS module syntax)
    for (const child of node.children) {
      if (!child.isNamed && child.type === 'export') return true;
    }
    return false;
  }

  protected extractParameters(
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

  /** Extract ordered parameter names from a function node. */
  protected getParamNames(fnNode: ASTNode): string[] {
    const raw = fnNode.raw as TreeSitterNode;
    const paramsNode = (raw as any).childForFieldName?.('parameters') as TreeSitterNode | null;
    if (!paramsNode) return [];
    const names: string[] = [];
    for (const child of paramsNode.namedChildren) {
      if (child.type === 'identifier') {
        names.push(child.text);
        continue;
      }
      const pattern = (child as any).childForFieldName?.('pattern') as TreeSitterNode | null;
      if (pattern && pattern.type === 'identifier') {
        names.push(pattern.text);
        continue;
      }
      for (const c of child.namedChildren) {
        if (c.type === 'identifier') { names.push(c.text); break; }
      }
    }
    return names;
  }

  /** Wrap a raw tree-sitter node into a detached ASTNode for local analysis. */
  protected wrapRaw(raw: TreeSitterNode | null): ASTNode | null {
    if (!raw) return null;
    return toASTNode(raw, undefined, 'typescript');
  }

  /** Return the ASTNodes for a call expression's arguments. */
  protected getCallArgASTNodes(callNode: ASTNode): ASTNode[] {
    const raw = callNode.raw as TreeSitterNode;
    const argsNode = (raw as any).childForFieldName?.('arguments') as TreeSitterNode | null;
    if (!argsNode) return [];
    return argsNode.namedChildren.map((c) => this.wrapRaw(c) as ASTNode);
  }
}

// ---------------------------------------------------------------------------
// Name / type / documentation extraction
// ---------------------------------------------------------------------------

class TsNameDocumentation extends TsTraversalHelpers {
  /** Extract the name/identifier from a tree-sitter TreeSitterNode. */
  protected extractName(node: TreeSitterNode): string | null {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'type_alias_declaration':
        return this.resolveNameField(node, ['identifier', 'type_identifier']);

      case 'method_definition':
      case 'public_field_definition':
        return this.resolveNameField(node, ['property_identifier', 'string']);

      case 'variable_declarator':
        return this.resolveNameField(node, []);

      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const child of node.namedChildren) {
          if (child.type === 'variable_declarator') {
            return this.extractName(child);
          }
        }
        return null;
      }

      case 'arrow_function': {
        const parent = node.parent;
        return parent?.type === 'variable_declarator' ? this.extractName(parent) : null;
      }

      case 'function_expression': {
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
        const parent = node.parent;
        return parent?.type === 'variable_declarator' ? this.extractName(parent) : null;
      }

      case 'property_identifier':
        return node.text;

      case 'identifier':
        return node.text;

      default:
        return null;
    }
  }

  /** Return `node`'s `name` field text, else the first named child whose type
   *  is in `fallbackTypes` (stripping quotes from `string` children). */
  protected resolveNameField(node: TreeSitterNode, fallbackTypes: string[]): string | null {
    const nameNode = node.childForFieldName?.('name');
    if (nameNode) return nameNode.text;
    for (const child of node.namedChildren) {
      if (fallbackTypes.includes(child.type)) {
        return child.type === 'string'
          ? child.text.replace(/^["']|["']$/g, '')
          : child.text;
      }
    }
    return null;
  }

  /** Extract a type annotation string from a node. */
  protected extractTypeAnnotation(node: TreeSitterNode): string | null {
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
  protected extractDocumentation(node: TreeSitterNode): string | null {
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

    // When the parent is `export_statement`, the JSDoc lives at the grandparent
    // (program) level as a sibling of the wrapper — ascend and look for it.
    return this.findExportStatementDoc(parent);
  }

  /** When `parent` is an `export_statement`, find an adjacent /** JSDoc comment
   *  at the grandparent level. Adjacency guard (comment ends on line L, wrapper
   *  starts on L+1) prevents misattributing file-level comments. */
  private findExportStatementDoc(parent: TreeSitterNode): string | null {
    if (parent.type !== 'export_statement' || !parent.parent) return null;
    const gpSiblings = parent.parent.children;
    let parentIndex = -1;
    for (let i = 0; i < gpSiblings.length; i++) {
      if (gpSiblings[i].equals(parent)) {
        parentIndex = i;
        break;
      }
    }
    if (parentIndex <= 0) return null;
    for (let i = parentIndex - 1; i >= 0; i--) {
      const sibling = gpSiblings[i];
      if (sibling.type === 'comment' && sibling.text.trimStart().startsWith('/**')) {
        if (sibling.endPosition.row + 1 === parent.startPosition.row) {
          return this.cleanCommentText(sibling.text);
        }
        break; // Found a comment but not adjacent — stop looking
      } else if (sibling.isNamed) {
        break; // Stop at named siblings
      }
    }
    return null;
  }

  /** Strip comment syntax markers. */
  protected cleanCommentText(comment: string): string {
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
  protected calculateCyclomaticComplexity(node: TreeSitterNode): number {
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

  /** Match an ASTNode against a NodePattern. */
  protected matchesPattern(node: ASTNode, pattern: NodePattern): boolean {
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
}

// ---------------------------------------------------------------------------
// Extraction builders (functions, classes, imports, exports, interfaces)
// ---------------------------------------------------------------------------

class TsExtraction extends TsNameDocumentation {
  protected buildFunctionInfo(
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

  protected buildClassInfo(
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

    const classBody = node.childForFieldName?.('body');
    const { methods, properties } = classBody
      ? this.buildClassMembers(classBody, sourceCode, name)
      : { methods: [], properties: [] };

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

  /** Build method/property lists from a class body's members. */
  private buildClassMembers(
    classBody: TreeSitterNode,
    sourceCode: string,
    className: string
  ): { methods: FunctionInfo[]; properties: PropertyInfo[] } {
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];
    for (const member of classBody.namedChildren) {
      if (member.type === 'method_definition') {
        const fnInfo = this.buildFunctionInfo(member, sourceCode);
        if (fnInfo) {
          fnInfo.className = className;
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
    return { methods, properties };
  }

  protected buildPropertyInfo(node: TreeSitterNode): PropertyInfo | null {
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

  protected buildImportInfo(
    node: TreeSitterNode,
    _sourceCode: string
  ): ImportInfo | null {
    // import source
    const sourceNode = node.childForFieldName?.('source');
    if (!sourceNode) return null;

    const source = sourceNode.text.slice(1, -1); // strip quotes
    const specifiers: ImportSpecifier[] = [];
    for (const child of node.namedChildren) {
      this.collectImportSpecifiers(child, specifiers);
    }

    return {
      source,
      specifiers,
      location: toSourceLocation(node),
    };
  }

  /** Recursively collect import specifiers (default / named / namespace).
   *  Tree-sitter nests named imports inside import_clause -> named_imports. */
  private collectImportSpecifiers(
    child: TreeSitterNode,
    specifiers: ImportSpecifier[]
  ): void {
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
      // Default import: `import foo from '...'` — import_clause children include
      // an identifier for the default binding and optionally named_imports for
      // mixed imports (`import foo, { bar }`).
      for (const grandchild of child.namedChildren) {
        if (grandchild.type === 'identifier') {
          specifiers.push({
            name: grandchild.text,
            isDefault: true,
            isNamespace: false,
          });
        } else {
          this.collectImportSpecifiers(grandchild, specifiers);
        }
      }
    } else {
      // Recurse into containers: import_clause, named_imports
      for (const grandchild of child.namedChildren) {
        this.collectImportSpecifiers(grandchild, specifiers);
      }
    }
  }

  protected buildExportInfo(
    node: TreeSitterNode,
    _sourceCode: string
  ): ExportInfo | null {
    // export default <expression>
    const isDefault = this.hasChild(node, 'default');

    // export { foo, bar } [from '...'] — return the first named export
    // (caller iterates export_statement nodes).
    const named = this.buildNamedExport(node);
    if (named) return named;

    // export function/class/const/let/var name
    const declaration = this.findFirstNamedChild(node, [
      'function_declaration',
      'class_declaration',
      'abstract_class_declaration',
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

  /** Build the ExportInfo for an `export { a, b } [from '...']` statement. */
  private buildNamedExport(node: TreeSitterNode): ExportInfo | null {
    const clause = node.childForFieldName?.('clause');
    if (clause?.type !== 'export_clause') return null;
    const sourceNode = node.childForFieldName?.('source');
    for (const spec of clause.namedChildren) {
      if (spec.type === 'export_specifier') {
        const nameNode = spec.childForFieldName?.('name');
        if (nameNode) {
          return {
            name: nameNode.text,
            location: toSourceLocation(nameNode),
            isDefault: false,
            source: sourceNode?.text.slice(1, -1),
          };
        }
      }
    }
    return null;
  }

  protected buildInterfaceInfo(
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
    const members: InterfaceInfo['members'] = body
      ? this.buildInterfaceMembers(body)
      : [];

    return {
      name,
      location: toSourceLocation(node),
      members,
      extends: extendsList,
      isExported,
    };
  }

  /** Build method/property member descriptors from an interface body. */
  private buildInterfaceMembers(body: TreeSitterNode): InterfaceInfo['members'] {
    const members: InterfaceInfo['members'] = [];
    for (const member of body.namedChildren) {
      if (member.type === 'method_signature' || member.type === 'property_signature') {
        const memberName = member.childForFieldName?.('name')?.text;
        if (memberName) {
          members.push({
            name: memberName,
            type: member.type === 'method_signature' ? 'method' : 'property',
            location: toSourceLocation(member),
          });
        }
      }
    }
    return members;
  }

  /** Get the enclosing class name for a method. */
  protected getEnclosingClassName(node: TreeSitterNode): string | undefined {
    let current = node.parent;
    while (current) {
      if (current.type === 'class_declaration' || current.type === 'abstract_class_declaration') {
        return this.extractName(current) ?? undefined;
      }
      current = current.parent ?? null;
    }
    return undefined;
  }

  /** Collect static imports, dynamic `import()`, and `require()` calls. */
  protected collectRawImport(node: TreeSitterNode, results: RawImport[]): void {
    if (node.type === 'import_statement') {
      const source = this.getChildByType(node, 'string');
      if (source) {
        results.push({
          moduleSpecifier: source.text.slice(1, -1), // strip quotes
          isStatic: true,
          isDynamic: false,
          isRequire: false,
          line: source.startPosition.row,
        });
      }
    }

    if (node.type === 'call_expression') {
      const fn = node.firstChild;
      if (fn?.type === 'import') {
        this.pushCallImport(node, results, /* isRequire */ false);
      } else if (fn?.type === 'identifier' && fn.text === 'require') {
        this.pushCallImport(node, results, /* isRequire */ true);
      }
    }
  }

  /** Push a `import('...')` or `require('...')` record for a call expression. */
  protected pushCallImport(
    node: TreeSitterNode,
    results: RawImport[],
    isRequire: boolean
  ): void {
    const args = this.getChildByType(node, 'arguments');
    const strNode = args ? this.findFirstNamedChild(args, 'string') : null;
    if (!strNode) return;
    results.push({
      moduleSpecifier: strNode.text.slice(1, -1),
      isStatic: false,
      isDynamic: !isRequire,
      isRequire,
      line: strNode.startPosition.row,
    });
  }

  /** Collect the exported symbol(s) declared by a single `export_statement`. */
  protected collectExportedSymbol(
    node: TreeSitterNode,
    symbols: Array<{ name: string; line: number }>
  ): void {
    // export function foo / export class Foo / export const x
    const declaration = this.findFirstNamedChild(node, [
      'function_declaration',
      'class_declaration',
      'abstract_class_declaration',
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
            symbols.push({ name: nameNode.text, line: nameNode.startPosition.row });
          }
        }
      }
    }

    // export default <expression>
    if (node.childForFieldName?.('value')) {
      symbols.push({ name: 'default', line: node.startPosition.row });
    }
  }
}

// ---------------------------------------------------------------------------
// Public LanguageAdapter surface: parsing, navigation, extraction
// ---------------------------------------------------------------------------

class TsPublicApi extends TsExtraction {
  readonly name = 'typescript';
  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

  supportsFile(filePath: string): boolean {
    return this.fileExtensions.some((ext) => filePath.endsWith(ext));
  }

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
      if (syntaxNode.type === 'class_declaration' || syntaxNode.type === 'abstract_class_declaration') {
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
}

// ---------------------------------------------------------------------------
// Node predicates + advanced + optional capabilities
// ---------------------------------------------------------------------------

class TsPredicatesOptional extends TsPublicApi {
  isClass(node: ASTNode): boolean {
    const type = (node.raw as TreeSitterNode).type;
    return type === 'class_declaration' || type === 'abstract_class_declaration' || type === 'class_expression';
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

  extractRawImports(_filePath: string, content: string): RawImport[] {
    const results: RawImport[] = [];

    const parser = getParser('typescript');
    const tree = parser.parse(content);
    if (!tree) return results;

    this.walkRaw(tree.rootNode, (node) => this.collectRawImport(node, results));

    return results;
  }

  extractExportedSymbols(ast: AST): Array<{ name: string; line: number }> {
    const symbols: Array<{ name: string; line: number }> = [];
    this.walk(ast.root, (astNode) => {
      const node = astNode.raw as TreeSitterNode;
      if (node.type === 'export_statement') this.collectExportedSymbol(node, symbols);
    });
    return symbols;
  }
}

// ---------------------------------------------------------------------------
// Scope + static-value resolution
// ---------------------------------------------------------------------------

class TsScopeStatic extends TsPredicatesOptional {
  /** Determine whether a tree-sitter value node represents a static (compile-time
   *  constant) expression — no variables, function calls, or runtime evaluation. */
  protected isStaticValueNode(node: TreeSitterNode | null): boolean {
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

    // Array literals are static when every element is a compile-time constant
    // (enables tracing `for (const t of TABLES)` over a static column list).
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

    // Type assertions (`[...] as const`, `x as T`, `x satisfies T`) wrap an inner
    // expression without changing its runtime value — unwrap and judge that.
    if (
      type === 'as_expression' ||
      type === 'type_assertion' ||
      type === 'satisfies_expression' ||
      type === 'non_null_expression'
    ) {
      return this.isStaticValueNode(node.namedChild(0));
    }

    // Everything else (identifiers, call expressions, binary expressions,
    // object literals, regexes, etc.) is conservatively treated as non-static.
    return false;
  }

  /** Walk the parent chain to find the enclosing function scope node. */
  protected findEnclosingScope(node: ASTNode, ast: AST): ASTNode | null {
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
  protected findEnclosingForStatement(declNode: ASTNode): ASTNode | null {
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
  protected findDeclarationInScope(scopeRoot: ASTNode, targetName: string): ASTNode | null {
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
  protected resolveImportConstant(name: string, ast: AST): ResolvedConstant | null {
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

  /** Check if identifier targetName is reassigned in scope after declLine.
   *  Handles both plain assignment (`x = …`) and augmented assignment
   *  (`x += …`, `x -= …`, etc.) — the latter accumulates into a string the
   *  same way `x = x + …` does, so a variable built up with `+=` is just as
   *  runtime-dependent as one reassigned with `=`. */
  protected hasReassignment(scopeRoot: ASTNode, targetName: string, declLine: number): boolean {
    let found = false;
    this.walk(scopeRoot, (astNode) => {
      if (found) return;
      const t = (astNode.raw as TreeSitterNode).type;
      if (t === 'assignment_expression' || t === 'augmented_assignment_expression') {
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

  /** Find a function declaration (named or arrow-assigned) by name in the file. */
  protected findFunctionDeclaration(name: string, ast: AST): ASTNode | null {
    let result: ASTNode | null = null;
    this.walk(ast.root, (node) => {
      if (result) return;
      const raw = node.raw as TreeSitterNode;
      const t = raw.type;
      if (t === 'function_declaration' || t === 'generator_function_declaration') {
        const nameNode = (raw as any).childForFieldName?.('name') as TreeSitterNode | null;
        if (nameNode && nameNode.text === name) result = node;
      } else if (t === 'variable_declarator') {
        const nameNode = (raw as any).childForFieldName?.('name') as TreeSitterNode | null;
        const valueNode = (raw as any).childForFieldName?.('value') as TreeSitterNode | null;
        if (nameNode && nameNode.type === 'identifier' && nameNode.text === name
            && valueNode && ['arrow_function', 'function_expression', 'function'].includes(valueNode.type)) {
          result = this.wrapRaw(valueNode);
        }
      }
    });
    return result;
  }

  /** Extract a function's name (named functions and arrow-function assignments). */
  protected getFunctionName(node: ASTNode): string | null {
    const raw = node.raw as TreeSitterNode;
    const t = raw.type;
    if (t === 'function_declaration' || t === 'generator_function_declaration'
        || t === 'function_expression' || t === 'method_definition') {
      const nameNode = (raw as any).childForFieldName?.('name') as TreeSitterNode | null;
      if (nameNode && nameNode.text) return nameNode.text;
    }
    if (t === 'arrow_function') {
      const parent = node.parent;
      if (parent) {
        const pRaw = parent.raw as TreeSitterNode;
        if (pRaw.type === 'variable_declarator') {
          const nameNode = (pRaw as any).childForFieldName?.('name') as TreeSitterNode | null;
          if (nameNode && nameNode.type === 'identifier') return nameNode.text;
        }
      }
    }
    return null;
  }

  /** Find all call sites of a named function in the file. */
  protected findCallSites(fnName: string, ast: AST): ASTNode[] {
    const sites: ASTNode[] = [];
    this.walk(ast.root, (node) => {
      const raw = node.raw as TreeSitterNode;
      if (raw.type !== 'call_expression') return;
      const fn = (raw as any).childForFieldName?.('function') as TreeSitterNode | null;
      if (fn && fn.type === 'identifier' && fn.text === fnName) sites.push(node);
    });
    return sites;
  }
}

// ---------------------------------------------------------------------------
// Dynamic string construction + local-constant resolution
// ---------------------------------------------------------------------------

class TsDynamicStringConstruction extends TsScopeStatic {
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
    if (type === 'call_expression') {
      const nested = this.getNestedDynamicCallParts(node, sourceCode);
      if (nested) return nested;
      return this.getCallArgParts(node);
    }
    if (type === 'template_string') return this.getTemplateStringParts(node, sourceCode);
    if (type === 'binary_expression') return this.getBinaryExpressionParts(node, sourceCode);
    return [];
  }

  /** For a non-`.concat()` call, recurse into the first argument that is itself
   *  a dynamic string construction; null when there is none (or it's .concat). */
  private getNestedDynamicCallParts(node: ASTNode, sourceCode: string): DynamicPart[] | null {
    const text = (node.raw as TreeSitterNode).text;
    if (text.includes('.concat(') || text.includes('?.concat(')) return null;
    for (const child of node.children ?? []) {
      if ((child.raw as TreeSitterNode).type !== 'arguments') continue;
      for (const arg of child.children ?? []) {
        const argType = (arg.raw as TreeSitterNode).type;
        if (argType === '(' || argType === ')' || argType === ',') continue;
        if (this.isDynamicStringConstruction(arg)) {
          return this.getDynamicParts(arg, sourceCode);
        }
      }
    }
    return null;
  }

  /** `.concat()` (or a call with no nested dynamic arg): every argument is dynamic. */
  private getCallArgParts(node: ASTNode): DynamicPart[] {
    const parts: DynamicPart[] = [];
    for (const child of node.children ?? []) {
      if ((child.raw as TreeSitterNode).type !== 'arguments') continue;
      for (const arg of child.children ?? []) {
        const argType = (arg.raw as TreeSitterNode).type;
        if (argType === '(' || argType === ')' || argType === ',') continue;
        const text = (arg.raw as TreeSitterNode).text.trim();
        const isId = /^[$\p{L}_][\p{L}\p{N}_$]*$/u.test(text);
        parts.push({ text, isIdentifier: isId, node: arg });
      }
    }
    return parts;
  }

  /** Dynamic parts from a template string's `${…}` substitutions. */
  private getTemplateStringParts(node: ASTNode, sourceCode: string): DynamicPart[] {
    const parts: DynamicPart[] = [];
    for (const child of node.children ?? []) {
      if ((child.raw as TreeSitterNode).type !== 'template_substitution') continue;
      const text = sourceCode.slice(child.range[0], child.range[1]);
      // Strip the ${ } wrapper to get the inner identifier/expression.
      const inner = text.startsWith('${') ? text.slice(2, -1).trim() : text;
      const isId = /^[$\p{L}_][\p{L}\p{N}_$]*$/u.test(inner);
      // The expression inside ${…} is the single named child; attach it for
      // isSafeInterpolation() cross-function safety checks.
      let exprNode: ASTNode | undefined;
      for (const subChild of child.children ?? []) {
        if ((subChild.raw as TreeSitterNode).type !== 'template_substitution') {
          exprNode = subChild;
          break;
        }
      }
      parts.push({ text: inner, isIdentifier: isId, node: exprNode ?? child });
    }
    return parts;
  }

  /** Dynamic parts from a `+`-concatenation of strings and expressions. */
  private getBinaryExpressionParts(node: ASTNode, sourceCode: string): DynamicPart[] {
    const parts: DynamicPart[] = [];
    for (const child of node.children ?? []) {
      const childType = (child.raw as TreeSitterNode).type;
      if (childType === 'string' || childType === '+' || childType === 'template_string') continue;
      const text = sourceCode.slice(child.range[0], child.range[1]);
      const isId = /^[$\p{L}_][\p{L}\p{N}_$]*$/u.test(text.trim());
      parts.push({ text: text.trim(), isIdentifier: isId, node: child });
    }
    return parts;
  }
}

class TsConstantResolution extends TsDynamicStringConstruction {
  /**
   * Resolves a local const/let/var declaration for an identifier node.
   * Searches within the enclosing function scope for the declaration site.
   * Returns null when the identifier is a parameter, complex expression,
   * or cannot be statically resolved.
   */
  resolveLocalConstant(identifierNode: ASTNode, ast: AST, sourceCode: string): ResolvedConstant | null {
    const idName = sourceCode.slice(identifierNode.range[0], identifierNode.range[1]).trim();
    if (!idName) return null;

    // Enclosing function/file scope, falling back to the module scope for
    // module-level constants.
    const enclosing = this.findEnclosingScope(identifierNode, ast);
    const scopeRoot = enclosing ?? ast.root;
    const scope: ScopeContext = { scopeRoot, enclosing, ast };

    const resolved = this.resolveDeclarationOrConstant(identifierNode, idName, sourceCode, scope);
    if (resolved.constant) return resolved.constant;
    const declNode = resolved.declNode;
    if (!declNode) return null;

    return this.resolveFromDeclaration(declNode, idName, sourceCode, scope);
  }

  /** Determine static-ness and init text from a resolved declaration node.
   *
   *  "Static" means the value is a compile-time constant that is never
   *  reassigned.  String literals and substitution-free template strings are
   *  constants regardless of `?` placeholders — SQL fragment constants (WHERE
   *  clauses, column lists) are as static as parameterised query strings.
   *
   *  The value is extracted from the AST rather than regex so that multiline
   *  declarations survive (`.` doesn't match `\n`). */
  private resolveFromDeclaration(
    declNode: ASTNode,
    idName: string,
    sourceCode: string,
    scope: ScopeContext,
  ): ResolvedConstant {
    const { scopeRoot, enclosing, ast } = scope;
    const raw = declNode.raw as TreeSitterNode;
    const valueNode = (raw as any).childForFieldName?.('value') as TreeSitterNode | null;
    const declLine = declNode.location.start.line;
    const reassigned = this.hasReassignment(scopeRoot, idName, declLine);

    let isStatic = !reassigned && this.isStaticValueNode(valueNode);

    // For-of / for-in loop variables: the declarator has no `value` field
    // (the iterable is on the for-statement's `right` child).  Trace the
    // iterable to see if all possible loop values are known constants.
    if (!isStatic && !valueNode && this.traceForOfLoopVariable(declNode, scopeRoot, enclosing, ast)) {
      isStatic = true;
    }

    // Value is a simple identifier (e.g. `table` ← `tables`): trace through to
    // the linked declaration (handles `for (const table of TABLES)` where the
    // iterable is a compile-time constant array).
    if (!isStatic && valueNode?.type === 'identifier' && this.traceLinkedIdentifier(valueNode, idName, scope)) {
      isStatic = true;
    }

    const initText = this.extractInitText(valueNode, declNode, sourceCode);
    return { initText, isStatic, declLine };
  }

  /** Resolve `idName` to a declaration in the enclosing scope (falling back to
   *  the program-level scope), or — when no local declaration exists — to an
   *  imported constant or a `for…in`/`for…of` loop variable.  Returns either a
   *  declaration node or a fully resolved constant. */
  private resolveDeclarationOrConstant(
    identifierNode: ASTNode,
    idName: string,
    sourceCode: string,
    scope: ScopeContext,
  ): { declNode: ASTNode | null; constant: ResolvedConstant | null } {
    const { scopeRoot, enclosing, ast } = scope;
    let declNode = this.findDeclarationInScope(scopeRoot, idName);
    // If the enclosing scope is a function (not the program) and we didn't
    // find the declaration there, also search the program-level scope.
    if (!declNode && enclosing && enclosing !== ast.root) {
      declNode = this.findDeclarationInScope(ast.root, idName);
    }
    if (declNode) return { declNode, constant: null };

    // Not in local declarations — imported symbols are compile-time constants
    // resolved at link time, not runtime, so user input cannot reach them via
    // import bindings.
    const importResult = this.resolveImportConstant(idName, ast);
    if (importResult) return { declNode: null, constant: importResult };

    // tree-sitter-typescript (v0.x) parses both "for…in" and "for…of" as
    // `for_in_statement`; the loop variable is a bare identifier child.
    const forInResult = this.traceForInLoopVariable(identifierNode, idName, sourceCode, scope);
    if (forInResult) return { declNode: null, constant: forInResult };

    return { declNode: null, constant: null };
  }

  /** Trace a `for…in`/`for…of` loop variable whose identifier appears directly
   *  under a `for_in_statement` `left` child.  tree-sitter-typescript (v0.x)
   *  parses both loop forms as `for_in_statement`; the loop variable is a bare
   *  `identifier` child — NOT wrapped in `variable_declarator` /
   *  `lexical_declaration`.  Walk up from the identifier to a `for_in_statement`
   *  and trace through the iterable to determine static-ness.
   *    const TABLES = ["a", "b"];
   *    for (const table of TABLES) { … `${table}` … }
   */
  protected traceForInLoopVariable(
    identifierNode: ASTNode,
    idName: string,
    sourceCode: string,
    scope: ScopeContext,
  ): ResolvedConstant | null {
    const { scopeRoot, enclosing, ast } = scope;
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

  /** Trace a for-of / for-in loop variable whose declarator has no `value` field
   *  (the iterable is on the for-statement's `right` child).  Returns true when
   *  all possible loop values are known compile-time constants. */
  protected traceForOfLoopVariable(
    declNode: ASTNode,
    scopeRoot: ASTNode,
    enclosing: ASTNode | null,
    ast: AST,
  ): boolean {
    const forParent = this.findEnclosingForStatement(declNode);
    if (!forParent) return false;
    const forRaw = forParent.raw as TreeSitterNode;
    const iterable = (forRaw as any).childForFieldName?.('right') as TreeSitterNode | null;
    if (!iterable || iterable.type !== 'identifier') return false;
    const iterName = iterable.text;
    let iterDecl = this.findDeclarationInScope(scopeRoot, iterName);
    if (!iterDecl && enclosing && enclosing !== ast.root) {
      iterDecl = this.findDeclarationInScope(ast.root, iterName);
    }
    if (!iterDecl) return false;
    const iterRaw = iterDecl.raw as TreeSitterNode;
    const iterValue = (iterRaw as any).childForFieldName?.('value') as TreeSitterNode | null;
    const iterLine = iterDecl.location.start.line;
    const iterReassigned = this.hasReassignment(scopeRoot, iterName, iterLine)
      || (enclosing && enclosing !== ast.root ? this.hasReassignment(ast.root, iterName, iterLine) : false);
    return !iterReassigned && this.isStaticValueNode(iterValue);
  }

  /** Trace an identifier value (e.g. `table` ← `tables`) to its linked
   *  declaration.  Returns true when the linked initializer is a static
   *  constant and is never reassigned. */
  protected traceLinkedIdentifier(
    valueNode: TreeSitterNode,
    idName: string,
    scope: ScopeContext,
  ): boolean {
    const { scopeRoot, enclosing, ast } = scope;
    const linkedName = valueNode.text;
    if (!linkedName || linkedName === idName) return false;
    let linkedDecl = this.findDeclarationInScope(scopeRoot, linkedName);
    if (!linkedDecl && enclosing && enclosing !== ast.root) {
      linkedDecl = this.findDeclarationInScope(ast.root, linkedName);
    }
    if (!linkedDecl) return false;
    const linkedRaw = linkedDecl.raw as TreeSitterNode;
    const linkedValue = (linkedRaw as any).childForFieldName?.('value') as TreeSitterNode | null;
    const linkedLine = linkedDecl.location.start.line;
    const linkedReassigned = this.hasReassignment(scopeRoot, linkedName, linkedLine)
      || (enclosing && enclosing !== ast.root ? this.hasReassignment(ast.root, linkedName, linkedLine) : false);
    return !linkedReassigned && this.isStaticValueNode(linkedValue);
  }

  /** Extract the initializer text from a declaration: the value node when
   *  present, otherwise a regex fallback over the full declaration text. */
  protected extractInitText(
    valueNode: TreeSitterNode | null,
    declNode: ASTNode,
    sourceCode: string,
  ): string {
    if (valueNode) {
      return sourceCode.slice(valueNode.startIndex, valueNode.endIndex).trim();
    }
    // No initializer node — try regex as a last resort.
    const declText = sourceCode.slice(declNode.range[0], declNode.range[1]);
    const declMatch = declText.match(
      /^(?:const|let|var)\s+(\w+)\s*=\s*(.+?);?\s*$|^(\w+)\s*=\s*(.+?);?\s*$/s,
    );
    return declMatch
      ? (declMatch[2] ?? declMatch[4]).replace(/;\s*$/, '').trim()
      : '';
  }

  /** True when the identifier names the enclosing function's parameter AND a
   *  guard call (assert/validate/check/ensure/guard-prefixed) is invoked on it
   *  before its use.  Guards throw on invalid input, so a parameter that has
   *  passed one cannot carry unvalidated attacker data past the check. */
  protected isGuardValidatedParameter(identifierNode: ASTNode, ast: AST): boolean {
    const idRaw = identifierNode.raw as TreeSitterNode;
    const paramName = idRaw.text;
    const enclosing = this.findEnclosingScope(identifierNode, ast);
    if (!enclosing || enclosing === ast.root) return false;
    if (!this.getParamNames(enclosing).includes(paramName)) return false;

    let guarded = false;
    this.walk(enclosing, (node) => {
      if (guarded) return;
      const raw = node.raw as TreeSitterNode;
      if (raw.type !== 'call_expression') return;
      const fn = (raw as any).childForFieldName?.('function') as TreeSitterNode | null;
      if (!fn) return;
      let calleeName: string | null = null;
      if (fn.type === 'identifier') calleeName = fn.text;
      else if (fn.type === 'member_expression') {
        calleeName = (fn as any).childForFieldName?.('property')?.text ?? null;
      }
      if (!calleeName) return;
      if (!/^(assert|validate|check|ensure|guard)([A-Z_]|$)/i.test(calleeName)) return;
      const argsNode = (raw as any).childForFieldName?.('arguments') as TreeSitterNode | null;
      const first = argsNode?.namedChildren[0] ?? null;
      if (first && first.type === 'identifier' && first.text === paramName
          && raw.startIndex < idRaw.startIndex) {
        guarded = true;
      }
    });
    return guarded;
  }
}

// ---------------------------------------------------------------------------
// Cross-function safety analysis (Spec 33 Item 6 — sql-injection FP: taint
// tracking).  `isSafeInterpolation` decides whether an expression embedded in
// a ${…} substitution (or a `+`/`.concat()` operand) is provably safe to put
// in a SQL string — extending the static-constant check to: ternary expressions
// whose branches are all safe, static-array `.map().join()` chains, local
// function calls with a safe body and safe call sites, and guard-validated /
// call-site-provenanced function parameters.  Each of these clears a real
// false positive without weakening raw-input detection.
//
// Deliberately NOT cleared: manual quote-escaping (`x.replace(/'/g, "''")`).
// Single-quote doubling handles only the single-quote case — not backslash
// escapes, unicode quote variants, or numeric/identifier positions where a
// quote isn't the injection vector — so certifying it "safe" would actively
// bless a real vulnerability (silence reads as clearance).  Such input stays
// unresolved and is flagged as a potential injection.
// ---------------------------------------------------------------------------

/** Mutable traversal state threaded through the `isSafe*` recursion: `seen`
 *  guards cycles, `seenFns` guards mutually-recursive function calls, and
 *  `paramMap` binds function parameters to the values passed at the current
 *  call site so we can trace through local helper functions
 *  (`qualifiedIconRemote(alias)` with a literal alias).  Bundled into a single
 *  context object so the whole family shares one signature instead of six
 *  positional parameters each. */
interface SafetyContext {
  ast: AST;
  sourceCode: string;
  seen: Set<number>;
  seenFns: Set<string>;
  paramMap: Map<string, ASTNode | null>;
}

/** Scope-resolution inputs shared by the constant-tracing helpers: the local
 *  scope root, the enclosing function scope (or null at module level), and the
 *  full AST for program-level fallback searches. */
interface ScopeContext {
  scopeRoot: ASTNode;
  enclosing: ASTNode | null;
  ast: AST;
}

class TsSafetyAnalysis extends TsConstantResolution {
  /** Public entry point (LanguageAdapter.isSafeInterpolation). */
  isSafeInterpolation(node: ASTNode, ast: AST, sourceCode: string): boolean {
    return this.isSafeExpression(node, {
      ast,
      sourceCode,
      seen: new Set(),
      seenFns: new Set(),
      paramMap: new Map(),
    });
  }

  /** Recursive safety check against the traversal context in `ctx`. */
  protected isSafeExpression(node: ASTNode | null, ctx: SafetyContext): boolean {
    if (!node) return false;
    if (node === SAFE_STRING_NODE) return true;

    const raw = node.raw as TreeSitterNode;

    // `seen` is path-based (added on entry, removed on exit) and keyed by the
    // node's unique `id` — NOT `startIndex`, which collides between an
    // expression and its leading operand (a `binary_expression` and its left
    // string share a start offset).  Path-based semantics let a shared value
    // (one literal bound to two parameters) be re-checked via sibling branches
    // while still breaking true cycles (a node in its own ancestor chain).
    const key = raw.id;
    if (ctx.seen.has(key)) return false;
    ctx.seen.add(key);

    const result = this.evaluateSafeExpression(node, raw, ctx);

    ctx.seen.delete(key);
    return result;
  }

  /** Evaluate a single expression node's safety, dispatching on its AST type. */
  private evaluateSafeExpression(node: ASTNode, raw: TreeSitterNode, ctx: SafetyContext): boolean {
    // Structural nodes (wrappers, binary, ternary) recurse into children.
    const structural = this.evaluateStructuralExpression(node, raw, ctx);
    if (structural !== null) return structural;

    switch (raw.type) {
      case 'string':
      case 'number':
      case 'true':
      case 'false':
      case 'null':
      case 'undefined':
      case 'regex':
        return true;
      case 'identifier':
        return this.isSafeIdentifier(node, ctx);
      case 'template_string':
        return this.isSafeTemplateString(node, ctx);
      case 'array':
        return this.isSafeArray(node, ctx);
      case 'call_expression':
        return this.isSafeCallExpression(node, ctx);
      // member_expression, object/class literals, await/async, etc. — a value we
      // cannot prove safe.  Conservative: stay flagged.
      default:
        return false;
    }
  }

  /** Handle structural nodes that recurse into child expressions (parenthesized
   *  wrappers, type casts/assertions, ternaries, binary ops).  Returns `null`
   *  when the node is not structural, so the caller can fall through to the
   *  leaf switch. */
  private evaluateStructuralExpression(
    node: ASTNode,
    raw: TreeSitterNode,
    ctx: SafetyContext,
  ): boolean | null {
    switch (raw.type) {
      case 'parenthesized_expression': {
        const inner = (node.children ?? []).find(
          (c) => !['(', ')'].includes((c.raw as TreeSitterNode).type),
        );
        return this.isSafeExpression(inner ?? null, ctx);
      }
      case 'as_expression':
      case 'type_assertion':
      case 'satisfies_expression':
      case 'non_null_expression': {
        const inner = (raw as any).namedChild?.(0) as TreeSitterNode | null;
        return this.isSafeExpression(this.wrapRaw(inner), ctx);
      }
      case 'ternary_expression': {
        const consequence = (raw as any).childForFieldName?.('consequence') as TreeSitterNode | null;
        const alternative = (raw as any).childForFieldName?.('alternative') as TreeSitterNode | null;
        return this.isSafeExpression(this.wrapRaw(consequence), ctx)
          && this.isSafeExpression(this.wrapRaw(alternative), ctx);
      }
      case 'binary_expression': {
        const left = (raw as any).childForFieldName?.('left') as TreeSitterNode | null;
        const right = (raw as any).childForFieldName?.('right') as TreeSitterNode | null;
        return this.isSafeExpression(this.wrapRaw(left), ctx)
          && this.isSafeExpression(this.wrapRaw(right), ctx);
      }
      default:
        return null;
    }
  }

  /** Identifier safety: a bound parameter, compile-time constant, or validated
   *  parameter at all call sites. */
  private isSafeIdentifier(node: ASTNode, ctx: SafetyContext): boolean {
    const name = (node.raw as TreeSitterNode).text;
    // A parameter bound at the current call site — recurse into its value.
    if (ctx.paramMap.has(name)) {
      return this.isSafeExpression(ctx.paramMap.get(name) ?? null, ctx);
    }
    // Compile-time constant (string/number/static array/imported symbol).
    const resolved = this.resolveLocalConstant(node, ctx.ast, ctx.sourceCode);
    if (resolved && resolved.isStatic) {
      return true;
    }
    if (this.isDeclarationValueSafe(node, ctx)) {
      return true;
    }
    if (this.isGuardValidatedParameter(node, ctx.ast)) {
      return true;
    }
    if (this.isParamSafeAtAllCallSites(node, ctx)) {
      return true;
    }
    return false;
  }

  /** A template string is safe only if every `${…}` substitution is safe. */
  private isSafeTemplateString(node: ASTNode, ctx: SafetyContext): boolean {
    for (const child of node.children ?? []) {
      const ct = (child.raw as TreeSitterNode).type;
      if (ct !== 'template_substitution') continue;
      const inner = (child.children ?? []).find(
        (c) => (c.raw as TreeSitterNode).type !== 'template_substitution',
      ) ?? child;
      if (!this.isSafeExpression(inner, ctx)) {
        return false;
      }
    }
    return true;
  }

  /** An array literal is safe only if every element is safe. */
  private isSafeArray(node: ASTNode, ctx: SafetyContext): boolean {
    for (const child of node.children ?? []) {
      const ct = (child.raw as TreeSitterNode).type;
      if (ct === ',' || ct === '[' || ct === ']') continue;
      if (!this.isSafeExpression(child, ctx)) {
        return false;
      }
    }
    return true;
  }

  /** Decide whether a call expression is provably safe to embed in SQL. */
  protected isSafeCallExpression(node: ASTNode, ctx: SafetyContext): boolean {
    const raw = node.raw as TreeSitterNode;
    const fnNode = (raw as any).childForFieldName?.('function') as TreeSitterNode | null;
    if (!fnNode) return false;

    // NOTE: manual quote-escaping (`x.replace(/'/g, "''")`) is deliberately NOT
    // treated as a sanitizer here — see the module-level comment above.  It
    // covers only the single-quote case and would otherwise bless a real
    // vulnerability.

    // 1. Static-array `.map().join()` chain (e.g. `FLAGS.map((c) => \`a.${c}\`).join(", ")`).
    if (this.isSafeMapJoin(node, ctx)) return true;

    // 2. Local function call with a safe body and safe call sites.
    if (this.isLocalFunctionCallSafe(node, ctx)) return true;

    return false;
  }

  /** True when the node is `.join(...)` over `.map(...)` of a static array whose
   *  callback body is safe for every element. */
  protected isSafeMapJoin(node: ASTNode, ctx: SafetyContext): boolean {
    const raw = node.raw as TreeSitterNode;
    const fnNode = (raw as any).childForFieldName?.('function') as TreeSitterNode | null;
    if (!fnNode || fnNode.type !== 'member_expression') return false;
    const joinProp = (fnNode as any).childForFieldName?.('property') as TreeSitterNode | null;
    const joinObj = (fnNode as any).childForFieldName?.('object') as TreeSitterNode | null;
    if (!joinProp || !joinObj || joinProp.text !== 'join') return false;
    if (joinObj.type !== 'call_expression') return false;

    const mapFn = (joinObj as any).childForFieldName?.('function') as TreeSitterNode | null;
    const mapArgs = (joinObj as any).childForFieldName?.('arguments') as TreeSitterNode | null;
    if (!mapFn || mapFn.type !== 'member_expression') return false;
    const mapProp = (mapFn as any).childForFieldName?.('property') as TreeSitterNode | null;
    const mapObj = (mapFn as any).childForFieldName?.('object') as TreeSitterNode | null;
    if (!mapProp || !mapObj || mapProp.text !== 'map') return false;

    // The array being mapped must itself be provably safe (static array/const).
    if (!this.isSafeExpression(this.wrapRaw(mapObj), ctx)) return false;

    // The callback must be safe for any element — bind its first parameter to a
    // compile-time string sentinel and check the callback body.
    const callback = mapArgs?.namedChildren[0] ?? null;
    if (!callback || !['arrow_function', 'function_expression', 'function'].includes(callback.type)) return false;
    const cbParams = this.getParamNames(this.wrapRaw(callback)!);
    if (cbParams.length === 0) return false;
    const bound = new Map<string, ASTNode | null>(ctx.paramMap);
    bound.set(cbParams[0], SAFE_STRING_NODE);
    return this.isBodySafeUnderParams(this.wrapRaw(callback)!, { ...ctx, paramMap: bound });
  }

  /** True when the node is a call to a local (in-file) function whose body is
   *  safe under the values passed at this call site. */
  protected isLocalFunctionCallSafe(node: ASTNode, ctx: SafetyContext): boolean {
    const raw = node.raw as TreeSitterNode;
    const fnNode = (raw as any).childForFieldName?.('function') as TreeSitterNode | null;
    if (!fnNode || fnNode.type !== 'identifier') return false;
    const calleeName = fnNode.text;
    if (!calleeName || ctx.seenFns.has(calleeName)) return false;
    ctx.seenFns.add(calleeName);

    const decl = this.findFunctionDeclaration(calleeName, ctx.ast);
    if (!decl) return false;
    const paramNames = this.getParamNames(decl);
    const argNodes = this.getCallArgASTNodes(node);
    const bound = new Map<string, ASTNode | null>(ctx.paramMap);
    paramNames.forEach((p, i) => bound.set(p, argNodes[i] ?? null));
    return this.isBodySafeUnderParams(decl, { ...ctx, paramMap: bound });
  }

  /** Check a function's body returns only safe values, under the `paramMap`
   *  already bound in `ctx` to the values passed at the call site. */
  protected isBodySafeUnderParams(fnNode: ASTNode, ctx: SafetyContext): boolean {
    const raw = fnNode.raw as TreeSitterNode;
    const body = (raw as any).childForFieldName?.('body') as TreeSitterNode | null;
    if (!body) return false;

    if (body.type === 'statement_block') {
      const returns: TreeSitterNode[] = [];
      const collect = (n: TreeSitterNode): void => {
        if (n.type === 'return_statement') returns.push(n);
        for (const c of n.namedChildren) collect(c);
      };
      collect(body);
      if (returns.length === 0) return false;
      for (const r of returns) {
        const expr = r.namedChildren.find((c) => c.type !== 'return_statement') ?? null;
        if (!expr) return false;
        if (!this.isSafeExpression(this.wrapRaw(expr), ctx)) return false;
      }
      return true;
    }

    // Arrow-function expression body (no braces).
    return this.isSafeExpression(this.wrapRaw(body), ctx);
  }

  /** True when the identifier names the enclosing function's parameter AND every
   *  in-file call site of that function passes a provably-safe value for that
   *  parameter position. */
  protected isParamSafeAtAllCallSites(identifierNode: ASTNode, ctx: SafetyContext): boolean {
    const idRaw = identifierNode.raw as TreeSitterNode;
    const paramName = idRaw.text;
    const enclosing = this.findEnclosingScope(identifierNode, ctx.ast);
    if (!enclosing || enclosing === ctx.ast.root) return false;
    const paramNames = this.getParamNames(enclosing);
    const paramIndex = paramNames.indexOf(paramName);
    if (paramIndex < 0) return false;
    const fnName = this.getFunctionName(enclosing);
    if (!fnName) return false;
    const callSites = this.findCallSites(fnName, ctx.ast);
    if (callSites.length === 0) return false;
    for (const site of callSites) {
      const arg = this.getCallArgASTNodes(site)[paramIndex];
      if (!arg) return false;
      if (!this.isSafeExpression(arg, { ...ctx, paramMap: new Map() })) return false;
    }
    return true;
  }

  /** True when the identifier names a local variable whose initializer is a
   *  provably-safe expression and which is never reassigned. */
  protected isDeclarationValueSafe(identifierNode: ASTNode, ctx: SafetyContext): boolean {
    const idRaw = identifierNode.raw as TreeSitterNode;
    const name = idRaw.text;
    const enclosing = this.findEnclosingScope(identifierNode, ctx.ast);
    const scopeRoot = enclosing ?? ctx.ast.root;
    let declNode = this.findDeclarationInScope(scopeRoot, name);
    if (!declNode && enclosing && enclosing !== ctx.ast.root) {
      declNode = this.findDeclarationInScope(ctx.ast.root, name);
    }
    if (!declNode) return false;
    const declLine = declNode.location.start.line;
    const reassigned = this.hasReassignment(scopeRoot, name, declLine)
      || (enclosing && enclosing !== ctx.ast.root ? this.hasReassignment(ctx.ast.root, name, declLine) : false);
    if (reassigned) return false;
    const declRaw = declNode.raw as TreeSitterNode;
    const valueRaw = (declRaw as any).childForFieldName?.('value') as TreeSitterNode | null;
    if (!valueRaw) return false;
    return this.isSafeExpression(this.wrapRaw(valueRaw), ctx);
  }
}

// ---------------------------------------------------------------------------
// Adapter (composes the slices above)
// ---------------------------------------------------------------------------

/**
 * Tree sitter type script adapter.
 */
export class TreeSitterTypeScriptAdapter extends TsSafetyAnalysis implements LanguageAdapter {}
