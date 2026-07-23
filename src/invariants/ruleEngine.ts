/**
 * Invariant Rules Engine — checks files and call graph against user-defined rules.
 *
 * Four rule kinds:
 *   import-ban       — no file may import a banned module (except exempt files)
 *   call-constraint   — restrict which files may call a given function
 *   module-boundary   — files in `from` may not import from `to`
 *   naming            — exported symbols must match a regex
 */

import picomatch from 'picomatch';
import { readFileSync } from 'fs';
import path from 'path';
import sg from '@ast-grep/napi';
import type { CodeIndexDB } from '../codeIndexDB.js';
import type {
  InvariantRule,
  ImportBanRule,
  CallConstraintRule,
  ModuleBoundaryRule,
  NamingRule,
  AstPatternRule,
  RuleViolation,
  RuleCheckResult,
} from './types.js';
import { hasRules } from './ruleValidator.js';

export type { InvariantRule, RuleViolation, RuleCheckResult } from './types.js';
export { hasRules } from './ruleValidator.js';

// ── Globbing helpers ──────────────────────────────────────────────────────

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

interface FileImport {
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

/**
 * Compute 1-based line number from a character offset in source text.
 */
function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * Extract all imports from a single source file using regex.
 * Catches: import ... from '...', import('...'), and require('...')
 *
 * Uses regex on raw source text — no parser dependency, works without WASM init.
 */
function extractImports(filePath: string): FileImport[] {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const imports: FileImport[] = [];

  // ── Static imports ──────────────────────────────────────────────────────
  // Matches: import 'mod', import x from 'mod', import { a } from 'mod',
  //          import * as ns from 'mod', import type { T } from 'mod',
  //          import x, { a } from 'mod'
  // Uses non-greedy match between "import" and the quoted specifier.
  const staticRe = /^import\b[\s\S]*?['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(source)) !== null) {
    imports.push({
      moduleSpecifier: m[1],
      isStatic: true,
      isDynamic: false,
      isRequire: false,
      line: lineNumberAt(source, m.index),
    });
  }

  // ── Dynamic import() expressions ────────────────────────────────────────
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynamicRe.exec(source)) !== null) {
    imports.push({
      moduleSpecifier: m[1],
      isStatic: false,
      isDynamic: true,
      isRequire: false,
      line: lineNumberAt(source, m.index),
    });
  }

  // ── require() calls ─────────────────────────────────────────────────────
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(source)) !== null) {
    imports.push({
      moduleSpecifier: m[1],
      isStatic: false,
      isDynamic: false,
      isRequire: true,
      line: lineNumberAt(source, m.index),
    });
  }

  return imports;
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
function resolveImportPath(fromFile: string, specifier: string, projectDir?: string): string | null {
  const base = resolveRelativeImport(fromFile, specifier);
  if (base) {
    // Check with full path
    const full = projectDir ? `${projectDir}/${base}` : base;
    try { readFileSync(full); return base; } catch { return null; }
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
    const candidate = basePath + ext;
    try {
      readFileSync(prefix + candidate);
      return candidate;
    } catch {
      // file doesn't exist, try next extension
    }
  }

  // Try index files
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = basePath + '/index' + ext;
    try {
      readFileSync(prefix + candidate);
      return candidate;
    } catch {
      // index doesn't exist either
    }
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

// ── Exported symbol extraction ────────────────────────────────────────────

/**
 * Extract all exported symbol names from a source file using regex.
 * Handles: export function/class/const/let/var name, export { name1, name2 },
 *          export default function/class name, export default name
 *
 * Uses regex on raw source text — no parser dependency, works without WASM init.
 */
function extractExportedSymbols(filePath: string): Array<{ name: string; line: number }> {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const symbols: Array<{ name: string; line: number }> = [];

  // ── export function|class|const|let|var|type|interface|enum name ────────
  // Covers: export function foo(), export class Bar {}, export const baz = ...
  const declRe = /^export\s+(?:(?:default\s+)?(?:function|class)\s+([\p{L}\p{N}_]+)|(?:const|let|var)\s+([\p{L}\p{N}_]+))/gmu;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    const name = m[1] || m[2]; // m[1] = function/class name, m[2] = const/let/var name
    if (name) {
      symbols.push({ name, line: lineNumberAt(source, m.index) });
    }
  }

  // ── export { name1, name2 as alias } ────────────────────────────────────
  // Capture the local (non-aliased) names inside export { ... }
  const clauseRe = /^export\s*\{([^}]+)\}/gm;
  while ((m = clauseRe.exec(source)) !== null) {
    const body = m[1];
    // Split on comma, then extract the first identifier (skip "as alias" forms)
    for (const part of body.split(',')) {
      const nameMatch = part.match(/^\s*([\p{L}\p{N}_]+)/u);
      if (nameMatch) {
        symbols.push({ name: nameMatch[1], line: lineNumberAt(source, m.index) });
      }
    }
  }

  // ── export default <identifier> ─────────────────────────────────────────
  // e.g. export default MyComponent
  const defaultIdRe = /^export\s+default\s+([\p{L}\p{N}_]+)\s*[;,\n]/gmu;
  while ((m = defaultIdRe.exec(source)) !== null) {
    symbols.push({ name: m[1], line: lineNumberAt(source, m.index) });
  }

  return symbols;
}

