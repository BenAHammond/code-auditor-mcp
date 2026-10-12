/**
 * Spec 68 §8 — the corpus `reachability` processor.
 *
 * Re-homes `clIsTestFile` / `clIsEntryPointFile` / `clResolveImport` /
 * `clComputeReachability` (pipelineAdapters.ts) onto the `file-imports` fact.
 * Resolution goes through `classifyImportSpecifier` (relative paths, tsconfig
 * `paths` aliases, `baseUrl`), so an alias import creates a real edge and a
 * bare package import never fabricates a local one. The result is the reverse
 * import adjacency (`importersOf`) plus the package.json entry-point set — the
 * two corpus inputs `unreferenced-module` needs beyond the per-file
 * `hasExports` and the test/entry filename heuristics.
 *
 * `classifyImportSpecifier` / `DEFAULT_VIRTUAL_MODULES` are imported (they
 * survive §15); the walk bodies and filename heuristics below are re-homed.
 */

import { classifyImportSpecifier, DEFAULT_VIRTUAL_MODULES } from '../graph/importClassification.js';
import type { FileImportsFact, ReachabilityFact, UnprovenModule } from './types.js';

/**
 * True when the file path matches a test-file convention (`.test.`/`.spec.`/
 * `__tests__`/`/test/`/`/tests/`/`_test.go`).
 *
 * @param fp - The file path to classify.
 * @returns `true` when the path is a test file.
 */
export function isTestFile(fp: string): boolean {
  const lower = fp.toLowerCase();
  return lower.includes('.test.') || lower.includes('.spec.') ||
    lower.includes('__tests__') || lower.includes('/test/') || lower.includes('/tests/') ||
    lower.endsWith('_test.go');
}

// Files the framework loads directly rather than via an import from sibling
// code. Skipped when flagging unreferenced modules — a route/page/entry file
// that nothing imports is an entry point, not dead code.
const ENTRY_BASENAMES = new Set([
  'route', 'page', 'layout', 'loading', 'error', 'not-found', 'template', 'default',
  'middleware', 'instrumentation', 'server', 'client', 'cli', 'main', 'app', 'index', 'worker',
  'setup', 'seed', 'mcp',
]);

/**
 * True when the file is a framework-loaded entry point (route/page/CLI/config)
 * rather than a module imported by sibling code.
 *
 * @param fp - The file path to classify.
 * @returns `true` when the path matches an entry-point basename or directory.
 */
export function isEntryPointFile(fp: string): boolean {
  const segments = fp.replace(/\\/g, '/').split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  if (ENTRY_BASENAMES.has(stem)) return true;
  if (stem.endsWith('.config')) return true; // next.config, vite.config, tailwind.config, …
  const joined = '/' + segments.join('/') + '/';
  if (joined.includes('/app/api/') || joined.includes('/pages/api/')) return true;
  if (joined.includes('/scripts/') || joined.includes('/bin/') || joined.includes('/cmd/')) return true;
  return false;
}

/** The corpus inputs the reachability computation needs (mirrors ClReachabilityOptions). */
export interface ReachabilityOptions {
  /** Full corpus file set (unfiltered discovery list) for alias resolution. */
  corpusFiles: ReadonlySet<string>;
  /** Virtual-module specifiers (exact match). */
  virtualModules: readonly string[];
  /** tsconfig `paths` + `baseUrl` for `@/` alias resolution. */
  tsconfigAliases?: {
    pathPatterns?: readonly string[];
    paths?: Readonly<Record<string, readonly string[]>>;
    baseUrl?: string;
  };
  /** Absolute paths reachable only through package.json (entry points). */
  packageEntryPoints?: ReadonlySet<string>;
  /** Absolute project root. */
  projectRoot: string;
}

