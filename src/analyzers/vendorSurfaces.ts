/**
 * Vendor surface resolution — Item B (reissued).
 *
 * The data-access analyzer once hand-maintained five method-name lists
 * (`EAGER_DB_METHODS`, `ORM_TABLE_VERBS`, `ORM_JOIN_VERBS`, `PRISMA_VERBS`, and
 * `D1_CONVENIENCE`) plus the `COLLECTION_TRANSFORM_METHODS` runtime probe. A
 * hand-copied vendor list drifts: the vendor adds, renames, or removes a method
 * and the replica silently goes stale (the `.get()` gap, the deferred `.iterate()`,
 * the missing lateral joins, the missing `…AndReturn` verbs). The reissued
 * directive deletes the committed snapshot and resolves each vendor's declaration
 * **from the tree under analysis, per run** — the `node_modules` (or workspace)
 * path the tree's *own* imports resolve to, at the version that tree actually
 * installs. Nothing about a vendor's API is committed here, and nothing is fetched
 * from the network at analysis time.
 *
 * Three of the five vendor lists (`eagerMethods`, `ormTableVerbs`, `ormJoinVerbs`)
 * are the union of the analyzer's irreducible cross-vendor grammar (the baseline,
 * present regardless of what resolves) and the per-run probe — the methods only a
 * specific vendor publishes. Two (`prismaVerbs`, `eagerExecutionMethods`) are
 * resolved **entirely** from the tree, with no baseline. `COLLECTION_TRANSFORM_METHODS`
 * is a runtime probe over `Array.prototype` and has no vendor declaration. When a
 * vendor declaration cannot be resolved, the corresponding surface is `null` and
 * its probe methods are absent (not a fallback list, not a stale snapshot); the
 * resolution record carries the *reason* naming what could not be resolved, so a
 * site whose classification depends on a probe-only method is `unproven`, never
 * silent.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseFile, getNodeText } from '../languages/adapterBridge.js';
import type { ASTNode } from '../languages/types.js';

/**
 * The eleven vendor surfaces the analyzer derives its method sets from. Each is a
 * resolved member-name set, or `null` when the vendor's declaration could not be
 * resolved from the tree. The names are exactly the declaration *types* the seven
 * packages publish; the *selection* of which members are eager I/O / table verbs /
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
  /** The `Pool` declaration from `@types/pg` — `query` is its eager-execution member. */
  pgPool: ReadonlySet<string> | null;
  /** The `Connection` declaration from `mysql2` — `execute` is its eager-execution member. */
  mysql2Connection: ReadonlySet<string> | null;
  /** The union of generated `*Delegate` member names from `.prisma/client`, or null
   *  when the generated client is not present in the analyzed tree. */
  prismaVerbs: ReadonlySet<string> | null;
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
  pgPool: null,
  mysql2Connection: null,
  prismaVerbs: null,
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
  /** The Prisma model verbs derived from the generated `.prisma/client` `*Delegate`
   *  declarations, or null when the generated client is absent. No hand-kept
   *  fallback: an absent client means the Prisma object-form admitter cannot
   *  confirm a verb and the site is `unproven` (never a stale snapshot). */
  prismaVerbs: ReadonlySet<string> | null;
  /** The cross-driver eager-execution surface — the union of the resolved
   *  D1PreparedStatement / better-sqlite3 / node:sqlite statement+database
   *  surfaces plus `query` (pg) and `execute` (mysql2). Null when no driver
   *  resolves (the site is `unproven`), never a fallback list. */
  eagerExecutionMethods: ReadonlySet<string> | null;
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

// Package specifiers shared by VENDOR_TYPE_SPECS (what to probe) and SURFACE_FIELDS
// (the resolved field name per probe). Extracted so a rename lands in one place and
// the duplicate-string-literal rule stays quiet on the three driver package names.
const PKG_BETTER_SQLITE3_TYPES = '@types/better-sqlite3';
const PKG_NODE_TYPES = '@types/node';
const PKG_CLOUDFLARE_WORKERS_TYPES = '@cloudflare/workers-types';

