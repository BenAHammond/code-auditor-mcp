/**
 * Universal Conventions Analyzer — Spec 12 R2.
 *
 * Reads mined conventions from the SQLite conventions table and flags
 * deviations at suggestion severity. All detection is cross-file (DB-based);
 * no per-AST processing is needed.
 *
 * Five rule IDs:
 *   conventions/usage-pair    — missing co-occurring function calls
 *   conventions/import-form   — minority import style
 *   conventions/error-handling — wrong error-handling shape
 *   conventions/export-shape  — minority export style
 *   conventions/naming        — wrong casing convention
 */

import * as path from 'path';
import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import { withRuleTiming } from '../ruleTiming.js';
import type { AnalyzerResult, Violation, ConventionsAnalyzerConfig } from '../../types.js';
import type { IndexHandle } from '../../types.js';
import { makeVisitorStatus } from '../../pipeline.js';
import {
  detectCase,
  detectErrorHandlingShape,
  detectExportForm,
  parseFileImports,
  hasNonLatinChars,
} from '../../conventions/conventionMiner.js';
import type { ExportInfo } from '../../languages/types.js';

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

export const DEFAULT_CONVENTIONS_CONFIG: ConventionsAnalyzerConfig = {
  minCorpus: 30,
  pairConfidence: 0.95,
  modeShare: 0.8,
  maxConventionsPerDomain: 200,
};

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface ConventionRow {
  id: number;
  domain: string;
  rule_id: string;
  antecedent: string | null;
  consequent: string | null;
  pattern: string | null;
  directory: string | null;
  file_path: string | null;
  line: number | null;
  support: number;
  total_cases: number;
  confidence: number;
  exemplar_file: string | null;
  exemplar_line: number | null;
}

interface FunctionRow {
  id: number;
  name: string;
  file_path: string;
  line_number: number;
  is_exported: number;
  metadata_json: string | null;
}

interface FunctionCallRow {
  caller_id: number;
  callee_name: string;
}

/** Per-scan context threaded through the convention detectors. */
interface ConventionsScanContext {
  projectRoot: string | undefined;
  readSource: ((filePath: string) => string | undefined) | undefined;
  exportsMap: Map<string, ExportInfo[]> | undefined;
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

/**
 * Universal conventions analyzer.
 */
export class UniversalConventionsAnalyzer extends UniversalAnalyzer {
  readonly name = 'conventions';
  readonly description =
    'Mines codebase conventions and flags deviations at suggestion severity';
  readonly category = 'style';

  /**
   * Full override: query conventions from the DB and emit violations per domain.
   * The base-class per-file AST loop is bypassed.
   * @param config
   * @param files
   * @param options
   * @returns
   */
  async analyze(
    files: string[],
    config: any = {},
    options: any = {},
  ): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const violations: Violation[] = [];

    const indexHandle: IndexHandle | undefined = config.indexHandle;
    if (!indexHandle) {
      return this.makeResult([], 0, startTime, [
        { file: '', error: 'No index handle available — code index not open' },
      ]);
    }

    // Query all conventions
    const conventions = indexHandle.query(
      'SELECT * FROM conventions ORDER BY domain, directory',
    ) as ConventionRow[];

    if (conventions.length === 0) {
      return this.makeResult([], files.length, startTime);
    }

    // Extract project root, on-demand source reader, and exports map from config
    const projectRoot: string | undefined = config.projectRoot;
    const readSource: ((filePath: string) => string | undefined) | undefined = config.readSource;
    // B2: exportsMap comes from function-index visitor facts (AST-extracted)
    const exportsMap: Map<string, ExportInfo[]> | undefined = config.exportsMap;

    // Detect violations per domain
    const byDomain = groupConventionsByDomain(conventions);
    const scanCtx: ConventionsScanContext = { projectRoot, readSource, exportsMap };
    violations.push(...this.detectPerDomain(byDomain, indexHandle, scanCtx));

