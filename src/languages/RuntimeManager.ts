/**
 * Runtime Manager
 * Detects available language runtimes and manages analyzer processes
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

export interface RuntimeInfo {
  name: string;
  command: string;
  version: string;
  available: boolean;
  minVersion?: string;
  analyzer?: LanguageAnalyzer;
  executablePath?: string;
}

export interface LanguageAnalyzer {
  name: string;
  runtime: string;
  command: string;
  supports: string[];
  analyze(files: string[], options?: any): Promise<AnalysisResult>;
}

export interface AnalysisResult {
  violations: any[];
  indexEntries: any[];
  metrics: AnalysisMetrics;
  errors?: any[];
}

export interface AnalysisMetrics {
  filesAnalyzed: number;
  executionTime: number;
  memoryUsage?: number;
}

export interface RuntimeConfig {
  enabled: boolean;
  minVersion?: string;
  command?: string;
  analyzer?: string;
  timeout?: number;
}

export class RuntimeManager {
  private runtimes = new Map<string, RuntimeInfo>();
  private initialized = false;
  private config: Map<string, RuntimeConfig> = new Map();

  constructor(config?: Record<string, RuntimeConfig>) {
    if (config) {
      for (const [runtime, cfg] of Object.entries(config)) {
        this.config.set(runtime, cfg);
      }
    }
  }

  /**
   * Initialize runtime detection
   */
  async initialize(): Promise<void> {
    console.error('[RuntimeManager] Initializing runtime detection...');
    
    await Promise.all([
      this.detectNodeRuntime(),
      this.detectGoRuntime(),
      this.detectPythonRuntime(),
      this.detectRustRuntime(),
      this.detectDenoRuntime(),
      this.detectBunRuntime()
    ]);

    this.initialized = true;
    console.error('[RuntimeManager] Runtime detection complete');
    this.logRuntimeStatus();
  }

  /**
   * Check if a specific runtime is available
   */
  hasRuntime(name: string): boolean {
    const runtime = this.runtimes.get(name);
    const config = this.config.get(name);
    
    return runtime?.available === true && 
           (config?.enabled !== false) &&
           this.checkVersionCompatibility(runtime, config);
  }

  /**
   * Get fallback runtime for a language if the primary is unavailable
   */
  getFallbackRuntime(language: string): RuntimeInfo | null {
    const fallbackMap: Record<string, string[]> = {
      'typescript': ['node', 'deno', 'bun'],
      'javascript': ['node', 'deno', 'bun'],
      'go': ['go'],
      'python': ['python'],
      'rust': ['rust']
    };

    const fallbacks = fallbackMap[language] || [];
    
    for (const fallback of fallbacks) {
      if (this.hasRuntime(fallback)) {
        const runtime = this.runtimes.get(fallback);
        if (runtime?.analyzer?.supports.some(ext => this.getLanguageExtensions(language).includes(ext))) {
          return runtime;
        }
      }
    }

    return null;
  }

  /**
   * Get file extensions for a language
   */
  private getLanguageExtensions(language: string): string[] {
    const extensionMap: Record<string, string[]> = {
      'typescript': ['.ts', '.tsx'],
      'javascript': ['.js', '.jsx'],
      'go': ['.go'],
      'python': ['.py'],
      'rust': ['.rs']
    };

    return extensionMap[language] || [];
  }

  /**
   * Attempt to analyze with fallback runtime if primary fails
   */
  async analyzeWithFallback(language: string, files: string[], options?: any): Promise<AnalysisResult | null> {
    // Try primary runtime first
    let result = await this.spawnAnalyzer(language, files, options);
    
    if (result && result.errors?.length === 0) {
      return result;
    }

    // If primary failed, try fallback
    const fallbackRuntime = this.getFallbackRuntime(language);
    if (fallbackRuntime) {
      console.log(`[RuntimeManager] Primary ${language} runtime failed, trying fallback: ${fallbackRuntime.name}`);
      
      try {
        const fallbackResult = await fallbackRuntime.analyzer!.analyze(files, {
          ...options,
          fallbackMode: true,
          originalLanguage: language
        });

        // Add warning about fallback usage
        fallbackResult.errors = fallbackResult.errors || [];
        fallbackResult.errors.push({
          message: `Analysis completed using fallback runtime ${fallbackRuntime.name} instead of native ${language} runtime`,
          type: 'fallback_warning',
          language
        });

        return fallbackResult;
      } catch (fallbackError) {
        console.error(`[RuntimeManager] Fallback runtime also failed:`, fallbackError);
      }
    }

    // No fallback available or fallback also failed
    return {
      violations: [],
      indexEntries: [],
      metrics: { filesAnalyzed: 0, executionTime: 0 },
      errors: [{
        message: `No working runtime available for ${language}. Install ${language} runtime or enable fallback options.`,
        type: 'no_runtime',
        language,
        suggestions: this.getRuntimeInstallationSuggestions(language)
      }]
    };
  }

  /**
   * Get installation suggestions for missing runtimes
   */
  private getRuntimeInstallationSuggestions(language: string): string[] {
    const suggestions: Record<string, string[]> = {
      'go': [
        'Install Go: https://golang.org/dl/',
        'Or use package manager: brew install go (macOS), apt install golang (Ubuntu)'
      ],
      'python': [
        'Install Python: https://python.org/downloads/',
        'Or use package manager: brew install python (macOS), apt install python3 (Ubuntu)'
      ],
      'rust': [
        'Install Rust: https://rustup.rs/',
        'Run: curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh'
      ],
      'node': [
        'Install Node.js: https://nodejs.org/',
        'Or use nvm: nvm install node'
      ]
    };

    return suggestions[language] || ['Check the official documentation for installation instructions'];
  }

  /**
   * Get runtime information
   */
  getRuntime(name: string): RuntimeInfo | undefined {
    return this.runtimes.get(name);
  }

  /**
   * Get all available runtimes
   */
  getAvailableRuntimes(): RuntimeInfo[] {
    return Array.from(this.runtimes.values()).filter(r => r.available);
  }

  /**
   * Spawn analyzer for a specific language
   */
  async spawnAnalyzer(language: string, files: string[], options?: any): Promise<AnalysisResult | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    const runtime = this.runtimes.get(language);
    if (!runtime?.available || !runtime.analyzer) {
      console.warn(`[RuntimeManager] No analyzer available for ${language}`);
      return null;
    }

    console.log(`[RuntimeManager] Spawning ${language} analyzer for ${files.length} files`);
    
    const startTime = Date.now();
    const processTimeout = options?.timeout || 300000; // 5 minutes default
    
    try {
      const result = await this.runWithTimeout(
        () => runtime.analyzer!.analyze(files, options),
        processTimeout
      );
      
      const executionTime = Date.now() - startTime;
      result.metrics.executionTime = executionTime;
      
      console.log(`[RuntimeManager] ${language} analysis complete in ${executionTime}ms: ${result.violations.length} violations`);
      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`[RuntimeManager] Error in ${language} analyzer after ${executionTime}ms:`, error);
      
      return {
        violations: [],
        indexEntries: [],
        metrics: { filesAnalyzed: 0, executionTime },
        errors: [{ 
          message: error instanceof Error ? error.message : String(error), 
          language,
          type: error instanceof Error && error.message.includes('timeout') ? 'timeout' : 'runtime_error'
        }]
      };
    }
  }

  /**
   * Run a function with timeout
   */
  private async runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Analysis timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Spawn multiple analyzers in parallel with concurrency control
   */
  async spawnMultipleAnalyzers(
    languageFilePairs: Array<{ language: string; files: string[] }>, 
    options?: { maxConcurrency?: number; timeout?: number }
  ): Promise<Array<{ language: string; result: AnalysisResult | null }>> {
    const maxConcurrency = options?.maxConcurrency || 3;
    const results: Array<{ language: string; result: AnalysisResult | null }> = [];
    
    console.log(`[RuntimeManager] Spawning ${languageFilePairs.length} analyzers with max concurrency ${maxConcurrency}`);
    
    // Process in batches to control concurrency
    for (let i = 0; i < languageFilePairs.length; i += maxConcurrency) {
      const batch = languageFilePairs.slice(i, i + maxConcurrency);
      
      const batchPromises = batch.map(async ({ language, files }) => {
        const result = await this.spawnAnalyzer(language, files, options);
        return { language, result };
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    
    return results;
  }

  /**
   * Kill all running analyzer processes (for cleanup)
   */
  async killAllAnalyzers(): Promise<void> {
    console.log('[RuntimeManager] Killing all analyzer processes...');
    
    // This is a placeholder for process management
    // In future implementations, we'll track child processes and kill them here
    // For now, we just log the action since our analyzers run in-process
    
    console.log('[RuntimeManager] All analyzer processes terminated');
  }

  /**
   * Detect Node.js runtime
   */
  private async detectNodeRuntime(): Promise<void> {
    try {
      const { stdout } = await execAsync('node --version');
      const version = stdout.trim();
      
      this.runtimes.set('node', {
        name: 'Node.js',
        command: 'node',
        version,
        available: true,
        minVersion: '16.0.0',
        analyzer: new TypeScriptAnalyzer()
      });
    } catch (error) {
      this.runtimes.set('node', {
        name: 'Node.js',
        command: 'node',
        version: 'unknown',
        available: false
      });
    }
  }

  /**
   * Detect Go runtime
   */
  private async detectGoRuntime(): Promise<void> {
    try {
      console.error('[RuntimeManager] Detecting Go runtime...');
      const { stdout } = await execAsync('go version');
      const versionMatch = stdout.match(/go(\d+\.\d+\.\d+)/);
      const version = versionMatch ? versionMatch[1] : stdout.trim();
      console.error('[RuntimeManager] Go version detected:', version);
      
      // Check if our Go analyzer exists
      const analyzerPath = path.join(__dirname, 'go', 'analyzer');
      console.error('[RuntimeManager] Looking for Go analyzer at:', analyzerPath);
      const analyzerExists = await this.fileExists(analyzerPath) || await this.fileExists(analyzerPath + '.exe');
      console.error('[RuntimeManager] Go analyzer exists:', analyzerExists);

      this.runtimes.set('go', {
        name: 'Go',
        command: 'go',
        version,
        available: true,
        minVersion: '1.18.0',
        executablePath: analyzerExists ? analyzerPath : undefined,
        analyzer: new GoAnalyzer(analyzerPath)
      });
      console.error('[RuntimeManager] Go runtime configured successfully');
    } catch (error) {
      this.runtimes.set('go', {
        name: 'Go',
        command: 'go',
        version: 'unknown',
        available: false
      });
    }
  }

  /**
   * Detect Python runtime
   */
  private async detectPythonRuntime(): Promise<void> {
    const pythonCommands = ['python3', 'python'];
    
    for (const cmd of pythonCommands) {
      try {
        const { stdout } = await execAsync(`${cmd} --version`);
        const versionMatch = stdout.match(/Python (\d+\.\d+\.\d+)/);
        const version = versionMatch ? versionMatch[1] : stdout.trim();
        
        this.runtimes.set('python', {
          name: 'Python',
          command: cmd,
          version,
          available: true,
          minVersion: '3.8.0',
          analyzer: new PythonAnalyzer(cmd)
        });
        return;
      } catch (error) {
        // Try next command
      }
    }

    this.runtimes.set('python', {
      name: 'Python',
      command: 'python',
      version: 'unknown',
      available: false
    });
  }

  /**
   * Detect Rust runtime
   */
  private async detectRustRuntime(): Promise<void> {
    try {
      const { stdout } = await execAsync('rustc --version');
      const versionMatch = stdout.match(/rustc (\d+\.\d+\.\d+)/);
      const version = versionMatch ? versionMatch[1] : stdout.trim();
      
      this.runtimes.set('rust', {
        name: 'Rust',
        command: 'rustc',
        version,
        available: true,
        minVersion: '1.60.0'
        // Rust analyzer will be implemented in future phases
      });
    } catch (error) {
      this.runtimes.set('rust', {
        name: 'Rust',
        command: 'rustc',
        version: 'unknown',
        available: false
      });
    }
  }

  /**
   * Detect Deno runtime
   */
  private async detectDenoRuntime(): Promise<void> {
    try {
      const { stdout } = await execAsync('deno --version');
      const versionMatch = stdout.match(/deno (\d+\.\d+\.\d+)/);
      const version = versionMatch ? versionMatch[1] : stdout.trim();
      
      this.runtimes.set('deno', {
        name: 'Deno',
        command: 'deno',
        version,
        available: true,
        minVersion: '1.20.0'
        // Could reuse TypeScript analyzer with Deno-specific adaptations
      });
    } catch (error) {
      this.runtimes.set('deno', {
        name: 'Deno',
        command: 'deno',
        version: 'unknown',
        available: false
      });
    }
  }

  /**
   * Detect Bun runtime
   */
  private async detectBunRuntime(): Promise<void> {
    try {
      const { stdout } = await execAsync('bun --version');
      const version = stdout.trim();
      
      this.runtimes.set('bun', {
        name: 'Bun',
        command: 'bun',
        version,
        available: true,
        minVersion: '0.5.0'
        // Could reuse TypeScript analyzer with Bun-specific adaptations
      });
    } catch (error) {
      this.runtimes.set('bun', {
        name: 'Bun',
        command: 'bun',
        version: 'unknown',
        available: false
      });
    }
  }

  /**
   * Check if a file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check version compatibility with detailed reporting
   */
  private checkVersionCompatibility(runtime: RuntimeInfo, config?: RuntimeConfig): boolean {
    const minVersion = config?.minVersion || runtime.minVersion;
    if (!minVersion || !runtime.version || runtime.version === 'unknown') {
      console.log(`[RuntimeManager] Version compatibility check skipped for ${runtime.name} (version: ${runtime.version})`);
      return true; // If we can't determine version, assume compatible
    }

    const isCompatible = this.compareVersions(runtime.version, minVersion) >= 0;
    
    if (!isCompatible) {
      console.warn(`[RuntimeManager] ${runtime.name} version ${runtime.version} is below minimum required ${minVersion}`);
    } else {
      console.log(`[RuntimeManager] ${runtime.name} version ${runtime.version} meets minimum requirement ${minVersion}`);
    }

    return isCompatible;
  }

  /**
   * Get detailed version compatibility report
   */
  getVersionCompatibilityReport(): Array<{
    runtime: string;
    currentVersion: string;
    minVersion?: string;
    compatible: boolean;
    status: 'compatible' | 'incompatible' | 'unknown';
    recommendations?: string[];
  }> {
    const report: Array<{
      runtime: string;
      currentVersion: string;
      minVersion?: string;
      compatible: boolean;
      status: 'compatible' | 'incompatible' | 'unknown';
      recommendations?: string[];
    }> = [];

    for (const [name, runtime] of this.runtimes) {
      const config = this.config.get(name);
      const minVersion = config?.minVersion || runtime.minVersion;
      const compatible = this.checkVersionCompatibility(runtime, config);
      
      let status: 'compatible' | 'incompatible' | 'unknown';
      let recommendations: string[] = [];

      if (!runtime.available) {
        status = 'unknown';
        recommendations.push(`Install ${runtime.name} runtime`);
        recommendations.push(...this.getRuntimeInstallationSuggestions(name));
      } else if (runtime.version === 'unknown') {
        status = 'unknown';
        recommendations.push(`Unable to detect ${runtime.name} version`);
      } else if (!compatible) {
        status = 'incompatible';
        recommendations.push(`Update ${runtime.name} to version ${minVersion} or higher`);
        recommendations.push(`Current: ${runtime.version}, Required: ${minVersion}`);
      } else {
        status = 'compatible';
      }

      report.push({
        runtime: runtime.name,
        currentVersion: runtime.version,
        minVersion,
        compatible: runtime.available && compatible,
        status,
        recommendations: recommendations.length > 0 ? recommendations : undefined
      });
    }

    return report;
  }

  /**
   * Validate all runtime versions and return summary
   */
  async validateRuntimeVersions(): Promise<{
    compatible: number;
    incompatible: number;
    unknown: number;
    issues: Array<{ runtime: string; issue: string; recommendations: string[] }>;
  }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const report = this.getVersionCompatibilityReport();
    const summary = {
      compatible: 0,
      incompatible: 0,
      unknown: 0,
      issues: [] as Array<{ runtime: string; issue: string; recommendations: string[] }>
    };

    for (const entry of report) {
      switch (entry.status) {
        case 'compatible':
          summary.compatible++;
          break;
        case 'incompatible':
          summary.incompatible++;
          summary.issues.push({
            runtime: entry.runtime,
            issue: `Version ${entry.currentVersion} is below minimum ${entry.minVersion}`,
            recommendations: entry.recommendations || []
          });
          break;
        case 'unknown':
          summary.unknown++;
          summary.issues.push({
            runtime: entry.runtime,
            issue: 'Runtime not available or version unknown',
            recommendations: entry.recommendations || []
          });
          break;
      }
    }

    return summary;
  }

  /**
   * Compare semantic versions with enhanced parsing
   */
  private compareVersions(version1: string, version2: string): number {
    // Handle various version formats: v1.2.3, 1.2.3, go1.19.5, etc.
    const normalizeVersion = (version: string): string => {
      return version
        .replace(/^v/, '')                    // Remove 'v' prefix
        .replace(/^go/, '')                   // Remove 'go' prefix
        .replace(/[^\d.]/g, '')               // Remove non-digit, non-dot chars
        .split('.')
        .slice(0, 3)                          // Take only major.minor.patch
        .join('.');
    };

    const v1 = normalizeVersion(version1);
    const v2 = normalizeVersion(version2);
    
    const v1Parts = v1.split('.').map(Number);
    const v2Parts = v2.split('.').map(Number);
    
    const maxLength = Math.max(v1Parts.length, v2Parts.length);
    
    for (let i = 0; i < maxLength; i++) {
      const v1Part = v1Parts[i] || 0;
      const v2Part = v2Parts[i] || 0;
      
      if (v1Part > v2Part) return 1;
      if (v1Part < v2Part) return -1;
    }
    
    return 0;
  }

  /**
   * Log runtime status
   */
  private logRuntimeStatus(): void {
    console.log('\n[RuntimeManager] Runtime Status:');
    for (const [name, runtime] of this.runtimes) {
      const status = runtime.available ? '✅' : '❌';
      const analyzer = runtime.analyzer ? '(analyzer available)' : '(no analyzer)';
      console.log(`  ${status} ${runtime.name} ${runtime.version} ${analyzer}`);
    }
    console.log('');
  }

  /**
   * Get runtime statistics
   */
  getStats() {
    const total = this.runtimes.size;
    const available = Array.from(this.runtimes.values()).filter(r => r.available).length;
    const withAnalyzers = Array.from(this.runtimes.values()).filter(r => r.available && r.analyzer).length;

    return {
      total,
      available,
      withAnalyzers,
      runtimes: Object.fromEntries(
        Array.from(this.runtimes.entries()).map(([name, runtime]) => [
          name,
          {
            available: runtime.available,
            version: runtime.version,
            hasAnalyzer: !!runtime.analyzer
          }
        ])
      )
    };
  }
}

// Enhanced TypeScript analyzer that integrates with existing infrastructure
class TypeScriptAnalyzer implements LanguageAnalyzer {
  name = 'typescript';
  runtime = 'node';
  command = 'node';
  supports = ['.ts', '.tsx', '.js', '.jsx'];

  async analyze(files: string[], options?: any): Promise<AnalysisResult> {
    console.log(`[TypeScriptAnalyzer] Analyzing ${files.length} TypeScript files`);
    const startTime = Date.now();
    
    try {
      // Import the existing TypeScript adapter and audit infrastructure
      const { TypeScriptAdapter } = await import('./typescript/TypeScriptAdapter.js');
      const { runAudit } = await import('../auditRunner.js');
      
      // Run the existing audit process
      const auditResult = await runAudit({
        includePaths: files,
        enabledAnalyzers: options?.analyzers || ['solid', 'dry', 'documentation', 'dataAccess'],
        minSeverity: options?.minSeverity || 'warning',
        verbose: false
      });

      // Extract index entries from the audit process
      const indexEntries: any[] = [];
      
      // Try to get functions from the audit metadata if available
      if (auditResult.metadata?.collectedFunctions) {
        for (const func of auditResult.metadata.collectedFunctions) {
          indexEntries.push({
            id: `typescript:function:${func.filePath}:${func.name}:${func.lineNumber || 0}`,
            name: func.name,
            type: 'function',
            language: 'typescript',
            file: func.filePath,
            signature: func.name, // Basic signature
            parameters: [],
            purpose: func.purpose || '',
            context: func.context || '',
            startLine: func.startLine,
            endLine: func.endLine,
            lineNumber: func.lineNumber,
            metadata: func.metadata
          });
        }
      }

      // Add component information if available
      if (auditResult.metadata?.fileToFunctionsMap) {
        for (const [filePath, funcs] of Object.entries(auditResult.metadata.fileToFunctionsMap)) {
          for (const func of funcs) {
            if (!indexEntries.find(e => e.id === `typescript:function:${func.filePath}:${func.name}:${func.lineNumber || 0}`)) {
              indexEntries.push({
                id: `typescript:function:${func.filePath}:${func.name}:${func.lineNumber || 0}`,
                name: func.name,
                type: 'function',
                language: 'typescript',
                file: func.filePath,
                signature: func.name,
                parameters: [],
                purpose: func.purpose || '',
                context: func.context || '',
                startLine: func.startLine,
                endLine: func.endLine,
                lineNumber: func.lineNumber,
                metadata: func.metadata
              });
            }
          }
        }
      }

      const executionTime = Date.now() - startTime;

      // Extract violations from all analyzer results
      const violations: any[] = [];
      for (const [analyzerName, analyzerResult] of Object.entries(auditResult.analyzerResults)) {
        violations.push(...analyzerResult.violations);
      }

      // Extract errors from analyzer results
      const errors: any[] = [];
      for (const [analyzerName, analyzerResult] of Object.entries(auditResult.analyzerResults)) {
        if (analyzerResult.errors) {
          errors.push(...analyzerResult.errors);
        }
      }

      return {
        violations,
        indexEntries,
        metrics: {
          filesAnalyzed: files.length,
          executionTime
        },
        errors
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`[TypeScriptAnalyzer] Error during analysis:`, error);
      
      return {
        violations: [],
        indexEntries: [],
        metrics: {
          filesAnalyzed: 0,
          executionTime
        },
        errors: [{
          message: error instanceof Error ? error.message : String(error),
          type: 'analysis_error'
        }]
      };
    }
  }
}

class GoAnalyzer implements LanguageAnalyzer {
  name = 'go';
  runtime = 'go';
  command: string;
  supports = ['.go'];

  constructor(private analyzerPath?: string) {
    this.command = analyzerPath || 'go';
  }

  async analyze(files: string[], options?: any): Promise<AnalysisResult> {
    console.log(`[GoAnalyzer] Analyzing ${files.length} Go files`);
    const startTime = Date.now();
    
    try {
      // Build the Go analyzer if needed
      const goAnalyzerDir = path.join(__dirname, 'go');
      await this.ensureGoAnalyzerBuilt(goAnalyzerDir);
      
      // Prepare analysis options
      const analysisOptions = {
        analyzers: options?.analyzers || ['solid', 'imports', 'errors'],
        minSeverity: options?.minSeverity || 'warning',
        timeout: options?.timeout || 30000,
        language: options?.language || 'go',
        verbose: options?.verbose || false
      };

      // Run the Go analyzer via JSON-RPC
      const result = await this.runGoAnalyzer(goAnalyzerDir, files, analysisOptions);
      
      const executionTime = Date.now() - startTime;
      result.metrics.executionTime = executionTime;
      
      console.log(`[GoAnalyzer] Analysis complete: ${result.violations.length} violations, ${result.indexEntries.length} entities`);
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`[GoAnalyzer] Error during analysis:`, error);
      
      return {
        violations: [],
        indexEntries: [],
        metrics: {
          filesAnalyzed: 0,
          executionTime
        },
        errors: [{
          message: error instanceof Error ? error.message : String(error),
          type: 'go_analyzer_error'
        }]
      };
    }
  }

  private async ensureGoAnalyzerBuilt(goDir: string): Promise<void> {
    const binaryPath = path.join(goDir, 'analyzer');
    const mainGoPath = path.join(goDir, 'main.go');
    
    try {
      // Check if binary exists
      await fs.access(binaryPath);
      console.log(`[GoAnalyzer] Binary already exists at ${binaryPath}`);
    } catch {
      // Binary doesn't exist, build it
      console.log(`[GoAnalyzer] Building Go analyzer binary...`);
      
      try {
        const { stdout, stderr } = await execAsync(`cd "${goDir}" && go build -o analyzer main.go`);
        if (stderr) {
          console.warn(`[GoAnalyzer] Build warnings: ${stderr}`);
        }
        console.log(`[GoAnalyzer] Successfully built Go analyzer binary`);
      } catch (buildError) {
        throw new Error(`Failed to build Go analyzer: ${buildError}`);
      }
    }
  }

  private async runGoAnalyzer(goDir: string, files: string[], options: any): Promise<AnalysisResult> {
    const binaryPath = path.join(goDir, 'analyzer');
    
    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: goDir
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Go analyzer exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          // Parse the last line as JSON response
          const lines = stdout.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          const response = JSON.parse(lastLine);
          
          if (response.error) {
            reject(new Error(`Go analyzer error: ${response.error.message}`));
          } else {
            resolve(response.result);
          }
        } catch (parseError) {
          reject(new Error(`Failed to parse Go analyzer response: ${parseError}`));
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to spawn Go analyzer: ${error}`));
      });

      // Send JSON-RPC request
      const request = {
        method: 'analyze',
        params: {
          files,
          options
        },
        id: 1
      };

      child.stdin?.write(JSON.stringify(request) + '\n');
      child.stdin?.end();
    });
  }
}

class PythonAnalyzer implements LanguageAnalyzer {
  name = 'python';
  runtime = 'python';
  command: string;
  supports = ['.py'];

  constructor(pythonCommand: string) {
    this.command = pythonCommand;
  }

  async analyze(files: string[], options?: any): Promise<AnalysisResult> {
    console.log(`[PythonAnalyzer] Analyzing ${files.length} Python files`);
    
    // This will spawn the Python analyzer process
    return {
      violations: [],
      indexEntries: [],
      metrics: {
        filesAnalyzed: files.length,
        executionTime: 0
      }
    };
  }
}