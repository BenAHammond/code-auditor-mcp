/**
 * Universal Schema Analyzer — Spec 17 R2
 *
 * R2.1: SQL-context-only extraction (AST-based, not regex scan-all-strings).
 * R2.2: File gate — only analyze files with DB usage indicators.
 * R2.3: Template expressions resolve to wildcards for known-table matching.
 * R2.4: Unknown-table findings include SQL kind, line, and Levenshtein suggestions.
 * R2.5: Legacy scan-all-strings path DELETED.
 * R7:   schema/unknown-table severity is "suggestion".
 */

import { readFileSync } from 'node:fs';
import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import { withRuleTiming } from '../ruleTiming.js';
import type { Violation, Violation as BaseViolation, AnalyzerResult, SchemaUsage } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../languages/types.js';
import {
  buildProvenanceContext,
  type ProvenanceContext,
  type DetectionMode,
} from '../provenance.js';
import { makeVisitorStatus } from '../../pipeline.js';

// Spec 34 — schema analyzer split (Step 0 reconciliation): shared types,
// SQL-context constants, and migration/DDL helpers now live in schema/
// submodules. Imported here for the class + standalone JSON-schema functions,
// then re-exported to preserve this file's public surface (pipelineAdapters.ts
// and UniversalDataAccessAnalyzer.ts import from this module).
import {
  parseMigrationOps,
  extractDdlColumnNames,
  extractReExports,
  sqlFileHasDdl,
  extractMigrationOpsFromFile,
} from './schema/migrations.js';
import {
  DB_RECEIVER_NAMES,
  DB_CALL_METHOD_NAMES,
  DB_BINDING_NAMES,
  DB_WRAPPER_NAMES,
  SQL_TAG_NAMES,
  DEFAULT_SCHEMA_CONFIG,
} from './schema/config.js';
import type {
  SchemaAnalyzerConfig,
  TableReference,
  TableSourceEntry,
  TableProvenance,
  TableCatalogEntry,
  RegistryExtractionContext,
  MigrationOp,
  ReExport,
} from './schema/types.js';
import {
  findTableReferences,
  checkMissingReferences,
  checkNamingConventions,
  checkQueryPatterns,
  checkSQLInjection,
  findClosestNodeAt,
  findEnclosingFunctionName,
} from './schema/codeAnalysis.js';
import {
  discoverTablesFromMigrations,
  discoverTablesFromWrangler,
  discoverTablesFromSchemaFiles,
  discoverTablesFromOrmSchemas,
  passesFileGate,
  anyFileHasDbContext,
  extractTablesFromRegistry,
} from './schema/discovery.js';

export {
  parseMigrationOps,
  extractDdlColumnNames,
  extractReExports,
  sqlFileHasDdl,
  extractMigrationOpsFromFile,
  DB_RECEIVER_NAMES,
  DB_CALL_METHOD_NAMES,
  DB_BINDING_NAMES,
  DB_WRAPPER_NAMES,
  SQL_TAG_NAMES,
  DEFAULT_SCHEMA_CONFIG,
};
export type {
  SchemaAnalyzerConfig,
  TableReference,
  TableSourceEntry,
  TableProvenance,
  TableCatalogEntry,
  RegistryExtractionContext,
  MigrationOp,
  ReExport,
};

/**
 * Universal schema analyzer.
 */
export class UniversalSchemaAnalyzer extends UniversalAnalyzer {
  readonly name = 'schema';
  readonly description = 'Analyzes code against database schemas and validates JSON schemas';
  readonly category = 'database';

  // Spec 25 B4 — Queue schema records for the pipeline to write after stage 2.
  // Was: direct CodeIndexDB.getInstance() call in recordTableUsage.
  private _pendingSchemaRecords: { clearFiles: string[]; usages: SchemaUsage[] } = { clearFiles: [], usages: [] };

