/**
 * Cross-file in-repo DB-receiver resolution — Spec 69 §10 (S1).
 *
 * Answers, structurally and with zero name-list fallback, "which identifiers in
 * this corpus are DB-provenanced?" — so the `DB_RECEIVER_NAMES` name list and its
 * fallback machinery can be deleted without a receiver going unseen (criterion 7
 * and the §10 "no silent regression" guard).
 *
 * The evidence is layered, most-specific-first:
 *   1. package imports          — `DB_PACKAGES` (import { neon } from '@neondatabase/serverless')
 *   2. within-file propagation  — `propagateProvenance` (const db = new Database(); db.query)
 *   3. wrapper functions/classes — bodies that construct/call a DB driver
 *   4. cross-file imports       — `import { Database } from './db'` where `./db`
 *      resolves to an in-repo file that exports `Database` as DB-provenanced
 *      (layers 1–3 on that file, transitively — a fixed point).
 *
 * Layer 4 is the point: `Database` in hhra-org's `queue-worker/src/db.ts` wraps
 * `neon` (layer 1) in a class (layer 4), and `queue-worker.ts` imports it from
 * `./db` (layer 5). None of that consults a name list — it is a resolution of a
 * declaration, not a guess from the identifier's English name.
 *
 * Unresolvable receivers (a runtime binding like `env.DB`, a `./db` whose target
 * is absent) are NOT silently provenanced; they are surfaced via
 * {@link ResolutionReport.unresolvedImports} so the caller can record a
 * `cannot-fire` disposition rather than a `clean` one (§10 coverage parity).
 */

import type { AST, LanguageAdapter, ASTNode } from '../languages/types.js';
import {
  extractDBProvenancedImports,
  propagateProvenance,
  detectDbWrappers,
  detectDbReturningFunctions,
  getCallExpressionCallee,
  getMemberExpressionReceiver,
  extractMemberExpressionProperty,
  applySqlArgumentInference,
  type ProvenanceEvidence,
} from './provenance.js';
import { DB_CALL_METHODS } from './tsEcosystem.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import {
  buildBindingEnv,
  classifyRootIdentifier,
  classifyThisChain,
  resolveReceiverRoot,
  type RootResolutionEnv,
  type Binding,
  type TypeRegistry,
} from './receiverRoot.js';
import {
  buildGoWithinFileProvenance,
  buildGoBindingEnv,
  buildGoImportMap,
  buildGoPackageBindings,
  type GoResolutionEnv,
  type GoBinding,
} from '../languages/go/goResolution.js';
import { identifyHandle } from './handleIdentification.js';
import type { Dialect } from '../mcp-tools/discoveryQueries.js';
import {
  discoverFiles,
  DEFAULT_EXCLUDED_DIRS,
  TYPESCRIPT_EXTENSIONS,
  JAVASCRIPT_EXTENSIONS,
} from '../utils/fileDiscovery.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readProjectManifest, computeManifestStaleness, type ManifestStaleEntry } from './manifestStaleness.js';

// The flat-facts surface (imports / type annotations / value text / provenance).
// The declaration-resolution classifier reads `resolution` (the deep environment),
// not these maps; the flat maps are populated for the surface's own sake. The
// project manifest is deliberately *not* here — it feeds the staleness report
// (manifestStaleness.ts, read once in `resolveReceiverProvenance`), never a
// classification input.
function makeResolutionFacts(sqlDialect: Dialect | null = null) {
  return {
    imports: new Map<string, string>(),
    typeAnnotations: new Map<string, string>(),
    bindings: new Map<string, string>(),
    withinFileProvenance: new Map<string, string>(),
    sqlDialect,
  };
}

/** A source file for resolution: path (absolute) + already-read content. */
export type SourceFile = { readonly path: string; readonly content: string };

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

