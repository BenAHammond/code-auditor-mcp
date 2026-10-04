/**
 * Go receiver resolution — Spec 69 §10 S5e (#369).
 *
 * The Go half of the three-way receiver disposition. It answers the same
 * question the TypeScript processor (`analyzers/receiverRoot.ts`) answers —
 * "does this identifier resolve to a DB handle, a definitively non-DB value, or
 * something undetermined?" — using Go's own declaration grammar:
 *
 *   • `parameter_declaration`   — `db *sql.DB` (function params AND method
 *                                  receivers; both are parameter_declarations).
 *   • `var_spec`                 — package-level `var db *sql.DB`.
 *   • `short_var_declaration`    — `db, err := sql.Open(...)` / `c := New()`.
 *   • `field_declaration`        — struct field `db *sql.DB`.
 *   • `function_declaration` / `method_declaration` — the return-type half of
 *                                  form-5: `func New() *Engine` resolves a
 *                                  `router := New()` receiver to not-a-handle.
 *
 * The ecosystem list lives HERE with the Go adapter — not in a shared constant
 * and not in the TypeScript implementation's `DB_PACKAGES` (tsEcosystem.ts,
 * which is npm/TypeScript only). A
 * name is a *handle* because it resolved to the `database/sql` package (the
 * parsed SQL argument proves the handle, not the type name), never because it
 * *looks* like `db`; a name is
 * *not-a-handle* because it resolved to a local type/primitive or an ambient
 * global, never because it is on a list. A name that resolved to an
 * *unrecognized* package (a non-`database/sql` import such as `gin`, `net/http`,
 * `testing`) is `unproven` — Spec 70 R4 reports `cannot-fire` for a package the
 * manifest does not recognize, rather than guessing it is not a DB client.
 *
 * The functions here are pure and parser-agnostic at their boundary: they take
 * the already-parsed `AST` + adapter, so the analyzer layer (`receiverResolution.ts`)
 * dispatches to them the same way it dispatches to the TypeScript processor.
 */

import type { AST, LanguageAdapter, ASTNode } from '../types.js';
import { getRawNode } from '../tree-sitter/rawNode.js';
import type { ProvenanceEvidence } from '../../analyzers/provenance.js';
import databasePackages from './database-packages.json' with { type: 'json' };

/** The live tree-sitter node behind an `ASTNode` (adapter-internal only). */
type RawNode = ReturnType<typeof getRawNode>;

/**
 * Package paths whose types are DB handles. Go-only, stdlib-first.
 *
 * Spec 70 R4 / criterion 10: loaded from the per-ecosystem manifest
 * (`src/languages/go/database-packages.json`, beside the format adapter), a
 * declarative data file holding import paths only. An unlisted package reached
 * by resolution reports `cannot-fire` (see `classifyGoRootIdentifier` /
 * `classifyGoTypeText`), never a guessed `not-handle`.
 */
export const GO_DB_PACKAGES: ReadonlySet<string> = new Set(databasePackages);

/** Unqualified builtin types that are definitively not a DB handle. */
const GO_NON_HANDLE_TYPES: ReadonlySet<string> = new Set([
  'bool',
  'byte',
  'complex64',
  'complex128',
  'error',
  'float32',
  'float64',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'rune',
  'string',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'any',
  'nil',
]);

/** A receiver root's disposition (mirrors the TS processor's three-way split). */
export type GoRootDisposition = 'handle' | 'not-handle' | 'unproven';

/** How a name is bound in a Go file's scope. */
export type GoBindingKind =
  | 'import'
  | 'variable'
  | 'parameter'
  | 'field'
  | 'function'
  | 'method'
  | 'type';

/**
 * A serializable projection of a Go value/initializer expression — the structure
 * `classifyGoValue` reads to resolve a variable/field initializer's disposition.
 *
 * Spec 70 Item 4 ("no AST outlives its file"): a package-scope `GoBinding` is
 * threaded *across* files via `buildGoPackageBindings`, so its `value` may not
 * hold a live tree-sitter node (which dies with the file's AST). This descriptor
 * carries only the fields `classifyGoValue` consults — the node type, its text,
 * and the `function`/`operand`/`type` named children it reads — projected
 * recursively to a bounded depth (the classifier never reads past two named-field
 * hops). It is the Go counterpart of the TypeScript `ValueDescriptor`
 * (`receiverRoot.ts`).
 */
