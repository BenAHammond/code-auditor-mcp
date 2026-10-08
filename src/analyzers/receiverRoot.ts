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
import { isNodeBuiltin, isDbHandleTypeName, dbHandlePackagesForName, handleTypesForPackage, JS_GLOBALS } from './tsEcosystem.js';

/** A receiver root's disposition (Spec 69 §10 S5e). */
export type RootDisposition = 'handle' | 'not-handle' | 'unproven';

/**
 * Where an import specifier resolves — the one specifier-resolution seam (Spec 70
 * B1): relative, tsconfig-`paths` alias, bare (tsconfig-`paths` → in-repo, else
 * node_modules vendor `.d.ts`), and the `@/`/`~/` fallback all answer through one
 * `resolveSpecifier`. `classifyImportSource` reads `in-repo` to abstain on an
 * unwalked export chain; Item 1 reads `vendor` to resolve a base class to its
 * declaration. `unresolved` means no in-repo file and no node_modules type
 * declaration existed.
 */
export type SpecifierResolution =
  | { readonly kind: 'in-repo'; readonly path: string }
  | { readonly kind: 'vendor'; readonly path: string }
  | { readonly kind: 'unresolved' };

/**
 * The fold-time heritage seam (Spec 70 Q3, Item 1): resolve `this.<field>` on a
 * worker base class to its declared field type by reading the base class's
 * declaration in the project's declared dependencies' `.d.ts` and substituting
 * the heritage's type arguments. Returns `null` (abstain) when the base class,
 * the field, or a referenced type argument cannot be resolved — never a guessed
 * clean. Absent from the env (the Go path, the build-side R3 fold, and callers
 * with no declared dependencies), the classifier abstains on every heritage arm.
 */
export type HeritageFieldResolver = (
  base: string,
  field: string,
  args: readonly string[],
) => string | null;

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
  /**
   * The binding's enclosing scope — the start byte offset of the enclosing
   * function (`range[0]`), `0` for top-level. Two same-named bindings in
   * different functions are distinct bindings, not a collision; a flat
   * name-keyed map collapses them, so the classifier keys on scope when a
   * reference's scope is known. Absent on older/foreign bindings (read as
   * scope-agnostic by the classifier — falls back to the flat lookup).
   */
  scope?: number;
}

/** Per-file resolution inputs the classifier reads. */
export interface RootResolutionEnv {
  /** Already-provenanced DB handles (package imports + propagation + wrappers). */
  provenance: ReadonlyMap<string, ProvenanceEvidence>;
  /** name → binding (import / declaration / parameter / field). */
  bindings: ReadonlyMap<string, Binding>;
  /**
   * name → (enclosing scope → binding), the scope-keyed index that disambiguates
   * two same-named bindings in different functions. When a reference carries a
   * `scope` (the classifier's `opts.scope`), the lookup prefers the binding with
   * that exact scope and falls back to the flat `bindings` map (a same-name
   * binding in an enclosing scope). Absent on the Go env and in callers that
   * classify with no reference scope — the flat lookup then applies unchanged.
   */
  bindingsByScope?: ReadonlyMap<string, ReadonlyMap<number, Binding>>;
  /**
   * Resolve an import specifier through the one specifier-resolution seam (Spec
   * 70 B1): relative, tsconfig-`paths` alias, bare (tsconfig-`paths` → in-repo,
   * else node_modules vendor `.d.ts`), and the `@/`/`~/` fallback. Returns a
   * tagged `SpecifierResolution`, or null when no resolver was threaded (the Go
   * path and bare-root callers abstain). `classifyImportSource` reads `in-repo`
   * to abstain on an unwalked export chain; the base-class heritage reader reads
   * `vendor` to resolve a declaration (Spec 70 Q/B2).
   */
  resolveImport?: (source: string) => SpecifierResolution | null;
  /**
   * Interface / type-alias field types, keyed `interfaceName → fieldName → typeText`
   * (`interface Env { DB: D1Database }` → `Env → { DB: 'D1Database' }`). The
   * member-chain resolution arm (Spec 70 decision B3) reads this to resolve a
   * member receiver (`env.DB`) through its interface's field type — `env` typed
   * `Env` is not a handle, but `Env.DB` is `D1Database`, which is. Absent in the
   * Go env and in callers that classify a bare root with no member chain.
   */
  interfaceFields?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /**
   * Project-level declared type packages — package.json `dependencies` ∪
   * `devDependencies` ∪ tsconfig `compilerOptions.types`. The ambient arm of
   * `classifyTypeText` (an unbound DB-handle type name) credits `handle` only
   * when a manifest package that declares the name is present here; absent, the
   * arm abstains (`unproven`) — no declared dependency, no ambient credit (Spec
   * 70 criterion 9, Item 3).
   */
  declaredTypePackages?: ReadonlySet<string>;
  /**
   * The fold-time heritage seam (Spec 70 Q3, Item 1): resolve `this.<field>` on
   * a worker base class to its declared field type by reading the base class's
   * declaration in the project's declared dependencies' `.d.ts` and substituting
   * the heritage's type arguments. Absent (Go env, build-side R3 fold, callers
   * with no declared dependencies), the heritage arm in {@link classifyRootIdentifier}
   * abstains (`unproven`). Built once per project by `makeHeritageResolver` in
   * `receiverResolution.ts`.
   */
  resolveHeritageField?: HeritageFieldResolver;
  /**
   * Out-param populated by `classifyTypeText` when it rejects the ambient arm:
   * an unbound DB-handle type name whose declaring package is not a declared
   * dependency. `resolveRoot` clears it before classifying and reads it to give
   * the cannot-fire reason "the type name resolved to nothing" instead of the
   * generic binding cause.
   */
  ambientRejectionReason?: string;
  /**
   * Out-param populated by `classifyImportSource` when an import resolved to an
   * in-repo file whose export chain is not walked here (Spec 70 B1): the
   * disposition is `unproven`, and `resolveRoot` reads this to give the
   * cannot-fire reason "resolves to in-repo file … whose export chain is not
   * walked here" instead of the generic binding cause.
   */
  importResolutionReason?: string;
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
/** Node types that open a function scope (the nearest enclosing function a
 *  binding belongs to). Reused by `enclosingFunctionScope` below. */
const FUNCTION_SCOPE_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
]);

