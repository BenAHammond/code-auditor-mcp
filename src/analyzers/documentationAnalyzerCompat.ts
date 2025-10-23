/**
 * Compatibility layer for DocumentationAnalyzer
 * Ensures the new universal analyzer produces identical results to the legacy one
 */

import type { AnalyzerFunction } from '../types.js';
import { UniversalDocumentationAnalyzer } from './universal/UniversalDocumentationAnalyzer.js';
import { initializeLanguages } from '../languages/index.js';

// Initialize language system on module load
initializeLanguages();

/**
 * Legacy-compatible documentation analyzer function
 * This wraps the new UniversalDocumentationAnalyzer to maintain API compatibility
 */
export const analyzeDocumentation: AnalyzerFunction = async (
  files: string[],
  config: any = {},
  options = {},
  progressCallback
) => {
  console.log('[DEBUG] DocumentationAnalyzerCompat called with files:', files);
  console.log('[DEBUG] DocumentationAnalyzerCompat config:', config);
  const analyzer = new UniversalDocumentationAnalyzer();
  
  // Convert legacy config format if needed
  const universalConfig = {
    requireFunctionDocs: config.requireFunctionDocs ?? true,
    requireClassDocs: config.requireComponentDocs ?? true,  // Map component → class
    requireFileDocs: config.requireFileDocs ?? true,
    requireParamDocs: config.requireParamDocs ?? true,
    requireReturnDocs: config.requireReturnDocs ?? true,
    minDescriptionLength: config.minDescriptionLength ?? 10,
    checkExportedOnly: config.checkExportedOnly ?? false,
    exemptPatterns: config.exemptPatterns ?? ['test', 'spec', '\\.d\\.ts$', 'mock', 'fixture']
  };
  
  // Call the universal analyzer
  const result = await analyzer.analyze(files, universalConfig, {
    progressCallback: progressCallback ? (progress: number) => {
      progressCallback({
        current: Math.floor(progress * 100),
        total: 100,
        analyzer: 'documentation',
        phase: 'analyzing'
      });
    } : undefined,
    ...options
  });
  
  // The result format should be identical, but we can add any necessary transformations here
  return result;
};

/**
 * Analyzer definition for registration
 */
export const documentationAnalyzer = {
  name: 'documentation',
  description: 'Analyzes documentation quality across the codebase',
  category: 'documentation',
  analyze: analyzeDocumentation
};