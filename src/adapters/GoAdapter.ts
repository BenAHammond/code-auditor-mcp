/**
 * Go Language Adapter
 * 
 * Provides Go language support through the LanguageAdapter interface.
 * Uses the Go-based analyzer as a child process for proper AST analysis.
 */

import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import fs from 'fs';
import {
  LanguageAdapter,
  AST,
  ASTNode,
  NodePattern,
  FunctionInfo,
  ClassInfo,
  ImportInfo,
  ExportInfo,
  SourceLocation,
  ParseError,
  ParameterInfo,
  PropertyInfo
} from './LanguageAdapter.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// JSON-RPC structures
interface JSONRPCRequest {
  method: string;
  params: any;
  id: number;
}

interface JSONRPCResponse {
  result?: any;
  error?: {
    code: number;
    message: string;
  };
  id: number;
}

// Go analyzer result structures
interface GoAnalysisResult {
  Violations: GoViolation[];
  IndexEntries: GoIndexEntry[];
  Metrics: {
    FilesAnalyzed: number;
    ExecutionTime: number;
  };
  Errors: GoError[];
}

interface GoViolation {
  File: string;
  Line: number;
  Severity: string;
  Message: string;
  Details: Record<string, any>;
  Suggestion: string;
  Analyzer: string;
  Category: string;
}

interface GoIndexEntry {
  Name: string;
  Type: string;
  File: string;
  StartLine: number;
  EndLine: number;
  Signature: string;
  Complexity: number;
  IsExported: boolean;
  Parameters?: string[];
  ReturnType?: string;
}

interface GoError {
  File: string;
  Line: number;
  Message: string;
}

interface GoAnalysisOptions {
  Analyzers: string[];
  MinSeverity: string;
  IncludeIndexing: boolean;
}

export class GoAdapter implements LanguageAdapter {
  readonly name = 'go';
  readonly extensions = ['.go'];
  
  private goAnalyzerProcess: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  
  private goExecutablePath: string;
  private logFile: string;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;
  private jsonBuffer = '';
  
  constructor(goExecutablePath: string = 'go') {
    this.goExecutablePath = goExecutablePath;
    
    // Create log file for Go child process debugging
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFile = path.join(process.cwd(), `go-analyzer-${timestamp}.log`);
    
    console.error(`[DEBUG] Go: Initialized with executable path: ${this.goExecutablePath}`);
    console.error(`[DEBUG] Go: Child process logs will be written to: ${this.logFile}`);
    
    // Initialize log file
    this.writeLog('=== Go Analyzer Process Log Started ===');
    this.writeLog(`Go executable path: ${this.goExecutablePath}`);
    this.writeLog(`Path is absolute: ${path.isAbsolute(this.goExecutablePath)}`);
    
    // Register cleanup on process exit
    this.registerProcessCleanup();
  }
  
