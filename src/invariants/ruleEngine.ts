/**
 * Invariant Rules Engine — checks files and call graph against user-defined rules.
 *
 * Rule kinds:
 *   import-ban       — no file may import a banned module (except exempt files)
 *   call-constraint   — restrict which files may call a given function
 *   module-boundary   — files in `from` may not import from `to`
 *   naming            — exported symbols must match a regex
 *   ast-pattern       — AST node pattern matching via @ast-grep/napi
 *   style-mechanism   — enforce allowed style mechanisms per file
 *   no-raw-values     — enforce design-token references for specified CSS properties
 */

import picomatch from 'picomatch';
import path from 'path';
import sg from '@ast-grep/napi';
import type { IndexHandle } from '../types.js';
import type {
  InvariantRule,
  ImportBanRule,
  CallConstraintRule,
  ModuleBoundaryRule,
  NamingRule,
  AstPatternRule,
  StyleMechanismRule,
  NoRawValuesRule,
  RuleViolation,
  RuleCheckResult,
} from './types.js';
import { hasRules } from './ruleValidator.js';

export type { InvariantRule, RuleViolation, RuleCheckResult } from './types.js';
export { hasRules } from './ruleValidator.js';

// ── Globbing helpers ──────────────────────────────────────────────────────

/** Chunked IN-clause bound (SQLite max host params, conservative). */
const SQLITE_MAX_VARIABLES = 900;

/** Cache compiled matchers keyed by pattern */
const matcherCache = new Map<string, ReturnType<typeof picomatch>>();

function matchesPattern(pattern: string, path: string): boolean {
  let m = matcherCache.get(pattern);
  if (!m) {
    m = picomatch(pattern, { dot: true });
    matcherCache.set(pattern, m);
  }
  return m(path);
}

function matchesAny(patterns: string[], path: string): boolean {
  return patterns.some(p => matchesPattern(p, path));
}

function matchesNone(patterns: string[], path: string): boolean {
  return !matchesAny(patterns, path);
}

// ── File-level import extraction ──────────────────────────────────────────

export interface FileImport {
  /** The module specifier (e.g. "lodash", "./foo", "@scope/pkg") */
  moduleSpecifier: string;
  /** Whether this is a static import */
  isStatic: boolean;
  /** Whether this is a dynamic import() */
  isDynamic: boolean;
  /** Whether this is a require() call */
  isRequire: boolean;
  /** Source line number */
  line: number;
}


// ── import-ban checker ────────────────────────────────────────────────────

function checkImportBan(
  rule: ImportBanRule,
  filePath: string,
  imports: FileImport[]
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  // If the file is in the except list, skip
  if (rule.except && matchesAny(rule.except, filePath)) {
    return violations;
  }

  for (const imp of imports) {
    if (matchesPattern(rule.module, imp.moduleSpecifier)) {
      violations.push({
        ruleId: rule.id,
        kind: 'import-ban',
        severity: rule.severity,
        message: rule.message || `Import of banned module "${imp.moduleSpecifier}"`,
        file: filePath,
        line: imp.line,
        importSpecifier: imp.moduleSpecifier,
      });
    }
  }

  return violations;
}

// ── module-boundary checker ───────────────────────────────────────────────

function checkModuleBoundary(
  rule: ModuleBoundaryRule,
  filePath: string,
  imports: FileImport[],
  resolveImportPath: (fromFile: string, specifier: string) => string | null
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  // Only check files matching `from`
  if (!matchesPattern(rule.from, filePath)) {
    return violations;
  }

  for (const imp of imports) {
    // Only check relative imports (inter-module) and internal absolute imports
    const resolved = resolveImportPath(filePath, imp.moduleSpecifier);
    if (resolved && matchesPattern(rule.to, resolved)) {
      violations.push({
        ruleId: rule.id,
        kind: 'module-boundary',
        severity: rule.severity,
        message: rule.message ||
          `File "${filePath}" imports "${imp.moduleSpecifier}" which matches forbidden boundary "${rule.to}"`,
        file: filePath,
        line: imp.line,
        importSpecifier: imp.moduleSpecifier,
      });
    }
  }

  return violations;
}

// ── Resolve import paths ──────────────────────────────────────────────────

/**
 * Resolve a relative import specifier to an absolute repo-relative path.
 * Returns null if the specifier is an external package (node_modules).
 */
