/**
 * Shared receiver-resolution helpers for the phase model — Spec 69 §10 (S1).
 *
 * The full cross-file resolver that once lived here (a layered fixed point
 * ending in `resolveCorpusReceivers`) has been deleted: the phase model
 * (`runPhaseModel` → `computeReceiverProvenance` / `classifyBuildProvenance`)
 * is the only live resolution surface. What remains is the shared, format-free
 * machinery that resolution surface is built from:
 *
 *   • module shape — `collectExports` / `resolveSpecifier` (in-repo specifier
 *     resolution without a name-list fallback), and the `FileProvenance` /
 *     `FileExports` / `UnresolvedImport` types the phase files carry.
 *   • within-file provenance — `computeTsWithinFileProvenance`, the fixed-point
 *     seed for the phase model's `within-file-provenance` file producer (Spec 70
 *     Item 4) and the byte-identical parity reference pinned by
 *     `spec70-ts-within-file-parity.spec.ts`.
 *   • the three-way disposition — `isProvablyNonDbDeclaration` (the
 *     proven-not-a-handle gate) and `describeUnprovenReceiver` /
 *     `describeReceiverClause` (the cannot-fire surface), shared by both the
 *     TS and Go classifiers in one function instead of the four historical
 *     copies.
 *
 * A receiver whose DB-ness cannot be resolved is never silently provenanced; it
 * is surfaced as an `UnprovenQueryReceiver` and reported `cannot-fire`, never
 * `clean` (§10 coverage parity).
 */

import type { AST, LanguageAdapter, ASTNode } from '../languages/types.js';
import {
  extractDBProvenancedImports,
  propagateProvenance,
  detectDbWrappers,
  detectDbReturningFunctions,
  type ProvenanceEvidence,
} from './provenance.js';
import {
  buildBindingEnv,
  classifyRootIdentifier,
  type RootResolutionEnv,
  type SpecifierResolution,
  type HeritageFieldResolver,
} from './receiverRoot.js';
import { parseFile, getNodeText } from '../languages/adapterBridge.js';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** Per-file DB-provenanced identifiers, keyed by absolute file path. */
export type FileProvenance = Map<string, Map<string, ProvenanceEvidence>>;

/** Per-file set of exported names that are DB-provenanced. */
export type FileExports = Map<string, Set<string>>;

/** An import whose specifier could not be resolved to an in-repo file. */
export interface UnresolvedImport {
  importer: string;
  source: string;
  /** The local binding(s) the importer wanted from that module. */
  names: string[];
}

/**
 * A query-shaped call site (a member-expression call whose method is a DB or ORM
 * verb) whose receiver could be neither proven a DB handle nor proven a non-DB
 * value by the declaration resolution. This is the Spec 69 §10 S5a surface: the
 * receiver's DB-ness is *unknown*, so the call must report `cannot-fire` — never
 * `clean` — with the reason it could not be resolved.
 */
export interface UnprovenQueryReceiver {
  /** Absolute file path the call site is in. */
  file: string;
  /** 1-based line of the call expression. */
  line: number;
  /** The receiver chain text (everything left of the final method), e.g.
   *  `"db.prepare(\"SELECT 1\").bind"` for `db.prepare(…).bind(…).first()`. */
  receiver: string;
  /** The receiver's *root* identifier (the leftmost chain segment reached by
   *  descending through member *and* call expressions), e.g. `"db"`, `"env"`. */
  root: string;
  /** The DB/ORM method invoked, e.g. `"query"`, `"findMany"`. */
  method: string;
  /** Why the receiver could not be proven a handle or a non-handle. */
  reason: string;
}

/** The set of extensions tried when resolving an extension-less specifier. */
const RESOLVE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.d.ts',
];

const INDEX_BASENAMES = RESOLVE_EXTENSIONS.map((ext) => `index${ext}`);

/** Declaration node types an `export` statement may wrap. */
const EXPORT_DECLARATION_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'function_declaration',
  'generator_function_declaration',
  'lexical_declaration',
  'variable_declaration',
  'interface_declaration',
  'enum_declaration',
  'type_alias_declaration',
]);

