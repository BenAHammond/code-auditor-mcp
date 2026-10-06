/**
 * Receiver root resolution — Spec 69 §10 S5e.
 *
 * cannot-fire keys to the *receiver's root resolution being inconclusive*, not
 * to the callee's method name. Every query-candidate receiver resolves to a root
 * identifier, and that root gets one of three dispositions:
 *
 *   • `handle`     — the root resolves to a DB handle (package import, DB-handle
 *                    type annotation, wrapper class/function, or form-5 function
 *                    return). The finding path extracts it; no coverage offset.
 *   • `not-handle` — the root resolves to something that is *definitively* not a
 *                    DB handle: an ambient global (no binding anywhere in the
 *                    file's scope chain), a literal / primitive / object / array
 *                    declaration, a non-DB-typed parameter, or a non-DB
 *                    constructor (`new URLSearchParams()`).
 *                    `clean` is the *correct* outcome, not a silent one.
 *   • `unproven`   — the root resolves to something genuinely undetermined: a
 *                    `any`/`unknown` type, an un-annotated parameter, an
 *                    un-annotated factory return, an unresolvable import, or an
 *                    unrecognized bare-specifier package (Spec 70 R4 — not in the
 *                    database-packages manifest). This is the cannot-fire surface
 *                    (Spec 69 §10 S5a).
 *
 * There is NO identifier list on either side. A global is `not-handle` because it
 * resolved to the global scope (no binding), not because it was enumerated; a
 * name is `handle` because it resolved to a DB package/type/wrapper, not because
 * it *looks* like `db`.
 */

import type { AST, LanguageAdapter, ASTNode } from '../languages/types.js';
import type { ProvenanceEvidence } from './provenance.js';
import { isNodeBuiltin, JS_GLOBALS } from './tsEcosystem.js';

/** A receiver root's disposition (Spec 69 §10 S5e). */
export type RootDisposition = 'handle' | 'not-handle' | 'unproven';

/** How a name is bound in the file's scope chain. */
export type BindingKind =
  | 'import'
  | 'variable'
  | 'parameter'
  | 'field'
  | 'function'
  | 'class';

/**
 * A serializable description of a binding's initializer/value expression,
 * extracted from the AST while it lives so a binding can outlive its file
 * without carrying a tree-sitter node (Spec 70 — no AST outliving its file).
 *
 * Classification (which depends on the file's provenance + bindings, unknown at
 * extraction time) is deferred to {@link classifyValue}; the descriptor carries
 * only names and structure, never a node.
 */
export type ValueDescriptor =
  | { readonly kind: 'literal' }
  | { readonly kind: 'identifier'; readonly name: string }
  | { readonly kind: 'new'; readonly ctorName: string | null }
  | {
      readonly kind: 'call';
      readonly calleeKind: 'identifier' | 'member' | 'other';
      readonly calleeName: string | null;
      readonly receiverRoot: string | null;
    }
  | { readonly kind: 'member'; readonly root: string | null }
  | { readonly kind: 'as'; readonly typeText: string | null; readonly operand: ValueDescriptor | null }
  | { readonly kind: 'unwrap'; readonly operand: ValueDescriptor | null }
  | { readonly kind: 'function' }
  | { readonly kind: 'other' };

/** A single binding: how a name is declared in a file. */
export interface Binding {
  kind: BindingKind;
  /** Import source specifier (kind === 'import'). */
  source?: string;
  /** Type-annotation text (variable / parameter / field / function return). */
  typeText?: string;
  /** Initializer / value expression, as a serializable descriptor (variable /
   *  field). Never a live AST node — the binding may outlive its file's tree. */
  value?: ValueDescriptor;
}

/** Per-file resolution inputs the classifier reads. */
export interface RootResolutionEnv {
  /** Already-provenanced DB handles (package imports + propagation + wrappers). */
  provenance: ReadonlyMap<string, ProvenanceEvidence>;
  /** name → binding (import / declaration / parameter / field). */
  bindings: ReadonlyMap<string, Binding>;
  /** Resolve an import specifier to an in-repo absolute path, or null. */
  resolveImport?: (source: string) => string | null;
  /** The adapter + source text for reading value/type node text. */
  adapter: LanguageAdapter;
  sourceCode: string;
}

// ── Binding extraction ───────────────────────────────────────────────────────