// ── Main rule checking ────────────────────────────────────────────────────

export interface RuleEngineOptions {
  /** The invariant rules to enforce */
  rules: InvariantRule[];
  /** Files to check (repo-relative paths) */
  files: string[];
  /** CodeIndexDB instance for call-graph lookups */
  db?: CodeIndexDB;
  /** Base project directory for resolving absolute paths */
  projectDir: string;
}

/**
 * Check all rules against all specified files.
 * import-ban, module-boundary, and naming are per-file.
 * call-constraint queries the full index for callers.
 */
export function checkRules(options: RuleEngineOptions): RuleCheckResult {
  const { rules, files, db, projectDir } = options;
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
    const fullPath = file.startsWith('/') ? file : `${projectDir}/${normalized}`;

    // Make absolute paths relative to projectDir so glob patterns match
    if (path.isAbsolute(normalized)) {
      normalized = path.relative(projectDir, normalized);
    }

    try {
      fileDataMap.set(normalized, {
        imports: extractImports(fullPath),
        exports: extractExportedSymbols(fullPath),
      });
    } catch (err: any) {
      errors.push(`Error reading ${file}: ${err.message}`);
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
        ...checkModuleBoundary(rule, filePath, data.imports, (from, spec) => resolveImportPath(from, spec, projectDir))
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
  if (callConstraints.length > 0 && db) {
    try {
      const scopedCallers = getScopedCallers(db, files);
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
          const source = readFileSync(fullPath, 'utf-8');
          violations.push(...checkAstPattern(rule, normalized, source));
        } catch (err: any) {
          errors.push(`Error running ast-pattern "${rule.id}" on ${file}: ${err.message}`);
        }
      }
    }
  }

  return { rules, violations, errors };
}

/**
 * Get all callers from the DB that are within the scoped files.
 * Returns [caller, callee] pairs for checking against constraints.
 */
function getScopedCallers(
  db: CodeIndexDB,
  scopedFiles: string[]
): Array<{ filePath: string; callerName: string; calleeName: string }> {
  const dbAny = db as any;
  if (!dbAny.db) return [];

  const rows = dbAny.db.prepare(`
    SELECT DISTINCT f.name as caller_name, f.file_path, fc.callee_name
    FROM function_calls fc
    JOIN functions f ON f.id = fc.caller_id
  `).all() as Array<{ caller_name: string; file_path: string; callee_name: string }>;

  // If scoped files provided, filter to those files
  if (scopedFiles.length > 0) {
    const fileSet = new Set(scopedFiles.map(f => f.replace(/^\.\//, '')));
    return rows
      .filter(r => fileSet.has(r.file_path))
      .map(r => ({
        filePath: r.file_path,
        callerName: r.caller_name,
        calleeName: r.callee_name,
      }));
  }

  return rows.map(r => ({
    filePath: r.file_path,
    callerName: r.caller_name,
    calleeName: r.callee_name,
  }));
}

/** Clear the matcher cache (useful for tests) */
export function clearMatcherCache(): void {
  matcherCache.clear();
}
