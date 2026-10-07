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
import { isNodeBuiltin, isDbHandleTypeName, handleTypesForPackage, JS_GLOBALS } from './tsEcosystem.js';

/** A receiver root's disposition (Spec 69 §10 S5e). */
export type RootDisposition = 'handle' | 'not-handle' | 'unproven';

/** How a name is bound in the file's scope chain. */
export type BindingKind =
  | 'import'
  | 'variable'
  | 'parameter'
  | 'field'
  | 'function'
  | 'class'
  | 'type';

/** How an import binding's specifier was written (Spec 70 criterion 10). A
 *  default/namespace import's local name is arbitrary (it is the package's
 *  handle), while a named import's name is the handle only when the manifest
 *  lists it. */
export type ImportKind = 'default' | 'named' | 'namespace';

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
  /** How an import was written (kind === 'import'): default / named / namespace.
   *  Absent on older/foreign bindings, read as `named` by the classifier. */
  importKind?: ImportKind;
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
  /**
   * Interface / type-alias field types, keyed `interfaceName → fieldName → typeText`
   * (`interface Env { DB: D1Database }` → `Env → { DB: 'D1Database' }`). The
   * member-chain resolution arm (Spec 70 decision B3) reads this to resolve a
   * member receiver (`env.DB`) through its interface's field type — `env` typed
   * `Env` is not a handle, but `Env.DB` is `D1Database`, which is. Absent in the
   * Go env and in callers that classify a bare root with no member chain.
   */
  interfaceFields?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** The adapter + source text for reading value/type node text. */
  adapter: LanguageAdapter;
  sourceCode: string;
}

// ── Binding extraction ───────────────────────────────────────────────────────

/** Node types that declare a name in the file scope (value and/or type). */
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
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
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

/** Node types that declare a *type-only* name (interface / type alias / enum) —
 *  a name that can appear in a type annotation but is not a runtime value, so a
 *  value reference to it is `unproven` and a same-named handle type is shadowed
 *  (Spec 70 criterion 9 — the type→package lookup must know the name is local). */
