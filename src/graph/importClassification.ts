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
 *                           `paths` pattern or begins with `@/`. A gap in this tool's
 *                           coverage of the project, not a defect in the project. Never
 *                           an edge until alias resolution exists (out of scope here).
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
 * Classify a single import specifier against the corpus file set.
 *
 * @param specifier   The raw specifier as written (quotes stripped), e.g. `react`,
 *                    `./types.js`, `@/components/Button`, `.blitz`, `./x.jsonl?raw`.
 * @param sourceFile  The absolute path of the file the specifier is written in.
 * @param corpusFiles The in-memory set of absolute paths in the corpus (the stage-1
 *                    discovery file list). Existence is checked against this set —
 *                    never `fs.existsSync`.
 * @param options     `virtualModules` (exact-match virtual list) and `aliasPatterns`
 *                    (tsconfig `paths` keys). Both default to empty; the caller
 *                    supplies them from config/tsconfig.
 */
export function classifyImportSpecifier(
  specifier: string,
  sourceFile: string,
  corpusFiles: ReadonlySet<string>,
  options: ClassifyOptions = {},
): ClassifiedSpecifier {
  const clean = stripQueryAndFragment(specifier);

  // 1. Bare (non-relative) specifier → package vs unresolved-alias.
  if (!clean.startsWith('.') && !clean.startsWith('/')) {
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

  // 4. Strip a JS extension so `./types.js` can resolve to `types.ts`.
  let stripped = base;
  for (const ext of JS_STRIP_EXTS) {
    if (base.endsWith(ext)) {
      stripped = base.slice(0, base.length - ext.length);
      break;
    }
  }

  // 5. Probe in order — first existing file in the corpus file set wins.
  const candidates: string[] = [base];
  for (const ext of PROBE_EXTS) candidates.push(stripped + ext);
  for (const ext of PROBE_EXTS) candidates.push(stripped + '/index' + ext);

  for (const candidate of candidates) {
    if (corpusFiles.has(candidate)) {
      return { classification: 'internal-resolved', resolvedPath: candidate };
    }
  }

  return { classification: 'internal-broken' };
}

// ── tsconfig alias reading ──────────────────────────────────────────────────

export interface TsconfigAliases {
  /** Keys of `compilerOptions.paths` (e.g. `['@/*', '~/*']`). */
  pathPatterns: string[];
  /** Raw `compilerOptions.baseUrl` string, if present (reported, not used to resolve). */
  baseUrl?: string;
  /** Whether a readable, parseable tsconfig.json existed at projectRoot. */
  hasTsconfig: boolean;
}

/**
 * Read `compilerOptions.paths` + `baseUrl` from the project's tsconfig.json for
 * pattern matching only. Behavior:
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
  if (visited.has(configPath)) return { pathPatterns: [], hasTsconfig: false };
  visited.add(configPath);

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return { pathPatterns: [], hasTsconfig: false };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return { pathPatterns: [], hasTsconfig: false };
  }

  let base: TsconfigAliases = { pathPatterns: [], hasTsconfig: false };
  if (typeof parsed.extends === 'string') {
    base = readTsconfigAt(path.resolve(path.dirname(configPath), parsed.extends), visited);
  }

  const co = parsed.compilerOptions ?? {};
  const baseUrl: string | undefined =
    typeof co.baseUrl === 'string' ? co.baseUrl : base.baseUrl;
  const pathPatterns: string[] =
    co.paths && typeof co.paths === 'object' && !Array.isArray(co.paths)
      ? Object.keys(co.paths)
      : base.pathPatterns;

  return { pathPatterns, baseUrl, hasTsconfig: true };
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
