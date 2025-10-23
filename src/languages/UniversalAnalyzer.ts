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
    console.error(`[DEBUG] ${this.name}: UniversalAnalyzer.analyze() called with files:`, files);
    const violations: Violation[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    const startTime = Date.now();
    
    // Group files by language
    const filesByAdapter = this.groupFilesByAdapter(files);
    console.error(`[DEBUG] ${this.name}: Grouped files by adapter:`, [...filesByAdapter.keys()].map(a => a.constructor.name));
    
    let filesProcessed = 0;
    const totalFiles = files.length;
    
    // Process each language group
    for (const [adapter, adapterFiles] of filesByAdapter) {
      console.error(`[DEBUG] ${this.name}: Processing ${adapterFiles.length} files with adapter:`, adapter.constructor.name);
      for (const file of adapterFiles) {
        console.error(`[DEBUG] ${this.name}: Processing file:`, file);
        try {
          const content = await fs.readFile(file, 'utf8');
          console.error(`[DEBUG] ${this.name}: Read file content, length:`, content.length);
          const ast = await adapter.parse(file, content);
          console.error(`[DEBUG] ${this.name}: Parsed AST, errors:`, ast.errors.length);
          
          if (ast.errors.length > 0) {
            // Record parse errors but continue
            console.error(`[DEBUG] ${this.name}: Parse errors:`, ast.errors);
            errors.push(...ast.errors.map(e => ({
              file,
              error: `Parse error: ${e.message}`
            })));
          }
          
          // Run language-agnostic analysis
          console.error(`[DEBUG] ${this.name}: About to call analyzeAST for:`, file);
          const fileViolations = await this.analyzeAST(
            ast,
            adapter,
            config,
            content
          );
          console.error(`[DEBUG] ${this.name}: analyzeAST returned ${fileViolations.length} violations for:`, file);
          
          violations.push(...fileViolations);
          
          filesProcessed++;
          if (options.progressCallback) {
            options.progressCallback(filesProcessed / totalFiles);
          }
        } catch (error) {
          console.error(`[DEBUG] ${this.name}: ERROR processing file ${file}:`, error);
          errors.push({
            file,
            error: error instanceof Error ? error.message : String(error)
          });
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