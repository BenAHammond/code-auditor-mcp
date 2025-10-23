/**
 * SOLID Analyzer Compatibility Layer
 * 
 * This bridges the new Universal Analyzer system with the existing audit infrastructure.
 * It allows gradual migration without breaking existing functionality.
 */

import { AnalyzerDefinition, AnalyzerResult, Violation } from '../types.js';
import { UniversalSOLIDAnalyzer } from './UniversalSOLIDAnalyzer.js';
import { TypeScriptAdapter } from './TypeScriptAdapter.js';
import { LanguageRegistry } from './LanguageAdapter.js';
import { createGoAdapter, getGoConfigFromEnv } from './GoConfig.js';

/**
 * Compatibility wrapper that makes the Universal SOLID analyzer work with existing infrastructure
 */
export class SOLIDAnalyzerCompat implements AnalyzerDefinition {
  name = 'solid';
  description = 'SOLID principles analyzer with multi-language support';
  
  private universalAnalyzer: UniversalSOLIDAnalyzer;
  private initialized = false;

  constructor() {
    this.universalAnalyzer = new UniversalSOLIDAnalyzer();
    // Note: initializeAdapters() is now async and called in analyze()
  }

  private async initializeAdapters(): Promise<void> {
    if (this.initialized) return;
    
    console.error('[DEBUG] SOLID compat layer: Initializing language adapters...');
    
    const registry = LanguageRegistry.getInstance();
    
    // Register TypeScript adapter (always available)
    const tsAdapter = new TypeScriptAdapter();
    registry.register(tsAdapter);
    console.error('[DEBUG] SOLID compat layer: TypeScript adapter registered');
    
    // Conditionally register Go adapter
    const goEnvConfig = getGoConfigFromEnv();
    
    if (goEnvConfig.disabled) {
      console.error('[DEBUG] SOLID compat layer: Go support disabled via environment variable');
    } else {
      console.error('[DEBUG] SOLID compat layer: Detecting Go configuration...');
      const goAdapter = await createGoAdapter(goEnvConfig.customPath);
      
      if (goAdapter) {
        registry.register(goAdapter);
        console.error('[DEBUG] SOLID compat layer: Go adapter registered successfully');
      } else {
        console.error('[DEBUG] SOLID compat layer: Go adapter not available - continuing with TypeScript-only support');
      }
    }
    
    this.initialized = true;
    console.error('[DEBUG] SOLID compat layer: Language adapters initialization complete');
  }

  async analyze(files: string[], config?: any, options?: any): Promise<AnalyzerResult> {
    console.error('[DEBUG] SOLID compat layer called with files:', files.map(f => f.substring(f.lastIndexOf('/') + 1)));
    console.error('[DEBUG] SOLID compat layer: File extensions in input:', files.map(f => f.substring(f.lastIndexOf('.'))));
    console.error('[DEBUG] SOLID compat layer: Go files count:', files.filter(f => f.endsWith('.go')).length);
    console.error('[DEBUG] SOLID compat layer: Total files count:', files.length);
    
    // Ensure adapters are initialized before analysis
    await this.initializeAdapters();
    
    try {
      const result = await this.universalAnalyzer.analyze(files, config, options);
      
      console.error(`[DEBUG] SOLID compat layer: Universal analyzer returned ${result.violations.length} violations`);
      
      return result;
    } catch (error) {
      console.error('[DEBUG] SOLID compat layer: Error in universal analyzer:', error);
      
      // Return empty result on error to prevent breaking the audit
      return {
        violations: [],
        filesProcessed: 0,
        executionTime: 0
      };
    }
  }
}

// Export a function that creates the compat analyzer (matches existing pattern)
export function createSOLIDAnalyzer(): AnalyzerDefinition {
  return new SOLIDAnalyzerCompat();
}