function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  // External package — not a boundary concern
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null;
  }

  // Normalize: resolve relative to the importing file's directory
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const parts = (fromDir ? fromDir + '/' : '') + specifier;
  const segments = parts.split('/');
  const resolved: string[] = [];

  for (const seg of segments) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(seg);
  }

  // Add common extensions if none present
  const result = resolved.join('/');
  if (!result.match(/\.(ts|tsx|js|jsx|mjs|cjs)$/)) {
    return null; // caller should try with extensions
  }

  return result;
}

/**
 * Try to resolve an import specifier to a file path, trying common extensions.
 */
function resolveImportPath(fromFile: string, specifier: string, projectDir?: string, knownFiles?: Set<string>): string | null {
  const fileExists = (p: string): boolean => knownFiles ? knownFiles.has(p) : false;

  const base = resolveRelativeImport(fromFile, specifier);
  if (base) {
    // Check with full path
    const full = projectDir ? `${projectDir}/${base}` : base;
    if (fileExists(full)) return base;
    return null;
  }

  // Try adding extensions
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const parts = (fromDir ? fromDir + '/' : '') + specifier;
  const segments = parts.split('/');
  const resolved: string[] = [];

  for (const seg of segments) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(seg);
  }

  const basePath = resolved.join('/');
  const prefix = projectDir ? `${projectDir}/` : '';

  // Check extensions
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = prefix + basePath + ext;
    if (fileExists(candidate)) return basePath + ext;
  }

  // Try index files
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = prefix + basePath + '/index' + ext;
    if (fileExists(candidate)) return basePath + '/index' + ext;
  }

  return null;
}

// ── call-constraint checker ──────────────────────────────────────────────

function checkCallConstraint(
  rule: CallConstraintRule,
  scopedCallers: Array<{ filePath: string; callerName: string; calleeName: string }>
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  // Parse callee: 'path/glob#name' or just 'name'
  const calleeParts = parseCallee(rule.callee);
  const calleeGlob = calleeParts.pathGlob;
  const calleeName = calleeParts.functionName;

  // Filter callers that target this callee
  const matchingCallers = scopedCallers.filter(c => {
    if (calleeName && c.calleeName !== calleeName) return false;
    if (calleeGlob && !matchesPattern(calleeGlob, c.filePath)) return false;
    return true;
  });

  if (matchingCallers.length === 0) return violations;

  if (rule.allowFrom) {
    // Only allowFrom files may call — all others are violations
    for (const call of matchingCallers) {
      if (matchesNone(rule.allowFrom, call.filePath)) {
        violations.push({
          ruleId: rule.id,
          kind: 'call-constraint',
          severity: rule.severity,
          message: rule.message ||
            `Caller "${call.callerName}" in "${call.filePath}" is not in the allow-list for callee "${call.calleeName}"`,
          file: call.filePath,
          symbol: call.callerName,
          callee: call.calleeName,
          caller: call.callerName,
        });
      }
    }
  } else if (rule.denyFrom) {
    // denyFrom files may NOT call — any match is a violation
    for (const call of matchingCallers) {
      if (matchesAny(rule.denyFrom, call.filePath)) {
        violations.push({
          ruleId: rule.id,
          kind: 'call-constraint',
          severity: rule.severity,
          message: rule.message ||
            `Caller "${call.callerName}" in "${call.filePath}" is denied from calling "${call.calleeName}"`,
          file: call.filePath,
          symbol: call.callerName,
          callee: call.calleeName,
          caller: call.callerName,
        });
      }
    }
  }

  return violations;
}

interface CalleeParts {
  pathGlob: string | null;
  functionName: string;
}

function parseCallee(callee: string): CalleeParts {
  const hashIdx = callee.lastIndexOf('#');
  if (hashIdx >= 0) {
    return {
      pathGlob: callee.substring(0, hashIdx) || null,
      functionName: callee.substring(hashIdx + 1),
    };
  }
  return { pathGlob: null, functionName: callee };
}

// ── naming checker ────────────────────────────────────────────────────────

function checkNaming(
  rule: NamingRule,
  filePath: string,
  exportedSymbols: Array<{ name: string; line: number }>
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  if (!matchesPattern(rule.path, filePath)) {
    return violations;
  }

  let regex: RegExp;
  try {
    regex = new RegExp(rule.exports);
  } catch {
    return violations; // invalid regex should have been caught by validation
  }

  for (const sym of exportedSymbols) {
    // Non-Latin identifiers are unclassifiable by Latin casing conventions — skip
    if (/[^\p{Script=Latin}\p{N}_$]/u.test(sym.name)) {
      continue;
    }
    if (!regex.test(sym.name)) {
      violations.push({
        ruleId: rule.id,
        kind: 'naming',
        severity: rule.severity,
        message: rule.message ||
          `Exported symbol "${sym.name}" does not match naming convention "${rule.exports}"`,
        file: filePath,
        line: sym.line,
        symbol: sym.name,
      });
    }
  }

  return violations;
}

