/**
 * Vendor surface resolution — Item B (reissued).
 *
 * The data-access analyzer once hand-maintained four method-name lists
 * (`EAGER_DB_METHODS`, `ORM_TABLE_VERBS`, `ORM_JOIN_VERBS`, and the
 * `COLLECTION_TRANSFORM_METHODS` runtime probe). A hand-copied vendor list
 * drifts: the vendor adds, renames, or removes a method and the replica silently
 * goes stale (the `.get()` gap, the deferred `.iterate()`, the missing lateral
 * joins). The reissued directive deletes the committed snapshot and resolves each
 * vendor's declaration **from the tree under analysis, per run** — the
 * `node_modules` (or workspace) path the tree's *own* imports resolve to, at the
 * version that tree actually installs. Nothing about a vendor's API is committed
 * here, and nothing is fetched from the network at analysis time.
 *
 * Three of the four lists derive from a vendor `.d.ts`; the fourth
 * (`COLLECTION_TRANSFORM_METHODS`) is a runtime probe over `Array.prototype` and
 * has no vendor declaration. Each derived set is the union of the analyzer's
 * irreducible cross-vendor grammar (the baseline, present regardless of what
 * resolves) and the per-run probe — the methods only a specific vendor publishes.
 * When a vendor declaration cannot be resolved, the corresponding surface is
 * `null` and its probe methods are absent (not a fallback list, not a stale
 * snapshot); the resolution record carries the *reason* naming what could not be
 * resolved, so a site whose classification depends on a probe-only method is
 * `unproven`, never silent.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseFile, getNodeText } from '../languages/adapterBridge.js';
import type { ASTNode } from '../languages/types.js';

/**
 * The eight vendor surfaces the analyzer derives its method sets from. Each is a
 * resolved member-name set, or `null` when the vendor's declaration could not be
 * resolved from the tree. The names are exactly the declaration *types* the four
 * vendors publish; the *selection* of which members are eager I/O / table verbs /
 * join verbs is a documented judgment (specs/vendor-replica-probes.md).
 */
export interface VendorSurfaces {
  kyselyQueryCreator: ReadonlySet<string> | null;
  kyselySelectQueryBuilder: ReadonlySet<string> | null;
  betterSqlite3Statement: ReadonlySet<string> | null;
  betterSqlite3Database: ReadonlySet<string> | null;
  nodeSqliteStatement: ReadonlySet<string> | null;
  nodeSqliteDatabase: ReadonlySet<string> | null;
  d1Database: ReadonlySet<string> | null;
  d1PreparedStatement: ReadonlySet<string> | null;
  /** One record per (package, type) resolution attempt — the probe's evidence. */
  resolutions: readonly VendorResolution[];
}

/** One (package, type) resolution attempt: where it resolved, at what version,
 *  and — when it did not — the reason naming what could not be resolved. */
export interface VendorResolution {
  pkg: string;
  type: string;
  /** The resolved `.d.ts` path, or `null` when unresolvable. */
  path: string | null;
  /** The installed package version, or `null` when the package is absent. */
  version: string | null;
  /** Human-readable reason when `path` is null (empty when resolved). */
  reason: string | null;
}

/** The every-surface-null surface set — used when there is no project root (the
 *  vertical slice tests, the raw extractor's direct-call API). */
export const EMPTY_VENDOR_SURFACES: VendorSurfaces = {
  kyselyQueryCreator: null,
  kyselySelectQueryBuilder: null,
  betterSqlite3Statement: null,
  betterSqlite3Database: null,
  nodeSqliteStatement: null,
  nodeSqliteDatabase: null,
  d1Database: null,
  d1PreparedStatement: null,
  resolutions: [],
};

/** The derived method sets the analyzer actually reads — the result of applying
 *  the documented selection judgment to the resolved surfaces. Threaded on the
 *  scan context so the loop-query / data-access discriminators read the resolved
 *  sets rather than the module-level constants they replaced. */
export interface DerivedVendorSets {
  eagerMethods: ReadonlySet<string>;
  ormTableVerbs: ReadonlySet<string>;
  ormJoinVerbs: ReadonlySet<string>;
}

/** Which vendor package publishes each declaration type, and which file (relative
 *  to the package root) declares it. `kysely` splits its builder interfaces
 *  across subpath files, so it has no single entry file — it is walked. */
interface VendorTypeSpec {
  pkg: string;
  /** Relative `.d.ts` that declares the type, or null to walk the package. */
  entry: string | null;
  types: readonly string[];
}

const VENDOR_TYPE_SPECS: readonly VendorTypeSpec[] = [
  { pkg: '@types/better-sqlite3', entry: 'index.d.ts', types: ['Database', 'Statement'] },
  { pkg: '@types/node', entry: 'sqlite.d.ts', types: ['DatabaseSync', 'StatementSync'] },
  { pkg: '@cloudflare/workers-types', entry: 'index.d.ts', types: ['D1Database', 'D1PreparedStatement'] },
  { pkg: 'kysely', entry: null, types: ['QueryCreator', 'SelectQueryBuilder'] },
];