export interface GoValueDescriptor {
  readonly type: string;
  readonly text: string;
  readonly function?: GoValueDescriptor | null;
  readonly operand?: GoValueDescriptor | null;
  readonly typeNode?: GoValueDescriptor | null;
}

/** A single Go binding: how a name is declared. */
export interface GoBinding {
  kind: GoBindingKind;
  /** Import source path (kind === 'import'). */
  source?: string;
  /** Type-annotation text (variable / parameter / field). */
  typeText?: string;
  /** Return-type text (function / method) — `(*sql.DB, error)`. */
  returnTypeText?: string;
  /** Initializer / value expression (variable / field), serializable. */
  value?: GoValueDescriptor;
}

/**
 * Project a live tree-sitter value node onto a {@link GoValueDescriptor}. Bounded
 * to `depth` named-field hops — `classifyGoValue` reads at most `call_expression
 * → function → operand` (two hops), so depth 4 is more than sufficient while
 * guarding against pathological nesting.
 */
function describeGoValue(raw: RawNode, depth = 4): GoValueDescriptor {
  const child = (field: 'function' | 'operand' | 'type'): GoValueDescriptor | null => {
    if (depth <= 0) return null;
    const c = raw.childForFieldName(field);
    return c ? describeGoValue(c, depth - 1) : null;
  };
  return {
    type: raw.type,
    text: raw.text ?? '',
    function: child('function'),
    operand: child('operand'),
    typeNode: child('type'),
  };
}

/** Per-file resolution inputs the Go classifier reads. `adapter` and `sourceCode`
 *  are optional: only the extraction half (`buildGoImportMap` / `buildGoBindingEnv`)
 *  needs them — the classifier (`classifyGoRootIdentifier` / `classifyGoTypeText` /
 *  `classifyGoValue`) is a pure function of the serializable maps, so
 *  {@link classifyGoBindings} (the corpus-side, no-AST arm of
 *  `buildGoWithinFileProvenance`) builds an env without them. */
export interface GoResolutionEnv {
  provenance: ReadonlyMap<string, ProvenanceEvidence>;
  bindings: ReadonlyMap<string, GoBinding>;
  /** package-name → import path (e.g. `sql` → `database/sql`). */
  imports: ReadonlyMap<string, string>;
  adapter?: LanguageAdapter;
  sourceCode?: string;
  /** Package-scope declarations from *other* files in the same Go package. */
  packageBindings?: ReadonlyMap<string, GoBinding>;
}

// ── Import resolution ────────────────────────────────────────────────────────

/** The package name for an import path when no explicit alias is present. */
function defaultPackageName(source: string): string {
  const parts = source.split('/');
  return parts[parts.length - 1] || source;
}

/** Strip surrounding quotes from a Go string-literal node text. */
function unquote(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === '`')) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Build the package-name → import-path map for one Go file.
 *
 * Handles both `import "database/sql"` (single) and the parenthesized
 * `import ( "database/sql"; alias "fmt" )` form — the latter is the shape
 * `adapter.extractImports` misses (its `import_declaration` iteration only
 * sees the `import_spec_list` wrapper, not the `import_spec` children). Dot and
 * blank imports (`. "x"`, `_ "x"`) are skipped: they contribute no package name.
 *
 * @param ast the parsed Go file AST
 * @param adapter the language adapter used to find `import_spec` nodes
 * @returns the package-name → import-path map for this file
 */
export function buildGoImportMap(ast: AST, adapter: LanguageAdapter): Map<string, string> {
  const imports = new Map<string, string>();
  const specs = adapter.findNodes(ast, { custom: (n: ASTNode) => n.type === 'import_spec' });
  for (const spec of specs) {
    const raw = getRawNode(spec);
    const pathNode = raw.childForFieldName('path');
    if (!pathNode) continue;
    const source = unquote(pathNode.text);
    if (!source) continue;

    const nameNode = raw.childForFieldName('name');
    let pkgName: string | undefined;
    if (!nameNode) {
      pkgName = defaultPackageName(source);
    } else if (nameNode.type === 'package_identifier' || nameNode.type === 'identifier') {
      pkgName = nameNode.text;
    } else {
      continue; // dot or blank import — no package name to resolve
    }
    if (pkgName) imports.set(pkgName, source);
  }
  return imports;
}

// ── Binding extraction ───────────────────────────────────────────────────────

