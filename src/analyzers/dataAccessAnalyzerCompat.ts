/**
 * Compatibility layer for Data Access Analyzer
 * Ensures the new universal analyzer produces similar results to the legacy one
 */

import type { AnalyzerFunction } from '../types.js';
import { UniversalDataAccessAnalyzer } from './universal/UniversalDataAccessAnalyzer.js';
import { initializeLanguages } from '../languages/index.js';

// Initialize language system on module load
initializeLanguages();

/**
 * Legacy-compatible data access analyzer function
 * This wraps the new UniversalDataAccessAnalyzer to maintain API compatibility
 */
export const analyzeDataAccess: AnalyzerFunction = async (
  files: string[],
  config: any = {},
  options = {},
  progressCallback
) => {
  const analyzer = new UniversalDataAccessAnalyzer();
  
  // Map legacy config to universal config, only including defined values
  const universalConfig: any = {};
  
  if (config.databases !== undefined) universalConfig.databases = config.databases;
  if (config.organizationPatterns !== undefined) universalConfig.organizationPatterns = config.organizationPatterns;
  if (config.tablePatterns !== undefined) universalConfig.tablePatterns = config.tablePatterns;
  if (config.performanceThresholds !== undefined) universalConfig.performanceThresholds = config.performanceThresholds;
  if (config.securityPatterns !== undefined) universalConfig.securityPatterns = config.securityPatterns;
  if (config.checkOrgFilters !== undefined) universalConfig.checkOrgFilters = config.checkOrgFilters;
  if (config.checkSQLInjection !== undefined) universalConfig.checkSQLInjection = config.checkSQLInjection;
  if (config.checkPerformance !== undefined) universalConfig.checkPerformance = config.checkPerformance;
  
  // Call the universal analyzer
  const result = await analyzer.analyze(files, universalConfig, {
    progressCallback: progressCallback ? (progress: number) => {
      progressCallback({
        current: Math.floor(progress * 100),
        total: 100,
        analyzer: 'data-access',
        phase: 'analyzing'
      });
    } : undefined,
    ...options
  });
  
  // Transform result to include data access patterns
  // Note: The universal analyzer focuses on violations, while the legacy one
  // also returned DataAccessPattern objects. For now, we'll just return violations.
  return result;
};

/**
 * Analyzer definition for registration
 */
export const dataAccessAnalyzer = {
  name: 'data-access',
  description: 'Analyzes database access patterns and data layer interactions',
  category: 'security',
  analyze: analyzeDataAccess
};