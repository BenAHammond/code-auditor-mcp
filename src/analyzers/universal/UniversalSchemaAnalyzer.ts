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
  extractTablesFromRegistry,
} from './schema/discovery.js';

export {
  parseMigrationOps,
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
    const schemas = config.schemas;
    const projectRoot = (config as any).projectRoot || process.cwd();
    if (!schemas || schemas.length === 0) {
      const fromWrangler = await discoverTablesFromWrangler(projectRoot);
      const schemaFiles = (config as SchemaAnalyzerConfig).schemaFiles;
      const fromSchemaFiles = schemaFiles && schemaFiles.length > 0
        ? await discoverTablesFromSchemaFiles(schemaFiles, projectRoot)
        : new Set<string>();
      const fromMigrations = await discoverTablesFromMigrations(projectRoot, config);
      const fromOrm = await discoverTablesFromOrmSchemas(codeFiles);
      const discovered = new Set([
        ...fromWrangler,
        ...fromSchemaFiles,
        ...fromMigrations,
        ...fromOrm,
      ]);
      if (discovered.size > 0) {
        config = {
          ...config,
          schemas: [{
            name: 'auto-discovered',
            tables: [...discovered].map(name => ({ name, columns: [] })),
          }],
        };
      }
    }

    const codeResult = codeFiles.length > 0 ? await super.analyze(codeFiles, config) : {
      violations: [] as Violation[],
      executionTime: 0,
      status: makeVisitorStatus(0),
      analyzerName: this.name,
      errors: [] as Array<{ file: string; error: string }>,
      filesProcessed: 0,
    };

    // Adapt JSON handling to the pipeline-style analyzeJsonSchemas(files, readJson) signature.
    let jsonResult: AnalyzerResult = {
      violations: [],
      executionTime: 0,
      status: makeVisitorStatus(0),
      analyzerName: this.name,
      errors: [],
      filesProcessed: 0,
    };
    if (jsonFiles.length > 0) {
      const readJson = (file: string): object | null => {
        try {
          const raw = readFileSync(file, 'utf8');
          const parsed = JSON.parse(raw);
          return parsed !== null && typeof parsed === 'object' ? (parsed as object) : null;
        } catch {
          return null;
        }
      };
      jsonResult = analyzeJsonSchemas(jsonFiles, readJson, config);
    }

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

    // Spec 21: Build provenance context for this file (R1 — provenance-primary detection)
    const detectionMode: DetectionMode =
      (config as any).detection?.mode ?? 'hybrid';
    const provenanceContext = buildProvenanceContext(ast, adapter, sourceCode, {
      mode: detectionMode,
      dbReceiverNames: finalConfig.dbReceiverNames ?? DEFAULT_SCHEMA_CONFIG.dbReceiverNames,
      dbBindingNames: finalConfig.dbBindingNames ?? DEFAULT_SCHEMA_CONFIG.dbBindingNames,
      dbCallMethods: finalConfig.dbCallMethods ?? DEFAULT_SCHEMA_CONFIG.dbCallMethods,
      dbWrapperNames: finalConfig.dbWrapperNames ?? DEFAULT_SCHEMA_CONFIG.dbWrapperNames,
    });

    // R2.2 — File gate: only analyze files with DB context (Spec 21: provenance-based)
    if (!passesFileGate(ast.filePath, sourceCode, finalConfig, provenanceContext)) {
      return violations;
    }

    // Get available schemas
    const schemas = finalConfig.schemas || [];
    const allTables = new Set<string>();

    for (const schema of schemas) {
      for (const table of schema.tables) {
        allTables.add(table.name);
      }
    }

    if (finalConfig.requiredSchemas && finalConfig.requiredSchemas.length > 0 && schemas.length === 0) {
      violations.push(this.createViolation(
        ast.filePath,
        { line: 1, column: 1 },
        'No database schemas loaded for analysis',
        'warning',
        'missing-schemas',
        'top-level:missing-schemas'
      ));
      return violations;
    }

    // R2.1 — AST-based table reference extraction (replaces legacy regex scan-all-strings)
    // Spec 21: Uses provenance context for DB-call pattern detection
    const tableRefs = findTableReferences(ast, adapter, sourceCode, finalConfig, provenanceContext, allTables);

    // Spec 15 R1 — Record schema usage for cross-domain lifecycle analysis.
    // Idempotent per-file: clear stale entries before inserting fresh references.
    if (finalConfig.enableTableUsageTracking) {
      this.recordTableUsage(ast, adapter, ast.filePath, tableRefs);
    }

    // Check for missing table references — R2.4: Levenshtein suggestions
    if (finalConfig.checkMissingReferences) {
      violations.push(...checkMissingReferences(tableRefs, allTables, ast.filePath));
    }

    // Check naming conventions
    if (finalConfig.checkNamingConventions) {
      violations.push(...checkNamingConventions(tableRefs, ast.filePath));
    }

    // Check query patterns
    if (finalConfig.validateQueryPatterns) {
      violations.push(...checkQueryPatterns(ast, adapter, sourceCode, finalConfig));
    }

    // Check for SQL injection patterns
    violations.push(...checkSQLInjection(ast, adapter, sourceCode));

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

import { analyzeJsonSchemas } from './schema/jsonSchema.js';

export { analyzeJsonSchemas };