const TYPE_DECLARATION_TYPES = new Set([
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
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
        const importKind: ImportKind = spec.isDefault ? 'default' : spec.isNamespace ? 'namespace' : 'named';
        bindings.set(name, { kind: 'import', source: imp.source, importKind });
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
      continue;
    }

    if (TYPE_DECLARATION_TYPES.has(node.type)) {
      const name = adapter.getNodeName(node);
      if (name && !bindings.has(name)) bindings.set(name, { kind: 'type' });
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
 * Extract interface and type-alias field-type maps (`Env → { DB: 'D1Database' }`)
 * for the member-chain resolution arm (Spec 70 decision B3). Walks
 * `interface_declaration` bodies (`interface_body`) and `type_alias_declaration`
 * object-literal bodies (`object_type`) for `property_signature` nodes, mapping
 * each declared field name to its type text. A name with a body but no typed
 * fields still yields a (possibly empty) entry — the entry's presence tells
 * {@link classifyMemberPath} the name is a *known* interface, so an unknown
 * field cannot-fire rather than falls back to the bare type name.
 */
export function extractInterfaceFields(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): Map<string, Map<string, string>> {
  const fields = new Map<string, Map<string, string>>();
  const decls = adapter.findNodes(ast, {
    custom: (n: ASTNode) =>
      n.type === 'interface_declaration' ||
      (n.type === 'type_alias_declaration' &&
        adapter.getChildren(n).some((c) => c.type === 'object_type')),
  });

  for (const decl of decls) {
    const nameNode = adapter.getChildren(decl).find((c) => c.type === 'type_identifier');
    const name = nameNode ? adapter.getNodeText(nameNode, sourceCode) : null;
    if (!name) continue;
    const body = adapter
      .getChildren(decl)
      .find((c) => c.type === 'interface_body' || c.type === 'object_type');
    if (!body) continue;

    let fieldMap = fields.get(name);
    if (!fieldMap) {
      fieldMap = new Map<string, string>();
      fields.set(name, fieldMap);
    }

    for (const sig of adapter.getChildren(body)) {
      if (sig.type !== 'property_signature') continue;
      const fieldNameNode = adapter.getChildren(sig).find((c) => c.type === 'property_identifier');
      const fieldName = fieldNameNode ? adapter.getNodeText(fieldNameNode, sourceCode) : null;
      if (!fieldName) continue;
      const typeText = propertySignatureFieldType(sig, adapter, sourceCode);
      if (typeText === undefined) continue;
      if (!fieldMap.has(fieldName)) fieldMap.set(fieldName, typeText);
    }
  }

  return fields;
}

/** Read a `property_signature`'s type text, stripping the annotation's `:`. */
function propertySignatureFieldType(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | undefined {
  const typeAnn = adapter.getChildren(node).find((c) => c.type === 'type_annotation');
  if (!typeAnn) return undefined;
  const typeNode = adapter.getChildren(typeAnn).find((c) => c.type !== ':');
  if (typeNode) {
    const text = adapter.getNodeText(typeNode, sourceCode);
    if (text) return text.trim();
  }
  const raw = adapter.getNodeText(typeAnn, sourceCode);
  return raw ? raw.trim().replace(/^:\s*/, '') : undefined;
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
 * @param opts `thisField` marks the name as a `this.<field>` reference;
 *            `memberPath` is the receiver's member chain after the root
 *            (e.g. `env.DB.prepare` → `['DB']`), resolved through the root's
 *            interface field types when present (Spec 70 decision B3)
 * @returns `handle`, `not-handle`, or `unproven`
 */
export function classifyRootIdentifier(
  name: string,
  env: RootResolutionEnv,
  depth = 0,
  opts?: { thisField?: boolean; memberPath?: readonly string[]; thisFieldType?: string | null },
): RootDisposition {
  if (!name) return 'unproven';
  if (env.provenance.has(name)) return 'handle';
  if (depth > 8) return 'unproven';

  // Form-3 heritage (Spec 70 Q3): a `this.<field>` reference resolves to the
  // enclosing class's base-class field type (`extends WorkflowEntrypoint<Env>`
  // → `this.env` is `Env`), then through the member path by the same
  // interface-field seam as B3. This runs *before* the binding lookup — the
  // heritage contract is authoritative, and a same-named local binding is a
  // shadow, not the field's type. No heritage contract → `thisFieldType` is
  // null and the field stays `unproven` (abstain, never a guess from the class
  // merely having a generic parameter).
  if (opts?.thisField && opts.thisFieldType) {
    return classifyTypeOrMember(opts.thisFieldType, opts.memberPath, env, depth + 1);
  }

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
    // unresolvable field stays cannot-fire rather than clean.
    return 'unproven';
  }

  switch (binding.kind) {
    case 'import':
      return classifyImportSource(binding.source ?? '', name, binding.importKind, env);
    case 'variable':
    case 'field':
      if (binding.typeText) return classifyTypeOrMember(binding.typeText, opts?.memberPath, env, depth);
      if (binding.value) return classifyValue(binding.value, env, depth);
      return 'unproven';
    case 'parameter':
      if (binding.typeText) return classifyTypeOrMember(binding.typeText, opts?.memberPath, env, depth);
      return 'unproven';
    case 'function':
    case 'class':
    case 'type':
      return 'unproven';
  }
}

/**
 * Classify a typed binding, resolving a member chain through interface field
 * types when one is supplied (Spec 70 decision B3). With no member path this is
 * the plain type-text classification.
 */
function classifyTypeOrMember(
  typeText: string,
  memberPath: readonly string[] | undefined,
  env: RootResolutionEnv,
  depth: number,
): RootDisposition {
  if (memberPath && memberPath.length > 0) {
    return classifyMemberPath(typeText, memberPath, env, depth);
  }
  return classifyTypeText(typeText, env, depth);
}

/**
 * Resolve a member receiver through its interface / type-alias field types
 * (Spec 70 decision B3): `env.DB` where `env` is typed `Env` and
 * `interface Env { DB: D1Database }` resolves `DB` → `D1Database` → handle.
 * Each step looks up the head member's declared field type in
 * `env.interfaceFields` and recurses on the remaining path; the final field
 * type is classified by the ordinary type-text rules. A field absent from the
 * known interface (or a type name with no known fields) cannot-fire — the
 * member is not a declared DB field, never a guessed clean.
 */
function classifyMemberPath(
  typeText: string,
  memberPath: readonly string[],
  env: RootResolutionEnv,
  depth: number,
): RootDisposition {
  const fields = env.interfaceFields;
  if (!fields || memberPath.length === 0) return classifyTypeText(typeText, env, depth);
  const base = baseTypeName(typeText);
  const iface = fields.get(base);
  if (!iface) return classifyTypeText(typeText, env, depth);
  const [head, ...rest] = memberPath;
  const fieldType = iface.get(head);
  if (fieldType === undefined) return 'unproven';
  if (rest.length === 0) return classifyTypeText(fieldType, env, depth + 1);
  return classifyMemberPath(fieldType, rest, env, depth + 1);
}

/**
 * Derive the receiver's member path after the root from the site strings (Spec 70
 * decision B3). `receiver` is the member-chain text left of the method (`env.DB`
 * for `env.DB.prepare`); `root` is its leftmost identifier (`env`); the path is
 * the non-root segments (`['DB']`). A `this`/`super`-rooted receiver has no
 * resolvable member path (its `thisField` guard already leaves it unproven), and
 * any segment that is not a plain identifier (a method name, an index, a call
 * result) is dropped to empty — only declared interface fields are resolvable.
 */
export function deriveMemberPath(
  root: string,
  receiver: string,
  thisField: boolean,
): readonly string[] {
  if (thisField || !root || !receiver.startsWith(root)) return [];
  const rest = receiver.slice(root.length).replace(/^[.\s]+/, '');
  if (!rest) return [];
  const parts = rest.split('.').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.some((p) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p))) return [];
  return parts;
}

/**
 * Derive the member path after the root for a `this`/`super`-rooted receiver
 * (Spec 70 Q3): `this.env.DB` → root `env`, path `['DB']`. Unlike
 * {@link deriveMemberPath} (which returns `[]` for a `this`-rooted receiver), the
 * `this.`/`super.` prefix is stripped first so the root's member chain is
 * recoverable — it resolves through the root's base-class field type (`this.env`
 * is `Env`) and then the same interface-field seam as B3.
 */
export function deriveThisMemberPath(root: string, receiver: string): readonly string[] {
  if (!root || !receiver) return [];
  const t = receiver.trim().replace(/^(?:this|super)\./, '');
  if (!t.startsWith(root)) return [];
  const rest = t.slice(root.length).replace(/^[.\s]+/, '');
  if (!rest) return [];
  const parts = rest.split('.').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.some((p) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p))) return [];
  return parts;
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