/**
 * Build the per-file binding environment: imports, parameters (incl. method
 * receivers), package/local vars, short-vars, struct fields, function/method
 * return types, and local type declarations.
 *
 * @param ast the parsed Go file AST
 * @param adapter the language adapter used to walk nodes
 * @param sourceCode the file source text for reading node text
 * @returns the name → binding map for every name bound in the file
 */
export function buildGoBindingEnv(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): Map<string, GoBinding> {
  const bindings = new Map<string, GoBinding>();
  const imports = buildGoImportMap(ast, adapter);
  for (const [pkgName, source] of imports) {
    if (!bindings.has(pkgName)) bindings.set(pkgName, { kind: 'import', source });
  }

  const rawWalk = (node: ASTNode, visit: (raw: RawNode) => void): void => {
    visit(getRawNode(node));
    for (const child of adapter.getChildren(node)) rawWalk(child, visit);
  };

  rawWalk(ast.root, (raw) => {
    switch (raw.type) {
      case 'parameter_declaration': {
        const nameNode = raw.childForFieldName('name');
        const typeNode = raw.childForFieldName('type');
        if (nameNode && !bindings.has(nameNode.text)) {
          bindings.set(nameNode.text, {
            kind: 'parameter',
            typeText: typeNode?.text,
          });
        }
        break;
      }
      case 'var_spec': {
        const nameNode = raw.childForFieldName('name');
        const typeNode = raw.childForFieldName('type');
        const valueNode = raw.childForFieldName('value');
        if (nameNode && !bindings.has(nameNode.text)) {
          bindings.set(nameNode.text, {
            kind: 'variable',
            typeText: typeNode?.text,
            value: valueNode ? describeGoValue(valueNode) : undefined,
          });
        }
        break;
      }
      case 'short_var_declaration': {
        const left = raw.childForFieldName('left');
        const right = raw.childForFieldName('right');
        const rightExprs = right?.namedChildren ?? [];
        const singleRight = rightExprs.length === 1 ? rightExprs[0] : null;
        for (const id of left?.namedChildren ?? []) {
          if (id.type !== 'identifier' || bindings.has(id.text)) continue;
          bindings.set(id.text, {
            kind: 'variable',
            value: singleRight ? describeGoValue(singleRight) : undefined,
          });
        }
        break;
      }
      case 'field_declaration': {
        const nameNode = raw.childForFieldName('name');
        const typeNode = raw.childForFieldName('type');
        const valueNode = raw.childForFieldName('value');
        if (nameNode && !bindings.has(nameNode.text)) {
          bindings.set(nameNode.text, {
            kind: 'field',
            typeText: typeNode?.text,
            value: valueNode ? describeGoValue(valueNode) : undefined,
          });
        }
        break;
      }
      case 'type_spec': {
        const nameNode = raw.childForFieldName('name');
        if (nameNode && !bindings.has(nameNode.text)) {
          bindings.set(nameNode.text, { kind: 'type' });
        }
        break;
      }
      case 'function_declaration':
      case 'method_declaration': {
        const nameNode = raw.childForFieldName('name');
        const resultNode = raw.childForFieldName('result');
        if (nameNode && !bindings.has(nameNode.text)) {
          bindings.set(nameNode.text, {
            kind: raw.type === 'method_declaration' ? 'method' : 'function',
            returnTypeText: resultNode?.text,
          });
        }
        break;
      }
    }
  });

  return bindings;
}

/**
 * Build a *package-scope* symbol table from a set of Go files in the same
 * package: top-level `function_declaration`/`method_declaration` (name + return
 * type), `type_declaration` → `type_spec` (name), and `var_declaration` →
 * `var_spec` (name + type + value). Local declarations (params, short-vars,
 * fields inside function bodies) are deliberately excluded — those are file/scope
 * local and must never bleed across files.
 *
 * This is the Go equivalent of the TS cross-file in-repo resolution: an
 * unqualified package-level call like `New()` / `CreateTestContext()` in one
 * file resolves through the symbol declared in a *sibling* file, so its return
 * type (`*Engine` / `*Context`) drives the receiver disposition instead of
 * `unproven`.
 *
 * @param files the Go files (AST + adapter) that share this package
 * @returns the package-scope name → binding symbol table
 */
export function buildGoPackageBindings(
  files: readonly { ast: AST; adapter: LanguageAdapter }[],
): Map<string, GoBinding> {
  const bindings = new Map<string, GoBinding>();
  for (const { ast } of files) {
    for (const [name, binding] of buildGoFileBindings(ast)) {
      if (!bindings.has(name)) bindings.set(name, binding);
    }
  }
  return bindings;
}