/** Iterate an AST subtree (inclusive) for nodes matching a predicate. */
function collectNodes(root: ASTNode, adapter: LanguageAdapter, pred: (n: ASTNode) => boolean): ASTNode[] {
  const out: ASTNode[] = [];
  const walk = (n: ASTNode): void => {
    if (pred(n)) out.push(n);
    for (const c of adapter.getChildren(n)) walk(c);
  };
  walk(root);
  return out;
}

/** The text of the first identifier/property_identifier descendant. */
function firstIdentifierText(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const id = collectNodes(node, adapter, (n) => n.type === 'identifier' || n.type === 'property_identifier')[0];
  return id ? adapter.getNodeText(id, sourceCode) : null;
}

/** Strip surrounding quotes from a string-literal node text. */
function unquote(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'" || text[0] === '`')) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Collect a file's full export set — names, default flag, and re-export source.
 *
 * More complete than `adapter.extractExports` (which returns only the first
 * named export per `export { a, b }` statement and misses `export * from`):
 *   1. `export const/class/function X` and `export default X` → name.
 *   2. `export { a, b }` / `export { a, b } from './x'` → each specifier name.
 *   3. `export * from './x'` → the special `*` name with its source.
 *
 * @param ast the parsed file AST
 * @param adapter the language adapter used to find `export_statement` nodes
 * @param sourceCode the file source text for reading node text
 * @returns every exported name with its re-export source and default flag
 */
export function collectExports(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): Array<{ name: string; source?: string; isDefault: boolean }> {
  const out: Array<{ name: string; source?: string; isDefault: boolean }> = [];
  const stmts = adapter.findNodes(ast, { custom: (n: ASTNode) => n.type === 'export_statement' });

  for (const stmt of stmts) {
    const children = adapter.getChildren(stmt);
    const isDefault = children.some((c) => c.type === 'default' || adapter.getNodeText(c, sourceCode) === 'default');

    // Re-export source (string literal) — export { … } from '…' / export * from '…'.
    const sourceChild = children.find(
      (c) => c.type === 'string' || c.type === 'string_fragment' || c.type === 'template_string',
    );
    const source = sourceChild ? unquote(adapter.getNodeText(sourceChild, sourceCode)) : undefined;

    // Named export specifiers.
    const specifiers = collectNodes(stmt, adapter, (n) => n.type === 'export_specifier');
    for (const spec of specifiers) {
      const name = firstIdentifierText(spec, adapter, sourceCode);
      if (name) out.push({ name, source, isDefault: false });
    }

    // A declaration wrapped by export.
    const decl = children.find((c) => EXPORT_DECLARATION_TYPES.has(c.type));
    if (decl) {
      const name = adapter.getNodeName(decl);
      if (name) out.push({ name, source, isDefault });
      continue;
    }

    // `export default <identifier>` (no declaration).
    if (isDefault) {
      const value = children.find((c) => c.type === 'identifier');
      if (value) out.push({ name: adapter.getNodeText(value, sourceCode), source, isDefault: true });
    }

    // `export * from '…'`.
    const star = children.some((c) => adapter.getNodeText(c, sourceCode) === '*');
    if (star && source) out.push({ name: '*', source, isDefault: false });
  }

  return out;
}

/** tsconfig `paths` mapping (pattern → target patterns) plus `baseUrl`. */
export interface TsconfigPathMap {
  baseUrl?: string;
  paths?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Resolve an import specifier through the one specifier-resolution seam (Spec 70
 * B1). Four specifier kinds answer here:
 *   • relative (`./x`, `../x`) — resolved against the importer's directory.
 *   • `@/`/`~/` alias — mapped against `projectRoot`, then its `src`/`app`.
 *   • bare — a bare specifier matching a tsconfig-`paths` pattern maps to an
 *     in-repo file; otherwise it resolves to a node_modules vendor declaration
 *     (`.d.ts` / `package.json` `types`) when one exists.
 *   • nothing else resolves → `unresolved`.
 *
 * @returns a tagged `SpecifierResolution` — `in-repo` (an in-repo file whose
 *   export chain is not walked here), `vendor` (a node_modules declaration), or
 *   `unresolved` (neither).
 */
export function resolveSpecifier(
  specifier: string,
  importerPath: string,
  filesByPath: ReadonlySet<string>,
  projectRoot?: string,
  tsconfig?: TsconfigPathMap,
): SpecifierResolution {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const base = path.resolve(path.dirname(importerPath), specifier);
    const rel = resolveFile(base, filesByPath);
    return rel ? { kind: 'in-repo', path: rel } : { kind: 'unresolved' };
  }

  // Alias specifiers (`@/x`, `~/x`) map to the project root, then its src/app.
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    const rel = specifier.slice(2);
    const roots = [projectRoot, projectRoot && path.join(projectRoot, 'src'), projectRoot && path.join(projectRoot, 'app')].filter(Boolean) as string[];
    for (const root of roots) {
      const resolved = resolveFile(path.join(root, rel), filesByPath);
      if (resolved) return { kind: 'in-repo', path: resolved };
    }
    return { kind: 'unresolved' };
  }

  // Bare specifier → tsconfig-`paths` alias first, else node_modules vendor.
  if (projectRoot && tsconfig?.paths) {
    const viaTsconfig = resolveViaTsconfigPaths(specifier, projectRoot, tsconfig.paths, tsconfig.baseUrl, filesByPath);
    if (viaTsconfig) return { kind: 'in-repo', path: viaTsconfig };
  }
  if (projectRoot) {
    const vendor = resolveVendorSpecifier(specifier, importerPath, projectRoot);
    if (vendor) return { kind: 'vendor', path: vendor };
  }
  return { kind: 'unresolved' };
}

/** Resolve a bare specifier through tsconfig `compilerOptions.paths` patterns. */
function resolveViaTsconfigPaths(
  specifier: string,
  projectRoot: string,
  paths: Readonly<Record<string, readonly string[]>>,
  baseUrl: string | undefined,
  filesByPath: ReadonlySet<string>,
): string | null {
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      // Exact key (no wildcard): `"db": ["./db/index.ts"]`.
      if (specifier !== pattern) continue;
      for (const target of targets) {
        const resolved = resolveFile(path.resolve(projectRoot, baseUrl ?? '.', target), filesByPath);
        if (resolved) return resolved;
      }
      continue;
    }
    // Wildcard: `"@/*": ["src/*"]` — match `prefix` + capture + `suffix`.
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const target of targets) {
      const replaced = target.replace('*', matched);
      const resolved = resolveFile(path.resolve(projectRoot, baseUrl ?? '.', replaced), filesByPath);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Resolve a bare specifier to a node_modules vendor declaration, if one exists. */
function resolveVendorSpecifier(specifier: string, importerPath: string, projectRoot: string): string | null {
  if (specifier.startsWith('node:')) return null; // Node builtins have no vendor `.d.ts`
  const root = path.resolve(projectRoot);
  const segments = specifier.split('/');
  let dir = path.dirname(importerPath);
  for (;;) {
    const pkgRoot = path.join(dir, 'node_modules', ...segments);
    const decl = resolveVendorDeclaration(pkgRoot);
    if (decl) return decl;
    if (dir === root || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  return null;
}

/** The `.d.ts` entry for a node_modules package root: `types` field, else `index.d.ts`. */
function resolveVendorDeclaration(pkgRoot: string): string | null {
  const pkgJson = path.join(pkgRoot, 'package.json');
  try {
    const parsed = JSON.parse(readFileSync(pkgJson, 'utf-8')) as { types?: unknown; typings?: unknown };
    const types = typeof parsed.types === 'string' ? parsed.types : typeof parsed.typings === 'string' ? parsed.typings : undefined;
    if (types) {
      const decl = path.join(pkgRoot, types);
      if (existsSync(decl)) return decl;
    }
  } catch {
    // no package.json (or unparseable) — fall through to `index.d.ts`.
  }
  const idx = path.join(pkgRoot, 'index.d.ts');
  return existsSync(idx) ? idx : null;
}

// ── Form-3 heritage declaration reader (Spec 70 Q3, Item 1) ─────────────────

/** The declared shape of one heritage base class, read from its `.d.ts`:
 *  its type-parameter names/defaults and its instance field → declared type map.
 *  No bundled name list — the declaration is the source of truth. */
interface HeritageClassDecl {
  typeParams: readonly HeritageTypeParam[];
  fields: ReadonlyMap<string, string>;
}

/** One type parameter: its name and its declared default (`unknown` for
 *  `Env = unknown`), or null when no default is declared. */
interface HeritageTypeParam {
  name: string;
  default: string | null;
}

/** Strip a tree-sitter `default_type` (`= unknown`) / `type_annotation`
 *  (`: Env`) wrapper to the bare type text. */
function stripTypePrefix(text: string): string {
  const t = text.trim();
  return t.replace(/^[=:]/, '').trim();
}

/** Escape a literal for interpolation into a `RegExp` — the type-parameter
 *  names become word-boundary alternatives. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The enclosing class declaration named `base`, or null when the `.d.ts`
 *  declares no such class. Both `class_declaration` and
 *  `abstract_class_declaration` name their class via a leading `type_identifier`
 *  child (tree-sitter renders a class name as a type identifier, not an
 *  identifier). */
function findClassNamed(root: ASTNode, base: string, sourceCode: string): ASTNode | null {
  const stack: ASTNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
      const nameNode = node.children?.find((c) => c.type === 'type_identifier');
      if (nameNode && getNodeText(nameNode, sourceCode) === base) return node;
    }
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return null;
}

/** Read one heritage base class's declared type parameters and instance fields
 *  from a `.d.ts`. Returns null (abstain) when the file is unreadable, unparseable,
 *  or declares no class named `base`. Only `public_field_definition` members are
 *  read — `method_signature`/`constructor` members carry no field type and are
 *  skipped, so a base class that declares only methods yields no fields. */
function readClassFieldTypes(dtsPath: string, base: string): HeritageClassDecl | null {
  let content: string;
  try {
    content = readFileSync(dtsPath, 'utf-8');
  } catch {
    return null;
  }
  const ast = parseFile(dtsPath, content);
  if (!ast) return null;
  const classNode = findClassNamed(ast.root, base, content);
  if (!classNode) return null;

  const typeParams: HeritageTypeParam[] = [];
  const fields = new Map<string, string>();
  for (const child of classNode.children ?? []) {
    if (child.type === 'type_parameters') {
      for (const tp of child.children ?? []) {
        if (tp.type !== 'type_parameter') continue;
        let name: string | null = null;
        let def: string | null = null;
        for (const c of tp.children ?? []) {
          if (c.type === 'type_identifier' && name === null) name = getNodeText(c, content);
          else if (c.type === 'default_type') def = stripTypePrefix(getNodeText(c, content));
        }
        if (name !== null) typeParams.push({ name, default: def });
      }
    } else if (child.type === 'class_body') {
      for (const member of child.children ?? []) {
        if (member.type !== 'public_field_definition') continue;
        let fieldName: string | null = null;
        let fieldType: string | null = null;
        for (const c of member.children ?? []) {
          if (c.type === 'property_identifier') fieldName = getNodeText(c, content);
          else if (c.type === 'type_annotation') fieldType = stripTypePrefix(getNodeText(c, content));
        }
        if (fieldName !== null && fieldType !== null) fields.set(fieldName, fieldType);
      }
    }
  }
  return { typeParams, fields };
}

/** Substitute the declared field type's type-parameter references with the
 *  heritage's type arguments (or the declared default when an argument is absent).
 *  A single combined word-boundary pass avoids chained substitution (a replacement
 *  that is itself another parameter's name). Returns null (abstain) when the
 *  declared type references a parameter that has neither an argument nor a
 *  declared default — never a guessed clean. */
function substituteTypeParams(
  declared: string,
  typeParams: readonly HeritageTypeParam[],
  args: readonly string[],
): string | null {
  if (typeParams.length === 0) return declared;
  const names = typeParams.map((p) => p.name);
  const pattern = names.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp(`\\b(?:${pattern})\\b`, 'g');
  let ok = true;
  const result = declared.replace(re, (m) => {
    const idx = names.indexOf(m);
    const replacement = args[idx] ?? typeParams[idx].default;
    if (replacement === null || replacement === undefined) {
      ok = false;
      return m;
    }
    return replacement;
  });
  return ok ? result : null;
}

/** Build the heritage field resolver for a project: given a base class name, its
 *  type arguments, and a `this.<field>` name, resolve the field's declared type
 *  from the base class's `.d.ts` in the project's declared dependencies. Each
 *  declared package is tried in turn (the base class may be an ambient global from
 *  any of them — `@cloudflare/workers-types`, the `agents` SDK, …), its vendor
 *  declaration resolved through the same `resolveVendorSpecifier` seam the import
 *  path uses (with a synthetic importer at the project root, since an ambient
 *  class carries no real importing file). Returns null when no declared dependency
 *  ships a `.d.ts` that declares the base class — which is every pinned clone, none
 *  of which carries `node_modules` — so the classifier abstains. Results are
 *  cached per base class name.
 */
export function makeHeritageResolver(
  projectRoot: string | undefined,
  declaredTypePackages: ReadonlySet<string> | undefined,
): HeritageFieldResolver | null {
  if (!projectRoot || !declaredTypePackages || declaredTypePackages.size === 0) return null;
  const importer = path.join(projectRoot, 'index.ts');
  const cache = new Map<string, HeritageClassDecl | null>();
  return (base, field, args) => {
    let decl = cache.get(base);
    if (decl === undefined) {
      decl = null;
      for (const pkg of declaredTypePackages) {
        const dts = resolveVendorSpecifier(pkg, importer, projectRoot);
        if (!dts) continue;
        const found = readClassFieldTypes(dts, base);
        if (found) {
          decl = found;
          break;
        }
      }
      cache.set(base, decl);
    }
    if (!decl) return null;
    const declared = decl.fields.get(field);
    if (declared === undefined) return null;
    return substituteTypeParams(declared, decl.typeParams, args);
  };
}

/** Resolve a base path (with or without extension) to a known in-repo file. */
function resolveFile(base: string, filesByPath: ReadonlySet<string>): string | null {
  const candidates: string[] = [base, ...RESOLVE_EXTENSIONS.map((e) => base + e)];
  for (const candidate of candidates) {
    if (filesByPath.has(candidate)) return candidate;
    for (const idx of INDEX_BASENAMES) {
      if (filesByPath.has(path.join(candidate, idx))) return path.join(candidate, idx);
    }
  }
  return null;
}

/**
 * The TS/JS within-file provenance for one file: seed DB-provenanced package
 * imports, then reach a fixed point across the three layers — propagation,
 * wrapper classes, and DB-returning functions (S5e/S5f). The fixed-point body
 * the phase model's `within-file-provenance` file producer (Spec 70 Item 4)
 * mirrors, so it can compute the same result from a single file's AST with no
 * cross-file seeds. This is also the byte-identical parity reference pinned by
 * `spec70-ts-within-file-parity.spec.ts`.
 *
 * The pre-S5 ordering ran propagation → wrappers once and stopped. That left
 * `const appDb = AppDatabase.getInstance()` unprovenanced: `AppDatabase` is only
 * discovered as a wrapper *class* by `detectDbWrappers`, which runs *after*
 * `propagateProvenance` has already scanned the declarator. Re-running propagation
 * after wrapper discovery closes that gap — the wrapper name is now in the map, so
 * the declarator's `.getInstance()` call resolves through it.
 *
 * @param ast The parsed file AST the within-file layers walk.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text (identifier/name extraction).
 * @param extraSeeds names provenanced *outside* this file (cross-file imports),
 *   merged into the DB-import seeds before the fixed point.
 * @returns The fixed-point map of DB-provenanced local names to their evidence.
 */
export function computeTsWithinFileProvenance(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  extraSeeds: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
): Map<string, ProvenanceEvidence> {
  const seeds = extractDBProvenancedImports(ast, adapter);
  for (const [name, evidence] of extraSeeds) {
    if (!seeds.has(name)) seeds.set(name, evidence);
  }

  let prov = new Map(seeds);
  const MAX_PASSES = 10;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = prov.size;
    prov = propagateProvenance(ast, adapter, sourceCode, prov);
    prov = detectDbWrappers(ast, adapter, sourceCode, prov, { classes: true });
    prov = detectDbReturningFunctions(ast, adapter, sourceCode, prov);
    if (prov.size === before) break;
  }
  return prov;
}

// ── S5a/S5e — three-way receiver disposition (Spec 69 §10) ────────────────────
//
// Every query-shaped call site gets an explicit disposition on its receiver's
// *root*, not on its callee's method name:
//   • handle     — the root resolves to a DB handle (package import, DB-handle
//                  type, wrapper, or form-5 function return). The finding path
//                  extracts it; no coverage offset.
//   • not-handle — the root resolves to something *definitively* not a DB handle:
//                  an ambient global (no binding in the file's scope chain), a
//                  non-DB package import, a literal / primitive / array, or a
//                  non-DB constructor (`new URLSearchParams()`). `clean` is the
//                  *correct* outcome here — not a silent one.
//   • unproven   — the root resolves to something indeterminate: an `any`/`unknown`
//                  type, an un-annotated parameter, an un-annotated factory return,
//                  or an undeclared `this.<field>`. This is the cannot-fire surface.
//
// The method-name list is only a *candidacy* filter (which calls to examine), not
// the disposition: `Array.map()`, `path.join()`, `page.locator()`, and
// `params.set()` all clear the candidacy filter but their roots resolve to
// not-a-handle, so they are `clean` — the mirror of the defect that previously
// reported cannot-fire on the strength of the method name alone.

/**
 * True when `name` resolves to a definitively non-DB root under the file's own
 * bindings (the `not-handle` disposition). A name that resolves to `unproven`
 * (an un-annotated factory return, an `any`-typed declaration, an un-annotated
 * parameter) returns false — it is *unknown*, not provably non-DB.
 *
 * @param name the bare root identifier to classify
 * @param ast the parsed file AST
 * @param adapter the language adapter used to build the binding environment
 * @param sourceCode the file source text
 * @returns true when `name` classifies `not-handle`, false when `unproven` or a handle
 */
export function isProvablyNonDbDeclaration(
  name: string,
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode = '',
): boolean {
  const bindings = buildBindingEnv(ast, adapter, sourceCode);
  const env: RootResolutionEnv = { provenance: new Map(), bindings, adapter, sourceCode };
  return classifyRootIdentifier(name, env) === 'not-handle';
}

/** A human-readable reason for an unproven receiver's cannot-fire disposition.
 *  The admission basis is now a real test, not a phrase: `queryShaped` is the
 *  `isQueryBuilderShape` result carried from the gate, so the tail names the
 *  mechanism that admitted the site (query-builder shape vs a static SQL argument)
 *  rather than asserting "query-shaped" unconditionally.
 *
 *  One function for both formats — the four historical copies (TS + Go, each in
 *  `receiverResolution.ts` and `receiverConsumers.ts`) were why a fabricated claim
 *  lived in all four and took four edits to fix. The only format-specific piece is
 *  the receiver/root/cause clause ({@link describeReceiverClause}); the tail and the
 *  closing "so its DB access is unseen" are shared. */
export function describeUnprovenReceiver(
  receiver: string,
  method: string,
  root: string,
  cause: string,
  queryShaped: boolean,
  format: 'typescript' | 'go',
): string {
  const tail = queryShaped
    ? `\`.${method}()\` is query-shaped`
    : `\`.${method}()\` carries a SQL argument`;
  const clause = describeReceiverClause(format, receiver, root, cause);
  return `${clause}; ${tail}, so its DB access is unseen.`;
}

/** The format-specific clause naming the receiver, its root, and the cause.
 *  Go has one shape (`has root \`x\` that …` — every Go receiver is a selector
 *  chain, so there is no `this`/bare-identifier branch); TS has three, keyed to
 *  the receiver chain shape. `cause` is the *combined* verdict reason from
 *  {@link identifyHandle} — the union of the declaration-resolution cause and (when
 *  a SQL argument fails to parse) the `sql-argument` cause, passed through whole so
 *  an unparseable literal is reported as such, never as a bare declaration failure. */
function describeReceiverClause(
  format: 'typescript' | 'go',
  receiver: string,
  root: string,
  cause: string,
): string {
  if (format === 'go') {
    return `receiver \`${receiver}\` has root \`${root}\` that ${cause}`;
  }
  if (receiver.startsWith('this.') || receiver.startsWith('super.')) {
    return `receiver \`${receiver}\` is a class field whose root \`${root}\` ${cause}`;
  }
  if (receiver.includes('.')) {
    return `receiver \`${receiver}\` is a runtime binding / compound reference whose root \`${root}\` ${cause}`;
  }
  return `receiver \`${receiver}\` has no in-repo declaration traceable to a DB handle (root \`${root}\` ${cause})`;
}