/** Node types that declare a value name in the file scope. */
const VALUE_DECLARATION_TYPES = new Set([
  'variable_declarator',
  'required_parameter',
  'optional_parameter',
  'public_field_definition',
  'field_definition',
  'function_declaration',
  'method_definition',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
]);

const FUNCTION_NAME_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'generator_function_declaration',
]);

const CLASS_NAME_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
]);

/**
 * Build the per-file binding environment: imports, variable/parameter/field
 * declarations, and function/class declaration names.
 *
 * This is structural resolution — enumerating *what is actually bound in the
 * file* — not a curated name list. A name is `not-handle` because it has no
 * binding here (ambient global), never because it is on some list.
 *
 * @param ast the parsed file AST whose imports and declarations seed the map
 * @param adapter the language adapter used to read node names and text
 * @param sourceCode the file source text for reading node text
 * @returns a name → binding map for every name bound in the file
 */
export function buildBindingEnv(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): Map<string, Binding> {
  const bindings = new Map<string, Binding>();

  for (const imp of adapter.extractImports(ast)) {
    for (const spec of imp.specifiers) {
      const name = spec.alias ?? spec.name;
      if (!name || name === '*') continue;
      if (!bindings.has(name)) {
        bindings.set(name, { kind: 'import', source: imp.source });
      }
    }
  }

  const nodes = adapter.findNodes(ast, {
    custom: (n: ASTNode) => VALUE_DECLARATION_TYPES.has(n.type),
  });

  for (const node of nodes) {
    if (node.type === 'variable_declarator') {
      for (const name of variableDeclaratorNames(node, adapter, sourceCode)) {
        if (name && !bindings.has(name)) {
          bindings.set(name, bindingFromDeclarator(node, adapter, sourceCode));
        }
      }
      continue;
    }

    if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
      const name = parameterName(node, adapter, sourceCode);
      if (name && !bindings.has(name)) {
        bindings.set(name, {
          kind: 'parameter',
          typeText: childTypeAnnotationText(node, adapter, sourceCode),
        });
      }
      continue;
    }

    if (node.type === 'public_field_definition' || node.type === 'field_definition') {
      const name = fieldName(node, adapter, sourceCode);
      if (name && !bindings.has(name)) {
        bindings.set(name, bindingFromField(node, adapter, sourceCode));
      }
      continue;
    }

    if (FUNCTION_NAME_TYPES.has(node.type)) {
      const name = adapter.getNodeName(node);
      if (name && !bindings.has(name)) bindings.set(name, { kind: 'function' });
      continue;
    }

    if (CLASS_NAME_TYPES.has(node.type)) {
      const name = adapter.getNodeName(node);
      if (name && !bindings.has(name)) bindings.set(name, { kind: 'class' });
    }
  }

  return bindings;
}

