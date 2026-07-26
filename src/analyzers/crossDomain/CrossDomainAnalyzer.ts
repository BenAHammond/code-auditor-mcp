/**
 * Cross-Domain Analyzer — Spec 15.
 *
 * Post-analysis analyzer that queries the SQLite database for cross-domain
 * findings no single per-file analyzer can produce:
 *
 *   R1 — Schema Lifecycle:
 *     cross-domain/written-never-read    — Table written but never read
 *     cross-domain/read-never-written    — Table read but never written
 *     cross-domain/transaction-boundary  — Function writes to too many tables
 *
 *   R3 — Validation Bypass (future):
 *     cross-domain/validation-bypass     — Writer doesn't reach a validator
 *
 *   R4 — Coverage by Importance:
 *     cross-domain/uncovered-risk        — Top-risk function with no test coverage
 *
 * All findings enter at suggestion severity per the entry rule.
 * Higher tiers require Spec 11 R5 recalibration bars (precision ≥ 0.95
 * AND judged-true ≥ 0.90) on real-corpus evidence.
 */

import * as path from 'node:path';

import type { AnalyzerResult, Violation, ValidatorBypassConfig, CoverageConfig } from '../../types.js';
import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import { CodeIndexDB } from '../../codeIndexDB.js';
import { VALIDATOR_PACKAGES } from '../provenance.js';

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface SchemaUsageRow {
  table_name: string;
  file_path: string;
  function_name: string;
  line: number;
  usage_type: string;
}

interface FilePathClause {
  clause: string;
  param: string;
}


// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

export class CrossDomainAnalyzer extends UniversalAnalyzer {
  readonly name = 'cross-domain';
  readonly description =
    'Detects cross-domain issues (schema lifecycle, validation bypass, coverage gaps)';
  readonly category = 'architecture';

  /**
   * Full override: query the code index DB for cross-domain findings.
   * The base-class per-file AST loop is bypassed — all detection is
   * post-analysis across the indexed data.
   */
  async analyze(
    files: string[],
    config: any = {},
    options: any = {},
  ): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const violations: Violation[] = [];

