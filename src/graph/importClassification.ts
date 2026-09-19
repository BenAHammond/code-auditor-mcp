/**
 * Spec 60.1 — import specifier classification at emission (five classes).
 *
 * Supersedes Spec 60's three-class scheme. Every import specifier is exactly one of
 * five classes:
 *
 *   - `package`           — does not begin with `.` or `/`, does not match a tsconfig
 *                           `paths` pattern, and does not begin with `@/`. A complete
 *                           answer (Node builtin, npm package, scoped package); never
 *                           an edge.
 *   - `unresolved-alias`  — does not begin with `.` or `/`, and *does* match a tsconfig
 *                           `paths` pattern or begins with `@/`, but its target did not
 *                           resolve to a corpus file. A gap in the tool's coverage of the
 *                           project, not a defect in the project (never an edge).
 *   - `internal-resolved` — begins with `.` or `/`, and normalization finds exactly one
 *                           existing file in the corpus file set. Carries that path.
 *   - `internal-broken`   — begins with `.` or `/`, and normalization finds no existing
 *                           file. A real defect in the audited project.
 *   - `unresolved-virtual` — begins with `.` or `/`, and the specifier exactly matches a
 *                           configured virtual-module entry (e.g. Blitz's `.blitz`).
 *
 * This deliberately does NOT use `resolveDependency` (src/graph/importGraph.ts) — that
 * function's basename / path-segment fallback produced blitz tested=350 against a truth
 * of 39, and is exactly what this spec exists to replace. It reuses only `normalizePath`,
 * which the spec forbids reimplementing.
 */

import fs from 'node:fs';
import path from 'path';
import { normalizePath } from './importGraph.js';

export type SpecifierClassification =
  | 'package'
  | 'unresolved-alias'
  | 'internal-resolved'
  | 'internal-broken'
  | 'unresolved-virtual';

export interface ClassifiedSpecifier {
  classification: SpecifierClassification;
  /** Absolute path when `classification` is 'internal-resolved'; undefined otherwise. */
  resolvedPath?: string;
}

/** Options threaded in by the caller (pure-function inputs — no I/O here). */
export interface ClassifyOptions {
  /** Virtual-module specifiers matched exactly. Defaults to DEFAULT_VIRTUAL_MODULES. */
  virtualModules?: readonly string[];
  /** tsconfig `compilerOptions.paths` keys, used for pattern matching only. */
  aliasPatterns?: readonly string[];
  /** Full tsconfig `compilerOptions.paths` mapping (pattern → targets), used to
   *  resolve alias specifiers to files. */
  pathMappings?: Readonly<Record<string, readonly string[]>>;
  /** tsconfig `compilerOptions.baseUrl`, resolved against `projectRoot` when
   *  relative. Only meaningful alongside `pathMappings`. */
  baseUrl?: string;
  /** Absolute project root — the base `baseUrl` resolves against. */
  projectRoot?: string;
}

/**
 * Extensions stripped off the base path before probing — ESM TypeScript writes
 * `./types.js` for a file named `types.ts`, so exact resolution of the `.js` form
 * fails until the extension is removed.
 */