/** The binding's enclosing scope: the start byte offset (`range[0]`) of the
 *  enclosing function, or `0` for top-level. Two same-named bindings in
 *  different functions are distinct bindings, not a collision — the classifier
 *  keys on this when a reference's scope is known. A function/class/type
 *  declaration introduces its name into the *enclosing* scope, so the walk
 *  starts from its parent; a variable/parameter/field sits inside its scope
 *  directly. */
function enclosingFunctionScope(node: ASTNode, adapter: LanguageAdapter): number {
  let current: ASTNode | null =
    FUNCTION_NAME_TYPES.has(node.type) || CLASS_NAME_TYPES.has(node.type) || TYPE_DECLARATION_TYPES.has(node.type)
      ? adapter.getParent(node)
      : node;
  while (current) {
    if (FUNCTION_SCOPE_TYPES.has(current.type)) return current.range[0];
    current = adapter.getParent(current);
  }
  return 0;
}

/** A binding plus its bound name, before any name-collapse. Every declaration
 *  and import is emitted — a name bound in two scopes yields two entries. */
interface CollectedBinding {
  name: string;
  binding: Binding;
}

/** Walk imports + value/type declarations and emit *every* binding with its
 *  enclosing scope — no name dedup. `buildBindingEnv` and
 *  `buildBindingScopeIndex` both reduce this list; it is the single source of
 *  truth so the flat map and the scope index cannot drift apart. */
function collectBindings(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): CollectedBinding[] {
  const out: CollectedBinding[] = [];

  for (const imp of adapter.extractImports(ast)) {
    for (const spec of imp.specifiers) {
      const name = spec.alias ?? spec.name;
      if (!name || name === '*') continue;
      const importKind: ImportKind = spec.isDefault ? 'default' : spec.isNamespace ? 'namespace' : 'named';
      out.push({ name, binding: { kind: 'import', source: imp.source, importKind, scope: 0 } });
    }
  }

  const nodes = adapter.findNodes(ast, {
    custom: (n: ASTNode) => VALUE_DECLARATION_TYPES.has(n.type),
  });

  for (const node of nodes) {
    const scope = enclosingFunctionScope(node, adapter);

    if (node.type === 'variable_declarator') {
      for (const name of variableDeclaratorNames(node, adapter, sourceCode)) {
        if (name) out.push({ name, binding: { ...bindingFromDeclarator(node, adapter, sourceCode), scope } });
      }
      continue;
    }

    if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
      const name = parameterName(node, adapter, sourceCode);
      if (name) {
        out.push({
          name,
          binding: { kind: 'parameter', typeText: childTypeAnnotationText(node, adapter, sourceCode), scope },
        });
      }
      continue;
    }

    if (node.type === 'public_field_definition') {
      const name = fieldName(node, adapter, sourceCode);
      if (name) out.push({ name, binding: { ...bindingFromField(node, adapter, sourceCode), scope } });
      continue;
    }

    if (FUNCTION_NAME_TYPES.has(node.type)) {
      const name = adapter.getNodeName(node);
      if (name) out.push({ name, binding: { kind: 'function', scope } });
      continue;
    }

    if (CLASS_NAME_TYPES.has(node.type)) {
      const name = adapter.getNodeName(node);
      if (name) out.push({ name, binding: { kind: 'class', scope } });
      continue;
    }

    if (TYPE_DECLARATION_TYPES.has(node.type)) {
      const name = adapter.getNodeName(node);
      if (name) out.push({ name, binding: { kind: 'type', scope } });
    }
  }

  return out;
}