function variableDeclaratorNames(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string[] {
  const children = adapter.getChildren(node);
  const nameNode = children.find(
    (c) => c.type === 'identifier' || c.type === 'object_pattern' || c.type === 'array_pattern',
  );
  if (!nameNode) return [];
  if (nameNode.type === 'identifier') return [adapter.getNodeText(nameNode, sourceCode) ?? ''];
  const names: string[] = [];
  collectPatternNames(nameNode, adapter, sourceCode, names);
  return names;
}

function collectPatternNames(node: ASTNode, adapter: LanguageAdapter, sourceCode: string, out: string[]): void {
  if (node.type === 'identifier') {
    const name = adapter.getNodeText(node, sourceCode);
    if (name) out.push(name);
    return;
  }
  for (const child of adapter.getChildren(node)) {
    if ([':', '=', '{', '}', '[', ']', ','].includes(child.type)) continue;
    collectPatternNames(child, adapter, sourceCode, out);
  }
}

function parameterName(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const id = adapter.getChildren(node).find((c) => c.type === 'identifier');
  return id ? adapter.getNodeText(id, sourceCode) : null;
}

function fieldName(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const id = adapter.getChildren(node).find(
    (c) => c.type === 'property_identifier' || c.type === 'field_identifier',
  );
  return id ? adapter.getNodeText(id, sourceCode) : null;
}

function childTypeAnnotationText(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | undefined {
  const typeNode = adapter.getChildren(node).find((c) => c.type === 'type_annotation');
  if (!typeNode) return undefined;
  return adapter.getNodeText(typeNode, sourceCode).trim();
}

function bindingFromDeclarator(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): Binding {
  const children = adapter.getChildren(node);
  const typeNode = children.find((c) => c.type === 'type_annotation');
  let valueNode: ASTNode | undefined;
  let pastEquals = false;
  for (const child of children) {
    if (child.type === '=' || child.type === 'equals') { pastEquals = true; continue; }
    if (child.type === ':' || child.type === 'type_annotation') continue;
    if (pastEquals || (!valueNode && child.type !== 'identifier' && child.type !== 'object_pattern' && child.type !== 'array_pattern')) {
      valueNode = child;
      break;
    }
  }
  return {
    kind: 'variable',
    typeText: typeNode ? adapter.getNodeText(typeNode, sourceCode).trim() : undefined,
    value: valueNode ? describeValue(valueNode, adapter, sourceCode) : undefined,
  };
}

function bindingFromField(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): Binding {
  const children = adapter.getChildren(node);
  const typeNode = children.find((c) => c.type === 'type_annotation');
  const valueNode = children.find(
    (c) =>
      c.type !== 'property_identifier' &&
      c.type !== 'field_identifier' &&
      c.type !== 'decorator' &&
      c.type !== 'accessibility_modifier' &&
      c.type !== 'private' &&
      c.type !== 'public' &&
      c.type !== 'protected' &&
      c.type !== 'static' &&
      c.type !== 'readonly' &&
      c.type !== 'abstract' &&
      c.type !== 'type_annotation',
  );
  return {
    kind: 'field',
    typeText: typeNode ? adapter.getNodeText(typeNode, sourceCode).trim() : undefined,
    value: valueNode ? describeValue(valueNode, adapter, sourceCode) : undefined,
  };
}

/**
 * Extract a serializable {@link ValueDescriptor} from a value/initializer
 * expression node, mirroring {@link classifyValue}'s structural dispatch exactly
 * but extracting names/structure instead of classifying. The descriptor lets a
 * binding outlive its file's AST; classification is deferred to
 * {@link classifyValue} at the point of use, where the file's provenance and
 * bindings are known.
 */
function describeValue(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): ValueDescriptor {
  const { type } = node;
  if (NON_HANDLE_VALUE_TYPES.has(type)) return { kind: 'literal' };
  if (type === 'identifier') return { kind: 'identifier', name: adapter.getNodeText(node, sourceCode) ?? '' };

  if (type === 'await_expression' || type === 'parenthesized_expression' || type === 'binary_expression' || type === 'ternary_expression') {
    for (const child of adapter.getChildren(node)) {
      if (type === 'await_expression' && child.type === 'await') continue;
      if (type === 'parenthesized_expression' && (child.type === '(' || child.type === ')')) continue;
      if ((type === 'binary_expression' || type === 'ternary_expression') && isPunctuation(child.type)) continue;
      return { kind: 'unwrap', operand: describeValue(child, adapter, sourceCode) };
    }
    return { kind: 'unwrap', operand: null };
  }

  if (type === 'new_expression') {
    const ctor = findChildOfType(node, ['identifier', 'member_expression']);
    const ctorName = ctor ? extractIdentifierName(ctor, adapter, sourceCode) : null;
    return { kind: 'new', ctorName };
  }

  if (type === 'call_expression') {
    const callee = getCallExpressionCallee(node, adapter);
    if (callee?.type === 'identifier') {
      return { kind: 'call', calleeKind: 'identifier', calleeName: adapter.getNodeText(callee, sourceCode) ?? '', receiverRoot: null };
    }
    if (callee && (callee.type === 'member_expression' || callee.type === 'selector_expression')) {
      return { kind: 'call', calleeKind: 'member', calleeName: null, receiverRoot: resolveReceiverRoot(callee, adapter, sourceCode) };
    }
    return { kind: 'call', calleeKind: 'other', calleeName: null, receiverRoot: null };
  }

  if (type === 'member_expression' || type === 'selector_expression') {
    return { kind: 'member', root: resolveReceiverRoot(node, adapter, sourceCode) };
  }

  if (type === 'as_expression' || type === 'satisfies_expression') {
    const children = adapter.getChildren(node);
    const typeNode = children.find((c) => c.type === 'type_annotation' || c.type === 'predefined_type');
    if (typeNode) {
      return { kind: 'as', typeText: adapter.getNodeText(typeNode, sourceCode), operand: null };
    }
    const operand = children.find((c) => c.type !== 'as' && c.type !== 'satisfies');
    if (operand && operand !== node) return { kind: 'as', typeText: null, operand: describeValue(operand, adapter, sourceCode) };
    return { kind: 'as', typeText: null, operand: null };
  }

  if (type === 'arrow_function' || type === 'function_expression' || type === 'function') {
    return { kind: 'function' };
  }

  return { kind: 'other' };
}

// ── Classification ───────────────────────────────────────────────────────────

const NON_HANDLE_VALUE_TYPES = new Set([
  'string',
  'string_fragment',
  'template_string',
  'number',
  'object',
  'array',
  'true',
  'false',
  'null',
  'undefined',
  'regex',
  'bigint',
]);

const NON_HANDLE_PRIMITIVES = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'void',
  'null',
  'undefined',
  'never',
]);