/**
 * Extract one Go file's *package-scope* declarations — the per-file half of
 * {@link buildGoPackageBindings}. Spec 70 Item 4 (2a): the phase model lifts
 * this per-file extraction into the `go-package-bindings` file fact so the
 * cross-file fixed point can group files by directory and merge first-wins,
 * exactly as {@link buildGoPackageBindings} does, with no AST outliving its
 * file. The bindings returned are `GoBinding` (already a serializable
 * projection: `value` is a {@link GoValueDescriptor}, not a live node).
 *
 * @param ast the parsed Go file AST
 * @returns this file's package-scope name → binding symbol table
 */
export function buildGoFileBindings(ast: AST): Map<string, GoBinding> {
  const bindings = new Map<string, GoBinding>();
  const root = getRawNode(ast.root);
  for (const decl of root.namedChildren) {
    switch (decl.type) {
      case 'function_declaration':
      case 'method_declaration': {
        const nameNode = decl.childForFieldName('name');
        const resultNode = decl.childForFieldName('result');
        if (nameNode && !bindings.has(nameNode.text)) {
          bindings.set(nameNode.text, {
            kind: decl.type === 'method_declaration' ? 'method' : 'function',
            returnTypeText: resultNode?.text,
          });
        }
        break;
      }
      case 'type_declaration': {
        for (const spec of decl.namedChildren) {
          if (spec.type !== 'type_spec') continue;
          const nameNode = spec.childForFieldName('name');
          if (nameNode && !bindings.has(nameNode.text)) {
            bindings.set(nameNode.text, { kind: 'type' });
          }
        }
        break;
      }
      case 'var_declaration': {
        for (const spec of decl.namedChildren) {
          if (spec.type !== 'var_spec') continue;
          const nameNode = spec.childForFieldName('name');
          const typeNode = spec.childForFieldName('type');
          const valueNode = spec.childForFieldName('value');
          if (nameNode && !bindings.has(nameNode.text)) {
            bindings.set(nameNode.text, {
              kind: 'variable',
              typeText: typeNode?.text,
              value: valueNode ? describeGoValue(valueNode) : undefined,
            });
          }
        }
        break;
      }
    }
  }
  return bindings;
}

// ── Classification ───────────────────────────────────────────────────────────

/** Resolve a package name to its import path (or null when not imported). */
function resolvePackage(pkgName: string, env: GoResolutionEnv): string | null {
  return env.imports.get(pkgName) ?? null;
}

/**
 * The first return *type* of a Go function signature text, e.g.
 * `(*sql.DB, error)` → `*sql.DB`, `*Engine` → `*Engine`,
 * `(c *Context, r *Engine)` → `*Context` (named results). Handles three shapes:
 *
 *   1. bare      — `*Engine`, `error`, `map[string]*sql.DB`
 *   2. parens    — `(*sql.DB, error)` → strip the outer parens, take first
 *   3. named     — `(c *Context, r *Engine)` → drop the leading result *name*,
 *                  keep its type
 *
 * Splits on top-level commas (tracking paren/bracket/brace depth) so
 * `map[string]*sql.DB` and `func() error` stay whole.
 */
function firstReturnType(resultText: string): string {
  let t = resultText.trim();
  // Strip a single outer paren group: `(c *Context, r *Engine)` →
  // `c *Context, r *Engine`, `(*sql.DB, error)` → `*sql.DB, error`.
  if (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1).trim();

  let depth = 0;
  let first = '';
  for (const ch of t) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) break;
    first += ch;
  }
  first = first.trim();

  // Named result: `c *Context` → the name is a plain identifier prefix, the type
  // is the rest. A bare type like `*Context` / `map[K]V` / `chan int` has no
  // such leading identifier, and `map`/`chan`/`func`/`struct`/`interface` are
  // type keywords, never result names.
  const named = first.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/s);
  if (named && !/^(map|chan|func|struct|interface)$/.test(named[1])) {
    return named[2].trim();
  }
  return first;
}

/**
 * Classify a bare Go root identifier's disposition under the file's env.
 *
 * @param name the bare root identifier to classify
 * @param env the file's Go resolution environment (provenance, bindings, imports)
 * @param depth recursion guard; classification gives up past depth 8
 * @returns `handle`, `not-handle`, or `unproven`
 */