    // Count unique files that conventions apply to (from the function index)
    const uniqueFiles = countUniqueFiles(indexHandle, projectRoot);

    return this.makeResult(violations, uniqueFiles, startTime);
  }

  /** Build a standard AnalyzerResult with shared metrics and timing fields. */
  private makeResult(
    violations: Violation[],
    filesAnalyzed: number,
    startTime: number,
    errors: Array<{ file: string; error: string }> = [],
  ): AnalyzerResult {
    return {
      violations,
      errors,
      status: makeVisitorStatus(filesAnalyzed),
      executionTime: Date.now() - startTime,
      analyzerName: this.name,
      metrics: {
        filesAnalyzed,
        totalViolations: violations.length,
        executionTime: Date.now() - startTime,
      },
    };
  }

  /** No-op — all detection is DB-based. */
  async analyzeAST(): Promise<any[]> {
    return [];
  }

  /**
   * Dispatch each convention domain to its detector.
   */
  private detectPerDomain(
    byDomain: Map<string, ConventionRow[]>,
    indexHandle: IndexHandle,
    scanCtx: ConventionsScanContext,
  ): Violation[] {
    const { projectRoot, readSource, exportsMap } = scanCtx;
    const violations: Violation[] = [];
    for (const [domain, domainConventions] of byDomain) {
      switch (domain) {
        case 'usage-pair':
          violations.push(...this.detectUsagePairViolations(indexHandle, domainConventions));
          break;
        case 'import-form':
          violations.push(
            ...this.detectImportFormViolations(indexHandle, domainConventions, projectRoot, readSource),
          );
          break;
        case 'error-handling':
          violations.push(
            ...this.detectErrorHandlingViolations(indexHandle, domainConventions),
          );
          break;
        case 'export-shape':
          violations.push(
            ...this.detectExportShapeViolations(indexHandle, domainConventions, exportsMap),
          );
          break;
        case 'naming':
          violations.push(
            ...this.detectNamingViolations(indexHandle, domainConventions),
          );
          break;
      }
    }
    return violations;
  }

  // ── Usage-Pair Detection ──────────────────────────────────────────────

  /**
   * For each usage-pair convention (antecedent → consequent), find functions
   * that call the antecedent but NOT the consequent.
   */
  private detectUsagePairViolations(
    indexHandle: IndexHandle,
    conventions: ConventionRow[],
  ): Violation[] {
    const violations: Violation[] = [];

    // Query all function calls once and index both directions
    const allCalls = indexHandle.query(
      'SELECT caller_id, callee_name FROM function_calls',
    ) as FunctionCallRow[];
    const { callerCalls, antecedentCallers } = buildCallMaps(allCalls);

    // Query all functions for file/line info
    const funcRows = indexHandle.query(
      'SELECT id, name, file_path, line_number FROM functions',
    ) as FunctionRow[];
    const funcById = buildFuncById(funcRows);

    const ctx: UsagePairContext = {
      antecedentCallers,
      callerCalls,
      funcById,
      analyzerName: this.name,
    };
    for (const conv of conventions) {
      violations.push(...withRuleTiming('conventions/usage-pair', () =>
        detectUsagePairForConvention(conv, ctx)));
    }

    return violations;
  }

  // ── Import-Form Detection ─────────────────────────────────────────────