function classifyImportSource(
  source: string,
  name: string,
  importKind: ImportKind | undefined,
  env: RootResolutionEnv,
): RootDisposition {
  const isRelative = source.startsWith('./') || source.startsWith('../');
  const isAlias = source.startsWith('@/') || source.startsWith('~/');
  if (!isRelative && !isAlias) {
    // Bare specifier → node_modules or a Node builtin. A Node builtin (`fs`,
    // `node:path`, …) is provably not a DB client → `not-handle`. A manifest DB
    // package resolves by import kind: a default/namespace import is the
    // package's handle (its local name is arbitrary — `import mysql from
    // 'mysql2/promise'`), while a *named* import is a handle only when the
    // manifest lists its name — `import { eq } from 'drizzle-orm'` is provably
    // NOT a handle, `import { Pool } from 'pg'` is. An unrecognized package
    // reached by resolution reports cannot-fire (Spec 70 R4), never a guessed
    // clean.
    if (isNodeBuiltin(source)) return 'not-handle';
    const handles = handleTypesForPackage(source);
    if (handles) {
      if (importKind === 'default' || importKind === 'namespace') return 'handle';
      return handles.has(name) ? 'handle' : 'not-handle';
    }
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
  // Resolve a handle-candidate type name to its *origin* before consulting the
  // manifest (Spec 70 criterion 9 — the lookup keys on package AND type). A bare
  // name match against the flattened handle-name set would credit a project's own
  // unrelated `D1Database` declaration or an import from a non-DB package, so ask
  // where the name came from first:
  //   · an import resolves through its package's handle list in the manifest;
  //   · a local type declaration (class/interface/type-alias/enum) shadows the
  //     ambient manifest name — it is not the DB handle;
  //   · only an *ambient* (unbound) name falls through to the name match, which
  //     is what a Workers `D1Database` without an import relies on (the type is
  //     injected by `@cloudflare/workers-types` via tsconfig `types`).
  const binding = env.bindings.get(base);
  if (binding) {
    if (binding.kind === 'import') {
      const handles = handleTypesForPackage(binding.source ?? '');
      if (handles?.has(base)) return 'handle';
      // Imported from a non-manifest package, or a non-handle name from a DB
      // package (`KVNamespace` from `@cloudflare/workers-types`) — cannot-fire,
      // never a guessed clean.
      return 'unproven';
    }
    if (binding.kind === 'class' || binding.kind === 'type') {
      // A local class/interface/type-alias/enum of this name shadows the ambient
      // manifest type — it is not the DB handle.
      return 'unproven';
    }
    // variable / parameter / field / function bind only a *value*, not a type,
    // so a type annotation naming one still refers to the ambient type.
  }
  if (isDbHandleTypeName(base)) return 'handle';
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

// ── Form-3 this-field type heritage (Spec 70 Q3) ─────────────────────────────

/**
 * Cloudflare base-class field contracts: `this.<field>` → type, given the
 * class's type arguments. Each entry maps the base class's type parameters into
 * its instance fields (a structural registry of `env`/`ctx`/`state` as declared
 * by the workers-types / agents packages) — NOT a name list of receivers.
 * `WorkflowEntrypoint<Env>` is the Q3 addition: `this.env` is `Env`, the field
 * the member path then resolves through `interfaceFields` to a DB handle.
 */
const BASE_CLASS_FIELD_TYPES: Readonly<Record<string, (args: readonly string[]) => Record<string, string>>> = {
  // `Agent<Env>` (Cloudflare Agents SDK): env is the type parameter, ctx is the
  // Durable Object state.
  Agent: (args) => ({ env: args[0] ?? 'Env', ctx: 'DurableObjectState' }),
  // `DurableObject<Env>` (workers-types): env is the type parameter, ctx/state are
  // the Durable Object state.
  DurableObject: (args) => ({ env: args[0] ?? 'Env', ctx: 'DurableObjectState', state: 'DurableObjectState' }),
  // `WorkerEntrypoint<Env>` (workers-types): env is the type parameter, ctx is the
  // execution context.
  WorkerEntrypoint: (args) => ({ env: args[0] ?? 'Env', ctx: 'ExecutionContext' }),
  // `WorkflowEntrypoint<Env>` (workers-types): env is the type parameter, ctx is
  // the execution context. The Q3 addition — `this.env.DB` resolves through `env`
  // → `Env` → `interfaceFields['Env']['DB']`.
  WorkflowEntrypoint: (args) => ({ env: args[0] ?? 'Env', ctx: 'ExecutionContext' }),
};

/** Split `Agent<Env>` → `{ base: 'Agent', args: ['Env'] }`. */
function splitGenericType(text: string): { base: string; args: string[] } {
  const t = text.trim();
  const lt = t.indexOf('<');
  if (lt <= 0 || !t.endsWith('>')) return { base: t, args: [] };
  const base = t.slice(0, lt).trim();
  const inner = t.slice(lt + 1, -1);
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return { base, args };
}

/**
 * Resolve the type of `this.<field>` from the enclosing class's `extends`
 * heritage (Spec 70 Q3): `extends WorkflowEntrypoint<Env>` → `this.env` is
 * `Env`. Returns `null` when the heritage, the base class, or the field is
 * unknown — the classifier then abstains (`unproven`), never guessing a handle
 * from the class merely having a generic parameter.
 */
export function resolveThisFieldType(field: string, heritageText: string | null | undefined): string | null {
  if (!heritageText || !field) return null;
  const { base, args } = splitGenericType(heritageText);
  const fieldResolver = BASE_CLASS_FIELD_TYPES[base];
  if (!fieldResolver) return null;
  return fieldResolver(args)[field] ?? null;
}

/**
 * The enclosing class declaration's `extends` clause text
 * (`WorkflowEntrypoint<Env>`), or null when the node is not inside a class or
 * the class has no base class. The smallest enclosing class wins (nested classes
 * resolve to the innermost), matching the deleted form-3 producer.
 */
export function findEnclosingClassHeritage(
  ast: AST,
  adapter: LanguageAdapter,
  node: ASTNode,
  sourceCode: string,
): string | null {
  const line = node.location.start.line;
  const classes = adapter.findNodes(ast, {
    custom: (n: ASTNode) => n.type === 'class_declaration' || n.type === 'abstract_class_declaration',
  });
  let best: ASTNode | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const cls of classes) {
    const start = cls.location.start.line;
    const end = cls.location.end.line;
    if (start <= line && line <= end) {
      const span = end - start;
      if (span < bestSpan) {
        bestSpan = span;
        best = cls;
      }
    }
  }
  if (!best) return null;
  const heritage = adapter.getChildren(best).find((c) => c.type === 'class_heritage');
  if (!heritage) return null;
  const ext = adapter.getChildren(heritage).find((c) => c.type === 'extends_clause');
  if (!ext) return null;
  return adapter.getNodeText(ext, sourceCode).trim().replace(/^extends\s+/, '');
}