/** The full output of one resolution pass. */
export interface ResolutionReport {
  fileProvenance: FileProvenance;
  fileExports: FileExports;
  unresolvedImports: UnresolvedImport[];
  /** Query-shaped call sites whose receiver is unproven (S5a disposition). */
  unprovenQueryReceivers: UnprovenQueryReceiver[];
  /**
   * The ecosystem-list staleness report (Part 2b): every package our DB-package
   * list names that this project does not depend on, keyed to the manifest it was
   * compared against. Diagnostic only — affects no verdict.
   */
  manifestStaleness: ManifestStaleEntry[];
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

/** Literal node types that carry a whole SQL string, per format. */
const GO_STRING_LITERAL_TYPES = new Set(['interpreted_string_literal', 'raw_string_literal']);
const TS_STRING_LITERAL_TYPES = new Set(['string', 'template_string']);

/**
 * Extract the text of a call's first argument when it is a string/template
 * literal, or null otherwise. This is Spec 70 R3 criterion #8: a call whose
 * first argument parses as SQL makes its receiver a handle. The argument is
 * returned *unquoted* so the SQL parser sees the statement, not the delimiter.
 *
 * Abstains (null) — rather than mis-proving — when the first argument is a
 * bound variable, a function call, a dynamic template with interpolation, or
 * anything other than a plain literal. The SQL-argument evidence source then
 * reports `unproven`, and only the declaration resolution (which can prove
 * `not-handle`) decides.
 */
function extractSqlArgument(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  const argListType = adapter.name === 'go' ? 'argument_list' : 'arguments';
  const stringTypes = adapter.name === 'go' ? GO_STRING_LITERAL_TYPES : TS_STRING_LITERAL_TYPES;
  const argsNode = adapter.getChildren(node).find((c) => c.type === argListType);
  if (!argsNode) return null;
  for (const arg of adapter.getChildren(argsNode)) {
    if (arg.type === '(' || arg.type === ')' || arg.type === ',') continue;
    if (!stringTypes.has(arg.type)) return null;
    return unquote(adapter.getNodeText(arg, sourceCode));
  }
  return null;
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

/**
 * Resolve an import specifier to an in-repo file path, or null when it is a
 * bare/node_modules specifier or no candidate file exists.
 *
 * @param specifier the import source string to resolve
 * @param importerPath the absolute path of the importing file
 * @param filesByPath the set of known in-repo file paths
 * @param projectRoot the corpus root, for resolving `@/`/`~/` aliases
 * @returns the resolved in-repo file path, or `null`
 */
export function resolveSpecifier(
  specifier: string,
  importerPath: string,
  filesByPath: ReadonlySet<string>,
  projectRoot?: string,
): string | null {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const base = path.resolve(path.dirname(importerPath), specifier);
    return resolveFile(base, filesByPath);
  }

  // Alias specifiers (`@/x`, `~/x`) map to the project root, then its src/app.
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    const rel = specifier.slice(2);
    const roots = [projectRoot, projectRoot && path.join(projectRoot, 'src'), projectRoot && path.join(projectRoot, 'app')].filter(Boolean) as string[];
    for (const root of roots) {
      const resolved = resolveFile(path.join(root, rel), filesByPath);
      if (resolved) return resolved;
    }
    return null;
  }

