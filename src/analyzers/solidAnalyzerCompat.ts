/**
 * Compatibility layer for SOLID Analyzer
 * Ensures the new universal analyzer produces similar results to the legacy one
 */

import type { AnalyzerFunction } from '../types.js';
import { UniversalSOLIDAnalyzer } from './universal/UniversalSOLIDAnalyzer.js';
import { initializeLanguages } from '../languages/index.js';

// Initialize language system on module load
initializeLanguages();

/**
 * Legacy-compatible SOLID analyzer function
 * This wraps the new UniversalSOLIDAnalyzer to maintain API compatibility
 */
export const analyzeSOLID: AnalyzerFunction = async (
  files: string[],
  config: any = {},
  options = {},
  progressCallback
) => {
  console.error('[DEBUG] SOLID compat layer called with files:', files);
  console.error('[DEBUG] SOLID compat layer config:', config);
  const analyzer = new UniversalSOLIDAnalyzer();
  
  // Map legacy config to universal config, only override defined values
  const universalConfig: any = {
    skipTestFiles: true
  };
  
  // Only set properties that are explicitly provided to avoid overriding defaults with undefined
  if (config.maxMethodsPerClass !== undefined) universalConfig.maxMethodsPerClass = config.maxMethodsPerClass;
  if (config.maxLinesPerMethod !== undefined) universalConfig.maxLinesPerMethod = config.maxLinesPerMethod;
  if (config.maxParametersPerMethod !== undefined) universalConfig.maxParametersPerMethod = config.maxParametersPerMethod;
  if (config.maxClassComplexity !== undefined) universalConfig.maxClassComplexity = config.maxClassComplexity;
  if (config.maxInterfaceMembers !== undefined) universalConfig.maxInterfaceMembers = config.maxInterfaceMembers;
  if (config.checkDependencyInversion !== undefined) universalConfig.checkDependencyInversion = config.checkDependencyInversion;
  if (config.checkInterfaceSegregation !== undefined) universalConfig.checkInterfaceSegregation = config.checkInterfaceSegregation;
  if (config.checkLiskovSubstitution !== undefined) universalConfig.checkLiskovSubstitution = config.checkLiskovSubstitution;
  
  console.error('[DEBUG] SOLID compat: Universal config:', universalConfig);
  
  // Call the universal analyzer
  console.error('[DEBUG] SOLID compat: About to call analyzer.analyze()');
  try {
    const result = await analyzer.analyze(files, universalConfig, {
      progressCallback: progressCallback ? (progress: number) => {
        progressCallback({
          current: Math.floor(progress * 100),
          total: 100,
          analyzer: 'solid',
          phase: 'analyzing'
        });
      } : undefined,
      ...options
    });
    console.error('[DEBUG] SOLID compat: analyzer.analyze() completed, violations:', result.violations.length);
    return {
      ...result,
      violations: result.violations.map(v => ({
        ...v,
        principle: v.rule as any,
        analyzer: 'solid',
        rule: v.rule
      }))
    };
  } catch (error) {
    console.error('[DEBUG] SOLID compat: ERROR in analyzer.analyze():', error);
    throw error;
  }
};

/**
 * Analyzer definition for registration
 */
export const solidAnalyzer = {
  name: 'solid',
  description: 'Detects violations of SOLID principles',
  category: 'architecture',
  analyze: analyzeSOLID
};