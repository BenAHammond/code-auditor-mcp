/**
 * Spec 68 §3.2 — the `file-symbols` producer's extraction.
 *
 * This is where the SOLID analyzer's per-file AST walking *used* to happen. It
 * folds `adapter.extractFunctions` / `extractClasses` / `extractInterfaces`
 * into a serializable `FileSymbols` per symbol, pre-computing every metric a
 * symbol-level rule needs (complexity, concern groups, line/param counts, the
 * open-closed `instanceof` targets, the LSP `throws` signal). The tree dies
 * with the file; `analyze` sees only these plain-data records.
 *
 * This is a temporary re-homing of the SOLID analyzer's private helpers
 * (`BUILTIN_TYPES`, `findNodeByLocation`, `methodThrows`, …). They live in
 * `UniversalSOLIDAnalyzer.ts` today and are deleted with that analyzer in §15;
 * importing them across the phase boundary would couple the new pipeline to a
 * class that is about to be removed, so they are re-declared here instead.
 */

import type { AstFile, FileSymbols, FileFunctionSymbol, FileClassSymbol } from './types.js';
import type { ASTNode, ClassInfo, FunctionInfo } from '../languages/types.js';
import { walkAST } from '../languages/adapterBridge.js';
import { findNodeByLocation } from '../languages/locationIndex.js';
import { detectFunctionConcerns, votingConcerns, CONCERN_LABELS, isFunctionNodeType } from '../analyzers/universal/functionConcerns.js';

/**
 * Builtin / standard-library type names excluded from the open-closed
 * `instanceof` signal (mirrors UniversalSOLIDAnalyzer's set). Platform
 * primitives, error types, and web globals are legitimate runtime concerns, not
 * extensibility (OCP) signals.
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
  // Web platform globals (Fetch + Streams API) — `instanceof Response` /
  // `instanceof ReadableStream` are platform type-checks, not extensibility
  // (OCP) signals, exactly like `instanceof Date` / `instanceof Error` above.
  'Request', 'Response', 'Headers',
  'ReadableStream', 'WritableStream', 'TransformStream',
]);

/**
 * Extract every symbol (function / class / interface) from one parsed file.
 *
 * @param file - The parsed file whose symbols are projected.
 * @returns The file's functions, classes, and interfaces as plain-data symbols.
 */
export function extractFileSymbols(file: AstFile): FileSymbols[] {
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
      extends: iface.extends ?? [],
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

function extractClass(file: AstFile, cls: ClassInfo): FileClassSymbol {
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
    implements: cls.implements ?? [],
    methodCount: cls.methods.length,
    aggregateComplexity,
    instanceofTargets: classNode ? extractInstanceofTargets(classNode, adapter, source) : [],
    methods,
    jsDoc: cls.jsDoc ?? null,
  };
}

function extractFunction(
  file: AstFile,
  func: FunctionInfo,
  ast: AstFile['ast'],
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
  adapter: AstFile['adapter'],
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
  adapter: AstFile['adapter'],
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
function isAnonymousOrCallback(node: ASTNode, adapter: AstFile['adapter']): boolean {
  const nodeType = adapter.getNodeType(node);
  const parent = adapter.getParent(node);
  if (!parent) return false;

  const parentType = adapter.getNodeType(parent);

  if (
    nodeType === 'arrow_function' ||
    nodeType === 'function_expression' ||
    nodeType === 'generator_function'
  ) {
    if (isInlineInCallArguments(parent, adapter)) return true;
    if (isJsxAttributeValue(parentType)) return true;
    if (parentType === 'call_expression' && isIifeCallee(node, parent, adapter)) return true;
  }

  return false;
}

/** (a)/(c) — true when `parent` positions the inline callable as a call argument. */
function isInlineInCallArguments(parent: ASTNode, adapter: AstFile['adapter']): boolean {
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
function isIifeCallee(node: ASTNode, parent: ASTNode, adapter: AstFile['adapter']): boolean {
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

/** The non-builtin `instanceof` target names in the class body. The rule
 *  resolves these against the corpus-wide class declarations to separate a
 *  genuine OCP `instanceof` (a domain type) from an Error-subclass
 *  catch-dispatch, which is not an extensibility signal. */
function extractInstanceofTargets(
  classNode: ASTNode,
  adapter: AstFile['adapter'],
  sourceCode: string,
): string[] {
  const targets = new Set<string>();
  walkAST(classNode, (node) => {
    if (node.type !== 'binary_expression') return;
    const text = adapter.getNodeText(node, sourceCode);
    const m = /\binstanceof\s+([A-Za-z_$][\w$]*)/.exec(text);
    if (m && !BUILTIN_TYPES.has(m[1])) targets.add(m[1]);
  });
  return [...targets];
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