  return null; // bare specifier → node_modules, handled by DB_PACKAGES not here
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

/** Parsed-file bundle held only for the duration of the resolution pass. */
interface Parsed {
  filePath: string;
  sourceCode: string;
  ast: AST;
  adapter: LanguageAdapter;
}

/**
 * Build a per-directory map of Go package-scope symbols. Go packages are
 * directory-scoped (one package per directory, modulo `_test`), so grouping by
 * `path.dirname` matches the language's own visibility rule: a package-level
 * `func New()` in one `.go` file is visible to every sibling `.go` file.
 */
function buildGoPackageBindingsByDir(
  parsedFiles: readonly Parsed[],
): Map<string, ReadonlyMap<string, GoBinding>> {
  const goFilesByDir = new Map<string, Parsed[]>();
  for (const parsed of parsedFiles) {
    if (parsed.adapter.name !== 'go') continue;
    const dir = path.dirname(parsed.filePath);
    const list = goFilesByDir.get(dir) ?? [];
    list.push(parsed);
    goFilesByDir.set(dir, list);
  }
  const out = new Map<string, ReadonlyMap<string, GoBinding>>();
  for (const [dir, files] of goFilesByDir) {
    out.set(dir, buildGoPackageBindings(files));
  }
  return out;
}

/** The within-file provenance from package imports + propagation + wrappers. */
function withinFileProvenance(
  parsed: Parsed,
  extraSeeds: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
  goPackageBindings?: ReadonlyMap<string, GoBinding>,
): Map<string, ProvenanceEvidence> {
  // Go resolves its own declaration grammar (parameter/var/short-var/field/
  // function-return) against `database/sql` — not the TS import + propagation +
  // wrapper machinery, which only understands TS/JS node shapes.
  if (parsed.adapter.name === 'go') {
    const prov = buildGoWithinFileProvenance(parsed.ast, parsed.adapter, parsed.sourceCode, goPackageBindings);
    for (const [name, evidence] of extraSeeds) {
      if (!prov.has(name)) prov.set(name, evidence);
    }
    return prov;
  }

  return computeTsWithinFileProvenance(parsed.ast, parsed.adapter, parsed.sourceCode, extraSeeds);
}

/**
 * The TS/JS within-file provenance for one file: seed DB-provenanced package
 * imports, then reach a fixed point across the three layers — propagation,
 * wrapper classes, and DB-returning functions (S5e/S5f). Extracted from
 * {@link withinFileProvenance} so the phase model's `within-file-provenance`
 * file producer (Spec 70 Item 4) can compute the same result from a single
 * file's AST with no cross-file seeds.
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

/** Compute the exported DB-provenanced names for one file. */
function exportedProvenancedNames(
  parsed: Parsed,
  provenance: ReadonlyMap<string, ProvenanceEvidence>,
): Set<string> {
  const exports = collectExports(parsed.ast, parsed.adapter, parsed.sourceCode);
  const out = new Set<string>();
  for (const ex of exports) {
    if (ex.name === '*') continue; // export * is handled by the module-level star
    const localName = ex.name;
    if (provenance.has(localName)) out.add(ex.name);
  }
  return out;
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

/** True when a receiver chain bottoms out at `this`/`super` (a field reference). */
function receiverIsThisRooted(callee: ASTNode, adapter: LanguageAdapter): boolean {
  let current: ASTNode = callee;
  while (current.type === 'member_expression' || current.type === 'selector_expression') {
    const children = adapter.getChildren(current);
    const firstChild = children.find(
      (c) => c.type !== '.' && c.type !== 'property_identifier' && c.type !== 'field_identifier',
    );
    if (!firstChild) return false;
    current = firstChild;
  }
  return current.type === 'this' || current.type === 'super';
}

/** A human-readable reason for an unproven receiver's cannot-fire disposition. */
function describeUnprovenReceiver(receiver: string, method: string, root: string, cause: string): string {
  if (receiver.startsWith('this.') || receiver.startsWith('super.')) {
    return `receiver \`${receiver}\` is a class field whose root \`${root}\` ${cause}; \`.${method}()\` is query-shaped, so its DB access is unseen.`;
  }
  if (receiver.includes('.')) {
    return `receiver \`${receiver}\` is a runtime binding / compound reference whose root \`${root}\` ${cause}; \`.${method}()\` is query-shaped, so its DB access is unseen.`;
  }
  return `receiver \`${receiver}\` has no in-repo declaration traceable to a DB handle (root \`${root}\` ${cause}); \`.${method}()\` is query-shaped, so its DB access is unseen.`;
}

/** A human-readable reason for a Go unproven receiver's cannot-fire disposition.
 *  `cause` is the *combined* verdict reason from {@link identifyHandle} — the union
 *  of the declaration-resolution cause and (when a SQL argument fails to parse) the
 *  `sql-argument` cause. Passing it through whole preserves the criterion-3
 *  guarantee that an unparseable literal is reported as such, never as a bare
 *  declaration failure. */
function describeGoUnprovenReceiver(receiver: string, method: string, root: string, cause: string): string {
  return `receiver \`${receiver}\` has root \`${root}\` that ${cause}; \`.${method}()\` is query-shaped, so its DB access is unseen.`;
}

/**
 * The four resolution inputs the TS and Go environments share — provenance,
 * bindings, adapter, and source text. Factored out so the Go and TS collectors
 * build the same base object once instead of two near-identical `env` literals
 * (dry/similar-expression). The bindings map is generic because TS binds
 * {@link Binding} values and Go binds {@link GoBinding} values.
 */
function resolutionEnvBase<B>(
  provenance: ReadonlyMap<string, ProvenanceEvidence>,
  bindings: ReadonlyMap<string, B>,
  adapter: LanguageAdapter,
  sourceCode: string,
): {
  provenance: ReadonlyMap<string, ProvenanceEvidence>;
  bindings: ReadonlyMap<string, B>;
  adapter: LanguageAdapter;
  sourceCode: string;
} {
  return { provenance, bindings, adapter, sourceCode };
}

/**
 * The Go half of {@link collectUnprovenQueryReceivers}: enumerates query-shaped
 * call sites whose receiver root is neither a DB handle nor a definitively
 * non-DB value under Go's own declaration resolution. The callee/method/receiver
 * extraction is shared with the TS path (`getCallExpressionCallee`,
 * `extractMemberExpressionProperty`, `resolveReceiverRoot` — all handle Go's
 * `selector_expression`/`field_identifier`/`identifier` shapes); only the
 * resolution environment differs (`{ dialect: 'go', env }` vs `{ dialect: 'ts', env }`).
 * Both route through `identifyHandle`, which dispatches to the per-format
 * resolution implementation.
 */
function collectGoUnprovenQueryReceivers(
  parsed: Parsed,
  provenance: ReadonlyMap<string, ProvenanceEvidence>,
  packageBindings?: ReadonlyMap<string, GoBinding>,
  sqlDialect: Dialect | null = null,
): UnprovenQueryReceiver[] {
  const { ast, adapter, sourceCode, filePath } = parsed;
  const bindings = buildGoBindingEnv(ast, adapter, sourceCode);
  const imports = buildGoImportMap(ast, adapter);
  const env: GoResolutionEnv = { ...resolutionEnvBase(provenance, bindings, adapter, sourceCode), imports, packageBindings };

  const out: UnprovenQueryReceiver[] = [];
  const calls = adapter.findNodes(ast, { custom: (n: ASTNode) => n.type === 'call_expression' });
  for (const node of calls) {
    const callee = getCallExpressionCallee(node, adapter);
    if (!callee || callee.type !== 'selector_expression') continue;
    const method = extractMemberExpressionProperty(callee, adapter, sourceCode);
    if (!method) continue;
    const m = method.toLowerCase();
    if (!DB_CALL_METHODS.has(m)) continue; // candidacy filter only

    const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode) ?? '(unknown)';
    const root = resolveReceiverRoot(callee, adapter, sourceCode);
    // A literal/array/object receiver has no identifier root — definitively not a handle.
    if (root === null) continue;

    const verdict = identifyHandle(
      { format: 'go', root, receiver, method, sqlArgument: extractSqlArgument(node, adapter, sourceCode), thisField: false },
      { ...makeResolutionFacts(sqlDialect), resolution: { dialect: 'go', env } },
    );
    if (verdict.kind !== 'unproven') continue;

    out.push({
      file: filePath,
      line: node.location.start.line,
      receiver,
      root,
      method,
      reason: describeGoUnprovenReceiver(receiver, method, root, verdict.reason),
    });
  }
  return out;
}

/**
 * Enumerate the query-shaped call sites in one parsed file whose receiver root is
 * unproven — neither a DB handle nor a definitively non-DB root — under the given
 * (already-resolved, cross-file) provenance map. The disposition keys to the
 * receiver's root resolution, not to the callee's method name.
 *
 * @param parsed the parsed file (AST, adapter, source code, path)
 * @param provenance the cross-file DB-provenanced identifier map
 * @param resolution optional cross-file context: file set, project root, Go
 *   package bindings, the corpus type registry, and the named SQL dialect
 * @returns the unproven query-shaped call sites in this file
 */
export function collectUnprovenQueryReceivers(
  parsed: Parsed,
  provenance: ReadonlyMap<string, ProvenanceEvidence>,
  resolution?: { filesByPath?: ReadonlySet<string>; projectRoot?: string; goPackageBindings?: ReadonlyMap<string, GoBinding>; typeRegistry?: TypeRegistry; sqlDialect?: Dialect | null },
): UnprovenQueryReceiver[] {
  if (parsed.adapter.name === 'go') {
    return collectGoUnprovenQueryReceivers(parsed, provenance, resolution?.goPackageBindings, resolution?.sqlDialect ?? null);
  }
  const { ast, adapter, sourceCode, filePath } = parsed;
  const bindings = buildBindingEnv(ast, adapter, sourceCode);
  // Spec 70 Item 1 — verdict propagation: a root proven `handle` at one site (via
  // a static SQL argument) carries to sibling sites sharing the root in the same
  // scope, so `db.prepare('SELECT …').bind(x).first()` resolves `bind`/`first` a
  // handle too, not unproven. The phase path does this in `classifyBuildProvenance`
  // (step 3 R3); this legacy enumerator must mirror it so its unproven population
  // agrees with production. R3 is TS-only (Go resolves cross-file), matching
  // `applyR3FromSites` — `applySqlArgumentInference` returns its input unchanged
  // for the Go adapter.
  const r3Provenance = resolution?.sqlDialect
    ? applySqlArgumentInference(ast, adapter, sourceCode, new Map(provenance), resolution.sqlDialect)
    : provenance;
  const env: RootResolutionEnv = {
    ...resolutionEnvBase(r3Provenance, bindings, adapter, sourceCode),
    resolveImport: resolution?.filesByPath
      ? (source: string) => resolveSpecifier(source, filePath, resolution.filesByPath!, resolution.projectRoot)
      : undefined,
  };

  const out: UnprovenQueryReceiver[] = [];
  const calls = adapter.findNodes(ast, {
    custom: (n: ASTNode) => n.type === 'call_expression',
  });
  for (const node of calls) {
    const callee = getCallExpressionCallee(node, adapter);
    if (!callee || (callee.type !== 'member_expression' && callee.type !== 'selector_expression')) continue;
    const method = extractMemberExpressionProperty(callee, adapter, sourceCode);
    if (!method) continue;
    const m = method.toLowerCase();
    if (!DB_CALL_METHODS.has(m)) continue; // candidacy filter only

    const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode) ?? '(unknown)';
    const root = resolveReceiverRoot(callee, adapter, sourceCode);
    // A literal/array/object receiver has no identifier root — definitively not a handle.
    if (root === null) continue;

    const thisRooted = receiverIsThisRooted(callee, adapter);

    // Form-3 — a `this.<field>.<…>` chain whose root is the class base type. The
    // bare root (`env`/`ctx`) has no file binding, so it classifies `unproven`; but
    // `this.env.DB` / `this.ctx.storage.sql` resolve through the class's
    // `extends Agent<Env>` heritage and the corpus type registry to a DB handle.
    // This is declaration resolution, not a name match on `env.DB`. It must run
    // *before* the bare-root classification: `this.<field>` is a field reference,
    // and the heritage contract is authoritative — a local `env`/`ctx`/`state`
    // binding (or a sibling-class field of the same name) in scope is a shadow,
    // not the field's type.
    if (thisRooted && resolution?.typeRegistry) {
      const segments = thisChainSegments(receiver);
      if (segments) {
        const heritage = findEnclosingClassHeritage(ast, adapter, node, sourceCode);
        const thisDisp = classifyThisChain(segments, heritage, resolution.typeRegistry);
        if (thisDisp === 'handle' || thisDisp === 'not-handle') continue;
      }
    }

    const verdict = identifyHandle(
      { format: 'typescript', root, receiver, method, sqlArgument: extractSqlArgument(node, adapter, sourceCode), thisField: thisRooted },
      { ...makeResolutionFacts(resolution?.sqlDialect ?? null), resolution: { dialect: 'ts', env } },
    );
    if (verdict.kind !== 'unproven') continue;

    out.push({
      file: filePath,
      line: node.location.start.line,
      receiver,
      root,
      method,
      reason: describeUnprovenReceiver(receiver, method, root, verdict.reason),
    });
  }
  return out;
}