export function classifyGoRootIdentifier(
  name: string,
  env: GoResolutionEnv,
  depth = 0,
): GoRootDisposition {
  if (!name) return 'unproven';
  if (env.provenance.has(name)) return 'handle';
  if (depth > 8) return 'unproven';

  const binding = env.bindings.get(name) ?? env.packageBindings?.get(name);
  if (!binding) return 'not-handle'; // ambient global → not-handle

  switch (binding.kind) {
    case 'import': {
      const source = binding.source ?? '';
      // A DB package proves handle; any other package is unrecognized, not a
      // DB client, or a DB client we do not list — all `unproven` (cannot-fire),
      // never a guessed `not-handle` (Spec 70 R4).
      return GO_DB_PACKAGES.has(source) ? 'handle' : 'unproven';
    }
    case 'variable':
    case 'field':
      if (binding.typeText) return classifyGoTypeText(binding.typeText, env, depth);
      if (binding.value) return classifyGoValue(binding.value, env, depth);
      return 'unproven';
    case 'parameter':
      if (binding.typeText) return classifyGoTypeText(binding.typeText, env, depth);
      return 'unproven';
    case 'function':
    case 'method':
      if (binding.returnTypeText) {
        return classifyGoTypeText(firstReturnType(binding.returnTypeText), env, depth + 1);
      }
      return 'unproven';
    case 'type':
      // A local type name is definitively not a DB handle (unless provenanced,
      // checked above).
      return 'not-handle';
  }
}

/**
 * Classify a Go type text (`*sql.DB`, `sql.DB`, `*gin.Context`, `string`).
 * Strips pointer/slice prefixes, then dispatches on qualified (`pkg.Type`) vs
 * unqualified (`Type` / builtin).
 *
 * @param typeText the Go type expression to classify
 * @param env the file's Go resolution environment
 * @param depth recursion guard
 * @returns `handle`, `not-handle`, or `unproven`
 */
export function classifyGoTypeText(
  typeText: string,
  env: GoResolutionEnv,
  depth: number,
): GoRootDisposition {
  let t = typeText.trim();
  // Strip leading pointer (`*sql.DB`) and slice/array (`[]byte`, `[4]string`)
  // prefixes. The slice regex is anchored to a leading `[`, so a `map[K]V` type
  // (no leading `[`) is left untouched.
  for (;;) {
    if (t.startsWith('*')) {
      t = t.slice(1).trim();
      continue;
    }
    const slice = t.match(/^\[(\d*)\](.*)$/s);
    if (slice) {
      t = slice[2].trim();
      continue;
    }
    break;
  }

  const dot = t.indexOf('.');
  if (dot > 0 && !/[\s()\[\]{},*]/.test(t)) {
    // Qualified type: `pkg.Type`. Handle-ness follows the *package* (the
    // `database/sql` import path), never the type name — the parsed SQL argument
    // is the handle proof; the package is the resolution fallback.
    const pkgName = t.slice(0, dot);
    const source = resolvePackage(pkgName, env);
    if (source === null) return 'unproven'; // package not imported → unknown
    if (GO_DB_PACKAGES.has(source)) return 'handle';
    return 'unproven'; // unrecognized package → cannot-fire (Spec 70 R4)
  }

  // Unqualified: a builtin or a local named type.
  if (GO_NON_HANDLE_TYPES.has(t)) return 'not-handle';
  return classifyGoRootIdentifier(t, env, depth + 1);
}

/**
 * Classify a Go value expression's disposition (an initializer). A call to a
 * function whose return type is known resolves through it — `c := New()` where
 * `New() *Engine` is not-a-handle, `db := sql.Open(...)` is a handle.
 */