  /**
   * Standalone analyze() override for backward compatibility with direct analyzer
   * calls (e.g., tests and non-pipeline audit paths). All production analysis now
   * flows through the pipeline visitors, but this method is preserved so tests
   * that call analyzer.analyze([file], config) continue to work.
   * @param config
   * @param files
   * @returns
   */
  async analyze(files: string[], config: any): Promise<AnalyzerResult> {
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const codeFiles = files.filter(f => !f.endsWith('.json'));

    // Auto-discover known tables when no schemas are configured.
    config = await resolveSchemasViaAutoDiscovery(config, codeFiles);

    const codeResult = codeFiles.length > 0
      ? await super.analyze(codeFiles, config)
      : emptySchemaResult(this.name);
    const jsonResult = analyzeJsonFiles(jsonFiles, config, this.name);

    return {
      violations: [...codeResult.violations, ...jsonResult.violations],
      executionTime: (codeResult.executionTime || 0) + (jsonResult.executionTime || 0),
      status: makeVisitorStatus((codeResult.filesProcessed ?? 0) + (jsonResult.filesProcessed ?? 0)),
      analyzerName: this.name,
      errors: [...(codeResult.errors || []), ...(jsonResult.errors || [])],
      filesProcessed: (codeResult.filesProcessed ?? 0) + (jsonResult.filesProcessed ?? 0),
    };
  }

  // analyzeAST is required by the protected abstract in UniversalAnalyzer.
  // In production, all schema analysis flows through the pipeline visitors.
  // This method is preserved for backward compatibility with direct test calls.
  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: SchemaAnalyzerConfig,
    sourceCode: string
  ): Promise<Violation[]> {
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_SCHEMA_CONFIG, ...config };
    const provenanceContext = buildSchemaProvenanceContext(ast, adapter, sourceCode, finalConfig);

    // R2.2 — File gate: only analyze files with DB context (Spec 21: provenance-based)
    if (!passesFileGate(ast.filePath, sourceCode, finalConfig, provenanceContext)) {
      return violations;
    }

    const schemas = finalConfig.schemas || [];
    const allTables = collectAllTableNames(schemas);

    if (finalConfig.requiredSchemas && finalConfig.requiredSchemas.length > 0 && schemas.length === 0) {
      violations.push(this.createViolation(
        ast.filePath,
        { line: 1, column: 1 },
        'No database schemas loaded for analysis',
        { severity: 'warning', rule: 'missing-schemas', symbol: 'top-level:missing-schemas' }
      ));
      return violations;
    }

    // R2.1 — AST-based table reference extraction (replaces legacy regex scan-all-strings)
    const tableRefs = findTableReferences(ast, adapter, sourceCode, { config: finalConfig, provenanceContext, allTables });

    // Spec 15 R1 — Record schema usage for cross-domain lifecycle analysis.
    if (finalConfig.enableTableUsageTracking) {
      this.recordTableUsage(ast, adapter, ast.filePath, tableRefs);
    }

    appendSchemaViolations(violations, {
      ast,
      adapter,
      sourceCode,
      config: finalConfig,
      tableRefs,
      allTables,
    });

    return violations;
  }

  /**
   * Spec 15 R1 — Record extracted table references to schema_usage for
   * cross-domain lifecycle analysis (written-never-read, read-never-written,
   * transaction-boundary risk).
   *
   * Idempotent per-file: stale entries are cleared before fresh references
   * are inserted. For .sql/migration files, uses "schema-file" as the
   * function name since there's no AST function context.
   * @returns
   * @param adapter
   * @param ast
   * @param filePath
   * @param references
   * @returns
   */
  public recordTableUsage(
    ast: AST,
    adapter: LanguageAdapter,
    filePath: string,
    references: TableReference[],
  ): void {
    try {
      this._pendingSchemaRecords.clearFiles.push(filePath);

      for (const ref of references) {
        // Find enclosing function from the AST position
        const node = findClosestNodeAt(ast.root, ref.location, adapter);
        const functionName = node
          ? findEnclosingFunctionName(node, adapter)
          : ast.filePath.endsWith('.sql') || ast.filePath.includes('/migrations/')
            ? 'schema-file'
            : 'top-level';

        this._pendingSchemaRecords.usages.push({
          tableName: ref.table,
          filePath,
          functionName,
          usageType: ref.type,
          line: ref.location.line,
          column: ref.location.column,
          rawQuery: ref.context,
        });
      }
    } catch {
      // Schema recording is best-effort — failures don't block analysis.
    }
  }

  /**
   * Spec 25 B4 — Drain pending schema records for the pipeline to write.
   * @returns
   */
  getPendingSchemaRecords(): { clearFiles: string[]; usages: SchemaUsage[] } {
    const records = this._pendingSchemaRecords;
    this._pendingSchemaRecords = { clearFiles: [], usages: [] };
    return records;
  }

}

// ── Spec 34 — analyze()/analyzeAST() extraction helpers ────────────────
// Extracted from the two methods above to keep them under the 50-line
// function-length gate. Pure module-level functions (no `this`), consistent
// with the functional-analyzer pattern.