/** The property-name chain from `this`/`super` to the receiver root (exclusive of
 *  the method), or null when the receiver isn't a pure `this.<a>.<b>` chain. */
function thisChainSegments(receiver: string): string[] | null {
  const t = receiver.trim();
  const m = /^(?:this|super)((?:\.[A-Za-z_$][\w$]*)+)$/.exec(t);
  if (!m) return null;
  return m[1].split('.').slice(1);
}

/** The enclosing class declaration's `extends` clause text (`Agent<Env>`), or null
 *  when the node is not inside a class or the class has no base class. */
function findEnclosingClassHeritage(
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

/** Mutable accumulators threaded through {@link walkTypeDecls}; the three
 *  collections that together form the returned {@link TypeRegistry}. */
interface TypeRegistryAccumulator {
  members: Map<string, Map<string, string>>;
  methods: Map<string, Set<string>>;
  heritage: Map<string, string[]>;
}

/**
 * Build a corpus-wide type-member registry from the parsed files: every
 * `interface` / object `type` alias's members (name → type) and `extends`
 * heritage, qualified by any enclosing `namespace`/`declare namespace`. This is
 * the declaration source {@link classifyThisChain} reads to resolve `this.env.DB`
 * (through `interface Env extends Cloudflare.Env { }` + `Cloudflare.Env.DB:
 * D1Database`) without a name list.
 *
 * @param parsedFiles the parsed files of the corpus (Go files are skipped)
 * @returns the corpus-wide type-member registry
 */
export function extractTypeRegistry(parsedFiles: readonly Parsed[]): TypeRegistry {
  const acc: TypeRegistryAccumulator = {
    members: new Map<string, Map<string, string>>(),
    methods: new Map<string, Set<string>>(),
    heritage: new Map<string, string[]>(),
  };
  for (const parsed of parsedFiles) {
    if (parsed.adapter.name === 'go') continue;
    walkTypeDecls(parsed.ast.root, parsed.adapter, parsed.sourceCode, '', acc);
  }
  return acc;
}

/** The direct identifier/type_identifier name child of a declaration node. */
function typeDeclName(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const id = adapter.getChildren(node).find(
    (c) => c.type === 'identifier' || c.type === 'type_identifier',
  );
  return id ? adapter.getNodeText(id, sourceCode) : null;
}

/** A `property_signature`'s name and declared type (the `type_annotation` text). */
function propertySignatureMember(
  sig: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): { name: string; type: string } | null {
  const children = adapter.getChildren(sig);
  const nameNode = children.find((c) => c.type === 'property_identifier');
  const typeNode = children.find((c) => c.type === 'type_annotation');
  if (!nameNode || !typeNode) return null;
  return {
    name: adapter.getNodeText(nameNode, sourceCode),
    type: adapter.getNodeText(typeNode, sourceCode).replace(/^:\s*/, '').trim(),
  };
}

/** A `method_signature`'s declared name (its `property_identifier` child). */
function methodSignatureName(
  sig: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  const nameNode = adapter.getChildren(sig).find((c) => c.type === 'property_identifier');
  return nameNode ? adapter.getNodeText(nameNode, sourceCode) : null;
}

/** The `extends` heritage of an interface (each non-`,` child of `extends_type_clause`). */
function interfaceHeritage(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string[] {
  const ext = adapter.getChildren(node).find((c) => c.type === 'extends_type_clause');
  if (!ext) return [];
  return adapter.getChildren(ext)
    .filter((c) => c.type !== ',')
    .map((c) => adapter.getNodeText(c, sourceCode).trim())
    .filter((t) => t.length > 0);
}

/** Recursive walk collecting interface/type-alias members + method-signature
 *  names + heritage, honoring `namespace`/`declare namespace` qualification. */
function walkTypeDecls(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  nsPrefix: string,
  acc: TypeRegistryAccumulator,
): void {
  const t = node.type;

  if (t === 'interface_declaration' || t === 'type_alias_declaration') {
    const name = typeDeclName(node, adapter, sourceCode);
    if (name) {
      const qualified = nsPrefix ? `${nsPrefix}.${name}` : name;
      let memberMap = acc.members.get(qualified);
      for (const sig of collectNodes(node, adapter, (n) => n.type === 'property_signature')) {
        const m = propertySignatureMember(sig, adapter, sourceCode);
        if (!m) continue;
        if (!memberMap) {
          memberMap = new Map();
          acc.members.set(qualified, memberMap);
        }
        if (!memberMap.has(m.name)) memberMap.set(m.name, m.type);
      }
      for (const sig of collectNodes(node, adapter, (n) => n.type === 'method_signature')) {
        const mn = methodSignatureName(sig, adapter, sourceCode);
        if (!mn) continue;
        let methodSet = acc.methods.get(qualified);
        if (!methodSet) {
          methodSet = new Set();
          acc.methods.set(qualified, methodSet);
        }
        methodSet.add(mn);
      }
      const ext = interfaceHeritage(node, adapter, sourceCode);
      if (ext.length > 0) acc.heritage.set(qualified, [...(acc.heritage.get(qualified) ?? []), ...ext]);
    }
    return; // members/methods/heritage already collected; do not recurse into the body
  }

  if (t === 'internal_module') {
    const modName = typeDeclName(node, adapter, sourceCode);
    const nextPrefix = nsPrefix && modName ? `${nsPrefix}.${modName}` : (modName ?? nsPrefix);
    for (const c of adapter.getChildren(node)) {
      walkTypeDecls(c, adapter, sourceCode, nextPrefix, acc);
    }
    return;
  }

  if (t === 'ambient_declaration') {
    // `declare namespace` / `declare interface` — transparent wrapper, same prefix.
    for (const c of adapter.getChildren(node)) {
      walkTypeDecls(c, adapter, sourceCode, nsPrefix, acc);
    }
    return;
  }

  for (const c of adapter.getChildren(node)) {
    walkTypeDecls(c, adapter, sourceCode, nsPrefix, acc);
  }
}

/**
 * Run the cross-file resolution over a corpus.
 *
 * @param files The corpus files (absolute paths + content).
 * @param projectRoot The corpus root (for alias specifiers). Optional.
 * @param sqlDialect The corpus's named dialect, used to prove a receiver by its
 *   parsed SQL argument; null when no dialect is named.
 * @returns Per-file provenance, exported provenanced names, unresolved imports,
 *   and the manifest staleness report (Part 2b — diagnostic only).
 */
export async function resolveReceiverProvenance(
  files: readonly SourceFile[],
  projectRoot?: string,
  sqlDialect: Dialect | null = null,
): Promise<ResolutionReport> {
  const registry = LanguageRegistry.getInstance();
  const filesByPath = new Set(files.map((f) => path.resolve(f.path)));

  // Read the project manifest once (package.json + go.mod). It feeds the
  // staleness report (Part 2b) — never a classification input. Absent a
  // projectRoot (or absent manifests), the report is empty.
  const manifest = projectRoot
    ? await readProjectManifest(projectRoot)
    : { names: new Set<string>(), tsManifestPath: null, goManifestPath: null };

  // Parse every file that has a language adapter.
  const parsedFiles: Parsed[] = [];
  for (const f of files) {
    const adapter = registry.getAdapterForFile(f.path);
    if (!adapter) continue;
    let ast: AST;
    try {
      ast = await adapter.parse(f.path, f.content);
    } catch {
      continue;
    }
    parsedFiles.push({ filePath: path.resolve(f.path), sourceCode: f.content, ast, adapter });
  }

  // Go cross-file package-level symbols, keyed by package directory. This is the
  // Go half of the TS cross-file import resolution: package-level functions/types
  // declared in a *sibling* `.go` file are visible to every file in the package.
  const goPackageBindingsByDir = buildGoPackageBindingsByDir(parsedFiles);

  // Corpus-wide type-member registry for form-3 `this.<field>` resolution.
  const typeRegistry = extractTypeRegistry(parsedFiles);

  // Phase 1 — within-file provenance only (package + type + propagation + wrapper).
  const fileProvenance: FileProvenance = new Map();
  for (const parsed of parsedFiles) {
    fileProvenance.set(parsed.filePath, withinFileProvenance(parsed, new Map(), goPackageBindingsByDir.get(path.dirname(parsed.filePath))));
  }

  // Phase 2 — exported provenanced names.
  const fileExports: FileExports = new Map();
  for (const parsed of parsedFiles) {
    fileExports.set(parsed.filePath, exportedProvenancedNames(parsed, fileProvenance.get(parsed.filePath)!));
  }

  // Phase 3 — fixed point over cross-file imports.
  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    for (const parsed of parsedFiles) {
      const imports = parsed.adapter.extractImports(parsed.ast);
      const extraSeeds = new Map<string, ProvenanceEvidence>();
      for (const imp of imports) {
        const target = resolveSpecifier(imp.source, parsed.filePath, filesByPath, projectRoot);
        if (!target) continue;
        const targetExports = fileExports.get(target);
        if (!targetExports || targetExports.size === 0) continue;
        for (const spec of imp.specifiers) {
          const localName = spec.alias ?? spec.name;
          // Namespace import (`import * as db from './x'`) — provenanced when the
          // module exports ANY provenanced name (it re-exposes DB handles).
          if (spec.isNamespace) {
            if (!extraSeeds.has(localName)) {
              extraSeeds.set(localName, moduleEvidence(localName, imp.source));
            }
            continue;
          }
          const exportedName = spec.name;
          if (targetExports.has(exportedName) || (spec.isDefault && targetExports.has('default'))) {
            if (!extraSeeds.has(localName)) {
              extraSeeds.set(localName, moduleEvidence(localName, imp.source));
            }
          }
        }
      }
      if (extraSeeds.size === 0) continue;

      const prev = fileProvenance.get(parsed.filePath)!;
      const next = withinFileProvenance(parsed, extraSeeds, goPackageBindingsByDir.get(path.dirname(parsed.filePath)));
      // Recompute exports against the new provenance; a changed export set
      // propagates further on a later iteration.
      const nextExports = exportedProvenancedNames(parsed, next);
      const prevExports = fileExports.get(parsed.filePath)!;
      let exportChanged = nextExports.size !== prevExports.size;
      if (!exportChanged) {
        for (const n of nextExports) if (!prevExports.has(n)) { exportChanged = true; break; }
      }
      if (next.size > prev.size || exportChanged) {
        fileProvenance.set(parsed.filePath, next);
        fileExports.set(parsed.filePath, nextExports);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Collect unresolved imports for the cannot-fire report.
  const unresolvedImports: UnresolvedImport[] = [];
  for (const parsed of parsedFiles) {
    for (const imp of parsed.adapter.extractImports(parsed.ast)) {
      const target = resolveSpecifier(imp.source, parsed.filePath, filesByPath, projectRoot);
      if (target) continue;
      const names = imp.specifiers.map((s) => s.alias ?? s.name);
      // Only DB-looking imports matter: a bare package specifier is already
      // covered by DB_PACKAGES; an in-repo-looking specifier that fails to
      // resolve is the cannot-fire signal.
      if (imp.source.startsWith('./') || imp.source.startsWith('../') || imp.source.startsWith('@/') || imp.source.startsWith('~/')) {
        unresolvedImports.push({ importer: parsed.filePath, source: imp.source, names });
      }
    }
  }

  // S5a — enumerate unproven query receivers (per call site, after the
  // fixed-point so the disposition reads the final cross-file provenance).
  const unprovenQueryReceivers: UnprovenQueryReceiver[] = [];
  for (const parsed of parsedFiles) {
    const prov = fileProvenance.get(parsed.filePath) ?? new Map();
    unprovenQueryReceivers.push(...collectUnprovenQueryReceivers(parsed, prov, {
      filesByPath,
      projectRoot,
      goPackageBindings: goPackageBindingsByDir.get(path.dirname(parsed.filePath)),
      typeRegistry,
      sqlDialect,
    }));
  }

  // Free ASTs.
  for (const parsed of parsedFiles) parsed.ast.dispose?.();

  return { fileProvenance, fileExports, unresolvedImports, unprovenQueryReceivers, manifestStaleness: computeManifestStaleness(manifest) };
}

function moduleEvidence(identifier: string, source: string): ProvenanceEvidence {
  return {
    identifier,
    reason: 'module',
    source: `import from ${source} (in-repo declaration)`,
    chain: [],
  };
}

const CORPUS_RESOLVE_EXTENSIONS = new Set([
  ...TYPESCRIPT_EXTENSIONS,
  ...JAVASCRIPT_EXTENSIONS,
  '.d.ts',
  '.go',
]);

/**
 * Resolve DB-receiver provenance over an entire corpus (Spec 69 §10 S3).
 *
 * The live-pipeline replacement for the deleted `DB_RECEIVER_NAMES` name list:
 * discover + read every TS/JS file under `projectRoot`, run the cross-file
 * declaration resolution once, and return per-file DB-provenanced identifiers
 * plus the unresolved DB-looking imports (the `cannot-fire` accounting signal).
 *
 * This is a *separate* read+parse pass from stage 1 (the pipeline streams and
 * disposes ASTs, so they are not reusable here). It is only invoked when a
 * receiver-consuming visitor is present (see `needsReceiverResolution` in
 * pipeline.ts), and only once per run — never memoized globally, so a daemon's
 * repeated audits cannot serve a stale resolution.
 *
 * @param projectRoot The corpus root (absolute).
 * @param explicitFiles Optional exact file list; when absent the corpus is
 *   discovered with the pipeline's own excludes.
 * @param sqlDialect The corpus's named SQL dialect, or null when undetermined.
 * @returns the per-file resolution report, including the `cannot-fire`
 *   unresolved DB-looking imports
 */
export async function resolveCorpusReceivers(
  projectRoot: string,
  explicitFiles?: readonly string[],
  sqlDialect: Dialect | null = null,
): Promise<ResolutionReport> {
  const files =
    explicitFiles !== undefined
      ? [...explicitFiles]
      : await discoverFiles(projectRoot, { excludeDirs: DEFAULT_EXCLUDED_DIRS });

  const registry = LanguageRegistry.getInstance();
  const inputs: SourceFile[] = [];
  for (const f of files) {
    if (!CORPUS_RESOLVE_EXTENSIONS.has(path.extname(f).toLowerCase())) continue;
    let content: string;
    try {
      content = await readFile(f, 'utf-8');
    } catch {
      continue;
    }
    inputs.push({ path: f, content });
  }

  return resolveReceiverProvenance(inputs, projectRoot, sqlDialect);
}