// ── ast-pattern checker ────────────────────────────────────────────────────

/**
 * Map rule language to ast-grep language key.
 * 'typescript' → 'tsx' (handles both .ts and .tsx)
 * 'javascript' → 'javascript'
 * 'go' → unsupported in @ast-grep/napi, but kept in the type for the schema
 */
function astGrepLanguage(lang: string): string {
  switch (lang) {
    case 'typescript': return 'tsx';
    case 'javascript': return 'javascript';
    case 'go': return 'go';
    default: return 'tsx';
  }
}

function checkAstPattern(
  rule: AstPatternRule,
  filePath: string,
  source: string
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  // Check path glob filter
  if (rule.path && !matchesPattern(rule.path, filePath)) {
    return violations;
  }

  const lang = astGrepLanguage(rule.language || 'typescript');
  let root: ReturnType<typeof sg.parse>;
  try {
    root = sg.parse(lang, source);
  } catch {
    // Unsupported language or parse error — skip this file
    return violations;
  }

  const rootNode = root.root();
  const matches = rootNode.findAll(rule.pattern);

  for (const match of matches) {
    const range = match.range();
    violations.push({
      ruleId: rule.id,
      kind: 'ast-pattern',
      severity: rule.severity,
      message: rule.message || `AST pattern matched: "${match.text()}"`,
      file: filePath,
      line: range.start.line + 1,   // ast-grep lines are 0-based
      column: range.start.column + 1, // ast-grep columns are 0-based
      symbol: String(match.kind()),
    });
  }

  return violations;
}

// ── style-mechanism checker ────────────────────────────────────────────────

/**
 * Enforce that style declarations in matching files only use allowed mechanisms.
 * Queries the style_declarations table in the CodeIndexDB.
 */
function checkStyleMechanism(
  rule: StyleMechanismRule,
  files: string[],
  indexHandle: IndexHandle
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  const allowedSet = new Set(rule.allow);

  for (const file of files) {
    // Check path filter
    if (rule.path && !matchesPattern(rule.path, file)) continue;

    try {
      const rows = indexHandle.query(`
        SELECT DISTINCT mechanism, file_path, line
        FROM style_declarations
        WHERE file_path = ?
        ORDER BY line
      `, [file]) as Array<{ mechanism: string; file_path: string; line: number }>;

      for (const row of rows) {
        if (!allowedSet.has(row.mechanism)) {
          violations.push({
            ruleId: rule.id,
            kind: 'style-mechanism',
            severity: rule.severity,
            message: rule.message ||
              `Style mechanism "${row.mechanism}" is not allowed (allowed: ${rule.allow.join(', ')})`,
            file: row.file_path,
            line: row.line,
          });
          // One violation per mechanism per file is sufficient
          break;
        }
      }
    } catch {
      // Table may not exist yet (no style index built)
      continue;
    }
  }

  return violations;
}

// ── no-raw-values checker ──────────────────────────────────────────────────

/**
 * Enforce that designated CSS properties reference a design token.
 * A declaration whose normalized_value is not in allowValues AND has no
 * token_ref is a violation.
 */
function checkNoRawValues(
  rule: NoRawValuesRule,
  files: string[],
  indexHandle: IndexHandle
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  const propertiesSet = new Set(rule.properties);
  const allowValuesSet = new Set(rule.allowValues ?? []);

  for (const file of files) {
    // Check path filter
    if (rule.path && !matchesPattern(rule.path, file)) continue;

    try {
      const rows = indexHandle.query(`
        SELECT property, raw_value, normalized_value, file_path, line
        FROM style_declarations
        WHERE file_path = ?
        ORDER BY line
      `, [file]) as Array<{
        property: string;
        raw_value: string;
        normalized_value: string | null;
        file_path: string;
        line: number;
      }>;

      for (const row of rows) {
        if (!propertiesSet.has(row.property)) continue;

        const normVal = row.normalized_value ?? row.raw_value;
        if (allowValuesSet.has(normVal) || allowValuesSet.has(row.raw_value)) continue;

        // Check if this declaration has a token ref
        const tokenRows = indexHandle.query(`
          SELECT token_ref FROM style_declarations
          WHERE file_path = ? AND line = ? AND property = ? AND token_ref IS NOT NULL
          LIMIT 1
        `, [row.file_path, row.line, row.property]) as Array<{ token_ref: string }>;
        const tokenRow = tokenRows[0];

        if (tokenRow) continue; // has a token ref — allowed

        violations.push({
          ruleId: rule.id,
          kind: 'no-raw-values',
          severity: rule.severity,
          message: rule.message ||
            `CSS property "${row.property}" has raw value "${row.raw_value}" — use a design token`,
          file: row.file_path,
          line: row.line,
          symbol: row.property,
        });
      }
    } catch {
      // Table may not exist yet (no style index built)
      continue;
    }
  }

  return violations;
}

