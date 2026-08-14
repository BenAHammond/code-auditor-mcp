/**
 * Base class for universal analyzers that work across languages
 */

import type { AnalyzerResult, Violation } from '../types.js';
import type { AST, LanguageAdapter } from './types.js';
import { LanguageRegistry } from './LanguageRegistry.js';
import { resolvePathProfile } from '../config/pathProfiles.js';
import { promises as fs } from 'fs';
import { makeVisitorStatus } from '../pipeline.js';

export interface UniversalAnalyzerOptions {
  progressCallback?: (progress: number) => void;
  [key: string]: any;
}

/**
 * Map of rule-id → severity for overriding built-in severity defaults.
 *
 * Example: `{ "sql-injection-risk": "critical" }` restores the original
 * critical severity for SQL injection findings.
 */
export type SeverityOverrides = Record<string, 'critical' | 'warning' | 'suggestion'>;

/**
 * Universal analyzer.
 */
export abstract class UniversalAnalyzer {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly category: string;
  
  /**
   * Main entry point - processes files and returns violations
   * @param config
   * @param files
   * @param options
   * @returns
   */
  async analyze(
    files: string[],
    config: any = {},
    options: UniversalAnalyzerOptions = {}
  ): Promise<AnalyzerResult> {
    const startTime = Date.now();

    // Extract severityOverrides from config before passing to analyzers.
    // This is a base-class feature — individual analyzers don't need to
    // know about it. Overrides are applied after analyzeAST returns.
    const severityOverrides: SeverityOverrides = config.severityOverrides ?? {};
    const configWithoutOverrides = { ...config };
    delete configWithoutOverrides.severityOverrides;

    // Extract path profiles and project root from config (Spec-20).
    // These are applied per-file in the loop below and should not leak
    // to individual analyzers.
    const pathProfiles = config.pathProfiles;
    const projectRoot: string | undefined = config.projectRoot;
    delete configWithoutOverrides.pathProfiles;
    delete configWithoutOverrides.projectRoot;

    const filesByAdapter = this.groupFilesByAdapter(files);
    const { violations, errors, filesProcessed } = await this.processFiles(
      filesByAdapter,
      configWithoutOverrides,
      pathProfiles,
      projectRoot,
      options,
      files.length
    );

    const filteredViolations = this.applySeverityPipeline(violations, severityOverrides);

    return {
      violations: filteredViolations,
      errors,
      status: makeVisitorStatus(filesProcessed),
      executionTime: Date.now() - startTime,
      analyzerName: this.name,
      metrics: {
        filesAnalyzed: filesProcessed,
        totalViolations: violations.length,
        executionTime: Date.now() - startTime
      }
    };
  }