/** Collapse the full binding list into the flat name-keyed map — first wins
 *  (declaration order). This is the legacy `buildBindingEnv` the classifier
 *  reads when a reference's scope is unknown; the scope-aware `resolveBinding`
 *  prefers `buildBindingScopeIndex` and falls back here for an enclosing scope.
 *
 * @param ast the parsed file AST
 * @param adapter the language adapter (imports + declaration walk)
 * @param sourceCode the file source text
 * @returns the flat name → first-wins binding map */
export function buildBindingEnv(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const { name, binding } of collectBindings(ast, adapter, sourceCode)) {
    if (!bindings.has(name)) bindings.set(name, binding);
  }
  return bindings;
}

/** The scope-keyed binding index: name → (enclosing scope → binding), with *no*
 *  name collapse. The classifier's scope-aware lookup reads this to resolve a
 *  reference to the same-scoped binding when two same-named bindings live in
 *  different functions; a scope with no entry for the name falls back to the
 *  flat `buildBindingEnv` map (a same-name binding in an enclosing scope).
 *
 * @param ast the parsed file AST
 * @param adapter the language adapter (imports + declaration walk)
 * @param sourceCode the file source text
 * @returns name → (enclosing scope → binding), no name collapse */
export function buildBindingScopeIndex(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): Map<string, Map<number, Binding>> {
  const index = new Map<string, Map<number, Binding>>();
  for (const { name, binding } of collectBindings(ast, adapter, sourceCode)) {
    const scope = binding.scope ?? 0;
    let byScope = index.get(name);
    if (!byScope) {
      byScope = new Map();
      index.set(name, byScope);
    }
    if (!byScope.has(scope)) byScope.set(scope, binding);
  }
  return index;
}

/** Resolve a reference to the binding in its scope: prefer the scope-keyed
 *  index's exact-scope entry, else fall back to the flat (name-keyed, first-wins)
 *  map. A reference with no `scope` (the legacy/bare callers) uses the flat map
 *  only — behavior unchanged. */