// ── Exported symbol extraction ────────────────────────────────────────────


// ── Main rule checking ────────────────────────────────────────────────────

export interface RuleEngineOptions {
  /** The invariant rules to enforce */
  rules: InvariantRule[];
  /** Files to check (repo-relative paths) */
  files: string[];
  /** IndexHandle for call-graph and style lookups (pipeline DB handle). */
  indexHandle?: IndexHandle;
  /** Base project directory for resolving absolute paths */
  projectDir: string;
  /**
   * Optional on-demand reader of absolute file path → source text.
   * When provided, ast-pattern uses this instead of calling readFileSync.
   */
  readSource?: (filePath: string) => string | undefined;
  /**
   * Optional set of known absolute file paths (for existence checks).
   * When provided, resolveImportPath checks membership here instead of
   * calling readFileSync as a file-existence probe.
   */
  knownFiles?: Set<string>;
  /**
   * Pre-extracted file data from AST (replaces regex extractImports/extractExportedSymbols).
   * Keys are repo-relative file paths. When provided, regex extraction is skipped.
   */
  fileData?: Map<string, { imports: FileImport[]; exports: Array<{ name: string; line: number }> }>;
  /**
   * True when this is a diff-scoped audit (`code-audit changed`). When set, the
   * in-scope file set is pushed into the call-graph query as a `file_path IN (...)`
   * clause instead of a JS post-filter (which would still be a no-op over the full
   * corpus on a full audit). When unset, `files` is the full discovered list and
   * the query is not restricted.
   */
  isScoped?: boolean;
}

/**
 * Check all rules against all specified files.
 * import-ban, module-boundary, and naming are per-file.
 * call-constraint queries the full index for callers.
 */
