/**
 * Spec 68 §3.2 — the `file-symbols` producer's extraction.
 *
 * This is where the SOLID analyzer's per-file AST walking *used* to happen. It
 * folds `adapter.extractFunctions` / `extractClasses` / `extractInterfaces`
 * into a serializable `FileSymbols` per symbol, pre-computing every metric a
 * symbol-level rule needs (complexity, concern groups, line/param counts, the
 * open-closed `instanceof` signal, the dependency-inversion `new` signal, the
 * LSP `throws` signal). The tree dies with the file; `analyze` sees only these
 * plain-data records.
 *
 * This is a temporary re-homing of the SOLID analyzer's private helpers
 * (`BUILTIN_TYPES`, `walkASTWithAncestors`, `constructionEscapes`,
 * `findNodeByLocation`, `methodThrows`, …). They live in
 * `UniversalSOLIDAnalyzer.ts` today and are deleted with that analyzer in §15;
 * importing them across the phase boundary would couple the new pipeline to a
 * class that is about to be removed, so they are re-declared here instead.
 */

import type { ParsedFile, FileSymbols, FileFunctionSymbol, FileClassSymbol } from './types.js';
import type { ASTNode, ClassInfo, FunctionInfo } from '../languages/types.js';
import { walkAST, getNodeText } from '../languages/adapterBridge.js';
import { detectFunctionConcerns, votingConcerns, CONCERN_LABELS, isFunctionNodeType } from '../analyzers/universal/functionConcerns.js';

/**
 * Builtin / standard-library type names excluded from the open-closed and
 * dependency-inversion signals (mirrors UniversalSOLIDAnalyzer's set). Platform
 * primitives and error types are legitimate runtime concerns, not extensibility
 * (OCP) or coupling (DIP) signals.
 */
const BUILTIN_TYPES = new Set<string>([
  'Date', 'Array', 'Object', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'RegExp', 'Number', 'String', 'Boolean', 'Symbol', 'BigInt',
  'Function', 'JSON', 'Math', 'Reflect', 'Proxy',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError',
  'ArrayBuffer', 'DataView', 'SharedArrayBuffer',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Buffer',
  'FormData', 'Blob', 'AbortController', 'AbortSignal',
]);

/** Expression wrappers that pass their operand through to the enclosing statement. */
const ESCAPE_WRAPPERS = new Set([
  'parenthesized_expression',
  'as_expression',
  'type_assertion',
  'satisfies_expression',
  'non_null_expression',
]);

/** Extract every symbol (function / class / interface) from one parsed file. */
export function extractFileSymbols(file: ParsedFile): FileSymbols[] {
  const { ast, adapter, source } = file;
  const symbols: FileSymbols[] = [];

  const classes = adapter.extractClasses(ast);
  for (const cls of classes) {
    symbols.push(extractClass(file, cls));
  }

  const interfaces = adapter.extractInterfaces ? adapter.extractInterfaces(ast) : [];
  for (const iface of interfaces) {
    symbols.push({
      kind: 'interface',
      file: file.file,
      name: iface.name,
      line: iface.location.start.line,
      column: iface.location.start.column,
      memberCount: (iface.members ?? []).length,
      hasMethodMembers: (iface.members ?? []).some((m) => m.type === 'method'),
    });
  }

  const functions = adapter.extractFunctions(ast);
  for (const func of functions) {
    if (func.isMethod) continue; // methods ride on their class symbol
    symbols.push(extractFunction(file, func, ast, source));
  }

  return symbols;
}