/**
 * Auto-discover known tables when no schemas are configured, returning the
 * (possibly augmented) config. When schemas are already present, returns the
 * config unchanged.
 */
async function resolveSchemasViaAutoDiscovery(config: any, codeFiles: string[]): Promise<any> {
  const schemas = config.schemas;
  if (schemas && schemas.length > 0) {
    return config;
  }
  const projectRoot = (config as any).projectRoot || process.cwd();
  const fromWrangler = await discoverTablesFromWrangler(projectRoot);
  const schemaFiles = (config as SchemaAnalyzerConfig).schemaFiles;
  const fromSchemaFiles = schemaFiles && schemaFiles.length > 0
    ? await discoverTablesFromSchemaFiles(schemaFiles, projectRoot)
    : new Set<string>();
  // Skip the full-repo migration walk when no analyzed file shows DB context.
  const fromMigrations = await anyFileHasDbContext(codeFiles, config)
    ? await discoverTablesFromMigrations(projectRoot, config)
    : new Set<string>();
  const fromOrm = await discoverTablesFromOrmSchemas(codeFiles);
  const discovered = new Set([
    ...fromWrangler,
    ...fromSchemaFiles,
    ...fromMigrations,
    ...fromOrm,
  ]);
  if (discovered.size === 0) {
    return config;
  }
  return {
    ...config,
    schemas: [{
      name: 'auto-discovered',
      tables: [...discovered].map(name => ({ name, columns: [] })),
    }],
  };
}

function emptySchemaResult(analyzerName: string): AnalyzerResult {
  return {
    violations: [],
    executionTime: 0,
    status: makeVisitorStatus(0),
    analyzerName,
    errors: [],
    filesProcessed: 0,
  };
}

function analyzeJsonFiles(jsonFiles: string[], config: any, analyzerName: string): AnalyzerResult {
  if (jsonFiles.length === 0) {
    return emptySchemaResult(analyzerName);
  }
  const readJson = (file: string): object | null => {
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? (parsed as object) : null;
    } catch {
      return null;
    }
  };
  return analyzeJsonSchemas(jsonFiles, readJson, config);
}

function buildSchemaProvenanceContext(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config: SchemaAnalyzerConfig,
): ProvenanceContext {
  const detectionMode: DetectionMode = (config as any).detection?.mode ?? 'hybrid';
  return buildProvenanceContext(ast, adapter, sourceCode, {
    mode: detectionMode,
    dbReceiverNames: config.dbReceiverNames ?? DEFAULT_SCHEMA_CONFIG.dbReceiverNames,
    dbBindingNames: config.dbBindingNames ?? DEFAULT_SCHEMA_CONFIG.dbBindingNames,
    dbCallMethods: config.dbCallMethods ?? DEFAULT_SCHEMA_CONFIG.dbCallMethods,
    dbWrapperNames: config.dbWrapperNames ?? DEFAULT_SCHEMA_CONFIG.dbWrapperNames,
  });
}

function collectAllTableNames(schemas: SchemaAnalyzerConfig['schemas']): Set<string> {
  const allTables = new Set<string>();
  for (const schema of schemas ?? []) {
    for (const table of schema.tables) {
      allTables.add(table.name);
    }
  }
  return allTables;
}

interface SchemaViolationContext {
  ast: AST;
  adapter: LanguageAdapter;
  sourceCode: string;
  config: SchemaAnalyzerConfig;
  tableRefs: TableReference[];
  allTables: Set<string>;
}

function appendSchemaViolations(
  violations: Violation[],
  ctx: SchemaViolationContext,
): void {
  const { ast, adapter, sourceCode, config, tableRefs, allTables } = ctx;
  // Check for missing table references — R2.4: Levenshtein suggestions
  if (config.checkMissingReferences) {
    violations.push(...withRuleTiming('unknown-table', () =>
      checkMissingReferences(tableRefs, allTables, ast.filePath)));
  }
  if (config.checkNamingConventions) {
    violations.push(...checkNamingConventions(tableRefs, ast.filePath));
  }
  if (config.validateQueryPatterns) {
    violations.push(...checkQueryPatterns(ast, adapter, sourceCode, config));
  }
  // Check for SQL injection patterns
  violations.push(...checkSQLInjection(ast, adapter, sourceCode));
}

import { analyzeJsonSchemas } from './schema/jsonSchema.js';

export { analyzeJsonSchemas };
