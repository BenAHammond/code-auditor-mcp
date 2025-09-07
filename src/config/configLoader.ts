/**
 * Configuration Loader (Functional)
 * Handles loading and merging configuration from multiple sources
 */

import { promises as fs } from 'fs';
import path from 'path';
import { AuditConfig } from '../types.js';
import { getDefaultConfig, DEFAULT_CODE_INDEX_CONFIG } from './defaults.js';

/**
 * Load configuration from multiple sources
 */
export async function loadConfig(options?: {
  configPath?: string;
  cliArgs?: Partial<AuditConfig>;
  environmentPrefix?: string;
}): Promise<AuditConfig> {
  // Start with defaults
  let config = getDefaultConfig();
  
  // Add code index defaults
  (config as any).codeIndex = DEFAULT_CODE_INDEX_CONFIG;
  
  // Load from config file if specified
  if (options?.configPath) {
    config = await loadFromFile(config, options.configPath);
  }
  
  // Load from environment variables
  if (options?.environmentPrefix) {
    config = loadFromEnvironment(config, options.environmentPrefix);
  }
  
  // Apply CLI arguments (highest priority)
  if (options?.cliArgs) {
    config = { ...config, ...options.cliArgs };
  }
  
  // Normalize paths
  config = normalizePaths(config);
  
  return config;
}

/**
 * Load configuration from a JSON file
 */
async function loadFromFile(baseConfig: AuditConfig, configPath: string): Promise<AuditConfig> {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const fileConfig = JSON.parse(content);
    return mergeConfig(baseConfig, fileConfig);
  } catch (error) {
    console.warn(`Failed to load config from ${configPath}:`, error);
    return baseConfig;
  }
}

/**
 * Load configuration from environment variables
 */
function loadFromEnvironment(baseConfig: AuditConfig, prefix: string): AuditConfig {
  const env = process.env;
  const envConfig: Partial<AuditConfig> = {};
  
  // Map environment variables to config properties
  if (env[`${prefix}_MIN_SEVERITY`]) {
    envConfig.minSeverity = env[`${prefix}_MIN_SEVERITY`] as any;
  }
  
  if (env[`${prefix}_OUTPUT_DIR`]) {
    envConfig.outputDirectory = env[`${prefix}_OUTPUT_DIR`];
  }
  
  if (env[`${prefix}_FAIL_ON_CRITICAL`]) {
    envConfig.failOnCritical = env[`${prefix}_FAIL_ON_CRITICAL`] === 'true';
  }
  
  if (env[`${prefix}_ANALYZERS`]) {
    envConfig.enabledAnalyzers = env[`${prefix}_ANALYZERS`].split(',');
  }
  
  // Code index environment variables
  const codeIndexConfig: any = {};
  if (env[`${prefix}_CODE_INDEX_DB_PATH`]) {
    codeIndexConfig.databasePath = env[`${prefix}_CODE_INDEX_DB_PATH`];
  }
  if (env[`${prefix}_CODE_INDEX_BATCH_SIZE`]) {
    codeIndexConfig.maxBatchSize = parseInt(env[`${prefix}_CODE_INDEX_BATCH_SIZE`], 10);
  }
  if (env[`${prefix}_CODE_INDEX_SEARCH_LIMIT`]) {
    codeIndexConfig.searchResultLimit = parseInt(env[`${prefix}_CODE_INDEX_SEARCH_LIMIT`], 10);
  }
  if (Object.keys(codeIndexConfig).length > 0) {
    (envConfig as any).codeIndex = codeIndexConfig;
  }
  
  return mergeConfig(baseConfig, envConfig);
}

/**
 * Deep merge two configuration objects
 */
function mergeConfig(base: AuditConfig, override: Partial<AuditConfig>): AuditConfig {
  const result: any = { ...base };
  
  for (const key in override) {
    const value = override[key as keyof AuditConfig];
    if (value !== undefined) {
      if (typeof value === 'object' && !Array.isArray(value)) {
        const baseValue = base[key as keyof AuditConfig];
        result[key] = {
          ...(typeof baseValue === 'object' ? baseValue : {}),
          ...value
        };
      } else {
        result[key] = value;
      }
    }
  }
  
  return result;
}

/**
 * Normalize file paths in configuration
 */
function normalizePaths(config: AuditConfig): AuditConfig {
  const normalized = { ...config };
  
  // Normalize output directory
  if (normalized.outputDirectory) {
    normalized.outputDirectory = path.resolve(normalized.outputDirectory);
  }
  
  // Normalize include/exclude paths
  if (normalized.includePaths) {
    normalized.includePaths = normalized.includePaths.map(p => 
      path.isAbsolute(p) ? p : path.join(process.cwd(), p)
    );
  }
  
  if (normalized.excludePaths) {
    normalized.excludePaths = normalized.excludePaths.map(p => 
      path.isAbsolute(p) ? p : path.join(process.cwd(), p)
    );
  }
  
  return normalized;
}

/**
 * Validate configuration
 */
export function validateConfig(config: AuditConfig): string[] {
  const errors: string[] = [];
  
  // Validate severity
  if (config.minSeverity && !['critical', 'warning', 'suggestion'].includes(config.minSeverity)) {
    errors.push(`Invalid severity: ${config.minSeverity}`);
  }
  
  // Validate analyzers
  const validAnalyzers = ['solid', 'dry', 'security', 'component', 'data-access'];
  if (config.enabledAnalyzers) {
    const invalid = config.enabledAnalyzers.filter(a => !validAnalyzers.includes(a));
    if (invalid.length > 0) {
      errors.push(`Invalid analyzers: ${invalid.join(', ')}`);
    }
  }
  
  return errors;
}

// Re-export for convenience
export { AuditConfig } from '../types.js';