/**
 * Resolve a package's directory under `projectRoot`'s `node_modules`, walking up
 * ancestor directories so a package hoisted to a workspace root still resolves.
 * Returns the package root, or `null` when the package is not installed anywhere
 * up the tree.
 */
function resolvePackageRoot(pkg: string, projectRoot: string): string | null {
  const segments = pkg.split('/');
  let dir = path.resolve(projectRoot);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...segments);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read a package's `version` field, or null when the package.json is absent or
 *  unparseable. */
function packageVersion(pkgRoot: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Recursively collect every `.d.ts` under `dir`, skipping nested `node_modules`. */
function walkDts(dir: string, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDts(p, out);
    else if (p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Find the `interface_declaration` / `class_declaration` /
 * `abstract_class_declaration` named `typeName` in a parsed `.d.ts`. The name is
 * the leading `type_identifier` child (tree-sitter renders a declaration name as
 * a type identifier for classes and interfaces alike).
 */
function findTypeDecl(root: ASTNode, typeName: string, sourceCode: string): ASTNode | null {
  const stack: ASTNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      node.type === 'interface_declaration' ||
      node.type === 'class_declaration' ||
      node.type === 'abstract_class_declaration'
    ) {
      const nameNode = node.children?.find((c) => c.type === 'type_identifier');
      if (nameNode && getNodeText(nameNode, sourceCode) === typeName) return node;
    }
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return null;
}

/**
 * Read the callable member-name surface of one declared type from a `.d.ts` file.
 * Method and property members both count — a vendor may declare `all(...)` as a
 * method or as a `(...args) => Result` property, and both are part of the callable
 * surface. Non-identifier members (`[Symbol.dispose]`, string-literal keys) are
 * dropped. Returns null when the file is unreadable, unparseable, or does not
 * declare the named type.
 */
function readTypeMemberSurface(dtsPath: string, typeName: string): ReadonlySet<string> | null {
  let content: string;
  try {
    content = readFileSync(dtsPath, 'utf8');
  } catch {
    return null;
  }
  const ast = parseFile(dtsPath, content);
  if (!ast) return null;
  const decl = findTypeDecl(ast.root, typeName, content);
  if (!decl) return null;
  const body = decl.children?.find((c) => c.type === 'interface_body' || c.type === 'class_body');
  if (!body) return new Set<string>();
  const members = new Set<string>();
  for (const m of body.children ?? []) {
    const t = m.type;
    if (
      t !== 'method_signature' &&
      t !== 'property_signature' &&
      t !== 'method_definition' &&
      t !== 'public_field_definition' &&
      t !== 'property_definition'
    ) {
      continue;
    }
    const nameNode = m.children?.find((c) => c.type === 'property_identifier');
    if (!nameNode) continue;
    const name = getNodeText(nameNode, content);
    if (name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) members.add(name);
  }
  return members;
}

/**
 * Resolve one (package, type) surface from the tree's `node_modules`. Reads the
 * named entry file when the spec names one; otherwise walks the package's shipped
 * `.d.ts` files for the declaration (kysely's builders are split across subpath
 * files, so its barrel index does not re-declare them). Returns a resolution
 * record plus the member set (or null).
 */
function resolveType(
  spec: VendorTypeSpec,
  type: string,
  projectRoot: string,
): { members: ReadonlySet<string> | null; resolution: VendorResolution } {
  const pkgRoot = resolvePackageRoot(spec.pkg, projectRoot);
  if (!pkgRoot) {
    return {
      members: null,
      resolution: {
        pkg: spec.pkg,
        type,
        path: null,
        version: null,
        reason: `package \`${spec.pkg}\` is not installed under ${path.join(path.resolve(projectRoot), 'node_modules')}`,
      },
    };
  }
  const version = packageVersion(pkgRoot);

  // Named entry first; if the type is not declared there, fall back to a walk.
  const candidates: string[] = [];
  if (spec.entry) candidates.push(path.join(pkgRoot, spec.entry));
  if (!spec.entry) walkDts(pkgRoot, candidates);

  for (const dts of candidates) {
    if (!existsSync(dts)) continue;
    const members = readTypeMemberSurface(dts, type);
    if (members !== null) {
      return {
        members,
        resolution: { pkg: spec.pkg, type, path: dts, version, reason: null },
      };
    }
  }

  // The entry (if named) may exist but not declare the type — walk as a fallback.
  if (spec.entry) {
    const walked: string[] = [];
    walkDts(pkgRoot, walked);
    for (const dts of walked) {
      const members = readTypeMemberSurface(dts, type);
      if (members !== null) {
        return {
          members,
          resolution: { pkg: spec.pkg, type, path: dts, version, reason: null },
        };
      }
    }
  }

  return {
    members: null,
    resolution: {
      pkg: spec.pkg,
      type,
      path: null,
      version,
      reason: `type \`${type}\` is not declared in the shipped \`${spec.pkg}\` declarations (${version ?? 'version unknown'})`,
    },
  };
}

/** The per-surface field names, in resolution order, keyed by the (pkg, type)
 *  pair they correspond to. */
const SURFACE_FIELDS: readonly {
  pkg: string;
  type: string;
  field: keyof Omit<VendorSurfaces, 'resolutions'>;
}[] = [
  { pkg: '@types/better-sqlite3', type: 'Database', field: 'betterSqlite3Database' },
  { pkg: '@types/better-sqlite3', type: 'Statement', field: 'betterSqlite3Statement' },
  { pkg: '@types/node', type: 'DatabaseSync', field: 'nodeSqliteDatabase' },
  { pkg: '@types/node', type: 'StatementSync', field: 'nodeSqliteStatement' },
  { pkg: '@cloudflare/workers-types', type: 'D1Database', field: 'd1Database' },
  { pkg: '@cloudflare/workers-types', type: 'D1PreparedStatement', field: 'd1PreparedStatement' },
  { pkg: 'kysely', type: 'QueryCreator', field: 'kyselyQueryCreator' },
  { pkg: 'kysely', type: 'SelectQueryBuilder', field: 'kyselySelectQueryBuilder' },
];

/**
 * Resolve every vendor surface from the tree under analysis. One pass per run;
 * nothing is cached across runs and nothing is fetched — a tree on a given
 * vendor version is judged by that version's own declarations.
 */
export function resolveVendorSurfaces(projectRoot: string): VendorSurfaces {
  const surfaces: Record<string, ReadonlySet<string> | null> = {};
  const resolutions: VendorResolution[] = [];
  for (const { pkg, type, field } of SURFACE_FIELDS) {
    const spec = VENDOR_TYPE_SPECS.find((s) => s.pkg === pkg && s.types.includes(type))!;
    const { members, resolution } = resolveType(spec, type, projectRoot);
    surfaces[field] = members;
    resolutions.push(resolution);
  }
  return {
    kyselyQueryCreator: surfaces.kyselyQueryCreator ?? null,
    kyselySelectQueryBuilder: surfaces.kyselySelectQueryBuilder ?? null,
    betterSqlite3Statement: surfaces.betterSqlite3Statement ?? null,
    betterSqlite3Database: surfaces.betterSqlite3Database ?? null,
    nodeSqliteStatement: surfaces.nodeSqliteStatement ?? null,
    nodeSqliteDatabase: surfaces.nodeSqliteDatabase ?? null,
    d1Database: surfaces.d1Database ?? null,
    d1PreparedStatement: surfaces.d1PreparedStatement ?? null,
    resolutions,
  };
}

/** Add every member of `names` that the surface publishes into `out`. */
function addIfPublished(
  surface: ReadonlySet<string> | null,
  names: readonly string[],
  out: Set<string>,
): void {
  if (!surface) return;
  for (const name of names) if (surface.has(name)) out.add(name);
}

/**
 * Derive the three method sets the analyzer reads, as the union of the analyzer's
 * irreducible cross-vendor grammar (the baseline, present regardless of what
 * resolves) and the per-run *probe* — the methods only a specific vendor publishes
 * that the baseline lacks. The probe is resolved from the analyzed tree; when a
 * vendor cannot be resolved, its probe methods are absent and the reason is
 * recorded on the resolution (`path: null`), which is the honest `unproven` state
 * — never a fallback list, never silence.
 *
 * The baseline is not a copy of any single vendor's declaration: it is the
 * analyzer's accumulated judgment of the generic SQL-driver/builder grammar, the
 * cross-vendor union no one vendor is the authority for (the same criterion that
 * keeps the nine irreducible lists). The probe supplies exactly what that grammar
 * misses and only a vendor publishes — `iterate` (better-sqlite3), `mergeInto` /
 * `replaceInto` and `fullJoin` / `*JoinLateral` (Kysely).
 */
export function deriveVendorSets(s: VendorSurfaces): DerivedVendorSets {
  // Irreducible baseline: the generic eager-I/O and builder-verb grammar.
  const eagerMethods = new Set<string>([
    'query', // generic driver abstraction (handle.query)
    'run', 'all', 'get', 'first', 'raw', 'exec', 'batch', // generic eager I/O
  ]);
  const ormTableVerbs = new Set<string>(['selectFrom', 'deleteFrom', 'insertInto', 'updateTable']);
  const ormJoinVerbs = new Set<string>(['join', 'leftJoin', 'rightJoin', 'innerJoin']);

  // Per-run probe additions — absent when the vendor is unresolvable (unproven).
  addIfPublished(s.betterSqlite3Statement, ['iterate'], eagerMethods);
  addIfPublished(s.kyselyQueryCreator, ['mergeInto', 'replaceInto'], ormTableVerbs);
  if (s.kyselySelectQueryBuilder) {
    for (const m of s.kyselySelectQueryBuilder) {
      if (m.endsWith('Join') || m.endsWith('JoinLateral')) ormJoinVerbs.add(m);
    }
  }

  return { eagerMethods, ormTableVerbs, ormJoinVerbs };
}
