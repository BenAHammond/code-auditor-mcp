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
} from './receiverRoot.js';
import path from 'node:path';

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