  private writeLog(message: string): void {
    try {
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] ${message}\n`;
      fs.appendFileSync(this.logFile, logEntry);
    } catch (error) {
      console.error('[DEBUG] Go: Failed to write to log file:', error);
    }
  }

  private registerProcessCleanup(): void {
    // Cleanup on various exit signals
    const cleanup = () => {
      console.error('[DEBUG] Go: Process cleanup triggered');
      this.writeLog('Process cleanup triggered by exit signal');
      this.cleanup();
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', cleanup);
    process.on('beforeExit', cleanup);
    
    this.writeLog('Registered process cleanup handlers');
  }

  async parse(file: string, content: string): Promise<AST> {
    console.error(`[DEBUG] Go: Parsing file using persistent child process: ${file} (content length: ${content.length})`);
    this.writeLog(`parse() called for ${file}, content length: ${content.length}`);
    
    try {
      // Ensure the process is initialized (lazy initialization)
      await this.ensureInitialized();
      
      // Use persistent process to analyze the file
      const result = await this.analyzeFileWithPersistentProcess(file, content);
      
      console.error(`[DEBUG] Go: Child process returned result with ${result.Violations?.length || 0} violations and ${result.IndexEntries?.length || 0} entities`);
      this.writeLog(`Child process returned ${result.Violations?.length || 0} violations and ${result.IndexEntries?.length || 0} entities`);
      
      // Convert Go analysis result to our AST format
      const ast = this.convertToAST(file, content, result);
      
      console.error(`[DEBUG] Go: Successfully parsed ${file} - AST conversion complete`);
      this.writeLog(`Successfully parsed ${file} - AST conversion complete`);
      
      return ast;
    } catch (error) {
      console.error(`[DEBUG] Go: Error parsing ${file}:`, error);
      console.error(`[DEBUG] Go: Error stack:`, error.stack);
      
      // Return a minimal AST with error information
      const lines = content.split('\n');
      return {
        root: {
          type: 'SourceFile',
          range: [0, content.length],
          location: {
            start: { line: 1, column: 1 },
            end: { line: lines.length, column: lines[lines.length - 1]?.length || 1 }
          },
          raw: { error: error.message }
        },
        language: this.name,
        filePath: file,
        errors: [{
          message: error.message,
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
          severity: 'error'
        }]
      };
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized && this.goAnalyzerProcess) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.initializeProcess();
    return this.initializationPromise;
  }

  private async initializeProcess(): Promise<void> {
    try {
      await this.ensureGoAnalyzer();
      this.isInitialized = true;
      this.writeLog('Persistent Go analyzer process initialized successfully');
    } catch (error) {
      this.initializationPromise = null;
      throw error;
    }
  }

  private async analyzeFileWithPersistentProcess(file: string, content: string): Promise<GoAnalysisResult> {
    if (!this.goAnalyzerProcess) {
      throw new Error('Go analyzer process not available');
    }

    const options: GoAnalysisOptions = {
      Analyzers: ['solid', 'imports'],
      MinSeverity: 'info',
      IncludeIndexing: true
    };

    const request: JSONRPCRequest = {
      method: 'analyzeContent',
      params: {
        file: file,
        content: content,
        options: options
      },
      id: ++this.requestId
    };

    this.writeLog(`Sending analysis request for ${file} (using content instead of file path)`);

    return new Promise((resolve, reject) => {
      // Set timeout for request
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`Go analyzer request timeout after 10 seconds`));
      }, 10000);

      this.pendingRequests.set(request.id, { 
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      const requestLine = JSON.stringify(request) + '\n';
      this.writeLog(`Sending JSON-RPC request: ${requestLine.trim()}`);
      
      try {
        this.goAnalyzerProcess.stdin?.write(requestLine);
        this.writeLog(`Request sent successfully to stdin`);
      } catch (error) {
        this.writeLog(`Error writing to stdin: ${error.message}`);
        reject(error);
      }
    });
  }

  private async analyzeFile(file: string): Promise<GoAnalysisResult> {
    console.error(`[DEBUG] Go: analyzeFile called for: ${file}`);
    
    try {
      await this.ensureGoAnalyzer();
      console.error(`[DEBUG] Go: Go analyzer ensured successfully`);
    } catch (error) {
      console.error(`[DEBUG] Go: Failed to ensure analyzer:`, error);
      throw error;
    }
    
    const options: GoAnalysisOptions = {
      Analyzers: ['solid', 'imports'],
      MinSeverity: 'info',
      IncludeIndexing: true
    };

    const request: JSONRPCRequest = {
      method: 'analyze',
      params: {
        files: [file],
        options: options
      },
      id: ++this.requestId
    };

    console.error(`[DEBUG] Go: Created request with ID ${request.id}`);

    return new Promise((resolve, reject) => {
      // Set timeout for request
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`Go analyzer request timeout after 10 seconds`));
      }, 10000);

      this.pendingRequests.set(request.id, { 
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
      
      if (!this.goAnalyzerProcess) {
        reject(new Error('Go analyzer process not available after ensure'));
        return;
      }

      // Send the request
      const requestLine = JSON.stringify(request) + '\n';
      console.error(`[DEBUG] Go: Sending request to analyzer: ${requestLine.trim()}`);
      this.writeLog(`Sending JSON-RPC request: ${requestLine.trim()}`);
      
      try {
        this.goAnalyzerProcess.stdin?.write(requestLine);
        console.error(`[DEBUG] Go: Request sent successfully`);
        this.writeLog(`Request sent successfully to stdin`);
      } catch (error) {
        console.error(`[DEBUG] Go: Error writing to stdin:`, error);
        this.writeLog(`Error writing to stdin: ${error.message}`);
        reject(error);
      }
    });
  }

  private async ensureGoAnalyzer(): Promise<void> {
    if (this.goAnalyzerProcess) {
      console.error('[DEBUG] Go: Analyzer process already running');
      return;
    }

    console.error('[DEBUG] Go: Starting Go analyzer process...');
    
    // Path to the Go analyzer binary
    // __dirname points to dist/adapters, so we need to go to src/languages/go
    const goAnalyzerPath = path.join(__dirname, '../../src/languages/go/main.go');
    const goModPath = path.dirname(goAnalyzerPath);
    
    console.error(`[DEBUG] Go: Go analyzer path: ${goAnalyzerPath}`);
    console.error(`[DEBUG] Go: Go mod path: ${goModPath}`);
    
    try {
      // Start the Go analyzer as a child process
      console.error(`[DEBUG] Go: Spawning ${this.goExecutablePath} run main.go...`);
      this.writeLog(`Starting Go analyzer: ${this.goExecutablePath} run main.go`);
      this.writeLog(`Working directory: ${goModPath}`);
      
      this.goAnalyzerProcess = spawn(this.goExecutablePath, ['run', 'main.go'], {
        cwd: goModPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env  // Inherit full environment including PATH
      });

      console.error(`[DEBUG] Go: Process spawned with PID: ${this.goAnalyzerProcess.pid}`);
      this.writeLog(`Process spawned with PID: ${this.goAnalyzerProcess.pid}`);

      // Handle stdout (JSON-RPC responses) with proper buffering for large responses
      this.goAnalyzerProcess.stdout?.on('data', (data) => {
        const dataStr = data.toString();
        console.error(`[DEBUG] Go: Raw stdout chunk (${dataStr.length} chars): ${dataStr.substring(0, 200)}...`);
        this.writeLog(`STDOUT Chunk (${dataStr.length} chars): ${dataStr.substring(0, 200)}${dataStr.length > 200 ? '...[TRUNCATED]' : ''}`);
        
        // Add to JSON buffer
        this.jsonBuffer += dataStr;
        
        // Process complete JSON objects from buffer
        this.processJsonBuffer();
      });

      // Handle stderr (debug output)
      this.goAnalyzerProcess.stderr?.on('data', (data) => {
        const stderrStr = data.toString().trim();
        console.error(`[GoAnalyzer] ${stderrStr}`);
        this.writeLog(`STDERR: ${stderrStr}`);
      });

      // Handle process exit
      this.goAnalyzerProcess.on('exit', (code) => {
        console.error(`[DEBUG] Go: Analyzer process exited with code ${code}`);
        this.writeLog(`Process exited with code: ${code}`);
        this.goAnalyzerProcess = null;
        
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error(`Go analyzer process exited with code ${code}`));
        }
        this.pendingRequests.clear();
      });

      // Handle process error
      this.goAnalyzerProcess.on('error', (error: any) => {
        console.error(`[DEBUG] Go: Process error:`, error);
        this.writeLog(`Process error: ${JSON.stringify(error)}`);
        
        if (error.code === 'ENOENT') {
          console.error(`[DEBUG] Go: 'go' command not found. Is Go installed and in your system's PATH?`);
          this.writeLog(`ENOENT: Go command not found`);
        }
        this.goAnalyzerProcess = null;
        
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error(`Go command not found: ${error.message}`));
        }
        this.pendingRequests.clear();
      });

      // Wait a bit for the process to start
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Test the connection
      console.error('[DEBUG] Go: Testing connection with ping...');
      const pingResult = await this.sendPing();
      console.error('[DEBUG] Go: Analyzer ready, ping result:', pingResult);
      
    } catch (error) {
      console.error('[DEBUG] Go: Failed to start analyzer process:', error);
      console.error('[DEBUG] Go: Error stack:', error.stack);
      throw new Error(`Failed to start Go analyzer: ${error.message}`);
    }
  }

  private async sendPing(): Promise<string> {
    const request: JSONRPCRequest = {
      method: 'ping',
      params: {},
      id: ++this.requestId
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject });
      
      if (!this.goAnalyzerProcess) {
        this.writeLog('Ping failed: Go analyzer process not available');
        reject(new Error('Go analyzer process not available'));
        return;
      }

      const requestLine = JSON.stringify(request) + '\n';
      this.writeLog(`Sending ping request: ${requestLine.trim()}`);
      this.goAnalyzerProcess.stdin?.write(requestLine);
    });
  }

  private convertToAST(file: string, content: string, result: GoAnalysisResult): AST {
    console.error(`[DEBUG] Go: convertToAST called for: ${file}`);
    this.writeLog(`convertToAST() called for ${file}`);
    
    const lines = content.split('\n');
    
    // Log the raw result we got from Go analyzer
    console.error(`[DEBUG] Go: Raw result from Go analyzer:`, {
      violations: result.Violations?.length || 0,
      indexEntries: result.IndexEntries?.length || 0,
      errors: result.Errors?.length || 0
    });
    this.writeLog(`Raw result: ${result.Violations?.length || 0} violations, ${result.IndexEntries?.length || 0} index entries, ${result.Errors?.length || 0} errors`);
    
    if (result.IndexEntries) {
      const functionEntries = result.IndexEntries.filter(e => e.Type === 'function');
      const structEntries = result.IndexEntries.filter(e => e.Type === 'struct');
      const interfaceEntries = result.IndexEntries.filter(e => e.Type === 'interface');
      
      console.error(`[DEBUG] Go: Filtering IndexEntries - functions: ${functionEntries.length}, structs: ${structEntries.length}, interfaces: ${interfaceEntries.length}`);
      this.writeLog(`Filtering IndexEntries - functions: ${functionEntries.length}, structs: ${structEntries.length}, interfaces: ${interfaceEntries.length}`);
      
      if (functionEntries.length > 0) {
        console.error(`[DEBUG] Go: Sample function entry:`, functionEntries[0]);
        this.writeLog(`Sample function entry: ${JSON.stringify(functionEntries[0])}`);
      }
    }
    
    // Convert Go analysis result to our unified AST format
    const entities = {
      functions: result.IndexEntries?.filter(e => e.Type === 'function') || [],
      structs: result.IndexEntries?.filter(e => e.Type === 'struct') || [],
      interfaces: result.IndexEntries?.filter(e => e.Type === 'interface') || [],
      violations: result.Violations || []
    };
    
    console.error(`[DEBUG] Go: Final entities object:`, {
      functions: entities.functions.length,
      structs: entities.structs.length,
      interfaces: entities.interfaces.length,
      violations: entities.violations.length
    });
    this.writeLog(`Final entities: ${entities.functions.length} functions, ${entities.structs.length} structs, ${entities.interfaces.length} interfaces, ${entities.violations.length} violations`);

    return {
      root: {
        type: 'SourceFile',
        range: [0, content.length],
        location: {
          start: { line: 1, column: 1 },
          end: { line: lines.length, column: lines[lines.length - 1]?.length || 1 }
        },
        raw: entities
      },
      language: this.name,
      filePath: file,
      errors: result.Errors?.map(err => ({
        message: err.Message,
        location: {
          start: { line: err.Line, column: 1 },
          end: { line: err.Line, column: 1 }
        },
        severity: 'error' as const
      })) || []
    };
  }

  supportsFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.extensions.includes(ext);
  }

  findNodes(ast: AST, pattern: NodePattern): ASTNode[] {
    const results: ASTNode[] = [];
    const entities = ast.root.raw;
    
    if (pattern.type === 'function' && entities.functions) {
      for (const func of entities.functions) {
        results.push(this.createFunctionNode(func));
      }
    }
    
    if (pattern.type === 'struct' && entities.structs) {
      for (const struct of entities.structs) {
        results.push(this.createStructNode(struct));
      }
    }
    
    return results;
  }

  private createFunctionNode(func: GoIndexEntry): ASTNode {
    return {
      type: 'function',
      range: [0, 0], // Simplified
      location: {
        start: { line: func.StartLine, column: 1 },
        end: { line: func.EndLine, column: 1 }
      },
      raw: func
    };
  }

  private createStructNode(struct: GoIndexEntry): ASTNode {
    return {
      type: 'struct',
      range: [0, 0], // Simplified
      location: {
        start: { line: struct.StartLine, column: 1 },
        end: { line: struct.EndLine, column: 1 }
      },
      raw: struct
    };
  }

  extractFunctions(ast: AST): FunctionInfo[] {
    console.error(`[DEBUG] Go: extractFunctions called for: ${ast.filePath}`);
    this.writeLog(`extractFunctions() called for ${ast.filePath}`);
    
    const entities = ast.root.raw;
    console.error(`[DEBUG] Go: Raw entities:`, JSON.stringify(entities, null, 2).substring(0, 500) + '...');
    this.writeLog(`Raw entities keys: ${Object.keys(entities || {})}`);
    
    if (!entities.functions) {
      console.error(`[DEBUG] Go: No functions found in entities for ${ast.filePath}`);
      this.writeLog(`No functions found in entities for ${ast.filePath}`);
      return [];
    }

    console.error(`[DEBUG] Go: Found ${entities.functions.length} functions in ${ast.filePath}`);
    this.writeLog(`Found ${entities.functions.length} functions in ${ast.filePath}`);

    return entities.functions.map((func: GoIndexEntry) => ({
      name: func.Name,
      location: {
        start: { line: func.StartLine, column: 1 },
        end: { line: func.EndLine, column: 1 }
      },
      parameters: (func.Parameters || []).map((param: string) => ({
        name: param,
        type: 'unknown', // Could be enhanced
        optional: false,
        defaultValue: undefined
      })),
      returnType: func.ReturnType || undefined,
      isAsync: false, // Go doesn't have async/await
      isExported: func.IsExported,
      isMethod: func.Type === 'method',
      className: undefined, // Go uses receivers, not classes
      complexity: func.Complexity || 1,
      lineCount: func.EndLine - func.StartLine + 1
    }));
  }

  extractClasses(ast: AST): ClassInfo[] {
    const entities = ast.root.raw;
    if (!entities.structs) return [];

    // In Go, structs are the closest equivalent to classes
    return entities.structs.map((struct: GoIndexEntry) => ({
      name: struct.Name,
      location: {
        start: { line: struct.StartLine, column: 1 },
        end: { line: struct.EndLine, column: 1 }
      },
      methods: [], // Methods would be found separately
      properties: [], // Could be enhanced to extract fields
      extends: [], // Go uses composition, not inheritance
      implements: [], // Could be enhanced
      isExported: struct.IsExported,
      isAbstract: false // Go doesn't have abstract structs
    }));
  }

  extractImports(ast: AST): ImportInfo[] {
    // Could be enhanced to extract import information from the Go analyzer
    return [];
  }

  extractExports(ast: AST): ExportInfo[] {
    // Could be enhanced to extract export information from the Go analyzer
    return [];
  }

  // AST Navigation
  getParent(node: ASTNode): ASTNode | null {
    // Simplified implementation - could be enhanced with proper parent tracking
    return null;
  }

  getChildren(node: ASTNode): ASTNode[] {
    // Simplified implementation - could be enhanced with proper child extraction
    return [];
  }

  // Node Information
  getNodeType(node: ASTNode): string {
    return node.type;
  }

  getNodeText(node: ASTNode): string {
    // Extract text representation from the Go entity
    const entity = node.raw;
    if (entity.Name) {
      return entity.Name;
    }
    return node.type;
  }

  getNodeLocation(node: ASTNode): SourceLocation {
    return node.location;
  }

  getNodeName(node: ASTNode): string | null {
    const entity = node.raw;
    return entity.Name || null;
  }

  // Pattern Matching
  isClass(node: ASTNode): boolean {
    return node.type === 'struct';
  }

  isFunction(node: ASTNode): boolean {
    return node.type === 'function';
  }

  isMethod(node: ASTNode): boolean {
    return node.type === 'function' && node.raw.Type === 'method';
  }

  isInterface(node: ASTNode): boolean {
    return node.type === 'interface';
  }

  isImport(node: ASTNode): boolean {
    return node.type === 'import';
  }

  isVariable(node: ASTNode): boolean {
    return node.type === 'variable';
  }

  private processJsonBuffer(): void {
    // Look for complete JSON objects (each ends with newline)
    const lines = this.jsonBuffer.split('\n');
    
    // Keep the last partial line in buffer (it might be incomplete)
    this.jsonBuffer = lines.pop() || '';
    
    // Process complete lines
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      try {
        const response: JSONRPCResponse = JSON.parse(trimmed);
        console.error(`[DEBUG] Go: Received complete response for ID ${response.id}`);
        this.writeLog(`Complete JSON-RPC Response for ID ${response.id}: ${JSON.stringify(response).substring(0, 500)}${JSON.stringify(response).length > 500 ? '...[TRUNCATED]' : ''}`);
        
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          
          if (response.error) {
            console.error(`[DEBUG] Go: Response has error:`, response.error);
            this.writeLog(`Response error: ${JSON.stringify(response.error)}`);
            pending.reject(new Error(response.error.message));
          } else {
            console.error(`[DEBUG] Go: Response successful, resolving with ${JSON.stringify(response.result).length} chars`);
            this.writeLog(`Response successful for ID ${response.id}, result size: ${JSON.stringify(response.result).length} chars`);
            pending.resolve(response.result);
          }
        } else {
          console.error(`[DEBUG] Go: No pending request found for ID ${response.id}`);
          this.writeLog(`No pending request found for ID ${response.id}`);
        }
      } catch (error) {
        console.error('[DEBUG] Go: Error parsing JSON line:', error.message, 'Line length:', trimmed.length);
        this.writeLog(`JSON Parse Error: ${error.message}, Line length: ${trimmed.length}, Line start: ${trimmed.substring(0, 100)}`);
        
        // If this line can't be parsed, it might be part of a larger JSON object
        // Put it back in the buffer and hope the next chunk completes it
        if (this.jsonBuffer) {
          this.jsonBuffer = trimmed + '\n' + this.jsonBuffer;
        } else {
          this.jsonBuffer = trimmed;
        }
      }
    }
  }

  async cleanup(): Promise<void> {
    if (this.goAnalyzerProcess) {
      console.error('[DEBUG] Go: Cleaning up analyzer process...');
      this.writeLog('Cleanup initiated - terminating Go process');
      this.goAnalyzerProcess.kill();
      this.goAnalyzerProcess = null;
    }
    
    // Clear JSON buffer
    this.jsonBuffer = '';
    
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Adapter cleanup'));
    }
    this.pendingRequests.clear();
    
    // Reset initialization state
    this.isInitialized = false;
    this.initializationPromise = null;
    
    this.writeLog('Cleanup completed');
  }
}