    let rawDb: any = null;
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      rawDb = (db as any).rawDb;
    } catch {
      return {
        violations: [],
        errors: [{ file: '', error: 'Failed to open code index database' }],
        filesProcessed: 0,
        executionTime: Date.now() - startTime,
        metrics: { filesAnalyzed: 0, totalViolations: 0, executionTime: Date.now() - startTime },
      };
    }

    if (!rawDb) {
      return {
        violations: [],
        errors: [],
        filesProcessed: 0,
        executionTime: Date.now() - startTime,
        metrics: { filesAnalyzed: 0, totalViolations: 0, executionTime: Date.now() - startTime },
      };
    }

    // Project root scoping: in test environments the in-memory DB singleton
    // is shared across tests, so schema_usage entries from previous test
    // cases leak into subsequent queries. Filter to the current project root.
    const projectRoot = config.projectRoot as string | undefined;
    const resolvedRoot = projectRoot ? path.resolve(projectRoot) : undefined;
    const filePathClause = resolvedRoot
      ? { prefix: resolvedRoot, clause: 'AND file_path LIKE ?', param: `${resolvedRoot}%` }
      : undefined;

    // R1 — Schema lifecycle detectors
    const lifecycle = config.schemaLifecycle ?? {};
    if (lifecycle.enableWrittenNeverRead !== false) {
      violations.push(...this.detectWrittenNeverRead(rawDb, filePathClause));
    }
    if (lifecycle.enableReadNeverWritten !== false) {
      violations.push(...this.detectReadNeverWritten(rawDb, filePathClause));
    }
    if (lifecycle.enableTransactionBoundaryRisk !== false) {
      const txnTableMax = lifecycle.txnTableMax ?? 4;
      violations.push(...this.detectTransactionBoundaryRisk(rawDb, txnTableMax, filePathClause));
    }

    // R3 — Validation-bypass detection
    const bypass = config.validatorBypass as ValidatorBypassConfig | undefined;
    if (bypass) {
      violations.push(...this.detectValidationBypass(rawDb, bypass, filePathClause));
    }

    // R4 — Coverage by importance
    const coverage = config.coverage as CoverageConfig | undefined;
    if (coverage) {
      violations.push(...this.detectUncoveredRisk(rawDb, coverage, filePathClause));
    }

    return {
      violations,
      errors: [],
      filesProcessed: files.length,
      executionTime: Date.now() - startTime,
      metrics: {
        filesAnalyzed: files.length,
        totalViolations: violations.length,
        executionTime: Date.now() - startTime,
      },
    };
  }

  /** No-op — all detection is DB-based. */
  async analyzeAST(): Promise<any[]> {
    return [];
  }

  // ── R1: Written-Never-Read ──────────────────────────────────────────────

  /**
   * Detect tables that are written to (INSERT/UPDATE/DELETE/CREATE) but
   * never read from (SELECT). These might be dead writes or missed read paths.
   */
  private detectWrittenNeverRead(rawDb: any, filePath?: FilePathClause): Violation[] {
    const violations: Violation[] = [];

    const fpWhere = filePath ? filePath.clause : '';

    const rows = rawDb
      .prepare(
        `SELECT DISTINCT table_name, file_path, function_name, line, usage_type
         FROM schema_usage
         WHERE usage_type IN ('insert', 'update', 'delete', 'create')
           ${fpWhere}
           AND table_name NOT IN (
             SELECT DISTINCT table_name FROM schema_usage WHERE usage_type = 'select' ${fpWhere}
           )
         ORDER BY table_name, file_path`,
      )
      .all(...(filePath ? [filePath.param, filePath.param] : [])) as SchemaUsageRow[];

    // Deduplicate by table_name — one violation per table, anchored to
    // the first writing file encountered.
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.table_name)) continue;
      seen.add(row.table_name);

      violations.push({
        file: row.file_path,
        line: row.line,
        column: 0,
        severity: 'suggestion',
        message: `Table '${row.table_name}' is written (${row.usage_type}) but never read (SELECT). Consider removing unused writes or adding read paths.`,
        rule: 'cross-domain/written-never-read',
        analyzer: this.name,
        functionName: row.function_name,
      });
    }

    return violations;
  }

  // ── R1: Read-Never-Written ──────────────────────────────────────────────

  /**
   * Detect tables that are read from (SELECT) but never written to
   * (INSERT/UPDATE/DELETE/CREATE). These may be external/managed tables
   * or indicate missing write coverage.
   */
  private detectReadNeverWritten(rawDb: any, filePath?: FilePathClause): Violation[] {
    const violations: Violation[] = [];

    const fpWhere = filePath ? filePath.clause : '';

    const rows = rawDb
      .prepare(
        `SELECT DISTINCT table_name, file_path, function_name, line, usage_type
         FROM schema_usage
         WHERE usage_type = 'select'
           ${fpWhere}
           AND table_name NOT IN (
             SELECT DISTINCT table_name FROM schema_usage
             WHERE usage_type IN ('insert', 'update', 'delete', 'create') ${fpWhere}
           )
         ORDER BY table_name, file_path`,
      )
      .all(...(filePath ? [filePath.param, filePath.param] : [])) as SchemaUsageRow[];

    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.table_name)) continue;
      seen.add(row.table_name);

      violations.push({
        file: row.file_path,
        line: row.line,
        column: 0,
        severity: 'suggestion',
        message: `Table '${row.table_name}' is read (SELECT) but never written (INSERT/UPDATE/DELETE). This may be an external/managed table, or indicate missing write coverage.`,
        rule: 'cross-domain/read-never-written',
        analyzer: this.name,
        functionName: row.function_name,
      });
    }

    return violations;
  }

  // ── R1: Transaction-Boundary Risk ───────────────────────────────────────

  /**
   * Detect functions that write to ≥ txnTableMax distinct tables, including
   * tables written by depth-1 callees via the call graph (graph_cache).
   *
   * This surfaces functions that may have transaction-boundary risk:
   * writing to too many tables in a single logical operation can lead to
   * long-running transactions, lock contention, and partial-failure complexity.
   */
  private detectTransactionBoundaryRisk(
    rawDb: any,
    txnTableMax: number,
    filePath?: FilePathClause,
  ): Violation[] {
    const violations: Violation[] = [];

    const fpWhere = filePath ? filePath.clause : '';
    const fpParams = filePath ? [filePath.param] : [];

    // ── 1. Group writes by (function_name, file_path) — no JOIN on functions.
    //    The functions table is only populated during deepSync (code-audit index
    //    sync), not during normal audit. We query schema_usage directly so this
    //    detector works in both modes.
    const writerRows = rawDb
      .prepare(
        `SELECT su.function_name, su.file_path, su.table_name, MIN(su.line) as line
         FROM schema_usage su
         WHERE su.usage_type IN ('insert', 'update', 'delete', 'create')
         ${fpWhere}
         GROUP BY su.function_name, su.file_path, su.table_name
         ORDER BY su.function_name, su.file_path`,
      )
      .all(...fpParams) as Array<{
      function_name: string;
      file_path: string;
      table_name: string;
      line: number;
    }>;

    if (writerRows.length === 0) return violations;

    // Group written tables by function key
    interface FuncWriteEntry {
      filePath: string;
      line: number;
      tables: Set<string>;
    }

    const funcWrites = new Map<string, FuncWriteEntry>();
    for (const row of writerRows) {
      const key = `${row.file_path}::${row.function_name}`;
      const entry = funcWrites.get(key);
      if (entry) {
        entry.tables.add(row.table_name);
      } else {
        funcWrites.set(key, {
          filePath: row.file_path,
          line: row.line,
          tables: new Set([row.table_name]),
        });
      }
    }

    // ── 2. Attempt callee expansion via graph_cache when the infrastructure
    //    is populated (requires code-audit index sync). When the functions or
    //    graph_cache tables are empty/missing, we fall back to reporting on
    //    direct writes only — the basic signal is still useful without the
    //    call-graph context.
    const hasGraphData: boolean = (() => {
      try {
        const cnt = rawDb.prepare(
          "SELECT COUNT(*) AS n FROM graph_cache WHERE graph_type = 'call'",
        ).get() as { n: number } | null;
        return (cnt?.n ?? 0) > 0;
      } catch {
        return false;
      }
    })();

    // Build a lookup of function IDs from the functions table (only if it
    // has data — i.e., deepSync has been run).
    let fnIdLookup: Map<string, number> | null = null;
    if (hasGraphData) {
      try {
        const fnRows = rawDb.prepare(
          'SELECT id, name, file_path FROM functions',
        ).all() as Array<{ id: number; name: string; file_path: string }>;
        if (fnRows.length > 0) {
          fnIdLookup = new Map();
          for (const r of fnRows) {
            fnIdLookup.set(`${r.file_path}::${r.name}`, r.id);
          }
        }
      } catch {
        // functions table might not exist or be unpopulated
      }
    }

    for (const [key, funcData] of funcWrites) {
      const allTables = new Set(funcData.tables);

      // Depth-1 callee expansion: only when graph_cache and functions tables
      // are both populated. Without deepSync, this is skipped gracefully.
      if (fnIdLookup && hasGraphData) {
        const funcId = fnIdLookup.get(key);
        if (funcId !== undefined) {
          const calleeRows = rawDb
            .prepare(
              `SELECT neighbor_key FROM graph_cache
               WHERE graph_type = 'call' AND node_key = ?`,
            )
            .all(String(funcId)) as Array<{ neighbor_key: string }>;

          for (const callee of calleeRows) {
            const calleeFuncs = rawDb
              .prepare(
                `SELECT name, file_path FROM functions WHERE id = ?`,
              )
              .all(parseInt(callee.neighbor_key, 10)) as Array<{
              name: string;
              file_path: string;
            }>;

            for (const cf of calleeFuncs) {
              const calleeTables = rawDb
                .prepare(
                  `SELECT DISTINCT table_name FROM schema_usage
                   WHERE usage_type IN ('insert', 'update', 'delete', 'create')
                     AND function_name = ? AND file_path = ?`,
                )
                .all(cf.name, cf.file_path) as Array<{ table_name: string }>;

              for (const ct of calleeTables) {
                allTables.add(ct.table_name);
              }
            }
          }
        }
      }

      if (allTables.size >= txnTableMax) {
        const tableList = [...allTables].sort().join(', ');
        violations.push({
          file: funcData.filePath,
          line: funcData.line,
          column: 0,
          severity: 'suggestion',
          message: `Function writes to ${allTables.size} distinct tables (threshold: ${txnTableMax}): ${tableList}. This may indicate transaction-boundary risk — consider splitting writes across smaller transactional scopes.`,
          rule: 'cross-domain/transaction-boundary',
          analyzer: this.name,
          functionName: key.split('::')[1],
        });
      }
    }

    return violations;
  }

  // ── R3: Validation-Bypass ────────────────────────────────────────────────

  /**
   * Detect write functions that don't reach a validator, when a majority of
   * peer writers in the same directory do (BFS ≤ configurable depth).
   *
   * Validator identification (priority order):
   *   1. User-configured validators list
   *   2. Provenanced: exported functions in files importing VALIDATOR_PACKAGES
   *   3. Heuristic fallback: name GLOB 'validate*' OR 'assert*' (when both
   *      above are silent)
   */
  private detectValidationBypass(
    rawDb: any,
    config: ValidatorBypassConfig,
    filePath?: FilePathClause,
  ): Violation[] {
    const violations: Violation[] = [];
    const {
      validators: userValidators = [],
      modeShare = 0.8,
      minCorpus = 20,
      depth = 3,
    } = config;

    // ── 1. Build the validator function ID set ─────────────────────────────

    const validatorIds = new Set<number>();

    // 1a. User-configured validators (format: "funcName" or "path#funcName")
    for (const v of userValidators) {
      const hashIdx = v.indexOf('#');
      if (hashIdx >= 0) {
        const vPath = v.substring(0, hashIdx);
        const vName = v.substring(hashIdx + 1);
        const rows = rawDb
          .prepare('SELECT id FROM functions WHERE name = ? AND file_path = ?')
          .all(vName, vPath) as Array<{ id: number }>;
        for (const r of rows) validatorIds.add(r.id);
      } else {
        const rows = rawDb
          .prepare('SELECT id FROM functions WHERE name = ?')
          .all(v) as Array<{ id: number }>;
        for (const r of rows) validatorIds.add(r.id);
      }
    }

    // 1b. Provenanced validators: exported functions whose OWN used_imports
    //     includes a validator package. Per-identifier check — a function in
    //     a zod-importing file only qualifies if its own body uses the
    //     validator package, not just because it cohabits the file.
    if (validatorIds.size === 0) {
      const likeClauses = [...VALIDATOR_PACKAGES].map(() => 'used_imports LIKE ?');
      const likeParams = [...VALIDATOR_PACKAGES].map((pkg) => `%"${pkg}"%`);

      const validatorFuncs = rawDb
        .prepare(
          `SELECT id FROM functions
           WHERE used_imports IS NOT NULL
             AND (${likeClauses.join(' OR ')})
             AND is_exported = 1`,
        )
        .all(...likeParams) as Array<{ id: number }>;
      for (const f of validatorFuncs) validatorIds.add(f.id);
    }

    // 1c. Heuristic fallback: name-based matching (only when provenance
    //     found nothing AND no user-configured validators exist).
    if (validatorIds.size === 0 && userValidators.length === 0) {
      const heuristicFuncs = rawDb
        .prepare(
          `SELECT id FROM functions
           WHERE (name GLOB 'validate*' OR name GLOB 'assert*')
             AND is_exported = 1`,
        )
        .all() as Array<{ id: number }>;
      for (const f of heuristicFuncs) validatorIds.add(f.id);
    }

    if (validatorIds.size === 0) return violations;

    // ── 2. Find all writer functions from schema_usage ─────────────────────

    const fpAliasWhere = filePath
      ? `AND su.${filePath.clause.slice(4)}`
      : '';

    const writers = rawDb
      .prepare(
        `SELECT DISTINCT su.function_name, su.file_path, su.line, f.id as function_id
         FROM schema_usage su
         JOIN functions f ON f.name = su.function_name
                          AND f.file_path = su.file_path
         WHERE su.usage_type IN ('insert', 'update', 'delete', 'create')
         ${fpAliasWhere}
         ORDER BY su.file_path, su.function_name`,
      )
      .all(...(filePath ? [filePath.param] : [])) as Array<{
      function_name: string;
      file_path: string;
      line: number;
      function_id: number;
    }>;

    if (writers.length === 0) return violations;

    // ── 3. BFS from each writer to check validator reach ───────────────────

    interface WriterCoverage {
      covered: boolean;
      line: number;
      funcName: string;
    }
    const writerCoverage = new Map<string, WriterCoverage>();

    for (const w of writers) {
      const key = `${w.file_path}::${w.function_name}`;
      if (writerCoverage.has(key)) continue; // deduplicate
      const covered = this.bfsReachesValidator(
        rawDb,
        w.function_id,
        validatorIds,
        depth,
      );
      writerCoverage.set(key, {
        covered,
        line: w.line,
        funcName: w.function_name,
      });
    }

    // ── 4. Group writers by directory ──────────────────────────────────────

    interface DirWriter {
      key: string;
      covered: boolean;
      line: number;
      funcName: string;
      filePath: string;
    }
    const dirWriters = new Map<string, DirWriter[]>();
    const dirSeen = new Set<string>(); // deduplicate writers with multiple schema_usage rows

    for (const w of writers) {
      const dir = path.dirname(w.file_path);
      const key = `${w.file_path}::${w.function_name}`;
      const dirKey = `${dir}::${key}`;
      if (dirSeen.has(dirKey)) continue;
      dirSeen.add(dirKey);

      const cov = writerCoverage.get(key);
      if (!cov) continue;
      if (!dirWriters.has(dir)) dirWriters.set(dir, []);
      dirWriters.get(dir)!.push({
        key,
        covered: cov.covered,
        line: cov.line,
        funcName: cov.funcName,
        filePath: w.file_path,
      });
    }

    // ── 5. Flag uncovered writers in validator-dense directories ───────────

    for (const [dir, dirWriterList] of dirWriters) {
      if (dirWriterList.length < minCorpus) continue;

      const coveredCount = dirWriterList.filter((w) => w.covered).length;
      const ratio = coveredCount / dirWriterList.length;

      if (ratio >= modeShare) {
        for (const w of dirWriterList) {
          if (w.covered) continue;
          violations.push({
            file: w.filePath,
            line: w.line,
            column: 0,
            severity: 'suggestion',
            message:
              `Function '${w.funcName}' is not validated. ` +
              `${coveredCount}/${dirWriterList.length} peer writers in '${dir}' ` +
              `reach a validator but this function does not (BFS depth ≤ ${depth}). ` +
              `Consider adding input validation.`,
            rule: 'cross-domain/validation-bypass',
            analyzer: this.name,
            functionName: w.funcName,
          });
        }
      }
    }

    return violations;
  }

  // ── R4: Coverage by Importance ──────────────────────────────────────────

  /**
   * Detect exported, high-risk functions with no test coverage.
   * Uses the getUntestedTopDecile() query that joins functions with
   * hotspot_scores and coverage_data to find untested high-risk functions.
   *
   * Static-reach fallback: when no measured coverage exists, falls back
   * to static reach analysis from test files (BFS from test-file functions
   * into the call graph).
   */
  private detectUncoveredRisk(
    rawDb: any,
    coverage: CoverageConfig,
    filePath?: FilePathClause,
  ): Violation[] {
    const violations: Violation[] = [];
    const db = CodeIndexDB.getInstance();

    const topRiskDecile = coverage.topRiskDecile ?? 0.1;

    // Check if any measured coverage exists
    const measuredCount = (
      rawDb
        .prepare("SELECT COUNT(*) AS cnt FROM coverage_data WHERE basis = 'measured'")
        .get() as { cnt: number }
    ).cnt;

    if (measuredCount > 0) {
      // Use measured coverage data from lcov/istanbul imports
      const untested = db.getUntestedTopDecile(topRiskDecile);

      // Determine source format from existing coverage entries
      const sourceRow = rawDb
        .prepare(
          "SELECT source, imported_at FROM coverage_data WHERE basis = 'measured' LIMIT 1",
        )
        .get() as { source: string | null; imported_at: string | null } | undefined;
      const sourceFormat = sourceRow?.source ?? 'unknown';
      const importedAt = sourceRow?.imported_at ?? null;

      // Stale-import detection: measured coverage predates last full index sync
      let staleWarning: string | null = null;
      if (importedAt) {
        const lastSync = db.getMeta?.('last_full_sync_timestamp') ?? null;
        if (lastSync && importedAt < lastSync) {
          staleWarning =
            ` — WARNING: this coverage data may be stale (imported ${importedAt}, ` +
            `last index sync was ${lastSync}). ` +
            `Re-import with 'code-audit coverage --import <path>' for accurate results.`;
        }
      }

      for (const fn of untested) {
        violations.push({
          file: fn.filePath,
          line: fn.lineNumber ?? 1,
          column: 0,
          severity: 'suggestion',
          message:
            `Exported function '${fn.functionName}' (risk ${fn.riskScore.toFixed(3)}) has no measured test coverage. ` +
            `Top imported functions should have test coverage. Import coverage data with 'code-audit coverage --import <path>'.` +
            (staleWarning ?? ''),
          rule: 'cross-domain/uncovered-risk',
          analyzer: this.name,
          functionName: fn.functionName,
          basis: fn.basis,
          sourceFormat,
          ...(staleWarning ? { staleImport: true } : {}),
        });
      }
    } else {
      // Static-reach fallback: use the call graph to determine which
      // exported high-risk functions are reachable from test files
      const fpWhere = filePath ? 'AND f.file_path LIKE ?' : '';
      const params: any[] = [topRiskDecile];
      if (filePath) params.push(filePath.param);

      const highRiskFns = rawDb
        .prepare(
          `WITH ranked AS (
            SELECT
              f.name,
              f.file_path,
              f.line_number,
              f.id,
              COALESCE(hs.score, 0.0) as risk_score,
              PERCENT_RANK() OVER (ORDER BY COALESCE(hs.score, 0.0) DESC) as pct
            FROM functions f
            LEFT JOIN hotspot_scores hs ON hs.target = (f.file_path || ':' || f.name)
              AND hs.type = 'function'
            WHERE f.is_exported = 1
              ${fpWhere}
          )
          SELECT id, name, file_path, line_number, risk_score
          FROM ranked
          WHERE pct <= ?
          ORDER BY risk_score DESC`,
        )
        .all(...params) as Array<{
        id: number;
        name: string;
        file_path: string;
        line_number: number;
        risk_score: number;
      }>;

      if (highRiskFns.length === 0) return violations;

      // Find test-file functions to use as BFS starting points.
      const testGlobs = coverage.testGlobs ?? ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'];
      const testGlobPatterns = testGlobs.map((g: string) =>
        g.replace(/\*\*/g, '%').replace(/\*/g, '%'),
      );

      let testFileClause = '';
      const testFileParams: string[] = [];
      if (testGlobPatterns.length > 0) {
        testFileClause = testGlobPatterns
          .map((_p: string, i: number) => `file_path LIKE ?`)
          .join(' OR ');
        for (const p of testGlobPatterns) testFileParams.push(p);
      }

      const testFuncIds = new Set<number>();
      if (testFileClause) {
        const testFunctions = rawDb
          .prepare(`SELECT id FROM functions WHERE ${testFileClause}`)
          .all(...testFileParams) as Array<{ id: number }>;
        for (const tf of testFunctions) testFuncIds.add(tf.id);
      }

      // BFS from each test-file function through call graph (reverse: test
      // calls code under test). We traverse the call edges: if testFunc → X,
      // then X is reachable.
      const reachableIds = new Set<number>();
      const maxDepth = coverage.staticReachDepth ?? 2;

      if (testFuncIds.size > 0) {
        for (const startId of testFuncIds) {
          const visited = new Set<number>();
          let currentLevel = [startId];

          for (let d = 0; d < maxDepth; d++) {
            const nextLevel: number[] = [];
            for (const funcId of currentLevel) {
              if (visited.has(funcId)) continue;
              visited.add(funcId);
              reachableIds.add(funcId);

              const callees = rawDb
                .prepare(
                  `SELECT neighbor_key FROM graph_cache
                   WHERE graph_type = 'call' AND node_key = ?`,
                )
                .all(String(funcId)) as Array<{ neighbor_key: string }>;
              for (const callee of callees) {
                const calleeId = parseInt(callee.neighbor_key, 10);
                if (!isNaN(calleeId) && !visited.has(calleeId)) {
                  nextLevel.push(calleeId);
                }
              }
            }
            currentLevel = nextLevel;
          }
          // Check last level
          for (const funcId of currentLevel) {
            if (!reachableIds.has(funcId)) reachableIds.add(funcId);
          }
        }
      }

      // Flag high-risk functions not in the reachable set
      for (const fn of highRiskFns) {
        if (!reachableIds.has(fn.id)) {
          violations.push({
            file: fn.file_path,
            line: fn.line_number,
            column: 0,
            severity: 'suggestion',
            message:
              `Exported function '${fn.name}' (risk ${fn.risk_score.toFixed(3)}) is not reachable from known test files. ` +
              `Add test coverage or import measured coverage with 'code-audit coverage --import <path>'.`,
            rule: 'cross-domain/uncovered-risk',
            analyzer: this.name,
            functionName: fn.name,
            basis: 'static-reach',
          });
        }
      }
    }

    return violations;
  }

  /**
   * BFS through the call graph (graph_cache) up to maxDepth to check if
   * any path from startFuncId reaches a validator function ID.
   */
  private bfsReachesValidator(
    rawDb: any,
    startFuncId: number,
    validatorIds: Set<number>,
    maxDepth: number,
  ): boolean {
    const visited = new Set<number>();
    let currentLevel = [startFuncId];

    for (let d = 0; d < maxDepth; d++) {
      const nextLevel: number[] = [];

      for (const funcId of currentLevel) {
        if (validatorIds.has(funcId)) return true;
        if (visited.has(funcId)) continue;
        visited.add(funcId);

        // Get callees from graph_cache call edges
        const callees = rawDb
          .prepare(
            `SELECT neighbor_key FROM graph_cache
             WHERE graph_type = 'call' AND node_key = ?`,
          )
          .all(String(funcId)) as Array<{ neighbor_key: string }>;

        for (const callee of callees) {
          const calleeId = parseInt(callee.neighbor_key, 10);
          if (!isNaN(calleeId) && !visited.has(calleeId)) {
            nextLevel.push(calleeId);
          }
        }
      }

      currentLevel = nextLevel;
    }

    // Check any remaining nodes at the final level
    for (const funcId of currentLevel) {
      if (validatorIds.has(funcId)) return true;
    }

    return false;
  }
}