const JS_STRIP_EXTS = ['.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * Extensions probed in order. Declaration extensions are appended LAST so a `.ts`
 * beats a `.d.ts` at the same stem. `.d.ts` was missing from Spec 60's list, which
 * classified knex's `../types` (resolving to a `.d.ts`) as broken.
 */
const PROBE_EXTS = [
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.d.ts', '.d.mts', '.d.cts',
] as const;

/** Default virtual-module list. A project overrides via config (not code). */
export const DEFAULT_VIRTUAL_MODULES: readonly string[] = ['.blitz'];

/**
 * Strip a trailing `?query` and `#fragment` suffix. Done first, before the alias
 * check, the virtual check, and the `.js`→`.ts` strip — so `./x.jsonl?raw`
 * normalizes as `./x.jsonl` (Vite convention) and `./x.js#frag` still strips `.js`.
 */
function stripQueryAndFragment(specifier: string): string {
  const q = specifier.indexOf('?');
  const h = specifier.indexOf('#');
  let end = specifier.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return specifier.slice(0, end);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a tsconfig `paths` key pattern against a specifier. `*` matches any string
 * (including empty), matching tsconfig's documented semantics. Pattern matching only
 * — this never resolves the alias to a file.
 */
function matchesPathsPattern(specifier: string, pattern: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$');
  return re.test(specifier);
}

/**
 * Probe a resolved base path for an existing corpus file: exact, then JS
 * extension stripped + TypeScript probe extensions, then `/index` forms.
 * Returns the first existing file, or `undefined`.
 */
function probeResolvedPath(base: string, corpusFiles: ReadonlySet<string>): string | undefined {
  let stripped = base;
  for (const ext of JS_STRIP_EXTS) {
    if (base.endsWith(ext)) {
      stripped = base.slice(0, base.length - ext.length);
      break;
    }
  }
  const candidates: string[] = [base];
  for (const ext of PROBE_EXTS) candidates.push(stripped + ext);
  for (const ext of PROBE_EXTS) candidates.push(stripped + '/index' + ext);

  for (const candidate of candidates) {
    if (corpusFiles.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve a bare specifier through tsconfig `paths` mappings (alias resolution).
 *
 * For each mapping whose pattern matches the specifier, the `*` wildcard is
 * captured and substituted into each target pattern; the result is resolved
 * against `baseUrl` (relative to `projectRoot`) and probed against the corpus.
 * Returns the first existing file, or `undefined` when nothing resolves.
 *
 * tsconfig `paths` supports a single `*` per pattern; multiple stars are
 * unsupported here (they have no defined substitution order anyway).
 */
function resolveAliasTarget(
  specifier: string,
  options: ClassifyOptions,
  corpusFiles: ReadonlySet<string>,
): string | undefined {
  const mappings = options.pathMappings;
  const root = options.projectRoot;
  if (!mappings || !root) return undefined;

  for (const [pattern, targets] of Object.entries(mappings)) {
    let wildcard: string | null = null;
    const starIdx = pattern.indexOf('*');
    if (starIdx !== -1) {
      const prefix = pattern.slice(0, starIdx);
      const suffix = pattern.slice(starIdx + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
    } else if (specifier !== pattern) {
      continue;
    }

    for (const target of targets) {
      const substituted = wildcard === null ? target : target.split('*').join(wildcard);
      const base = normalizePath(path.resolve(root, options.baseUrl ?? '.', substituted));
      const resolved = probeResolvedPath(base, corpusFiles);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

/**
 * Classify a single import specifier against the corpus file set.
 *
 * @param specifier   The raw specifier as written (quotes stripped), e.g. `react`,
 *                    `./types.js`, `@/components/Button`, `.blitz`, `./x.jsonl?raw`.
 * @param sourceFile  The absolute path of the file the specifier is written in.
 * @param corpusFiles The in-memory set of absolute paths in the corpus (the stage-1
 *                    discovery file list). Existence is checked against this set —
 *                    never `fs.existsSync`.
 * @param options     `virtualModules` (exact-match virtual list), `aliasPatterns`
 *                    (tsconfig `paths` keys), `pathMappings` (full `paths` mapping),
 *                    and `baseUrl`/`projectRoot` (for alias + baseUrl-rooted bare
 *                    resolution). All default to empty; the caller supplies them
 *                    from config/tsconfig.
 */
export function classifyImportSpecifier(
  specifier: string,
  sourceFile: string,
  corpusFiles: ReadonlySet<string>,
  options: ClassifyOptions = {},
): ClassifiedSpecifier {
  const clean = stripQueryAndFragment(specifier);

  // 1. Bare (non-relative) specifier → alias resolution, then package vs alias.
  if (!clean.startsWith('.') && !clean.startsWith('/')) {
    // A tsconfig `paths` alias that resolves to a corpus file is a live internal
    // edge, not a coverage gap — resolve it before falling back to classification.
    const aliasTarget = resolveAliasTarget(clean, options, corpusFiles);
    if (aliasTarget) return { classification: 'internal-resolved', resolvedPath: aliasTarget };

    // A `baseUrl`-rooted bare import (classic node resolution with `baseUrl`):
    // `baseUrl + specifier` resolves a local file — e.g. hhra's `from "app/actions"`
    // with `baseUrl: "."`. Probe it before declaring `package`; a non-existent
    // target (e.g. `react`) simply misses and falls through to `package`.
    if (options.baseUrl && options.projectRoot) {
      const baseUrlTarget = probeResolvedPath(
        normalizePath(path.resolve(options.projectRoot, options.baseUrl, clean)),
        corpusFiles,
      );
      if (baseUrlTarget) return { classification: 'internal-resolved', resolvedPath: baseUrlTarget };
    }

    if (clean.startsWith('@/')) return { classification: 'unresolved-alias' };
    for (const pattern of options.aliasPatterns ?? []) {
      if (matchesPathsPattern(clean, pattern)) {
        return { classification: 'unresolved-alias' };
      }
    }
    return { classification: 'package' };
  }

  // 2. Relative/absolute specifier that exactly matches a virtual-module entry.
  //    Defaults to DEFAULT_VIRTUAL_MODULES (['.blitz']); the caller overrides it
  //    from config.
  if ((options.virtualModules ?? DEFAULT_VIRTUAL_MODULES).includes(clean)) {
    return { classification: 'unresolved-virtual' };
  }

  // 3. base = normalize(join(dirname(sourceFile), clean)). `path.join` resolves
  //    `.`/`..`; `normalizePath` converts backslashes and preserves a leading slash.
  const base = normalizePath(path.join(path.dirname(sourceFile), clean));

  // 4-5. Probe in order — first existing file in the corpus file set wins.
  const resolved = probeResolvedPath(base, corpusFiles);
  if (resolved) return { classification: 'internal-resolved', resolvedPath: resolved };

  return { classification: 'internal-broken' };
}

// ── tsconfig alias reading ──────────────────────────────────────────────────

export interface TsconfigAliases {
  /** Keys of `compilerOptions.paths` (e.g. `['@/*', '~/*']`). */
  pathPatterns: string[];
  /** Raw `compilerOptions.baseUrl` string, if present. */
  baseUrl?: string;
  /** Whether a readable, parseable tsconfig.json existed at projectRoot. */
  hasTsconfig: boolean;
  /** Full `compilerOptions.paths` mapping: pattern → target patterns. */
  paths: Record<string, string[]>;
}

/**
 * Read `compilerOptions.paths` + `baseUrl` from the project's tsconfig.json for
 * alias classification and resolution. Behavior:
 *   - absent — returns `{ hasTsconfig: false, pathPatterns: [] }` (a project with no
 *     tsconfig still classifies `@/`-prefixed specifiers as alias, independent of this).
 *   - malformed (JSON parse fails, or comments the stripper can't recover from) —
 *     same as absent.
 *   - `extends` — the extended config is read first (relative to the extending file),
 *     then this config's `paths`/`baseUrl` override it. A cycle or a non-relative
 *     (package-name) extends that can't be read yields the base as empty.
 */
export function readTsconfigAliases(projectRoot: string): TsconfigAliases {
  const visited = new Set<string>();
  return readTsconfigAt(path.resolve(projectRoot, 'tsconfig.json'), visited);
}

function readTsconfigAt(configPath: string, visited: Set<string>): TsconfigAliases {
  if (visited.has(configPath)) return { pathPatterns: [], hasTsconfig: false, paths: {} };
  visited.add(configPath);

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return { pathPatterns: [], hasTsconfig: false, paths: {} };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return { pathPatterns: [], hasTsconfig: false, paths: {} };
  }

  let base: TsconfigAliases = { pathPatterns: [], hasTsconfig: false, paths: {} };
  if (typeof parsed.extends === 'string') {
    base = readTsconfigAt(path.resolve(path.dirname(configPath), parsed.extends), visited);
  }

  const co = parsed.compilerOptions ?? {};
  const baseUrl: string | undefined =
    typeof co.baseUrl === 'string' ? co.baseUrl : base.baseUrl;
  const paths: Record<string, string[]> =
    co.paths && typeof co.paths === 'object' && !Array.isArray(co.paths)
      ? (co.paths as Record<string, string[]>)
      : base.paths;
  const pathPatterns: string[] = Object.keys(paths);

  return { pathPatterns, baseUrl, paths, hasTsconfig: true };
}

/** Strip `//` and `/* *‍/` comments, respecting double-quoted strings (JSON). */
function stripJsonComments(text: string): string {
  if (!text) return text;
  let out = '';
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < n) { out += next; i += 2; continue; }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ── package.json entry-point reading ─────────────────────────────────────────

export interface PackageEntryPoints {
  /** Absolute paths of declared entry points plus their sibling facades. */
  entryPaths: string[];
  /** Whether a readable, parseable package.json existed at projectRoot. */
  hasPackageJson: boolean;
}

/**
 * Facade extensions in stem-stripping order. Declaration extensions (`.d.mts`,
 * `.d.cts`, `.d.ts`) come first so `knex.d.mts` strips its stem to `knex`
 * rather than `knex.d`; the code extensions follow. This is the module-format
 * set a published package ships its entry in — and the `.mjs` / `.d.mts` /
 * `.cjs` siblings of `main` are exactly the files `unreferenced-module` flags
 * dead (knex's `knex.mjs` / `knex.d.mts` beside `main: knex.js`), because no
 * in-tree import ever reaches them.
 */
const FACADE_EXTS = [
  '.d.mts', '.d.cts', '.d.ts',
  '.mts', '.cts', '.tsx',
  '.mjs', '.cjs', '.jsx', '.js', '.ts',
] as const;

function stripFacadeExt(p: string): string {
  for (const ext of FACADE_EXTS) {
    if (p.endsWith(ext)) return p.slice(0, p.length - ext.length);
  }
  return p;
}

/**
 * Collect relative subpath targets (`./dist/x.js`) from an `exports` field.
 * `exports` is a nested structure of condition keys (`import`, `require`,
 * `node`, `types`, `default`, …) over string targets, fallback arrays, or
 * nested objects. Only string leaves are local files; a non-relative leaf
 * (a package name or bare pattern) is not.
 */
function collectExportsTargets(exports: unknown, out: string[]): void {
  if (typeof exports === 'string') {
    if (exports.startsWith('./')) out.push(exports);
    return;
  }
  if (Array.isArray(exports)) {
    for (const e of exports) collectExportsTargets(e, out);
    return;
  }
  if (exports && typeof exports === 'object') {
    for (const v of Object.values(exports as Record<string, unknown>)) {
      collectExportsTargets(v, out);
    }
  }
}

/**
 * Pure: expand declared entry paths (package.json `main`/`module`/`types`/
 * `bin`/`exports` targets) into their absolute paths plus every sibling facade.
 * `main: knex.js` expands to `knex.js`, `knex.mjs`, `knex.cjs`, `knex.d.mts`,
 * … so the ESM/types facades that no in-tree import reaches are still counted
 * as live. Each declared path is resolved against `projectRoot`; `./`-prefixed
 * and extensionless entries resolve the same way.
 */
export function expandEntryPointFacades(
  declared: readonly string[],
  projectRoot: string,
): Set<string> {
  const entryPaths = new Set<string>();
  for (const d of declared) {
    const resolved = normalizePath(path.resolve(projectRoot, d));
    entryPaths.add(resolved);
    const stem = stripFacadeExt(resolved);
    for (const ext of FACADE_EXTS) entryPaths.add(stem + ext);
  }
  return entryPaths;
}

/**
 * Read a package's declared entry points from package.json and expand each into
 * its sibling facades. A file reachable only through the package manifest is an
 * entry point, not dead code — the filename heuristic (`clIsEntryPointFile`)
 * covers `app`/`route`/`page`/`index` but not `knex.mjs` / `knex.d.mts`, so a
 * published library's facades were being flagged `unreferenced-module`.
 *
 * Malformed or absent package.json yields an empty set (same failure mode as
 * `readTsconfigAliases`).
 */
export function readPackageEntryPoints(projectRoot: string): PackageEntryPoints {
  let raw: string;
  try {
    raw = fs.readFileSync(path.resolve(projectRoot, 'package.json'), 'utf-8');
  } catch {
    return { entryPaths: [], hasPackageJson: false };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return { entryPaths: [], hasPackageJson: false };
  }

  const declared: string[] = [];
  for (const key of ['main', 'module', 'types', 'typings']) {
    const v = parsed[key];
    if (typeof v === 'string') declared.push(v);
  }
  const bin = parsed.bin;
  if (typeof bin === 'string') declared.push(bin);
  else if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    for (const v of Object.values(bin as Record<string, unknown>)) {
      if (typeof v === 'string') declared.push(v);
    }
  }
  collectExportsTargets(parsed.exports, declared);

  return { entryPaths: [...expandEntryPointFacades(declared, projectRoot)], hasPackageJson: true };
}
