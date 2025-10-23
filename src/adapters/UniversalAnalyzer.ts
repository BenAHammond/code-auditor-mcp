/**
 * Universal Analyzer Base Class
 * 
 * Implements the architecture plan for multi-language analyzers.
 * Each analyzer extends this class and implements language-agnostic analysis logic.
 */

import { promises as fs } from 'fs';
import { LanguageAdapter, AST, LanguageRegistry } from './LanguageAdapter.js';
import { AnalyzerDefinition, AnalyzerResult, Violation, Severity } from '../types.js';

export abstract class UniversalAnalyzer implements AnalyzerDefinition {
  abstract readonly name: string;
  abstract readonly description: string;
  
  private registry = LanguageRegistry.getInstance();

  async analyze(
    files: string[],
    config: any,
    options: any = {}
  ): Promise<AnalyzerResult> {
    const violations: Violation[] = [];
    let filesProcessed = 0;
    let executionTime = 0;
    
    const startTime = Date.now();
    
    console.error(`[DEBUG] ${this.name}: UniversalAnalyzer.analyze() called with files:`, files.map(f => f.substring(f.lastIndexOf('/') + 1)));
    
    for (const file of files) {
      try {
        console.error(`[DEBUG] ${this.name}: Processing file: ${file}`);
        
        const adapter = this.getAdapter(file);
        if (!adapter) {
          console.error(`[DEBUG] ${this.name}: No adapter found for file: ${file}`);
          continue;
        }
        
        console.error(`[DEBUG] ${this.name}: Using adapter: ${adapter.name} for file: ${file}`);
        
        const content = await fs.readFile(file, 'utf8');
        const ast = await adapter.parse(file, content);
        
        console.error(`[DEBUG] ${this.name}: About to call analyzeAST for: ${file}`);
        const fileViolations = await this.analyzeAST(ast, adapter, config);
        console.error(`[DEBUG] ${this.name}: analyzeAST returned ${fileViolations.length} violations for: ${file}`);
        
        violations.push(...fileViolations);
        filesProcessed++;
        
      } catch (error) {
        console.error(`[DEBUG] ${this.name}: Error processing file ${file}:`, error);
        // Continue processing other files even if one fails
      }
    }
    
    executionTime = Date.now() - startTime;
    console.error(`[DEBUG] ${this.name}: Analysis complete. ${violations.length} total violations found.`);
    
    return {
      violations,
      filesProcessed,
      executionTime
    };
  }
  
  /**
   * Language-agnostic analysis logic
   * Each analyzer implements this method to perform analysis on the abstracted AST
   */
  abstract analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: any
  ): Promise<Violation[]>;
  
  /**
   * Get the appropriate language adapter for a file
   */
  private getAdapter(file: string): LanguageAdapter | null {
    const adapter = this.registry.getAdapterForFile(file);
    if (!adapter) {
      console.warn(`[UniversalAnalyzer] No adapter found for file: ${file}`);
    }
    return adapter;
  }
  
  /**
   * Helper method to create violations with consistent formatting
   */
  protected createViolation(
    file: string,
    line: number,
    column: number,
    message: string,
    severity: Severity = 'warning',
    rule?: string,
    fix?: any
  ): Violation {
    return {
      file,
      line,
      column,
      severity,
      message,
      rule: rule || this.name,
      analyzer: this.name,
      ...(fix && { fix })
    };
  }
  
  /**
   * Helper method to check if a node matches a specific pattern
   */
  protected nodeMatches(
    node: any,
    adapter: LanguageAdapter,
    pattern: { type?: string; name?: string | RegExp }
  ): boolean {
    if (pattern.type && adapter.getNodeType(node) !== pattern.type) {
      return false;
    }
    
    if (pattern.name) {
      const nodeName = adapter.getNodeName(node);
      if (!nodeName) return false;
      
      if (typeof pattern.name === 'string') {
        return nodeName === pattern.name;
      } else if (pattern.name instanceof RegExp) {
        return pattern.name.test(nodeName);
      }
    }
    
    return true;
  }
  
  /**
   * Helper method to get source location for violations
   */
  protected getSourceLocation(adapter: LanguageAdapter, node: any): { line: number; column: number } {
    const location = adapter.getNodeLocation(node);
    return {
      line: location.start.line,
      column: location.start.column
    };
  }
}