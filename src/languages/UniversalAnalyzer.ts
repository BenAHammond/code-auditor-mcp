/**
 * Base class for universal analyzers that work across languages
 */

import type { AnalyzerDefinition, AnalyzerResult, Violation } from '../types.js';
import type { AST, LanguageAdapter } from './types.js';
import { LanguageRegistry } from './LanguageRegistry.js';
import { promises as fs } from 'fs';

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

export abstract class UniversalAnalyzer implements AnalyzerDefinition {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly category: string;
  
  /**
   * Main entry point - processes files and returns violations
   */
  async analyze(
    files: string[],
    config: any = {},
    options: UniversalAnalyzerOptions = {}
  ): Promise<AnalyzerResult> {
    const violations: Violation[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    const startTime = Date.now();

    // Extract severityOverrides from config before passing to analyzers.
    // This is a base-class feature — individual analyzers don't need to
    // know about it. Overrides are applied after analyzeAST returns.
    const severityOverrides: SeverityOverrides = config.severityOverrides ?? {};
    const configWithoutOverrides = { ...config };
    delete configWithoutOverrides.severityOverrides;

    // Group files by language
    const filesByAdapter = this.groupFilesByAdapter(files);
    
    let filesProcessed = 0;
    const totalFiles = files.length;
    
    // Process each language group
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
          
          // Run language-agnostic analysis
          const fileViolations = await this.analyzeAST(
            ast,
            adapter,
            configWithoutOverrides,
            content
          );
          
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
    
    // Apply severity overrides to all violations
    if (Object.keys(severityOverrides).length > 0) {
      for (const v of violations) {
        const override = severityOverrides[v.rule];
        if (override) {
          v.severity = override;
        }
      }
    }

    return {
      violations,
      errors,
      filesProcessed,
      executionTime: Date.now() - startTime,
      metrics: {
        filesAnalyzed: filesProcessed,
        totalViolations: violations.length,
        executionTime: Date.now() - startTime
      }
    };
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
   * Helper method to create a violation
   */
  protected createViolation(
    file: string,
    location: { line: number; column: number },
    message: string,
    severity: 'critical' | 'warning' | 'suggestion',
    rule: string,
    fix?: { oldText: string; newText: string }
  ): Violation {
    return {
      file,
      line: location.line,
      column: location.column,
      severity,
      message,
      rule,
      analyzer: this.name,
      fix
    };
  }
}