/**
 * Classify a bare root identifier's disposition under the file's resolution env.
 *
 * @param name the bare root identifier to classify
 * @param env the file's resolution environment (provenance, bindings, adapter)
 * @param depth recursion guard; classification gives up past depth 8
 * @param opts `thisField` marks the name as a `this.<field>` reference
 * @returns `handle`, `not-handle`, or `unproven`
 */
export function classifyRootIdentifier(
  name: string,
  env: RootResolutionEnv,
  depth = 0,
  opts?: { thisField?: boolean },
): RootDisposition {
  if (!name) return 'unproven';
  if (env.provenance.has(name)) return 'handle';
  if (depth > 8) return 'unproven';

  const binding = env.bindings.get(name);
  if (!binding) {
    // A bare unbound name is an ambient global → not-handle. An undeclared
    // `this.<field>` is a dynamic/unseen field → unproven (the caller passes
    // `thisField` when the receiver chain bottoms out at `this`/`super`).
    return opts?.thisField ? 'unproven' : 'not-handle';
  }

  if (opts?.thisField && binding.kind !== 'field') {
    // `this.<field>` is a field reference, never a local name. A parameter,
    // variable, import, function, or class of the same name is a *shadow*, not
    // the field's type — consulting it would let `env`/`ctx`/`state` resolve to
    // a local's disposition instead of the field. Leave it unproven: a plain
    // unresolvable field stays cannot-fire rather than clean. There is no
    // type-heritage resolver to prove base-class fields — the form-3
    // `classifyThisChain` was deleted as dead code (Spec 69 R3).
    return 'unproven';
  }

  switch (binding.kind) {
    case 'import':
      return classifyImportSource(binding.source ?? '', env);
    case 'variable':
    case 'field':
      if (binding.typeText) return classifyTypeText(binding.typeText, env, depth);
      if (binding.value) return classifyValue(binding.value, env, depth);
      return 'unproven';
    case 'parameter':
      if (binding.typeText) return classifyTypeText(binding.typeText, env, depth);
      return 'unproven';
    case 'function':
    case 'class':
      return 'unproven';
  }
}

/**
 * True when a receiver root is DB-shaped — its disposition is `handle` or
 * `unproven` — never a name list. This is the package-discriminant replacement
 * for the deleted `DB_CALL_METHODS` / `isDbShapedMethod` candidacy filters: a
 * call is a DB/ORM candidate when its receiver resolves to a DB package/handle
 * or to something unresolved, and NOT when it resolves to a provably non-DB
 * receiver (a JS global, primitive, or Node builtin). `join` is
 * `Array.prototype.join` (root `Array` → not-handle) and also `SQL JOIN`
 * (root `db` → handle) — the receiver's resolution, not the method name,
 * distinguishes them.
 *
 * @param root the bare receiver-root identifier to classify
 * @param env the file's resolution environment (provenance, bindings, adapter)
 * @returns true unless the root provably resolves to a non-DB receiver
 */
export function isDbShapedRoot(root: string, env: RootResolutionEnv, opts?: { thisField?: boolean }): boolean {
  return classifyRootIdentifier(root, env, 0, opts) !== 'not-handle';
}