/** Resolve one import specifier to zero or one internal file via the classifier. */
function resolveImport(dep: string, sourceFile: string, options: ReachabilityOptions): string[] {
  const { classification, resolvedPath } = classifyImportSpecifier(dep, sourceFile, options.corpusFiles, {
    virtualModules: options.virtualModules,
    aliasPatterns: options.tsconfigAliases?.pathPatterns ?? [],
    pathMappings: options.tsconfigAliases?.paths ?? {},
    baseUrl: options.tsconfigAliases?.baseUrl,
    projectRoot: options.projectRoot,
  });
  if (classification === 'internal-resolved' && resolvedPath) return [resolvedPath];
  return [];
}

/**
 * Compute the reverse import adjacency from per-file imports. A file's forward
 * edges (`info.imports`) are resolved against the corpus; every resolved
 * internal target records its source as an importer. `packageEntryPoints` is
 * projected to a plain array so the fact stays serializable (§4).
 *
 * @param fileImports - The per-file import facts whose edges are reversed.
 * @param options - The corpus, alias, and entry-point resolution inputs.
 * @returns The reverse import adjacency and the package entry-point set.
 */
export function computeReachability(
  fileImports: readonly FileImportsFact[],
  options: ReachabilityOptions,
): ReachabilityFact {
  const packageEntries = options.packageEntryPoints ?? new Set<string>();

  const importersOf = new Map<string, Set<string>>();
  for (const info of fileImports) {
    for (const dep of info.imports) {
      const targets = resolveImport(dep, info.file, options);
      for (const t of targets) {
        if (t === info.file) continue;
        if (!importersOf.has(t)) importersOf.set(t, new Set());
        importersOf.get(t)!.add(info.file);
      }
    }
  }

  const plain: Record<string, string[]> = {};
  for (const [fp, importers] of importersOf) {
    plain[fp] = [...importers].sort();
  }
  return { importersOf: plain, packageEntryPoints: [...packageEntries] };
}

/** The reason `unreferenced-module` reports a module as `unproven` rather than dead. */
const UNPROVEN_REASON =
  'A computed specifier could not be resolved, so this module may be imported dynamically and is not provably dead code.';

/**
 * True when the corpus's import graph carries at least one computed-specifier
 * dynamic import (`import(someVar)` / `require(filepath)`). Such an import cannot
 * become a resolved edge, so its target is unknown — which makes the
 * "imported by nothing" conclusion unsound for *every* module. `unreferenced-module`
 * reads this flag to withhold a dead-code finding in that case.
 */
export function hasUnresolvedDynamicImports(fileImports: readonly FileImportsFact[]): boolean {
  return fileImports.some((f) => f.unresolvedDynamicImports.length > 0);
}

/**
 * The modules `unreferenced-module` reports `unproven` instead of dead: a module
 * with no resolved importer (and not a test/entry point) while the graph carries
 * an unresolved dynamic import. Empty when the graph has no computed-specifier
 * import — then the ordinary dead-code findings are sound and this disposition is
 * not needed. This is the coverage-diagnostic half of the split; the rule's
 * `analyze` reads {@link hasUnresolvedDynamicImports} to suppress the finding half.
 *
 * @param fileImports - The corpus's per-file import facts (each carries the file
 *   path, whether it has exports, and its unresolved dynamic imports).
 * @param reachability - The corpus import graph (package entry points plus the
 *   per-module resolved importer lists).
 * @returns The modules that cannot be proven dead, each carrying a file-level
 *   `unproven` disposition and the shared reason.
 */
export function computeUnprovenModules(
  fileImports: readonly FileImportsFact[],
  reachability: ReachabilityFact,
): UnprovenModule[] {
  if (!hasUnresolvedDynamicImports(fileImports)) return [];
  const entrySet = new Set(reachability.packageEntryPoints);
  const importersOf = reachability.importersOf;

  const out: UnprovenModule[] = [];
  for (const info of fileImports) {
    if (!info.hasExports) continue;
    if (isTestFile(info.file)) continue;
    if (isEntryPointFile(info.file) || entrySet.has(info.file)) continue;
    if ((importersOf[info.file]?.length ?? 0) > 0) continue;
    out.push({ file: info.file, line: 1, reason: UNPROVEN_REASON });
  }
  return out;
}