function extractClass(file: ParsedFile, cls: ClassInfo): FileClassSymbol {
  const { ast, adapter, source } = file;
  const classNode = findNodeByLocation(ast.root, cls.location.start);

  const methods = cls.methods.map((m) => {
    const methodNode = findNodeByLocation(ast.root, m.location.start);
    return {
      name: m.name,
      line: m.location.start.line,
      column: m.location.start.column,
      parameterCount: m.parameters.length,
      parameterNames: m.parameters.map((p) => p.name),
      lineCount: m.location.end.line - m.location.start.line + 1,
      complexity: methodNode ? adapter.getComplexity(methodNode) : 0,
      throws: methodNode ? nodeThrows(methodNode) : false,
      concernGroups: methodNode
        ? votingConcerns(detectFunctionConcerns(methodNode, (n) => adapter.getNodeText(n, source))).map((c) => CONCERN_LABELS[c])
        : [],
      jsDoc: m.jsDoc ?? null,
      isNonPublic: methodNode ? isNonPublicMethod(methodNode, adapter, source) : false,
      returnType: m.returnType,
    };
  });

  const aggregateComplexity = methods.reduce((sum, m) => sum + m.complexity, 0);

  return {
    kind: 'class',
    file: file.file,
    name: cls.name,
    line: cls.location.start.line,
    column: cls.location.start.column,
    isExported: cls.isExported,
    extends: cls.extends,
    methodCount: cls.methods.length,
    aggregateComplexity,
    hasInstanceofAgainstUserType: classNode ? hasTypeChecking(classNode, adapter, source) : false,
    hasHeldDirectInstantiation: classNode ? hasHeldInstantiation(cls.name, classNode, adapter, source) : false,
    methods,
    jsDoc: cls.jsDoc ?? null,
  };
}

function extractFunction(
  file: ParsedFile,
  func: FunctionInfo,
  ast: ParsedFile['ast'],
  source: string,
): FileFunctionSymbol {
  const funcNode = findFunctionNode(ast.root, func.location.start);
  const complexity = funcNode ? file.adapter.getComplexity(funcNode) : 0;
  const concernGroups = funcNode
    ? votingConcerns(detectFunctionConcerns(funcNode, (n) => file.adapter.getNodeText(n, source))).map((c) => CONCERN_LABELS[c])
    : [];

  return {
    kind: 'function',
    file: file.file,
    name: func.name,
    className: func.className,
    line: func.location.start.line,
    column: func.location.start.column,
    endLine: func.location.end.line,
    isExported: func.isExported,
    isAsync: func.isAsync,
    parameterCount: func.parameters.length,
    parameterNames: func.parameters.map((p) => p.name),
    lineCount: func.location.end.line - func.location.start.line + 1,
    complexity,
    concernGroups,
    jsDoc: func.jsDoc ?? null,
    returnType: func.returnType,
    isAnonymousOrCallback: funcNode ? isAnonymousOrCallback(funcNode, file.adapter) : false,
  };
}

// ── Helpers (re-homed from UniversalSOLIDAnalyzer) ───────────────────────────

/** True when the node subtree contains a `throw_statement`. */
function nodeThrows(node: ASTNode): boolean {
  let hasThrow = false;
  walkAST(node, (n) => {
    if (n.type === 'throw_statement') hasThrow = true;
  });
  return hasThrow;
}

// ── Documentation skip signals (re-homed from UniversalDocumentationAnalyzer) ─

/**
 * True when a method is non-public: an accessibility modifier of `private` /
 * `protected`, or a `#`-prefixed (JS private) / `_`-prefixed (convention) name.
 * This is the R1.2 signal `method-documentation` and the method arm of the
 * function/param/return skip use. Re-homed verbatim — it reads the AST node's
 * children and name, which the rule cannot reach once the tree is freed.
 */
function isNonPublicMethod(
  node: ASTNode,
  adapter: ParsedFile['adapter'],
  sourceCode: string,
): boolean {
  const type = adapter.getNodeType(node);
  if (type !== 'method_definition' && type !== 'public_field_definition') {
    return false;
  }

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

  const propName = getMethodName(node, adapter, sourceCode);
  if (propName && (propName.startsWith('#') || propName.startsWith('_'))) {
    return true;
  }

  return false;
}