function classifyImportSource(source: string, env: RootResolutionEnv): RootDisposition {
  const isRelative = source.startsWith('./') || source.startsWith('../');
  const isAlias = source.startsWith('@/') || source.startsWith('~/');
  if (!isRelative && !isAlias) {
    // Bare specifier → node_modules or a Node builtin. A DB package would already
    // be provenanced (extractDBProvenancedImports); a Node builtin (`fs`,
    // `node:path`, …) is provably not a DB client → `not-handle`. Anything else
    // reaching here is NOT in the database-packages manifest — Spec 70 R4: an
    // unrecognized package reached by resolution reports cannot-fire, never a
    // guessed clean.
    if (isNodeBuiltin(source)) return 'not-handle';
    return 'unproven';
  }
  if (!env.resolveImport) return 'unproven';
  const resolved = env.resolveImport(source);
  if (resolved) return 'not-handle'; // in-repo file, name not a handle.
  return 'unproven'; // the existing unresolved-import cannot-fire signal.
}

function classifyTypeText(typeText: string, env: RootResolutionEnv, depth: number): RootDisposition {
  const t = typeText.trim();
  const unionParts = splitTopLevel(t, '|');
  const interParts = splitTopLevel(t, '&');
  if (unionParts.length > 1 || interParts.length > 1) {
    const parts = unionParts.length > 1 ? unionParts : interParts;
    const dispositions = parts.map((p) => classifyTypeText(p, env, depth + 1));
    if (dispositions.some((d) => d === 'handle')) return 'handle';
    if (dispositions.every((d) => d === 'not-handle')) return 'not-handle';
    return 'unproven';
  }

  const base = baseTypeName(t);
  if (base === 'any' || base === 'unknown') return 'unproven';
  if (NON_HANDLE_PRIMITIVES.has(base)) return 'not-handle';
  if (/\[\]$/.test(t) || /^ReadonlyArray</.test(t) || /^Array</.test(t)) return 'not-handle';
  // A JS builtin global type (`Map`, `Set`, `Buffer`, `Date`, `Promise`, `String`,
  // …) is provably not a DB handle — the global object's own names, enumerated at
  // load, never a hand-written list.
  if (JS_GLOBALS.has(base)) return 'not-handle';
  // A non-primitive type name (e.g. `D1Database`, `Pool`, `MyDb`) no longer
  // proves or disproves handle-ness: the parsed SQL argument is the handle
  // proof (Spec 70 criterion 9 deletes handle-type names as a test). The old
  // `classifyRootIdentifier(base, …)` treated the *type* name as a *value*
  // name, returning `not-handle` for an unbound ambient interface and thereby
  // silently dropping a type-annotated handle before its SQL could be seen.
  // Anything that is not a primitive stays `unproven` — visible, never clean.
  return 'unproven';
}

function baseTypeName(typeText: string): string {
  let t = typeText.trim();
  if (t.startsWith(':')) t = t.slice(1).trim();
  if (t.startsWith('typeof ')) t = t.slice('typeof '.length).trim();
  if (t.startsWith('keyof ')) t = t.slice('keyof '.length).trim();
  const lt = t.indexOf('<');
  if (lt > 0 && t.endsWith('>')) t = t.slice(0, lt).trim();
  return t;
}

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === sep && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function classifyValue(value: ValueDescriptor, env: RootResolutionEnv, depth: number): RootDisposition {
  switch (value.kind) {
    case 'literal':
    case 'function':
      return 'not-handle';

    case 'identifier':
      return classifyRootIdentifier(value.name, env, depth + 1);

    case 'new':
      if (value.ctorName) return classifyRootIdentifier(value.ctorName, env, depth + 1);
      return 'unproven';

    case 'call':
      if (value.calleeKind === 'identifier') {
        const name = value.calleeName ?? '';
        if (env.provenance.has(name)) return 'handle';
        // A *declared* factory name that resolves non-handle (an import from a
        // non-DB package, a variable typed as a non-handle) proves the return is
        // non-handle: `const $ = load(html)` with `load` from `cheerio`. A truly
        // *unbound* factory name is NOT proof of non-handle — `getConnection()`
        // might return a connection — so only accept not-handle for a name that has
        // a binding in scope.
        const disp = classifyRootIdentifier(name, env, depth + 1);
        if (disp === 'not-handle' && env.bindings.has(name)) return 'not-handle';
        return 'unproven';
      }
      if (value.calleeKind === 'member') {
        const root = value.receiverRoot;
        // A method call on a *provably non-DB* root is itself non-DB: `cheerio.load()`,
        // `JSON.parse()`, `lodash.get()` all resolve to a package/global that is not a
        // handle, so the call's return is not a handle either.
        if (root) {
          const rootDisp = classifyRootIdentifier(root, env, depth + 1);
          if (rootDisp === 'handle') return 'handle';
          if (rootDisp === 'not-handle') return 'not-handle';
        }
      }
      return 'unproven';

    case 'member':
      if (value.root) return classifyRootIdentifier(value.root, env, depth + 1);
      return 'not-handle';

    case 'as':
      if (value.typeText != null) return classifyTypeText(value.typeText, env, depth + 1);
      if (value.operand) return classifyValue(value.operand, env, depth + 1);
      return 'unproven';

    case 'unwrap':
      if (value.operand) return classifyValue(value.operand, env, depth + 1);
      return 'unproven';

    case 'other':
      return 'unproven';
  }
}