  /**
   * Parse and analyze each file, resolving per-file path profiles (Spec-20).
   */
  private async processFiles(
    filesByAdapter: Map<LanguageAdapter, string[]>,
    configWithoutOverrides: any,
    pathProfiles: any,
    projectRoot: string | undefined,
    options: UniversalAnalyzerOptions,
    totalFiles: number
  ): Promise<{ violations: Violation[]; errors: Array<{ file: string; error: string }>; filesProcessed: number }> {
    const violations: Violation[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    let filesProcessed = 0;

    for (const [adapter, adapterFiles] of filesByAdapter) {
      for (const file of adapterFiles) {
        try {
          const content = await fs.readFile(file, 'utf8');
          const ast = await adapter.parse(file, content);

          if (ast.errors.length > 0) {
            // Record parse errors but continue
            errors.push(...ast.errors.map(e => ({
              file,
              error: `Parse error: ${e.message}`
            })));
          }

          // Resolve path profiles for this file (Spec-20)
          let fileConfig = configWithoutOverrides;
          let fileSeverityCap: string | undefined;
          let fileProfileNames: string[] = [];
          if (pathProfiles && projectRoot && pathProfiles.length > 0) {
            const resolved = resolvePathProfile(file, projectRoot, pathProfiles);
            if (Object.keys(resolved.overrides).length > 0) {
              fileConfig = { ...configWithoutOverrides, ...resolved.overrides };
            }
            fileSeverityCap = resolved.severityCap;
            fileProfileNames = resolved.matchedProfileNames;
          }

          // Run language-agnostic analysis
          const fileViolations = await this.analyzeAST(
            ast,
            adapter,
            fileConfig,
            content
          );

          // Attach profile attribution (last matching profile wins on merge)
          if (fileProfileNames.length > 0) {
            for (const v of fileViolations) {
              v.profile = fileProfileNames[fileProfileNames.length - 1];
            }
          }

          // Store severity cap for post-processing (applied after severityOverrides
          // so path-level caps beat global per-rule promotions — intentional design,
          // documented in Spec-20)
          if (fileSeverityCap) {
            for (const v of fileViolations) {
              (v as any)._severityCap = fileSeverityCap;
            }
          }

          violations.push(...fileViolations);

          filesProcessed++;
          if (options.progressCallback) {
            options.progressCallback(filesProcessed / totalFiles);
          }
        } catch (error) {
          console.error(`[${this.name}] Error processing file ${file}:`, error);
          errors.push({
            file,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    return { violations, errors, filesProcessed };
  }

  /**
   * Apply severity overrides, filter 'off' severities, then apply path-profile
   * severity caps (Spec-11 R5, Spec-20). Order is intentional and tested:
   * caps run AFTER overrides so path-level caps beat global per-rule promotions.
   */
  private applySeverityPipeline(violations: Violation[], severityOverrides: SeverityOverrides): Violation[] {
    if (Object.keys(severityOverrides).length > 0) {
      for (const v of violations) {
        const override = severityOverrides[v.rule];
        if (override) {
          v.severity = override;
        }
      }
    }

    // Filter out violations whose severity was overridden to 'off' (Spec-11 R5).
    // Must happen before severity caps so 'off' violations are removed entirely.
    const filteredViolations = violations.filter(v => v.severity !== 'off');

    const severityOrder = ['suggestion', 'warning', 'critical'];
    for (const v of filteredViolations) {
      const cap = (v as any)._severityCap as string | undefined;
      if (cap) {
        const capIndex = severityOrder.indexOf(cap);
        if (severityOrder.indexOf(v.severity) > capIndex) {
          v.severity = cap as 'critical' | 'warning' | 'suggestion';
        }
        delete (v as any)._severityCap;
      }
    }

    return filteredViolations;
  }
  
  /**
   * Implement this method to analyze an AST
   */
  protected abstract analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: any,
    sourceCode: string
  ): Promise<Violation[]>;
  
  /**
   * Group files by their corresponding language adapter
   */
  private groupFilesByAdapter(files: string[]): Map<LanguageAdapter, string[]> {
    const registry = LanguageRegistry.getInstance();
    const groups = new Map<LanguageAdapter, string[]>();
    
    for (const file of files) {
      const adapter = registry.getAdapterForFile(file);
      if (adapter) {
        const adapterFiles = groups.get(adapter) || [];
        adapterFiles.push(file);
        groups.set(adapter, adapterFiles);
      }
    }
    
    return groups;
  }
  
  /**
   * Helper method to create a violation.
   *
   * The optional `symbol` is set as the violation's functionName (used for
   * diff-scoped detection). Callers that need a structured fix patch attach
   * `v.fix` to the returned object — `fix` was folded out of this signature to
   * keep the arity honest (the only two callers that set it are in DRY).
   */
  protected createViolation(
    file: string,
    location: { line: number; column: number },
    message: string,
    severity: 'critical' | 'warning' | 'suggestion',
    rule: string,
    symbol?: string
  ): Violation {
    // Tree-sitter uses 0-based line numbers. Convert to 1-based for all
    // toSourceLocation() now returns 1-based positions — no compensation needed.
    const v: Violation = {
      file,
      line: location.line,
      column: location.column,
      severity,
      message,
      rule,
      analyzer: this.name
    };
    if (symbol) {
      v.functionName = symbol;
    }
    return v;
  }
}