  /**
   * For each import-form convention (source → dominantForm in directory),
   * find imports of that source that use a minority form.
   */
  private detectImportFormViolations(
    indexHandle: IndexHandle,
    conventions: ConventionRow[],
    projectRoot?: string,
    readSource?: (filePath: string) => string | undefined,
  ): Violation[] {
    const violations: Violation[] = [];

    // Build directory → Map<source, ImportConv>
    const dirImports = buildDirImports(conventions);

    // Get unique file paths
    const fileRows = indexHandle.query(
      'SELECT DISTINCT file_path FROM functions WHERE file_path IS NOT NULL',
    ) as Array<{ file_path: string }>;

    const seenFiles = new Set<string>();

    for (const { file_path: fp } of fileRows) {
      if (seenFiles.has(fp)) continue;
      seenFiles.add(fp);

      const directory = path.dirname(fp) || '.';
      const importConvs = dirImports.get(directory);
      if (!importConvs) continue;

      const fullPath = projectRoot ? path.join(projectRoot, fp) : fp;
      const content = readSource?.(fullPath);
      if (content === undefined) continue;

      violations.push(...detectImportFormForFile(fp, content, importConvs, this.name));
    }

    return violations;
  }

  // ── Error-Handling Detection ──────────────────────────────────────────

  /**
   * For each error-handling convention, find functions in that directory
   * that have error handling but use a different shape.
   *
   * Functions with NO error handling are excluded — never flagged.
   */
  private detectErrorHandlingViolations(
    indexHandle: IndexHandle,
    conventions: ConventionRow[],
  ): Violation[] {
    const violations: Violation[] = [];

    // directory → dominantShape
    const dirShapes = buildDirShapes(conventions);

    const rows = indexHandle.query(
        `SELECT id, name, file_path, line_number, metadata_json
         FROM functions
         WHERE metadata_json IS NOT NULL`,
      ) as FunctionRow[];

    for (const row of rows) {
      const violation = detectErrorHandlingForRow(row, dirShapes, this.name);
      if (violation) violations.push(violation);
    }

    return violations;
  }

  // ── Export-Shape Detection ────────────────────────────────────────────

  /**
   * For each export-shape convention, find exported functions in that
   * directory that use a minority export form.
   */
  private detectExportShapeViolations(
    indexHandle: IndexHandle,
    conventions: ConventionRow[],
    exportsMap?: Map<string, ExportInfo[]>,
  ): Violation[] {
    const violations: Violation[] = [];

    // directory → dominantForm
    const dirForms = buildDirForms(conventions);

    const rows = indexHandle.query(
        `SELECT id, name, file_path, line_number, is_exported
         FROM functions
         WHERE is_exported = 1`,
      ) as FunctionRow[];

    for (const row of rows) {
      const violation = detectExportShapeForRow(row, dirForms, exportsMap, this.name);
      if (violation) violations.push(violation);
    }

    return violations;
  }

  // ── Naming Detection ──────────────────────────────────────────────────