function resolveBinding(name: string, env: RootResolutionEnv, scope?: number): Binding | undefined {
  if (scope !== undefined && env.bindingsByScope) {
    const scoped = env.bindingsByScope.get(name)?.get(scope);
    if (scoped) return scoped;
  }
  return env.bindings.get(name);
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
 *
 * @param ast the parsed file AST to walk for interface/type-alias declarations
 * @param adapter the language adapter used to find and read declaration nodes
 * @param sourceCode the file source text for reading node text
 * @returns a name → field-name → type-text map for every interface/type alias
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
  opts?: { thisField?: boolean; memberPath?: readonly string[]; thisHeritage?: string | null; scope?: number },
): RootDisposition {
  if (!name) return 'unproven';
  // A provenanced name is a DB handle — except a `this.<name>` reference to a
  // *wrapper* (a function/method whose body does DB work). Wrapper evidence
  // describes the method's own body, not the receiver `this.<method>`: a method
  // name is not evidence (the method-name proof this path removed lists for).
  // A package-import / sql-argument / binding seed still proves a `this.<field>`
  // handle (`this.env`, `this.db`), and those reasons are not `wrapper`, so they
  // keep short-circuiting here. This must stay *before* the binding lookup.
  const evidence = env.provenance.get(name);
  if (evidence && !(opts?.thisField && evidence.reason === 'wrapper')) return 'handle';
  if (depth > 8) return 'unproven';

  // Form-3 heritage (Spec 70 Q3, Item 1): a `this.<field>` reference resolves to
  // the enclosing class's base-class field type (`extends WorkflowEntrypoint<Env>`
  // → `this.env` is `Env`), then through the member path by the same
  // interface-field seam as B3. The base class is resolved *to its declaration*
  // in the project's declared dependencies' `.d.ts` via `env.resolveHeritageField`
  // — never a bundled name map. This runs *before* the binding lookup — the
  // heritage contract is authoritative, and a same-named local binding is a
  // shadow, not the field's type. No heritage (`thisHeritage` null), no resolver,
  // or an unresolvable declaration all fall through to `unproven` (abstain,
  // never a guess from the class merely having a generic parameter).
  if (opts?.thisField && opts.thisHeritage && env.resolveHeritageField) {
    const { base, args } = splitHeritage(opts.thisHeritage);
    const fieldType = env.resolveHeritageField(base, name, args);
    if (fieldType !== null) {
      return classifyTypeOrMember(fieldType, opts.memberPath, env, depth + 1);
    }
  }

  const binding = resolveBinding(name, env, opts?.scope);
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
 *
 * @param root the receiver's leftmost identifier
 * @param receiver the member-chain text left of the method
 * @param thisField true when the receiver is a `this`/`super` field
 * @returns the non-root member-path segments, or an empty array when not resolvable
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
 *
 * @param root the receiver's leftmost identifier (after the `this.`/`super.` strip)
 * @param receiver the member-chain text left of the method
 * @returns the member-path segments after the root, or an empty array when not resolvable
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
  // One seam (Spec 70 B1): every specifier kind — relative, tsconfig-`paths`
  // alias, bare (tsconfig-`paths` → in-repo, else node_modules vendor `.d.ts`),
  // and the `@/`/`~/` fallback — answers through `resolveImport`. An in-repo
  // resolution means the name's origin is a project file whose export chain is
  // not walked here, so the name's DB-handle status is unknown → `unproven`
  // (never the old `not-handle`, which claimed to have proven a re-exported
  // handle is clean). Absent a resolver, relative/alias still abstain below.
  const resolved = env.resolveImport?.(source);
  if (resolved?.kind === 'in-repo') {
    env.importResolutionReason = `resolves to in-repo file \`${resolved.path}\` whose export chain is not walked here`;
    return 'unproven';
  }
  // A bare specifier that did not land in-repo → node_modules or a Node builtin.
  // A Node builtin (`fs`, `node:path`, …) is provably not a DB client →
  // `not-handle`. A manifest DB package resolves by import kind: a
  // default/namespace import is the package's handle (its local name is
  // arbitrary — `import mysql from 'mysql2/promise'`), while a *named* import is
  // a handle only when the manifest lists its name — `import { eq } from
  // 'drizzle-orm'` is provably NOT a handle, `import { Pool } from 'pg'` is. An
  // unrecognized package reached by resolution reports cannot-fire (Spec 70 R4),
  // never a guessed clean.
  if (isNodeBuiltin(source)) return 'not-handle';
  const handles = handleTypesForPackage(source);
  if (handles) {
    if (importKind === 'default' || importKind === 'namespace') return 'handle';
    return handles.has(name) ? 'handle' : 'not-handle';
  }
  return 'unproven';
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
  if (isDbHandleTypeName(base)) {
    // The ambient arm (Spec 70 criterion 9, Item 3): an unbound handle-type name
    // is credited only when a manifest package that declares it is a declared
    // dependency of the project (package.json deps/devDeps or tsconfig `types`).
    // Otherwise the name resolved to nothing — cannot-fire, never a guessed
    // clean — and the cause is recorded for `resolveRoot`'s reason.
    const declaring = dbHandlePackagesForName(base);
    const declared = env.declaredTypePackages;
    if (declaring && declared && [...declaring].some((pkg) => declared.has(pkg))) {
      return 'handle';
    }
    env.ambientRejectionReason = `type \`${base}\` resolves to nothing (its declaring package is not a declared dependency)`;
    return 'unproven';
  }
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
        // A provenanced factory name yields a handle when called: the provenance
        // already established the name as a handle-shaped value, and calling it
        // produces a handle (`resolveHero`, a wrapper that queries in a loop).
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
        // handle, so the call's return is not a handle either. A method call on a
        // *handle* root is NOT itself a handle — `db.prepare()` returns a Statement,
        // `db.transaction()` a Transaction, `stmt.all()` a result row — so it
        // abstains to `unproven` rather than over-claiming `handle`.
        if (root) {
          const rootDisp = classifyRootIdentifier(root, env, depth + 1);
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

/** Split `Agent<Env>` / `WorkflowEntrypoint` into its base-class name and type
 *  arguments. A heritage with no `<…>` has an empty argument list; nested
 *  generics (`Foo<Bar<Baz>, Qux>`) split at top-level commas only. The base-class
 *  name and arguments are then handed to `env.resolveHeritageField` for the
 *  declaration lookup, or left unresolvable (abstain) when no resolver is
 *  threaded. */
function splitHeritage(text: string): { base: string; args: string[] } {
  const t = text.trim();
  const base = baseTypeName(t);
  const lt = t.indexOf('<');
  if (lt <= 0 || !t.endsWith('>')) return { base, args: [] };
  return { base, args: splitTopLevel(t.slice(lt + 1, -1), ',') };
}

/**
 * The enclosing class declaration's `extends` clause text
 * (`WorkflowEntrypoint<Env>`), or null when the node is not inside a class or
 * the class has no base class. The smallest enclosing class wins (nested classes
 * resolve to the innermost), matching the deleted form-3 producer.
 *
 * @param ast the parsed file AST searched for enclosing classes
 * @param adapter the language adapter used to find and read class nodes
 * @param node the node whose enclosing class heritage is sought
 * @param sourceCode the file source text for reading the heritage text
 * @returns the enclosing class's `extends` clause text, or null when none applies
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
