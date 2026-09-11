/**
 * Base class for universal analyzers that work across languages
 */

import type { AnalyzerResult, Violation, Resolution, Severity } from '../types.js';
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
 * Bundled "how is this violation classified" inputs for createViolation: the
 * severity + rule + optional symbol always travel together, so they are passed
 * as one object rather than three trailing positional parameters.
 */
export interface ViolationClassification {
  severity: Severity;
  rule: string;
  symbol?: string;
  /** Spec 37 R1 — structured next action carried on gating findings. */
  resolution?: Resolution;
}

/**
 * Bundled inputs for the per-file processing loop: the config (with overrides
 * already stripped), the path-profile table, the project root, the run options,
 * and the total file count used for progress reporting.
 */
interface ProcessContext {
  config: any;
  pathProfiles: any;
  projectRoot: string | undefined;
  options: UniversalAnalyzerOptions;
  totalFiles: number;
}

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

    // Extract path profiles and project root from config (Spec-20).
    // These are applied per-file in the loop below and should not leak
    // to individual analyzers.
    const pathProfiles = config.pathProfiles;
    const projectRoot: string | undefined = config.projectRoot;
    const configWithoutOverrides = { ...config };
    delete configWithoutOverrides.pathProfiles;
    delete configWithoutOverrides.projectRoot;

    const filesByAdapter = this.groupFilesByAdapter(files);
    const { violations, errors, filesProcessed } = await this.processFiles(filesByAdapter, {
      config: configWithoutOverrides,
      pathProfiles,
      projectRoot,
      options,
      totalFiles: files.length,
    });

    return {
      violations,
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
    ctx: ProcessContext
  ): Promise<{ violations: Violation[]; errors: Array<{ file: string; error: string }>; filesProcessed: number }> {
    const violations: Violation[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    let filesProcessed = 0;

    for (const [adapter, adapterFiles] of filesByAdapter) {
      for (const file of adapterFiles) {
        const result = await this.processFile(adapter, file, ctx);
        violations.push(...result.violations);
        errors.push(...result.errors);
        if (result.processed) {
          filesProcessed++;
          if (ctx.options.progressCallback) {
            ctx.options.progressCallback(filesProcessed / ctx.totalFiles);
          }
        }
      }
    }

    return { violations, errors, filesProcessed };
  }

  /**
   * Analyze a single file: read + parse, resolve its path profile (Spec-20),
   * run analyzeAST, and attach profile/severity-cap attribution. Failures are
   * captured as errors rather than thrown so one bad file never aborts a run.
   */
  private async processFile(
    adapter: LanguageAdapter,
    file: string,
    ctx: ProcessContext
  ): Promise<{ violations: Violation[]; errors: Array<{ file: string; error: string }>; processed: boolean }> {
    const { config } = ctx;
    try {
      const content = await fs.readFile(file, 'utf8');
      const ast = await adapter.parse(file, content);

      const errors: Array<{ file: string; error: string }> = [];
      if (ast.errors.length > 0) {
        // Record parse errors but continue
        errors.push(...ast.errors.map(e => ({
          file,
          error: `Parse error: ${e.message}`
        })));
      }

      // Resolve path profiles for this file (Spec-20, Spec-36 R4), then run analysis.
      const { fileConfig, fileGateExcluded, fileProfileNames } =
        this.applyPathProfile(file, config, ctx);

      const fileViolations = await this.analyzeAST(ast, adapter, fileConfig, content);

      this.attachProfileMetadata(fileViolations, fileProfileNames, fileGateExcluded);

      return { violations: fileViolations, errors, processed: true };
    } catch (error) {
      console.error(`[${this.name}] Error processing file ${file}:`, error);
      return {
        violations: [],
        errors: [{ file, error: error instanceof Error ? error.message : String(error) }],
        processed: false,
      };
    }
  }

  /**
   * Resolve per-file config, gate exclusion, and matched profiles (Spec-20, Spec-36 R4).
   */
  private applyPathProfile(
    file: string,
    config: any,
    ctx: ProcessContext
  ): { fileConfig: any; fileGateExcluded: boolean; fileProfileNames: string[] } {
    const { pathProfiles, projectRoot } = ctx;
    let fileConfig = config;
    let fileGateExcluded = false;
    let fileProfileNames: string[] = [];
    if (pathProfiles && projectRoot && pathProfiles.length > 0) {
      const resolved = resolvePathProfile(file, projectRoot, pathProfiles);
      if (Object.keys(resolved.overrides).length > 0) {
        fileConfig = { ...config, ...resolved.overrides };
      }
      fileGateExcluded = resolved.excludeFromGate === true;
      fileProfileNames = resolved.matchedProfileNames;
    }
    return { fileConfig, fileGateExcluded, fileProfileNames };
  }

  /**
   * Attach profile attribution and gate exclusion to violations (Spec-36 R4).
   * A path profile excludes a file from the blocking gate; it never softens a
   * finding within it (the old severity cap is removed).
   */
  private attachProfileMetadata(
    fileViolations: Violation[],
    fileProfileNames: string[],
    fileGateExcluded: boolean
  ): void {
    if (fileProfileNames.length > 0) {
      for (const v of fileViolations) {
        v.profile = fileProfileNames[fileProfileNames.length - 1];
      }
    }
    if (fileGateExcluded) {
      for (const v of fileViolations) {
        v.gateExcluded = true;
      }
    }
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
    classification: ViolationClassification
  ): Violation {
    const { severity, rule, symbol } = classification;
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
    if (classification.resolution) {
      v.resolution = classification.resolution;
    }
    return v;
  }
}