function classifyGoValue(
  raw: GoValueDescriptor,
  env: GoResolutionEnv,
  depth: number,
): GoRootDisposition {
  if (raw.type === 'identifier') {
    return classifyGoRootIdentifier(raw.text, env, depth + 1);
  }

  if (raw.type === 'call_expression') {
    const fnNode = raw.function;
    if (fnNode?.type === 'identifier') {
      const name = fnNode.text;
      if (env.provenance.has(name)) return 'handle';
      const b = env.bindings.get(name) ?? env.packageBindings?.get(name);
      if (b && (b.kind === 'function' || b.kind === 'method') && b.returnTypeText) {
        return classifyGoTypeText(firstReturnType(b.returnTypeText), env, depth + 1);
      }
      return 'unproven';
    }
    if (fnNode?.type === 'selector_expression') {
      const operand = fnNode.operand;
      const root = operand?.text ?? '';
      if (root && env.provenance.has(root)) return 'handle';
      const b = env.bindings.get(root);
      if (b && b.kind === 'import') {
        return GO_DB_PACKAGES.has(b.source ?? '') ? 'handle' : 'unproven';
      }
      return 'unproven';
    }
    return 'unproven';
  }

  if (raw.type === 'selector_expression') {
    const operand = raw.operand;
    if (operand?.type === 'identifier') return classifyGoRootIdentifier(operand.text, env, depth + 1);
    return 'unproven';
  }

  if (raw.type === 'unary_expression') {
    // `&Context{}` / `&sql.DB{}` — classify the operand (the address-of target).
    const operand = raw.operand;
    if (operand) {
      const opText = operand.text;
      if (opText) return classifyGoTypeText(opText, env, depth + 1);
    }
    return 'unproven';
  }

  if (raw.type === 'composite_literal') {
    const typeNode = raw.typeNode;
    if (typeNode?.text) return classifyGoTypeText(typeNode.text, env, depth + 1);
    return 'unproven';
  }

  if (
    raw.type === 'interpreted_string_literal' ||
    raw.type === 'raw_string_literal' ||
    raw.type === 'int_literal' ||
    raw.type === 'float_literal' ||
    raw.type === 'true' ||
    raw.type === 'false' ||
    raw.type === 'nil'
  ) {
    return 'not-handle';
  }

  return 'unproven';
}

// ── Within-file provenance ───────────────────────────────────────────────────

/**
 * The Go within-file provenance: seed DB package names (`sql` for
 * `database/sql`) plus every binding whose type/value resolves to a DB handle.
 * `packageBindings` (optional) carries package-scope declarations from *other*
 * files in the same package, so `router := New()` resolves `New`'s return type
 * (`*Engine` → not-a-handle) instead of falling back to `unproven`.
 *
 * @param ast the parsed Go file AST
 * @param adapter the language adapter used to walk nodes
 * @param sourceCode the file source text for reading node text
 * @param packageBindings package-scope declarations from sibling files (optional)
 * @returns the name → provenance-evidence map of DB handles resolved in this file
 */
export function buildGoWithinFileProvenance(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  packageBindings?: ReadonlyMap<string, GoBinding>,
): Map<string, ProvenanceEvidence> {
  const imports = buildGoImportMap(ast, adapter);
  const bindings = buildGoBindingEnv(ast, adapter, sourceCode);
  return classifyGoBindings(imports, bindings, packageBindings);
}

/**
 * The corpus-side, no-AST arm of {@link buildGoWithinFileProvenance}: seed DB
 * package names then classify every binding against the (already-extracted)
 * imports + bindings + package-scope declarations. This is the functional
 * half — it reads only the serializable maps, so the receiver-provenance corpus
 * producer (Spec 70 Item 4) can finalize a Go file's within-file provenance once
 * its sibling package-scope symbols are known, without re-holding the AST.
 *
 * @param imports package-name → import path for the file
 * @param bindings the file's name → binding environment (from `buildGoBindingEnv`)
 * @param packageBindings package-scope declarations from sibling `.go` files
 * @returns the name → provenance-evidence map of DB handles resolved in this file
 */
export function classifyGoBindings(
  imports: ReadonlyMap<string, string>,
  bindings: ReadonlyMap<string, GoBinding>,
  packageBindings?: ReadonlyMap<string, GoBinding>,
): Map<string, ProvenanceEvidence> {
  const env: GoResolutionEnv = {
    provenance: new Map(),
    bindings,
    imports,
    packageBindings,
  };

  const prov = new Map<string, ProvenanceEvidence>();

  for (const [pkgName, source] of imports) {
    if (GO_DB_PACKAGES.has(source)) {
      prov.set(pkgName, {
        identifier: pkgName,
        reason: 'package',
        source: `import ${source}`,
        chain: [],
      });
    }
  }

  for (const [name, binding] of bindings) {
    let disposition: GoRootDisposition = 'unproven';
    if (binding.typeText) disposition = classifyGoTypeText(binding.typeText, env, 0);
    else if (binding.value) disposition = classifyGoValue(binding.value, env, 0);

    if (disposition === 'handle') {
      prov.set(name, {
        identifier: name,
        reason: 'binding',
        source: binding.typeText
          ? `declared ${binding.typeText}`
          : 'declared as a DB handle',
        chain: [],
      });
    }
  }

  return prov;
}
