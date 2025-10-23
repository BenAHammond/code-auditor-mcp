/**
 * Compatibility layer for DRY Analyzer
 * Ensures the new universal analyzer produces identical results to the legacy one
 */

import type { AnalyzerFunction } from '../types.js';
import { UniversalDRYAnalyzer } from './universal/UniversalDRYAnalyzer.js';
import { initializeLanguages } from '../languages/index.js';

// Initialize language system on module load
initializeLanguages();

/**
 * Legacy-compatible DRY analyzer function
 * This wraps the new UniversalDRYAnalyzer to maintain API compatibility
 */
export const analyzeDRY: AnalyzerFunction = async (
  files: string[],
  config: any = {},
  options = {},
  progressCallback
) => {
  const analyzer = new UniversalDRYAnalyzer();
  
  // The config format should be mostly compatible
  const universalConfig = {
    ...config,
    // Map any legacy config fields if needed
  };
  
  // Call the universal analyzer
  const result = await analyzer.analyze(files, universalConfig, {
    progressCallback: progressCallback ? (progress: number) => {
      progressCallback({
        current: Math.floor(progress * 100),
        total: 100,
        analyzer: 'dry',
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
export const dryAnalyzer = {
  name: 'dry',
  description: 'Detects code duplication across the codebase',
  category: 'maintainability',
  analyze: analyzeDRY
};