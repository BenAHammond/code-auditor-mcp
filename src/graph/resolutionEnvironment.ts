/**
 * The project-resolution environment — a single constructor over a project root
 * that produces every root-derived input the import / symbol / SQL resolution
 * surfaces consume.
 *
 * Before this module, the same derivation was duplicated in two places with two
 * different shapes: `auditRunner.buildPipelineAnalyzerConfig` read tsconfig
 * aliases, package entry points, declared type packages, the SQL dialect, and the
 * virtual-module list inline into `_infra`, while each measurement script
 * re-derived a *subset* of the same environment (`detectDialect(projectRoot).dialect`,
 * sometimes `readDeclaredTypePackages`) ad hoc. A script that forgot a field
 * silently measured a thinner environment than the runner ships — the same
 * drift class the declared-input discipline exists to prevent. One constructor
 * closes it: every consumer names the same inputs, from the same root.
 *
 * The environment is entirely sync and parser-free — it reads `tsconfig.json`,
 * `package.json`, and `wrangler.toml` (for a D1 binding) from disk, none of
 * which need tree-sitter. Callers still run `initializeLanguages()` +
 * `initParsers()` + `discoverFiles()` themselves; those are language init and
 * file discovery, not resolution, and this module does not own them.
 */

import { normalizeDialect, type Dialect } from '../mcp-tools/discoveryQueries.js';
import { detectDialect } from '../languages/sql/dialectDetection.js';
import {
  readTsconfigAliases,
  readPackageEntryPoints,
  readDeclaredTypePackages,
  DEFAULT_VIRTUAL_MODULES,
  type TsconfigAliases,
} from './importClassification.js';

/** The complete project-resolution environment, derived from one project root. */
export interface ResolutionEnvironment {
  /** tsconfig `paths` + `baseUrl` for alias classification + resolution. */
  tsconfigAliases: TsconfigAliases;
  /** package.json entry points (facade-expanded), absolute. */
  packageEntryPoints: string[];
  /** The project's declared type packages (the ambient-type gate). */
  declaredTypePackages: ReadonlySet<string>;
  /** The corpus's named SQL dialect, or null when undetermined/ambiguous. */
  sqlDialect: Dialect | null;
  /** The named reason when `sqlDialect` is null (used in cannot-fire messages). */
  sqlDialectReason: string | null;
  /** Virtual-module specifiers (config, default `DEFAULT_VIRTUAL_MODULES`). */
  importVirtualModules: readonly string[];
}

/** Config-level overrides that layer over the root-derived resolution inputs. */
export interface ResolutionEnvironmentOptions {
  /** Explicit dialect config (`databaseType`); overrides manifest detection. */
  databaseType?: string;
  /** Virtual-module list override; defaults to `DEFAULT_VIRTUAL_MODULES`. */
  importVirtualModules?: readonly string[];
}

/**
 * Build the complete resolution environment for a project root.
 *
 * The dialect is the same honest gate as the runner: explicit `databaseType`
 * overrides detection, and an unsupported `databaseType` (or a manifest naming
 * zero / more than one dialect) yields a null dialect with a named reason —
 * never a guessed default. Absent/malformed manifests degrade exactly as their
 * individual readers document (empty aliases, empty entry points, empty declared
 * types, null dialect with a reason).
 *
 * @param projectRoot The absolute project root whose tsconfig/package/wrangler are read.
 * @param options     Optional config overrides (`databaseType`, `importVirtualModules`).
 * @returns The complete resolution environment.
 */
export function buildResolutionEnvironment(
  projectRoot: string,
  options: ResolutionEnvironmentOptions = {},
): ResolutionEnvironment {
  const detection = options.databaseType
    ? (() => {
        const explicit = normalizeDialect(options.databaseType);
        return explicit
          ? { dialect: explicit, reason: null as string | null }
          : { dialect: null as Dialect | null, reason: `dialect undetermined (unsupported databaseType '${options.databaseType}')` };
      })()
    : detectDialect(projectRoot);

  return {
    tsconfigAliases: readTsconfigAliases(projectRoot),
    packageEntryPoints: readPackageEntryPoints(projectRoot).entryPaths,
    declaredTypePackages: readDeclaredTypePackages(projectRoot),
    sqlDialect: detection.dialect,
    sqlDialectReason: detection.reason,
    importVirtualModules: options.importVirtualModules ?? DEFAULT_VIRTUAL_MODULES,
  };
}
