/**
 * Go Configuration Utility
 * 
 * Handles Go executable detection and configuration for conditional language support.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { GoAdapter } from './GoAdapter.js';

const execFileAsync = promisify(execFile);

/**
 * Resolves symlinks to get the real executable path
 */
function resolveSymlinks(executablePath: string): string {
  try {
    const realPath = fs.realpathSync(executablePath);
    console.error(`[DEBUG] GoConfig: Resolved symlink ${executablePath} → ${realPath}`);
    return realPath;
  } catch (error) {
    console.error(`[DEBUG] GoConfig: Failed to resolve symlink ${executablePath}:`, error.message);
    return executablePath; // Return original path if resolution fails
  }
}

export interface GoConfig {
  enabled: boolean;
  executablePath?: string;
  version?: string;
  error?: string;
}

/**
 * Uses which/where to find absolute path to Go executable
 */
async function findAbsoluteGoPath(): Promise<string> {
  const isWindows = process.platform === 'win32';
  const checkCommand = isWindows ? 'where' : 'which';
  
  try {
    console.error(`[DEBUG] GoConfig: Using ${checkCommand} to find absolute Go path...`);
    
    const { stdout } = await execFileAsync(checkCommand, ['go'], {
      timeout: 5000,
      env: process.env
    });
    
    // 'which' or 'where' returns the absolute path
    // 'where' on Windows might return multiple paths, so take the first one
    const absolutePath = stdout.trim().split('\n')[0].trim();
    console.error(`[DEBUG] GoConfig: Found Go via PATH lookup: ${absolutePath}`);
    
    return absolutePath;
    
  } catch (error: any) {
    throw new Error(`Go executable not found via ${checkCommand}: ${error.message}`);
  }
}

/**
 * Detects Go installation and returns configuration with absolute path
 */
export async function detectGoConfig(customPath?: string): Promise<GoConfig> {
  console.error('[DEBUG] GoConfig: Detecting Go installation...');
  
  // Strategy 1: Try custom path if provided
  if (customPath) {
    try {
      console.error(`[DEBUG] GoConfig: Trying custom Go path: ${customPath}`);
      
      const { stdout } = await execFileAsync(customPath, ['version'], { 
        timeout: 5000,
        env: process.env 
      });
      
      const version = stdout.trim();
      console.error(`[DEBUG] GoConfig: Found Go at custom path ${customPath}: ${version}`);
      
      return {
        enabled: true,
        executablePath: customPath, // Use the custom path as-is
        version: version
      };
      
    } catch (error: any) {
      console.error(`[DEBUG] GoConfig: Custom path failed: ${error.message}`);
      // Continue to fallback strategy
    }
  }
  
  // Strategy 2: Use which/where to find absolute path
  try {
    const absolutePath = await findAbsoluteGoPath();
    
    // Resolve symlinks to get the real binary path
    const realPath = resolveSymlinks(absolutePath);
    
    // Verify the resolved path works
    const { stdout } = await execFileAsync(realPath, ['version'], { 
      timeout: 5000,
      env: process.env 
    });
    
    const version = stdout.trim();
    console.error(`[DEBUG] GoConfig: Verified Go at ${realPath}: ${version}`);
    
    return {
      enabled: true,
      executablePath: realPath, // Return the REAL path (symlinks resolved)
      version: version
    };
    
  } catch (error: any) {
    console.error(`[DEBUG] GoConfig: PATH-based detection failed: ${error.message}`);
  }
  
  // Strategy 3: Try common absolute paths as fallback
  const commonPaths = [
    '/usr/local/bin/go',
    '/opt/homebrew/bin/go', 
    '/usr/bin/go'
  ];
  
  for (const goPath of commonPaths) {
    try {
      console.error(`[DEBUG] GoConfig: Trying fallback path: ${goPath}`);
      
      const { stdout } = await execFileAsync(goPath, ['version'], { 
        timeout: 5000,
        env: process.env 
      });
      
      const version = stdout.trim();
      console.error(`[DEBUG] GoConfig: Found Go at fallback ${goPath}: ${version}`);
      
      return {
        enabled: true,
        executablePath: goPath,
        version: version
      };
      
    } catch (error: any) {
      console.error(`[DEBUG] GoConfig: Fallback path ${goPath} failed: ${error.message}`);
      continue;
    }
  }
  
  const errorMsg = `Go executable not found. Tried custom path, PATH lookup, and common locations.`;
  console.error(`[DEBUG] GoConfig: ${errorMsg}`);
  
  return {
    enabled: false,
    error: errorMsg
  };
}

/**
 * Creates a GoAdapter if Go is available, null otherwise
 */
export async function createGoAdapter(customPath?: string): Promise<GoAdapter | null> {
  const config = await detectGoConfig(customPath);
  
  if (!config.enabled || !config.executablePath) {
    console.error('[DEBUG] GoConfig: Go support disabled - no valid Go executable found');
    return null;
  }
  
  console.error(`[DEBUG] GoConfig: Creating GoAdapter with path: ${config.executablePath}`);
  return new GoAdapter(config.executablePath);
}

/**
 * Environment variable names for Go configuration
 */
export const GO_CONFIG_ENV = {
  EXECUTABLE_PATH: 'CODE_AUDITOR_GO_PATH',
  DISABLE: 'CODE_AUDITOR_DISABLE_GO'
} as const;

/**
 * Gets Go configuration from environment variables
 */
export function getGoConfigFromEnv(): { customPath?: string; disabled: boolean } {
  return {
    customPath: process.env[GO_CONFIG_ENV.EXECUTABLE_PATH],
    disabled: process.env[GO_CONFIG_ENV.DISABLE] === 'true'
  };
}