export function checkRules(options: RuleEngineOptions): RuleCheckResult {
  const { rules, files, indexHandle, projectDir, readSource, knownFiles, fileData: preExtractedFileData, isScoped } = options;
  const violations: RuleViolation[] = [];
  const errors: string[] = [];

  if (rules.length === 0) {
    return { rules, violations, errors };
  }

  // Group rules by kind for efficient checking
  const importBans = rules.filter(r => r.kind === 'import-ban') as ImportBanRule[];
  const callConstraints = rules.filter(r => r.kind === 'call-constraint') as CallConstraintRule[];
  const moduleBoundaries = rules.filter(r => r.kind === 'module-boundary') as ModuleBoundaryRule[];
  const namingRules = rules.filter(r => r.kind === 'naming') as NamingRule[];
  const astPatterns = rules.filter(r => r.kind === 'ast-pattern') as AstPatternRule[];
  const styleMechanisms = rules.filter(r => r.kind === 'style-mechanism') as StyleMechanismRule[];
  const noRawValues = rules.filter(r => r.kind === 'no-raw-values') as NoRawValuesRule[];

  // Pre-extract imports and exports for all files
  interface FileData {
    imports: FileImport[];
    exports: Array<{ name: string; line: number }>;
  }

  const fileDataMap = new Map<string, FileData>();

  // Adjust file paths to be relative to project dir for reading
  for (const file of files) {
    // Strip any leading './' for consistency
    let normalized = file.replace(/^\.\//, '');

    // Make absolute paths relative to projectDir so glob patterns match
    if (path.isAbsolute(normalized)) {
      normalized = path.relative(projectDir, normalized);
    }

    if (preExtractedFileData) {
      // Use pre-extracted data from AST (B1: replaces regex extraction)
      const data = preExtractedFileData.get(normalized);
      if (data) {
        fileDataMap.set(normalized, data);
      }
    } else {
      // fileData is required (provided by the pipeline via function-index AST extraction).
      // Standalone callers must populate fileData from AST before calling checkRules.
      errors.push(`No fileData provided for ${file}. File data must be extracted from AST (not raw source).`);
    }
  }

  // 1. import-ban checks
  for (const rule of importBans) {
    for (const [filePath, data] of fileDataMap) {
      violations.push(...checkImportBan(rule, filePath, data.imports));
    }
  }

  // 2. module-boundary checks
  for (const rule of moduleBoundaries) {
    for (const [filePath, data] of fileDataMap) {
      violations.push(
        ...checkModuleBoundary(rule, filePath, data.imports, (from, spec) => resolveImportPath(from, spec, projectDir, knownFiles))
      );
    }
  }

  // 3. naming checks
  for (const rule of namingRules) {
    for (const [filePath, data] of fileDataMap) {
      violations.push(...checkNaming(rule, filePath, data.exports));
    }
  }

  // 4. call-constraint checks — requires DB
  if (callConstraints.length > 0 && indexHandle) {
    try {
      const scopedCallers = getScopedCallers(indexHandle, files, isScoped);
      for (const rule of callConstraints) {
        violations.push(...checkCallConstraint(rule, scopedCallers));
      }
    } catch (err: any) {
      errors.push(`Error checking call-constraints: ${err.message}`);
    }
  }

  // 5. ast-pattern checks — uses @ast-grep/napi
  if (astPatterns.length > 0) {
    for (const rule of astPatterns) {
      for (const file of files) {
        const normalized = file.replace(/^\.\//, '');
        const fullPath = file.startsWith('/') ? file : `${projectDir}/${normalized}`;
        try {
          const source = readSource?.(fullPath);
          if (!source) continue;
          violations.push(...checkAstPattern(rule, normalized, source));
        } catch (err: any) {
          errors.push(`Error running ast-pattern "${rule.id}" on ${file}: ${err.message}`);
        }
      }
    }
  }

  // 6. style-mechanism and no-raw-values checks — require DB (style index)
  if (indexHandle) {
    const scopedPaths = files.map(f => f.replace(/^\.\//, ''));

    for (const rule of styleMechanisms) {
      try {
        violations.push(...checkStyleMechanism(rule, scopedPaths, indexHandle));
      } catch (err: any) {
        errors.push(`Error checking style-mechanism "${rule.id}": ${err.message}`);
      }
    }

    for (const rule of noRawValues) {
      try {
        violations.push(...checkNoRawValues(rule, scopedPaths, indexHandle));
      } catch (err: any) {
        errors.push(`Error checking no-raw-values "${rule.id}": ${err.message}`);
      }
    }
  }

  return { rules, violations, errors };
}

/**
 * Get all callers from the DB that are within the scoped files.
 * Returns [caller, callee] pairs for checking against constraints.
 *
 * When `isScoped` is true (diff audit), the in-scope file set is pushed into the
 * SQL as a chunked `f.file_path IN (...)` clause so out-of-scope callers are
 * never fetched. On a full audit `isScoped` is false and `files` is the full
 * discovered list, so a JS filter would be a no-op; the query is left
 * unrestricted (equivalent result, fewer bind params).
 */
function getScopedCallers(
  indexHandle: IndexHandle,
  scopedFiles: string[],
  isScoped?: boolean
): Array<{ filePath: string; callerName: string; calleeName: string }> {
  const mapRows = (rows: Array<{ caller_name: string; file_path: string; callee_name: string }>) =>
    rows.map(r => ({
      filePath: r.file_path,
      callerName: r.caller_name,
      calleeName: r.callee_name,
    }));

  if (isScoped && scopedFiles.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < scopedFiles.length; i += SQLITE_MAX_VARIABLES) {
      chunks.push(scopedFiles.slice(i, i + SQLITE_MAX_VARIABLES));
    }
    const clause = chunks
      .map(c => `f.file_path IN (${c.map(() => '?').join(', ')})`)
      .join(' OR ');
    const rows = indexHandle.query(`
      SELECT DISTINCT f.name as caller_name, f.file_path, fc.callee_name
      FROM function_calls fc
      JOIN functions f ON f.id = fc.caller_id
      WHERE ${clause}
    `, scopedFiles) as Array<{ caller_name: string; file_path: string; callee_name: string }>;
    return mapRows(rows);
  }

  const rows = indexHandle.query(`
    SELECT DISTINCT f.name as caller_name, f.file_path, fc.callee_name
    FROM function_calls fc
    JOIN functions f ON f.id = fc.caller_id
  `) as Array<{ caller_name: string; file_path: string; callee_name: string }>;

  // If scoped files provided, filter to those files
  if (scopedFiles.length > 0) {
    const fileSet = new Set(scopedFiles.map(f => f.replace(/^\.\//, '')));
    return mapRows(rows.filter(r => fileSet.has(r.file_path)));
  }

  return mapRows(rows);
}

/** Clear the matcher cache (useful for tests) */
export function clearMatcherCache(): void {
  matcherCache.clear();
}
