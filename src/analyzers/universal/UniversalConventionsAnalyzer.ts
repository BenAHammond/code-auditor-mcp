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

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

export class UniversalConventionsAnalyzer extends UniversalAnalyzer {
  readonly name = 'conventions';
  readonly description =
    'Mines codebase conventions and flags deviations at suggestion severity';
  readonly category = 'style';

  /**
   * Full override: query conventions from the DB and emit violations per domain.
   * The base-class per-file AST loop is bypassed.
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
      return {
        violations: [],
        errors: [{ file: '', error: 'No index handle available — code index not open' }],
        status: makeVisitorStatus(0),
        executionTime: Date.now() - startTime,
        analyzerName: this.name,
        metrics: { filesAnalyzed: 0, totalViolations: 0, executionTime: Date.now() - startTime },
      };
    }

    // Query all conventions
    const conventions = indexHandle.query(
      'SELECT * FROM conventions ORDER BY domain, directory',
    ) as ConventionRow[];

    if (conventions.length === 0) {
      return {
        violations: [],
        errors: [],
        status: makeVisitorStatus(files.length),
        executionTime: Date.now() - startTime,
        analyzerName: this.name,
        metrics: { filesAnalyzed: files.length, totalViolations: 0, executionTime: Date.now() - startTime },
      };
    }

    // Extract project root, on-demand source reader, and exports map from config
    const projectRoot: string | undefined = config.projectRoot;
    const readSource: ((filePath: string) => string | undefined) | undefined = config.readSource;
    // B2: exportsMap comes from function-index visitor facts (AST-extracted)
    const exportsMap: Map<string, ExportInfo[]> | undefined = config.exportsMap;

    // Group conventions by domain for efficient detection
    const byDomain = new Map<string, ConventionRow[]>();
    for (const c of conventions) {
      const list = byDomain.get(c.domain) ?? [];
      list.push(c);
      byDomain.set(c.domain, list);
    }

    // Detect violations per domain
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

    // Count unique files that conventions apply to (from the function index)
    const resolvedProjectRoot = projectRoot ? path.resolve(projectRoot) : undefined;
    const fileRows = indexHandle.query(
      resolvedProjectRoot
        ? 'SELECT COUNT(DISTINCT file_path) as cnt FROM functions WHERE file_path LIKE ?'
        : 'SELECT COUNT(DISTINCT file_path) as cnt FROM functions',
      resolvedProjectRoot ? [resolvedProjectRoot + '%'] : [],
    ) as Array<{ cnt: number }>;
    const uniqueFiles = fileRows[0]?.cnt ?? 0;

    return {
      violations,
      errors: [],
      status: makeVisitorStatus(uniqueFiles),
      executionTime: Date.now() - startTime,
      analyzerName: this.name,
      metrics: {
        filesAnalyzed: uniqueFiles,
        totalViolations: violations.length,
        executionTime: Date.now() - startTime,
      },
    };
  }

  /** No-op — all detection is DB-based. */
  async analyzeAST(): Promise<any[]> {
    return [];
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

    // Query all function calls once
    const allCalls = indexHandle.query(
      'SELECT caller_id, callee_name FROM function_calls',
    ) as FunctionCallRow[];

    // Build callerId → Set<calleeName>
    const callerCalls = new Map<number, Set<string>>();
    for (const fc of allCalls) {
      if (!callerCalls.has(fc.caller_id)) callerCalls.set(fc.caller_id, new Set());
      callerCalls.get(fc.caller_id)!.add(fc.callee_name);
    }

    // antecedentName → Set<callerId>
    const antecedentCallers = new Map<string, Set<number>>();
    for (const fc of allCalls) {
      if (!antecedentCallers.has(fc.callee_name)) {
        antecedentCallers.set(fc.callee_name, new Set());
      }
      antecedentCallers.get(fc.callee_name)!.add(fc.caller_id);
    }

    // Query all functions for file/line info
    const funcRows = indexHandle.query(
      'SELECT id, name, file_path, line_number FROM functions',
    ) as FunctionRow[];

    const funcById = new Map<number, FunctionRow>();
    for (const f of funcRows) {
      funcById.set(f.id, f);
    }

    for (const conv of conventions) {
      if (!conv.antecedent || !conv.consequent) continue;

      const antecedent = conv.antecedent;
      const consequent = conv.consequent;
      const callerIds = antecedentCallers.get(antecedent);
      if (!callerIds || callerIds.size === 0) continue;

      for (const cid of callerIds) {
        const callSet = callerCalls.get(cid);
        if (!callSet || !callSet.has(consequent)) {
          const func = funcById.get(cid);
          if (!func) continue;

          const exemplarRef = conv.exemplar_file
            ? ` (exemplar: ${conv.exemplar_file}${
                conv.exemplar_line ? `:${conv.exemplar_line}` : ''
              })`
            : '';

          const pct = Math.round(conv.confidence * 100);
          violations.push({
            file: func.file_path,
            line: func.line_number,
            column: 1,
            severity: 'suggestion',
            message:
              `${pct}% of \`${antecedent}\` callers also call \`${consequent}\` — ` +
              `this function calls \`${antecedent}\` without \`${consequent}\`${exemplarRef}`,
            rule: 'conventions/usage-pair',
            analyzer: this.name,
            functionName: func.name,
          });
        }
      }
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

    // Build a lookup: (source, directory) → dominantForm
    // Group conventions: directory → [{source, dominantForm}]
    interface ImportConv {
      source: string;
      form: string;
      confidence: number;
      exemplar_file: string | null;
      exemplar_line: number | null;
    }

    // Use directory-key → Map<source, ImportConv>
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
      let content: string | undefined = readSource?.(fullPath);
      if (content === undefined) continue;

      const imports = parseFileImports(content);

      for (const imp of imports) {
        const conv = importConvs.get(imp.source);
        if (!conv || imp.form === conv.form) continue;

        const pct = Math.round(conv.confidence * 100);
        const exemplarRef = conv.exemplar_file
          ? ` (exemplar: ${conv.exemplar_file}${
              conv.exemplar_line ? `:${conv.exemplar_line}` : ''
            })`
          : '';

        violations.push({
          file: fp,
          line: imp.line,
          column: 1,
          severity: 'suggestion',
          message:
            `${pct}% of imports of \`${imp.source}\` in \`${directory}/\` ` +
            `use ${conv.form} import — this file uses ${imp.form}${exemplarRef}`,
          rule: 'conventions/import-form',
          analyzer: this.name,
          details: {
            source: imp.source,
            directory,
            conventionForm: conv.form,
            actualForm: imp.form,
            localNames: imp.localNames,
          },
        });
      }
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
    const dirShapes = new Map<string, { shape: string; confidence: number; exemplar_file: string | null; exemplar_line: number | null }>();
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

    const rows = indexHandle.query(
        `SELECT id, name, file_path, line_number, metadata_json
         FROM functions
         WHERE metadata_json IS NOT NULL`,
      ) as FunctionRow[];

    for (const row of rows) {
      const directory = path.dirname(row.file_path) || '.';
      const conv = dirShapes.get(directory);
      if (!conv) continue;

      let metadata: any;
      try {
        metadata = JSON.parse(row.metadata_json!);
      } catch {
        continue;
      }

      const body: string | undefined = metadata.body;
      const shape = detectErrorHandlingShape(body);
      if (!shape) continue; // no error handling → skip
      if (shape === conv.shape) continue; // matches convention

      const pct = Math.round(conv.confidence * 100);
      const exemplarRef = conv.exemplar_file
        ? ` (exemplar: ${conv.exemplar_file}${
            conv.exemplar_line ? `:${conv.exemplar_line}` : ''
          })`
        : '';

      violations.push({
        file: row.file_path,
        line: row.line_number,
        column: 1,
        severity: 'suggestion',
        message:
          `${pct}% of error-handling functions in \`${directory}/\` use ` +
          `\`${conv.shape}\` — this function uses \`${shape}\`${exemplarRef}`,
        rule: 'conventions/error-handling',
        analyzer: this.name,
        functionName: row.name,
      });
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
    const dirForms = new Map<string, { form: string; confidence: number; exemplar_file: string | null; exemplar_line: number | null }>();
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

    const rows = indexHandle.query(
        `SELECT id, name, file_path, line_number, is_exported
         FROM functions
         WHERE is_exported = 1`,
      ) as FunctionRow[];

    for (const row of rows) {
      const directory = path.dirname(row.file_path) || '.';
      const conv = dirForms.get(directory);
      if (!conv) continue;

      // B2: Use AST-extracted ExportInfo[] from function-index facts
      const fileExports = exportsMap?.get(row.file_path);
      if (!fileExports) continue;
      const form = detectExportForm(row.name, fileExports);
      if (!form || form === conv.form) continue;

      const pct = Math.round(conv.confidence * 100);
      const exemplarRef = conv.exemplar_file
        ? ` (exemplar: ${conv.exemplar_file}${
            conv.exemplar_line ? `:${conv.exemplar_line}` : ''
          })`
        : '';

      violations.push({
        file: row.file_path,
        line: row.line_number,
        column: 1,
        severity: 'suggestion',
        message:
          `${pct}% of exports in \`${directory}/\` use ${conv.form} export — ` +
          `\`${row.name}\` uses ${form}${exemplarRef}`,
        rule: 'conventions/export-shape',
        analyzer: this.name,
        functionName: row.name,
      });
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
    const dirKindCases = new Map<string, Map<string, {
      casing: string;
      confidence: number;
      exemplar_file: string | null;
      exemplar_line: number | null;
      kind: string;
    }>>();

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

    const rows = indexHandle.query(
        `SELECT id, name, file_path, line_number, is_exported, entity_type, component_type
         FROM functions
         WHERE is_exported = 1`,
      ) as Array<{
        id: number;
        name: string;
        file_path: string;
        line_number: number;
        is_exported: number;
        entity_type: string;
        component_type: string | null;
      }>;

    for (const row of rows) {
      const directory = path.dirname(row.file_path) || '.';

      // Classify into export kind (same logic as mineNaming)
      let rowKind: string;
      if (row.entity_type === 'component' || row.component_type !== null) {
        rowKind = 'react-component';
      } else if (/^use[A-Z]/.test(row.name)) {
        rowKind = 'hook';
      } else {
        rowKind = 'function';
      }

      const kindConvs = dirKindCases.get(directory);
      if (!kindConvs) continue;

      // Try exact kind match first, fall back to 'function' for backward compat
      const conv = kindConvs.get(rowKind);
      if (!conv) continue;

      // Non-Latin skip (Spec 21 R5.4)
      if (hasNonLatinChars(row.name)) continue;

      const casing = detectCase(row.name);
      if (!casing || casing === conv.casing) continue;

      const pct = Math.round(conv.confidence * 100);
      const exemplarRef = conv.exemplar_file
        ? ` (exemplar: ${conv.exemplar_file}${
            conv.exemplar_line ? `:${conv.exemplar_line}` : ''
          })`
        : '';

      violations.push({
        file: row.file_path,
        line: row.line_number,
        column: 1,
        severity: 'suggestion',
        message:
          `${pct}% of ${conv.kind} exports in \`${directory}/\` use ${conv.casing} — ` +
          `\`${row.name}\` uses ${casing}${exemplarRef}`,
        rule: 'conventions/naming',
        analyzer: this.name,
        functionName: row.name,
      });
    }

    return violations;
  }
}