/** The name of a method-definition node (property_identifier or identifier). */
function getMethodName(
  node: ASTNode,
  adapter: ParsedFile['adapter'],
  sourceCode: string,
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
 * True when the node is an anonymous arrow/function expression used as a call
 * argument, JSX attribute value, object/array literal passed as an argument, or
 * an IIFE (R1.1 — inline callables are skipped, not downgraded). Re-homed
 * verbatim; the rule cannot reach the parent chain once the tree is freed.
 */
function isAnonymousOrCallback(node: ASTNode, adapter: ParsedFile['adapter']): boolean {
  const nodeType = adapter.getNodeType(node);
  const parent = adapter.getParent(node);
  if (!parent) return false;

  const parentType = adapter.getNodeType(parent);

  if (
    nodeType === 'arrow_function' ||
    nodeType === 'function_expression' ||
    nodeType === 'generator_function_expression'
  ) {
    if (isInlineInCallArguments(parent, adapter)) return true;
    if (isJsxAttributeValue(parentType)) return true;
    if (parentType === 'call_expression' && isIifeCallee(node, parent, adapter)) return true;
  }

  return false;
}

/** (a)/(c) — true when `parent` positions the inline callable as a call argument. */
function isInlineInCallArguments(parent: ASTNode, adapter: ParsedFile['adapter']): boolean {
  const parentType = adapter.getNodeType(parent);
  if (parentType === 'arguments') return true;

  if (parentType === 'pair') {
    const gp = adapter.getParent(parent);
    if (gp && (adapter.getNodeType(gp) === 'object' || adapter.getNodeType(gp) === 'object_pattern')) {
      const ggp = adapter.getParent(gp);
      return !!(ggp && adapter.getNodeType(ggp) === 'arguments');
    }
  }

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
function isIifeCallee(node: ASTNode, parent: ASTNode, adapter: ParsedFile['adapter']): boolean {
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

/** The first child node matching one of the given types. */
function getFirstChildOfType(node: ASTNode, types: string[]): ASTNode | null {
  if (!node.children) return null;
  for (const child of node.children) {
    if (types.includes(child.type)) {
      return child;
    }
  }
  return null;
}

/** True when the class body uses `instanceof` against a user-defined type. */
function hasTypeChecking(
  classNode: ASTNode,
  adapter: ParsedFile['adapter'],
  sourceCode: string,
): boolean {
  let has = false;
  walkAST(classNode, (node) => {
    if (node.type !== 'binary_expression') return;
    const text = adapter.getNodeText(node, sourceCode);
    const m = /\binstanceof\s+([A-Za-z_$][\w$]*)/.exec(text);
    if (m && !BUILTIN_TYPES.has(m[1])) has = true;
  });
  return has;
}

/** True when the class body holds (does not escape) a `new PascalCaseType()`. */
function hasHeldInstantiation(
  className: string,
  classNode: ASTNode,
  adapter: ParsedFile['adapter'],
  sourceCode: string,
): boolean {
  let has = false;
  walkASTWithAncestors(classNode, (node, ancestors) => {
    if (node.type !== 'new_expression') return;
    if (constructionEscapes(ancestors)) return;
    const ctor = (node.children ?? []).find(
      (c) => c.type !== 'arguments' && c.type !== 'type_arguments',
    );
    if (!ctor || ctor.type !== 'identifier') return;
    const ctorName = getNodeText(ctor, sourceCode).trim();
    if (!/^[A-Z]/.test(ctorName)) return;
    if (BUILTIN_TYPES.has(ctorName)) return;
    if (ctorName === className) return;
    has = true;
  });
  return has;
}

/** True when the `new` expression escapes via throw/return (not a held dependency). */
function constructionEscapes(ancestors: ASTNode[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const type = ancestors[i].type;
    if (type === 'throw_statement' || type === 'return_statement') return true;
    if (!ESCAPE_WRAPPERS.has(type)) return false;
  }
  return false;
}

/** Depth-first walk that also passes each node's ancestor chain. */
function walkASTWithAncestors(
  node: ASTNode,
  callback: (node: ASTNode, ancestors: ASTNode[]) => void,
  ancestors: ASTNode[] = [],
): void {
  callback(node, ancestors);
  if (node.children) {
    const next = [...ancestors, node];
    for (const child of node.children) walkASTWithAncestors(child, callback, next);
  }
}

/** BFS for the node whose start position matches `location`. */
function findNodeByLocation(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
  const queue: ASTNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.location.start.line === location.line && node.location.start.column === location.column) {
      return node;
    }
    if (node.children) queue.push(...node.children);
  }
  return null;
}

/** Find the function/method node at `location`, disambiguating the program root. */
function findFunctionNode(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
  let found: ASTNode | null = null;
  walkAST(root, (node) => {
    if (found) return;
    if (
      node.location.start.line === location.line &&
      node.location.start.column === location.column &&
      isFunctionNodeType(node.type)
    ) {
      found = node;
    }
  });
  return found;
}