// The Prisma probe's target type name, and the version fallback rendered when a
// package carries no resolvable version. Each repeats across every
// `resolvePrismaSurface` / `resolveType` return branch, so a single constant names it.
const PRISMA_DELEGATE_TYPE = '*Delegate';
const VERSION_UNKNOWN = 'version unknown';

const VENDOR_TYPE_SPECS: readonly VendorTypeSpec[] = [
  { pkg: PKG_BETTER_SQLITE3_TYPES, entry: 'index.d.ts', types: ['Database', 'Statement'] },
  { pkg: PKG_NODE_TYPES, entry: 'sqlite.d.ts', types: ['DatabaseSync', 'StatementSync'] },
  { pkg: PKG_CLOUDFLARE_WORKERS_TYPES, entry: 'index.d.ts', types: ['D1Database', 'D1PreparedStatement'] },
  { pkg: 'kysely', entry: null, types: ['QueryCreator', 'SelectQueryBuilder'] },
  // `@types/pg` and `mysql2` contribute only their single eager-execution member
  // (`query` / `execute` respectively) — a Pool/Connection surface is a *client*
  // surface (connect/end/on), not an eager-execution surface, so the whole
  // declaration is not unioned the way the statement/database surfaces are.
  { pkg: '@types/pg', entry: null, types: ['Pool'] },
  { pkg: 'mysql2', entry: null, types: ['Connection'] },
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
 * The declaration kinds a named type may take: interfaces and classes (with an
 * `interface_body`/`class_body`), plus type aliases (a `type_alias_declaration`
 * whose body is an `object_type` or an `intersection_type` of `object_type`s).
 * tree-sitter renders a declaration name as a leading `type_identifier` child
 * for all three.
 */
const TYPE_DECLARATION_KINDS = new Set([
  'interface_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'type_alias_declaration',
]);

/**
 * Find every `interface_declaration` / `class_declaration` /
 * `abstract_class_declaration` / `type_alias_declaration` named `typeName` in a
 * parsed `.d.ts`.
 *
 * A name is not unique in a real declaration file: `@types/better-sqlite3`
 * declares both `interface Statement` (the surface) and a *conditional*
 * `type Statement<…> = …` alias (a tuple-parameter helper), in the same
 * namespace. Returning the first match — whichever a depth-first walk reaches
 * first — would let the helper alias shadow the interface and read an empty
 * surface. Collect *all* matches and let the caller union their member surfaces.
 */
function findTypeDecls(root: ASTNode, typeName: string, sourceCode: string): ASTNode[] {
  const decls: ASTNode[] = [];
  const stack: ASTNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (TYPE_DECLARATION_KINDS.has(node.type)) {
      const nameNode = node.children?.find((c) => c.type === 'type_identifier');
      if (nameNode && getNodeText(nameNode, sourceCode) === typeName) decls.push(node);
    }
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return decls;
}

/** A member node of a type body: a callable method/property signature or
 *  definition. */
function isMemberNode(t: string): boolean {
  return (
    t === 'method_signature' ||
    t === 'property_signature' ||
    t === 'method_definition' ||
    t === 'public_field_definition' ||
    t === 'property_definition'
  );
}

/** Extract the identifier-name surface from a list of member nodes. Non-identifier
 *  members (`[Symbol.dispose]`, string-literal keys) are dropped. */
function collectCallableMembers(memberNodes: readonly ASTNode[], sourceCode: string): Set<string> {
  const members = new Set<string>();
  for (const m of memberNodes) {
    if (!isMemberNode(m.type)) continue;
    const nameNode = m.children?.find((c) => c.type === 'property_identifier');
    if (!nameNode) continue;
    const name = getNodeText(nameNode, sourceCode);
    if (name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) members.add(name);
  }
  return members;
}

/**
 * Read the member surface of a `type_alias_declaration` whose body is an
 * `object_type` or an `intersection_type` of `object_type`s — e.g.
 * `type X = { a(): void } & { b(): void }`. Only the top-level members of each
 * `object_type` are collected; a nested `object_type` inside a member's own type
 * annotation (an index signature's value type, a method's return type) is NOT
 * descended into — those are member *types*, not members of the alias.
 */
function readTypeAliasMembers(decl: ASTNode, sourceCode: string): Set<string> {
  const typeNode = decl.children?.find(
    (c) => c.type === 'intersection_type' || c.type === 'object_type',
  );
  if (!typeNode) return new Set<string>();
  const memberNodes: ASTNode[] = [];
  if (typeNode.type === 'object_type') {
    memberNodes.push(...(typeNode.children ?? []));
  } else if (typeNode.type === 'intersection_type') {
    for (const part of typeNode.children ?? []) {
      if (part.type === 'object_type') memberNodes.push(...(part.children ?? []));
      // A named-type reference (`type_identifier`) inside an intersection is a
      // cross-declaration alias this single-file reader does not chase — the
      // generated Prisma client never uses it for model delegates.
    }
  }
  return collectCallableMembers(memberNodes, sourceCode);
}

/**
 * Read the callable member-name surface of one declared type from a `.d.ts` file.
 * Method and property members both count — a vendor may declare `all(...)` as a
 * method or as a `(...args) => Result` property, and both are part of the callable
 * surface. Non-identifier members (`[Symbol.dispose]`, string-literal keys) are
 * dropped. Returns null when the file is unreadable, unparseable, or does not
 * declare the named type.
 *
 * When a name is declared more than once (an interface shadowed by a helper type
 * alias, as in `@types/better-sqlite3`'s `Statement`), the surface is the union of
 * every declaration's members — a conditional-type alias contributes none, so the
 * interface's surface wins rather than being masked by the helper.
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
  const decls = findTypeDecls(ast.root, typeName, content);
  if (decls.length === 0) return null;
  const members = new Set<string>();
  for (const decl of decls) {
    const body = decl.children?.find((c) => c.type === 'interface_body' || c.type === 'class_body');
    if (body) {
      for (const m of collectCallableMembers(body.children ?? [], content)) members.add(m);
    } else if (decl.type === 'type_alias_declaration') {
      for (const m of readTypeAliasMembers(decl, content)) members.add(m);
    }
  }
  return members;
}

/**
 * Enumerate every `*Delegate` declaration in a parsed generated Prisma client and
 * return the union of their callable member names — the model verb set. Prisma 6
 * generates one delegate *interface* per model (`export interface UserDelegate<…>`)
 * whose members are exactly the model verbs; the `[K: symbol]` index signature the
 * generator adds is not a callable member and is dropped. Returns null when no
 * `*Delegate` declaration is found (so an empty client is `unproven`, not an empty
 * verb set).
 */
function readDelegateUnion(root: ASTNode, sourceCode: string): ReadonlySet<string> | null {
  const verbs = new Set<string>();
  let found = false;
  const stack: ASTNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (TYPE_DECLARATION_KINDS.has(node.type)) {
      const nameNode = node.children?.find((c) => c.type === 'type_identifier');
      const name = nameNode ? getNodeText(nameNode, sourceCode) : null;
      if (name && /Delegate$/.test(name)) {
        found = true;
        const body = node.children?.find(
          (c) => c.type === 'interface_body' || c.type === 'class_body',
        );
        const members = body
          ? collectCallableMembers(body.children ?? [], sourceCode)
          : node.type === 'type_alias_declaration'
            ? readTypeAliasMembers(node, sourceCode)
            : new Set<string>();
        for (const m of members) verbs.add(m);
      }
    }
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return found ? verbs : null;
}

/**
 * Resolve the generated Prisma client's model verb set from the analyzed tree.
 *
 * Prisma generates its client into a dot-prefixed *virtual* package —
 * `node_modules/.prisma/client/index.d.ts` — re-exported by the `@prisma/client`
 * shim. The verbs live on the generated `*Delegate` declarations (one per model),
 * identical across models by construction, so the union of their member names is
 * exactly the verb set the repo's own schema generated. A tree without a generated
 * client (no `node_modules/.prisma/client`) is `unproven` with that reason — never
 * a committed snapshot, never a network fetch.
 */
function resolvePrismaSurface(projectRoot: string): {
  verbs: ReadonlySet<string> | null;
  resolution: VendorResolution;
} {
  const pkgRoot = resolvePackageRoot('.prisma/client', projectRoot);
  if (!pkgRoot) {
    return {
      verbs: null,
      resolution: {
        pkg: '.prisma/client',
        type: PRISMA_DELEGATE_TYPE,
        path: null,
        version: null,
        reason: `generated Prisma client \`.prisma/client\` is not present under ${path.join(path.resolve(projectRoot), 'node_modules')} (run \`prisma generate\` in the analyzed tree)`,
      },
    };
  }
  const version = packageVersion(pkgRoot);
  const indexDts = path.join(pkgRoot, 'index.d.ts');
  if (!existsSync(indexDts)) {
    return {
      verbs: null,
      resolution: {
        pkg: '.prisma/client',
        type: PRISMA_DELEGATE_TYPE,
        path: null,
        version,
        reason: `generated Prisma client has no index.d.ts (${version ?? VERSION_UNKNOWN})`,
      },
    };
  }
  let content: string;
  try {
    content = readFileSync(indexDts, 'utf8');
  } catch {
    return {
      verbs: null,
      resolution: {
        pkg: '.prisma/client',
        type: PRISMA_DELEGATE_TYPE,
        path: null,
        version,
        reason: `could not read ${indexDts}`,
      },
    };
  }
  const ast = parseFile(indexDts, content);
  if (!ast) {
    return {
      verbs: null,
      resolution: {
        pkg: '.prisma/client',
        type: PRISMA_DELEGATE_TYPE,
        path: null,
        version,
        reason: `could not parse ${indexDts}`,
      },
    };
  }
  const verbs = readDelegateUnion(ast.root, content);
  if (verbs === null) {
    return {
      verbs: null,
      resolution: {
        pkg: '.prisma/client',
        type: PRISMA_DELEGATE_TYPE,
        path: null,
        version,
        reason: `no \`*Delegate\` declaration found in the generated client (${version ?? VERSION_UNKNOWN})`,
      },
    };
  }
  return {
    verbs,
    resolution: { pkg: '.prisma/client', type: PRISMA_DELEGATE_TYPE, path: indexDts, version, reason: null },
  };
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
      reason: `type \`${type}\` is not declared in the shipped \`${spec.pkg}\` declarations (${version ?? VERSION_UNKNOWN})`,
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
  { pkg: PKG_BETTER_SQLITE3_TYPES, type: 'Database', field: 'betterSqlite3Database' },
  { pkg: PKG_BETTER_SQLITE3_TYPES, type: 'Statement', field: 'betterSqlite3Statement' },
  { pkg: PKG_NODE_TYPES, type: 'DatabaseSync', field: 'nodeSqliteDatabase' },
  { pkg: PKG_NODE_TYPES, type: 'StatementSync', field: 'nodeSqliteStatement' },
  { pkg: PKG_CLOUDFLARE_WORKERS_TYPES, type: 'D1Database', field: 'd1Database' },
  { pkg: PKG_CLOUDFLARE_WORKERS_TYPES, type: 'D1PreparedStatement', field: 'd1PreparedStatement' },
  { pkg: 'kysely', type: 'QueryCreator', field: 'kyselyQueryCreator' },
  { pkg: 'kysely', type: 'SelectQueryBuilder', field: 'kyselySelectQueryBuilder' },
  { pkg: '@types/pg', type: 'Pool', field: 'pgPool' },
  { pkg: 'mysql2', type: 'Connection', field: 'mysql2Connection' },
];

/**
 * Resolve every vendor surface from the tree under analysis. One pass per run;
 * nothing is cached across runs and nothing is fetched — a tree on a given
 * vendor version is judged by that version's own declarations.
 *
 * @param projectRoot - The root of the tree under analysis; its `node_modules`
 *   (walked upward to the workspace root) is where each vendor's declarations resolve.
 * @returns Every vendor surface, each either the resolved member set or `null`
 *   with a per-surface `resolution` record carrying the reason.
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
  // Prisma is resolved separately: it is not a single named declaration type but
  // the union of every generated `*Delegate` declaration in `.prisma/client`.
  const prisma = resolvePrismaSurface(projectRoot);
  surfaces.prismaVerbs = prisma.verbs;
  resolutions.push(prisma.resolution);
  return {
    kyselyQueryCreator: surfaces.kyselyQueryCreator ?? null,
    kyselySelectQueryBuilder: surfaces.kyselySelectQueryBuilder ?? null,
    betterSqlite3Statement: surfaces.betterSqlite3Statement ?? null,
    betterSqlite3Database: surfaces.betterSqlite3Database ?? null,
    nodeSqliteStatement: surfaces.nodeSqliteStatement ?? null,
    nodeSqliteDatabase: surfaces.nodeSqliteDatabase ?? null,
    d1Database: surfaces.d1Database ?? null,
    d1PreparedStatement: surfaces.d1PreparedStatement ?? null,
    pgPool: surfaces.pgPool ?? null,
    mysql2Connection: surfaces.mysql2Connection ?? null,
    prismaVerbs: surfaces.prismaVerbs ?? null,
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
 * Derive the method sets the analyzer reads. Three of them (`eagerMethods`,
 * `ormTableVerbs`, `ormJoinVerbs`) are the union of the analyzer's irreducible
 * cross-vendor grammar (the baseline, present regardless of what resolves) and the
 * per-run *probe* — the methods only a specific vendor publishes that the baseline
 * lacks. Two more are resolved *entirely* from the tree, with no baseline:
 *
 *   - `prismaVerbs` — the union of the generated `.prisma/client` `*Delegate`
 *     member names. No hand-kept fallback: where `.prisma/client` is not generated,
 *     the set is null and the site is `unproven` with that reason.
 *   - `eagerExecutionMethods` — the cross-driver eager-execution surface, the union
 *     of whichever driver surfaces resolve (D1PreparedStatement; better-sqlite3 and
 *     node:sqlite statement+database; `query` from pg; `execute` from mysql2).
 *     Null when no driver resolves, never a fallback list.
 *
 * The baseline is not a copy of any single vendor's declaration: it is the
 * analyzer's accumulated judgment of the generic SQL-driver/builder grammar, the
 * cross-vendor union no one vendor is the authority for (the same criterion that
 * keeps the seven irreducible lists). The probe supplies exactly what that grammar
 * misses and only a vendor publishes — `iterate` (better-sqlite3), `mergeInto` /
 * `replaceInto` and `fullJoin` / `*JoinLateral` (Kysely).
 *
 * @param s - The resolved vendor surfaces to derive the analyzer's method sets from.
 * @returns The derived method sets (`eagerMethods`, `ormTableVerbs`, `ormJoinVerbs`,
 *   `prismaVerbs`, `eagerExecutionMethods`) the data-access analyzer reads.
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

  // Eager-execution surface — the cross-driver union of resolved statement/database
  // surfaces, plus pg's `query` and mysql2's `execute`. Null when nothing resolves
  // (the site is `unproven`); a tree with only better-sqlite3 gets better-sqlite3's
  // methods and nothing else.
  const eagerExecutionMethods = new Set<string>();
  let anyEagerDriverResolved = false;
  const unionSurface = (surface: ReadonlySet<string> | null): void => {
    if (!surface) return;
    anyEagerDriverResolved = true;
    for (const m of surface) eagerExecutionMethods.add(m);
  };
  unionSurface(s.d1PreparedStatement);
  unionSurface(s.betterSqlite3Statement);
  unionSurface(s.betterSqlite3Database);
  unionSurface(s.nodeSqliteStatement);
  unionSurface(s.nodeSqliteDatabase);
  if (s.pgPool) {
    anyEagerDriverResolved = true;
    if (s.pgPool.has('query')) eagerExecutionMethods.add('query');
  }
  if (s.mysql2Connection) {
    anyEagerDriverResolved = true;
    if (s.mysql2Connection.has('execute')) eagerExecutionMethods.add('execute');
  }

  return {
    eagerMethods,
    ormTableVerbs,
    ormJoinVerbs,
    prismaVerbs: s.prismaVerbs,
    eagerExecutionMethods: anyEagerDriverResolved ? eagerExecutionMethods : null,
  };
}