  /**
   * For each naming convention, find exported functions in that directory
   * that don't match the dominant casing. Non-Latin names are skipped
   * (Spec 21 R5.4).
   */
  private detectNamingViolations(
    indexHandle: IndexHandle,
    conventions: ConventionRow[],
  ): Violation[] {
    const violations: Violation[] = [];

    // directory → kind → convention
    const dirKindCases = buildDirKindCases(conventions);

    const rows = indexHandle.query(
        `SELECT id, name, file_path, line_number, is_exported, entity_type, component_type
         FROM functions
         WHERE is_exported = 1`,
      ) as NamingFunctionRow[];

    for (const row of rows) {
      const violation = detectNamingForRow(row, dirKindCases, this.name);
      if (violation) violations.push(violation);
    }

    return violations;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Directory → Map<source, ImportConv> for the import-form detector. */
interface ImportConv {
  source: string;
  form: string;
  confidence: number;
  exemplar_file: string | null;
  exemplar_line: number | null;
}

/** Directory → dominant error-handling shape. */
interface DirShape {
  shape: string;
  confidence: number;
  exemplar_file: string | null;
  exemplar_line: number | null;
}

/** Directory → dominant export form. */
interface DirForm {
  form: string;
  confidence: number;
  exemplar_file: string | null;
  exemplar_line: number | null;
}

/** Per-kind naming convention within a directory. */
interface NamingKindConv {
  casing: string;
  confidence: number;
  exemplar_file: string | null;
  exemplar_line: number | null;
  kind: string;
}

/** Row shape for the naming detector's exported-function query. */
interface NamingFunctionRow {
  id: number;
  name: string;
  file_path: string;
  line_number: number;
  is_exported: number;
  entity_type: string;
  component_type: string | null;
}

/** Build the `(exemplar: file:line)` suffix shared across convention messages. */
function exemplarRef(conv: { exemplar_file: string | null; exemplar_line: number | null }): string {
  return conv.exemplar_file
    ? ` (exemplar: ${conv.exemplar_file}${conv.exemplar_line ? `:${conv.exemplar_line}` : ''})`
    : '';
}

/** Group convention rows by their `domain` field. */
function groupConventionsByDomain(conventions: ConventionRow[]): Map<string, ConventionRow[]> {
  const byDomain = new Map<string, ConventionRow[]>();
  for (const conv of conventions) {
    const list = byDomain.get(conv.domain);
    if (list) list.push(conv);
    else byDomain.set(conv.domain, [conv]);
  }
  return byDomain;
}

/** Count distinct file paths in the function index (files conventions apply to). */
function countUniqueFiles(indexHandle: IndexHandle, projectRoot?: string): number {
  const rows = indexHandle.query(
    'SELECT DISTINCT file_path FROM functions WHERE file_path IS NOT NULL',
  ) as Array<{ file_path: string }>;
  return rows.length;
}

/** Index call rows in both directions: caller→callees and callee→callers. */
function buildCallMaps(allCalls: FunctionCallRow[]): {
  callerCalls: Map<number, Set<string>>;
  antecedentCallers: Map<string, Set<number>>;
} {
  const callerCalls = new Map<number, Set<string>>();
  const antecedentCallers = new Map<string, Set<number>>();
  for (const call of allCalls) {
    const callees = callerCalls.get(call.caller_id);
    if (callees) callees.add(call.callee_name);
    else callerCalls.set(call.caller_id, new Set([call.callee_name]));

    const callers = antecedentCallers.get(call.callee_name);
    if (callers) callers.add(call.caller_id);
    else antecedentCallers.set(call.callee_name, new Set([call.caller_id]));
  }
  return { callerCalls, antecedentCallers };
}

/** Index function rows by id for caller→function lookups. */
function buildFuncById(funcRows: FunctionRow[]): Map<number, FunctionRow> {
  const map = new Map<number, FunctionRow>();
  for (const row of funcRows) map.set(row.id, row);
  return map;
}

/** Shared lookup state for the usage-pair detector. */
interface UsagePairContext {
  antecedentCallers: Map<string, Set<number>>;
  callerCalls: Map<number, Set<string>>;
  funcById: Map<number, FunctionRow>;
  analyzerName: string;
}

/** Emit usage-pair violations for a single convention row. */
function detectUsagePairForConvention(
  conv: ConventionRow,
  ctx: UsagePairContext,
): Violation[] {
  const violations: Violation[] = [];
  if (!conv.antecedent || !conv.consequent) return violations;

  const antecedent = conv.antecedent;
  const consequent = conv.consequent;
  const callerIds = ctx.antecedentCallers.get(antecedent);
  if (!callerIds || callerIds.size === 0) return violations;

  for (const cid of callerIds) {
    const callSet = ctx.callerCalls.get(cid);
    if (!callSet || !callSet.has(consequent)) {
      const func = ctx.funcById.get(cid);
      if (!func) continue;

      const pct = Math.round(conv.confidence * 100);
      violations.push({
        file: func.file_path,
        line: func.line_number,
        column: 1,
        severity: 'suggestion',
        message:
          `${pct}% of \`${antecedent}\` callers also call \`${consequent}\` — ` +
          `this function calls \`${antecedent}\` without \`${consequent}\`${exemplarRef(conv)}`,
        rule: 'conventions/usage-pair',
        analyzer: ctx.analyzerName,
        functionName: func.name,
        resolution: {
          action: 'call-companion',
          summary: `Add a call to the companion function \`${consequent}\` in \`${func.name}\` — ${pct}% of \`${antecedent}\` callers also call it.`,
          symbols: [consequent, antecedent],
          files: [func.file_path],
          lines: [func.line_number],
        },
      });
    }
  }

  return violations;
}

/** Build directory → Map<source, ImportConv> from import-form convention rows. */
function buildDirImports(conventions: ConventionRow[]): Map<string, Map<string, ImportConv>> {
  const dirImports = new Map<string, Map<string, ImportConv>>();
  for (const conv of conventions) {
    const dir = conv.directory ?? '.';
    const source = conv.antecedent;
    if (!source) continue;
    const form = conv.consequent;
    if (!form) continue;

    if (!dirImports.has(dir)) dirImports.set(dir, new Map());
    dirImports.get(dir)!.set(source, {
      source,
      form,
      confidence: conv.confidence,
      exemplar_file: conv.exemplar_file,
      exemplar_line: conv.exemplar_line,
    });
  }
  return dirImports;
}

/** Detect import-form violations within one file's parsed imports. */
function detectImportFormForFile(
  fp: string,
  content: string,
  importConvs: Map<string, ImportConv>,
  analyzerName: string,
): Violation[] {
  const violations: Violation[] = [];
  const directory = path.dirname(fp) || '.';
  const imports = parseFileImports(content);

  for (const imp of imports) {
    const conv = importConvs.get(imp.source);
    if (!conv || imp.form === conv.form) continue;

    const pct = Math.round(conv.confidence * 100);
    violations.push({
      file: fp,
      line: imp.line,
      column: 1,
      severity: 'suggestion',
      message:
        `${pct}% of imports of \`${imp.source}\` in \`${directory}/\` ` +
        `use ${conv.form} import — this file uses ${imp.form}${exemplarRef(conv)}`,
      rule: 'conventions/import-form',
      analyzer: analyzerName,
      details: {
        source: imp.source,
        directory,
        conventionForm: conv.form,
        actualForm: imp.form,
        localNames: imp.localNames,
      },
    });
  }

  return violations;
}

/** Build directory → dominant error-handling shape from convention rows. */
function buildDirShapes(conventions: ConventionRow[]): Map<string, DirShape> {
  const dirShapes = new Map<string, DirShape>();
  for (const conv of conventions) {
    const dir = conv.directory ?? '.';
    const shape = conv.pattern;
    if (!shape) continue;
    dirShapes.set(dir, {
      shape,
      confidence: conv.confidence,
      exemplar_file: conv.exemplar_file,
      exemplar_line: conv.exemplar_line,
    });
  }
  return dirShapes;
}

/** Detect an error-handling-shape deviation for one function row, if any. */
function detectErrorHandlingForRow(
  row: FunctionRow,
  dirShapes: Map<string, DirShape>,
  analyzerName: string,
): Violation | null {
  const directory = path.dirname(row.file_path) || '.';
  const conv = dirShapes.get(directory);
  if (!conv) return null;

  let metadata: any;
  try {
    metadata = JSON.parse(row.metadata_json!);
  } catch {
    return null;
  }

  const body: string | undefined = metadata.body;
  const shape = detectErrorHandlingShape(body);
  if (!shape) return null; // no error handling → skip
  if (shape === conv.shape) return null; // matches convention

  const pct = Math.round(conv.confidence * 100);
  return {
    file: row.file_path,
    line: row.line_number,
    column: 1,
    severity: 'suggestion',
    message:
      `${pct}% of error-handling functions in \`${directory}/\` use ` +
      `\`${conv.shape}\` — this function uses \`${shape}\`${exemplarRef(conv)}`,
    rule: 'conventions/error-handling',
    analyzer: analyzerName,
    functionName: row.name,
  };
}

/** Build directory → dominant export form from convention rows. */
function buildDirForms(conventions: ConventionRow[]): Map<string, DirForm> {
  const dirForms = new Map<string, DirForm>();
  for (const conv of conventions) {
    const dir = conv.directory ?? '.';
    const form = conv.pattern;
    if (!form) continue;
    dirForms.set(dir, {
      form,
      confidence: conv.confidence,
      exemplar_file: conv.exemplar_file,
      exemplar_line: conv.exemplar_line,
    });
  }
  return dirForms;
}

/** Detect an export-shape deviation for one function row, if any. */
function detectExportShapeForRow(
  row: FunctionRow,
  dirForms: Map<string, DirForm>,
  exportsMap: Map<string, ExportInfo[]> | undefined,
  analyzerName: string,
): Violation | null {
  const directory = path.dirname(row.file_path) || '.';
  const conv = dirForms.get(directory);
  if (!conv) return null;

  // B2: Use AST-extracted ExportInfo[] from function-index facts
  const fileExports = exportsMap?.get(row.file_path);
  if (!fileExports) return null;
  const form = detectExportForm(row.name, fileExports);
  if (!form || form === conv.form) return null;

  const pct = Math.round(conv.confidence * 100);
  return {
    file: row.file_path,
    line: row.line_number,
    column: 1,
    severity: 'suggestion',
    message:
      `${pct}% of exports in \`${directory}/\` use ${conv.form} export — ` +
      `\`${row.name}\` uses ${form}${exemplarRef(conv)}`,
    rule: 'conventions/export-shape',
    analyzer: analyzerName,
    functionName: row.name,
  };
}

/** Build directory → kind → convention from naming convention rows. */
function buildDirKindCases(conventions: ConventionRow[]): Map<string, Map<string, NamingKindConv>> {
  const dirKindCases = new Map<string, Map<string, NamingKindConv>>();
  for (const conv of conventions) {
    const dir = conv.directory ?? '.';
    const casing = conv.pattern;
    if (!casing) continue;
    const kind = (conv as any).export_kind ?? 'function';

    if (!dirKindCases.has(dir)) dirKindCases.set(dir, new Map());
    dirKindCases.get(dir)!.set(kind, {
      casing,
      confidence: conv.confidence,
      exemplar_file: conv.exemplar_file,
      exemplar_line: conv.exemplar_line,
      kind,
    });
  }
  return dirKindCases;
}

/** Classify an exported function into a naming kind (same logic as mineNaming). */
function classifyExportKind(row: NamingFunctionRow): string {
  if (row.entity_type === 'component' || row.component_type !== null) {
    return 'react-component';
  }
  if (/^use[A-Z]/.test(row.name)) {
    return 'hook';
  }
  return 'function';
}

/** Detect a naming-casing deviation for one function row, if any. */
function detectNamingForRow(
  row: NamingFunctionRow,
  dirKindCases: Map<string, Map<string, NamingKindConv>>,
  analyzerName: string,
): Violation | null {
  const directory = path.dirname(row.file_path) || '.';
  const kindConvs = dirKindCases.get(directory);
  if (!kindConvs) return null;

  const rowKind = classifyExportKind(row);
  const conv = kindConvs.get(rowKind);
  if (!conv) return null;

  // Non-Latin skip (Spec 21 R5.4)
  if (hasNonLatinChars(row.name)) return null;

  const casing = detectCase(row.name);
  if (!casing || casing === conv.casing) return null;

  const pct = Math.round(conv.confidence * 100);
  return {
    file: row.file_path,
    line: row.line_number,
    column: 1,
    severity: 'suggestion',
    message:
      `${pct}% of ${conv.kind} exports in \`${directory}/\` use ${conv.casing} — ` +
      `\`${row.name}\` uses ${casing}${exemplarRef(conv)}`,
    rule: 'conventions/naming',
    analyzer: analyzerName,
    functionName: row.name,
  };
}