function isPunctuation(type: string): boolean {
  return [
    '?', ':', '(', ')', '??', '&&', '||', '=', '===', '==', '+', '-', '*', '/', '%', '.', ',',
  ].includes(type);
}

function findChildOfType(node: ASTNode, types: string[]): ASTNode | null {
  for (const child of node.children ?? []) {
    if (types.includes(child.type)) return child;
    const found = findChildOfType(child, types);
    if (found) return found;
  }
  return null;
}

function extractIdentifierName(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  if (node.type === 'identifier') return adapter.getNodeText(node, sourceCode);
  if (node.type === 'member_expression' || node.type === 'selector_expression') {
    const firstChild = node.children?.[0];
    if (firstChild) return extractIdentifierName(firstChild, adapter, sourceCode);
  }
  return null;
}

function getCallExpressionCallee(node: ASTNode, adapter: LanguageAdapter): ASTNode | null {
  for (const child of adapter.getChildren(node)) {
    if (child.type === 'arguments') break;
    if (child.type === 'await_expression') {
      const inner = getCallExpressionCallee(child, adapter);
      if (inner) return inner;
      continue;
    }
    if (
      child.type === 'identifier' ||
      child.type === 'member_expression' ||
      child.type === 'selector_expression' ||
      child.type === 'call_expression'
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Resolve a member/selector chain to its root identifier name (the leftmost
 * segment, descending through call expressions for builder chains). Returns the
 * bare name (`"db"` for `db.select().from()`, `"page"` for `page.locator()`), or
 * `null` when the root is a literal (array/object/string) or otherwise not an
 * identifier.
 *
 * @param callee the member/selector/identifier expression to resolve
 * @param adapter the language adapter used to read children and text
 * @param sourceCode the file source text for reading node text
 * @returns the leftmost identifier name, or null for a non-identifier root
 */
export function resolveReceiverRoot(
  callee: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  let current: ASTNode = callee;
  while (current.type === 'member_expression' || current.type === 'selector_expression') {
    const children = adapter.getChildren(current);
    const object = children.find(
      (c) => c.type !== '.' && c.type !== 'property_identifier' && c.type !== 'field_identifier',
    );
    if (!object) return null;

    // When the object is `this`/`super`, the receiver's root is the property of
    // THIS member expression — the first segment after `this` (`env` in
    // `this.env.DB`, `ctx` in `this.ctx.storage.sql`). Returning it here avoids
    // the old `findFirstProperty` fallback, which scanned the whole callee for
    // the first `property_identifier` it could find — which is the *method*
    // (`prepare`/`exec`), i.e. the last segment, not the first.
    if (object.type === 'this' || object.type === 'super') {
      const prop = children.find(
        (c) => c.type === 'property_identifier' || c.type === 'field_identifier',
      );
      return prop ? adapter.getNodeText(prop, sourceCode) : null;
    }

    current = object;
  }

  if (current.type === 'call_expression') {
    const innerCallee = getCallExpressionCallee(current, adapter);
    if (innerCallee) return resolveReceiverRoot(innerCallee, adapter, sourceCode);
    return null;
  }

  if (current.type === 'identifier') {
    return adapter.getNodeText(current, sourceCode);
  }

  return null;
}
