/**
 * DRY (Don't Repeat Yourself) Analyzer (Functional)
 * Detects code duplication across the entire codebase
 * 
 * Uses a code index to efficiently find:
 * - Exact code duplicates
 * - Similar code patterns
 * - Repeated string literals
 * - Duplicate imports
 */

import * as ts from 'typescript';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { 
  DRYViolation,
  AnalyzerDefinition,
  Violation
} from '../types.js';
import { 
  parseTypeScriptFile,
  getNodeText,
  getLineAndColumn,
  findNodesByKind,
  getImports
} from './analyzerUtils.js';
import {
  getImportsDetailed,
  extractIdentifierUsage
} from '../utils/astUtils.js';

/**
 * Debug logger
 */
class DebugLogger {
  private logs: string[] = [];
  private enabled: boolean;

  constructor(enabled: boolean = false) {
    this.enabled = enabled;
  }

  log(message: string, data?: any): void {
    if (!this.enabled) return;
    
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    
    if (data !== undefined) {
      this.logs.push(`${logEntry}\n${JSON.stringify(data, null, 2)}`);
    } else {
      this.logs.push(logEntry);
    }
    
    // Don't log to console to avoid interfering with MCP protocol
    // console.log(`[DRY] ${message}`, data || '');
  }

  async writeToFile(filePath: string): Promise<void> {
    if (!this.enabled || this.logs.length === 0) return;
    
    const content = this.logs.join('\n\n');
    await fs.writeFile(filePath, content, 'utf-8');
    // Don't log to console - the file write is sufficient
  }

  getLogs(): string[] {
    return this.logs;
  }
}

/**
 * Configuration for DRY analyzer
 */
export interface DRYAnalyzerConfig {
  minLineThreshold?: number;
  similarityThreshold?: number;
  excludePatterns?: string[];
  checkImports?: boolean;
  checkStrings?: boolean;
  checkUnusedImports?: boolean;
  ignoreComments?: boolean;
  ignoreWhitespace?: boolean;
  debug?: boolean;
  debugLogPath?: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: DRYAnalyzerConfig = {
  minLineThreshold: 5,
  similarityThreshold: 0.85,
  excludePatterns: ['**/*.test.ts', '**/*.spec.ts'],
  checkImports: true,
  checkStrings: true,
  checkUnusedImports: true,
  ignoreComments: true,
  ignoreWhitespace: true,
  debug: false,
  debugLogPath: './dry-analyzer-debug.log'
};

/**
 * Code block information for indexing
 */
interface CodeBlock {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  normalizedText: string;
  hash: string;
  type: 'function' | 'class' | 'method' | 'block' | 'import' | 'string';
  name?: string;
}

/**
 * Code index for efficient duplicate detection
 */
interface CodeIndex {
  blocks: CodeBlock[];
  hashMap: Map<string, CodeBlock[]>;
  stringLiterals: Map<string, Array<{ file: string; line: number }>>;
  imports: Map<string, Array<{ file: string; line: number; modules: string[] }>>;
  unusedImports: Map<string, Array<{ file: string; line: number; importName: string; moduleSpecifier: string }>>;
}

/**
 * Build a code index from all files
 */
async function buildCodeIndex(
  files: string[],
  config: DRYAnalyzerConfig,
  logger: DebugLogger
): Promise<CodeIndex> {
  const index: CodeIndex = {
    blocks: [],
    hashMap: new Map(),
    stringLiterals: new Map(),
    imports: new Map(),
    unusedImports: new Map()
  };

  logger.log(`Building code index for ${files.length} files`);

  for (const file of files) {
    // Skip excluded patterns
    if (config.excludePatterns?.some(pattern => 
      file.includes(pattern.replace('**/', '').replace('*', ''))
    )) {
      logger.log(`Skipping excluded file: ${file}`);
      continue;
    }

    try {
      const { sourceFile } = await parseTypeScriptFile(file);
      logger.log(`Processing file: ${file}`);
      
      // Extract code blocks
      const blocks = extractCodeBlocks(sourceFile, file, config, logger);
      logger.log(`Extracted ${blocks.length} code blocks from ${file}`);
      
      for (const block of blocks) {
        index.blocks.push(block);
        
        // Add to hash map for O(1) duplicate lookup
        if (!index.hashMap.has(block.hash)) {
          index.hashMap.set(block.hash, []);
        }
        index.hashMap.get(block.hash)!.push(block);
      }
      
      // Extract string literals if enabled
      if (config.checkStrings) {
        const stringCount = index.stringLiterals.size;
        extractStringLiterals(sourceFile, file, index.stringLiterals, logger);
        logger.log(`Found ${index.stringLiterals.size - stringCount} new string literals`);
      }
      
      // Extract imports if enabled
      if (config.checkImports) {
        const importCount = index.imports.size;
        extractImports(sourceFile, file, index.imports, logger);
        logger.log(`Found ${index.imports.size - importCount} new import patterns`);
      }
      
      // Extract unused imports if enabled
      if (config.checkUnusedImports) {
        const unusedImportCount = index.unusedImports.size;
        extractUnusedImports(sourceFile, file, index.unusedImports, logger);
        logger.log(`Found ${index.unusedImports.size - unusedImportCount} new unused imports`);
      }
    } catch (error) {
      logger.log(`Error processing ${file}: ${error}`);
      // Don't use console.error to avoid MCP interference
    }
  }
  
  logger.log('Code index built', {
    totalBlocks: index.blocks.length,
    uniqueHashes: index.hashMap.size,
    stringLiterals: index.stringLiterals.size,
    importPatterns: index.imports.size,
    unusedImports: index.unusedImports.size
  });
  
  return index;
}

/**
 * Extract code blocks from a source file
 */
function extractCodeBlocks(
  sourceFile: ts.SourceFile,
  filePath: string,
  config: DRYAnalyzerConfig,
  logger: DebugLogger
): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  
  // Extract functions
  const functions = findNodesByKind<ts.FunctionDeclaration>(
    sourceFile as ts.Node,
    ts.SyntaxKind.FunctionDeclaration
  );
  
  for (const func of functions) {
    const block = createCodeBlock(sourceFile, func, filePath, 'function', config);
    if (block && isBlockLargeEnough(block, config)) {
      blocks.push(block);
    }
  }
  
  // Extract arrow functions
  const arrowFunctions = findNodesByKind<ts.ArrowFunction>(
    sourceFile as ts.Node,
    ts.SyntaxKind.ArrowFunction
  );
  
  for (const arrow of arrowFunctions) {
    const block = createCodeBlock(sourceFile, arrow, filePath, 'function', config);
    if (block && isBlockLargeEnough(block, config)) {
      blocks.push(block);
    }
  }
  
  // Extract methods
  const methods = findNodesByKind<ts.MethodDeclaration>(
    sourceFile as ts.Node,
    ts.SyntaxKind.MethodDeclaration
  );
  
  for (const method of methods) {
    const block = createCodeBlock(sourceFile, method, filePath, 'method', config);
    if (block && isBlockLargeEnough(block, config)) {
      blocks.push(block);
    }
  }
  
  // Extract class declarations
  const classes = findNodesByKind<ts.ClassDeclaration>(
    sourceFile as ts.Node,
    ts.SyntaxKind.ClassDeclaration
  );
  
  for (const cls of classes) {
    const block = createCodeBlock(sourceFile, cls, filePath, 'class', config);
    if (block && isBlockLargeEnough(block, config)) {
      blocks.push(block);
    }
  }
  
  // Extract block statements (if/else, loops, etc.)
  const blockStatements = findNodesByKind<ts.Block>(
    sourceFile as ts.Node,
    ts.SyntaxKind.Block
  );
  
  for (const blockStmt of blockStatements) {
    // Only consider substantial blocks
    const block = createCodeBlock(sourceFile, blockStmt, filePath, 'block', config);
    if (block && isBlockLargeEnough(block, config)) {
      blocks.push(block);
    }
  }
  
  return blocks;
}

/**
 * Create a code block from a node
 */
function createCodeBlock(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  filePath: string,
  type: CodeBlock['type'],
  config: DRYAnalyzerConfig
): CodeBlock | null {
  const text = getNodeText(node, sourceFile);
  const normalizedText = normalizeCode(text, config);
  
  if (!normalizedText.trim()) {
    return null;
  }
  
  const { line: startLine } = getLineAndColumn(sourceFile, node.getStart());
  const { line: endLine } = getLineAndColumn(sourceFile, node.getEnd());
  
  let name: string | undefined;
  if ('name' in node && node.name) {
    const nodeName = (node as any).name;
    if (ts.isIdentifier(nodeName)) {
      name = nodeName.text;
    }
  }
  
  return {
    file: filePath,
    startLine,
    endLine,
    text,
    normalizedText,
    hash: hashCode(normalizedText),
    type,
    name
  };
}

/**
 * Normalize code for comparison
 */
function normalizeCode(code: string, config: DRYAnalyzerConfig): string {
  let normalized = code;
  
  if (config.ignoreComments) {
    // Remove single-line comments
    normalized = normalized.replace(/\/\/.*$/gm, '');
    // Remove multi-line comments
    normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
  }
  
  if (config.ignoreWhitespace) {
    // Normalize whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();
  }
  
  // Remove variable names to detect similar patterns
  // This is a simple approach - could be improved with proper AST analysis
  normalized = normalized.replace(/\b(?:const|let|var)\s+(\w+)/g, 'VAR $1');
  
  return normalized;
}

/**
 * Hash code for fast comparison
 */
function hashCode(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

/**
 * Check if a block is large enough to be considered
 */
function isBlockLargeEnough(block: CodeBlock, config: DRYAnalyzerConfig): boolean {
  const lineCount = block.endLine - block.startLine + 1;
  return lineCount >= (config.minLineThreshold || 5);
}

/**
 * Extract string literals
 */
function extractStringLiterals(
  sourceFile: ts.SourceFile,
  filePath: string,
  stringMap: Map<string, Array<{ file: string; line: number }>>,
  logger: DebugLogger
): void {
  const stringLiterals = findNodesByKind<ts.StringLiteral>(
    sourceFile as ts.Node,
    ts.SyntaxKind.StringLiteral
  );
  
  for (const literal of stringLiterals) {
    const text = literal.text;
    
    // Skip short strings and common ones
    if (text.length < 10 || isCommonString(text)) {
      continue;
    }
    
    const { line } = getLineAndColumn(sourceFile, literal.getStart());
    
    if (!stringMap.has(text)) {
      stringMap.set(text, []);
    }
    
    stringMap.get(text)!.push({ file: filePath, line });
  }
}

/**
 * Check if a string is too common to track
 */
function isCommonString(str: string): boolean {
  const common = [
    'use strict',
    'default',
    'exports',
    'undefined',
    'null',
    'true',
    'false',
    '',
    ' ',
    '\n',
    '\t'
  ];
  
  return common.includes(str) || /^[\s\d]+$/.test(str);
}

/**
 * Extract imports
 */
function extractImports(
  sourceFile: ts.SourceFile,
  filePath: string,
  importMap: Map<string, Array<{ file: string; line: number; modules: string[] }>>,
  logger: DebugLogger
): void {
  const imports = getImports(sourceFile);
  
  for (const imp of imports) {
    const key = `${imp.moduleSpecifier}:${imp.importedNames.sort().join(',')}`;
    
    if (!importMap.has(key)) {
      importMap.set(key, []);
    }
    
    importMap.get(key)!.push({
      file: filePath,
      line: imp.line,
      modules: imp.importedNames
    });
  }
}

/**
 * Extract unused imports from a source file
 */
function extractUnusedImports(
  sourceFile: ts.SourceFile,
  filePath: string,
  unusedImportsMap: Map<string, Array<{ file: string; line: number; importName: string; moduleSpecifier: string }>>,
  logger: DebugLogger
): void {
  // Get detailed imports
  const detailedImports = getImportsDetailed(sourceFile);
  const importNames = new Set(detailedImports.map(imp => imp.localName));
  
  // Extract identifier usage across the entire file
  const usageMap = extractIdentifierUsage(sourceFile, sourceFile, importNames);
  
  // Find unused imports
  for (const imp of detailedImports) {
    if (!usageMap.has(imp.localName)) {
      const key = `${filePath}:${imp.localName}`;
      
      
      if (!unusedImportsMap.has(key)) {
        unusedImportsMap.set(key, []);
      }
      
      // Get line number for this import
      const importInfo = getImports(sourceFile).find(i => 
        i.moduleSpecifier === imp.modulePath &&
        (i.importedNames.includes(imp.localName) ||
         i.importedNames.some(name => name === `* as ${imp.localName}`))
      );
      
      unusedImportsMap.get(key)!.push({
        file: filePath,
        line: importInfo?.line || 0,
        importName: imp.localName,
        moduleSpecifier: imp.modulePath
      });
    }
  }
}

/**
 * Find duplicates in the code index
 */
function findDuplicates(index: CodeIndex, config: DRYAnalyzerConfig, logger: DebugLogger): DRYViolation[] {
  const violations: DRYViolation[] = [];
  
  // Find exact duplicates
  logger.log(`Checking ${index.hashMap.size} unique hashes for duplicates`);
  
  for (const [hash, blocks] of index.hashMap) {
    if (blocks.length > 1) {
      logger.log(`Hash ${hash} has ${blocks.length} blocks`);
      
      // Group by actual code (not just hash) to avoid false positives
      const groups = groupByExactCode(blocks);
      
      for (const group of groups) {
        if (group.length > 1) {
          logger.log(`Found exact duplicate with ${group.length} instances`, {
            files: group.map(b => ({ file: b.file, line: b.startLine, type: b.type })),
            preview: group[0].text.substring(0, 100) + '...'
          });
          violations.push(createDuplicateViolation(group, 'exact-duplicate'));
        }
      }
    }
  }
  
  // Find similar code blocks
  const similarViolations = findSimilarBlocks(index.blocks, config, logger);
  violations.push(...similarViolations);
  
  // Find duplicate strings
  if (config.checkStrings) {
    for (const [str, locations] of index.stringLiterals) {
      if (locations.length > 2) { // More than 2 occurrences
        violations.push(createStringDuplicateViolation(str, locations));
      }
    }
  }
  
  // Find duplicate imports
  if (config.checkImports) {
    for (const [importKey, locations] of index.imports) {
      if (locations.length > 3) { // More than 3 files with same imports
        violations.push(createImportDuplicateViolation(importKey, locations));
      }
    }
  }
  
  // Find unused imports
  if (config.checkUnusedImports) {
    for (const [importKey, locations] of index.unusedImports) {
      if (locations.length > 0) {
        violations.push(createUnusedImportViolation(locations[0]));
      }
    }
  }
  
  return violations;
}

/**
 * Group blocks by exact code content
 */
function groupByExactCode(blocks: CodeBlock[]): CodeBlock[][] {
  const groups = new Map<string, CodeBlock[]>();
  
  for (const block of blocks) {
    const key = block.normalizedText;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(block);
  }
  
  return Array.from(groups.values());
}

/**
 * Find similar (but not exact) code blocks
 */
function findSimilarBlocks(blocks: CodeBlock[], config: DRYAnalyzerConfig, logger: DebugLogger): DRYViolation[] {
  const violations: DRYViolation[] = [];
  const threshold = config.similarityThreshold || 0.85;
  const processed = new Set<string>();
  
  for (let i = 0; i < blocks.length; i++) {
    const block1 = blocks[i];
    const key1 = `${block1.file}:${block1.startLine}`;
    
    if (processed.has(key1)) continue;
    
    const similar: CodeBlock[] = [block1];
    
    for (let j = i + 1; j < blocks.length; j++) {
      const block2 = blocks[j];
      const key2 = `${block2.file}:${block2.startLine}`;
      
      if (processed.has(key2)) continue;
      
      // Skip if same hash (already handled in exact duplicates)
      if (block1.hash === block2.hash) continue;
      
      const similarity = calculateSimilarity(block1.normalizedText, block2.normalizedText);
      
      if (similarity >= threshold) {
        similar.push(block2);
        processed.add(key2);
      }
    }
    
    if (similar.length > 1) {
      violations.push(createDuplicateViolation(similar, 'similar-logic', 
        calculateAverageSimilarity(similar)));
      similar.forEach(b => processed.add(`${b.file}:${b.startLine}`));
    }
  }
  
  return violations;
}

/**
 * Calculate similarity between two strings (0-1)
 */
function calculateSimilarity(str1: string, str2: string): number {
  // Simple token-based similarity
  const tokens1 = tokenize(str1);
  const tokens2 = tokenize(str2);
  
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  // Jaccard similarity
  const jaccard = intersection.size / union.size;
  
  // Length similarity
  const lengthSim = Math.min(str1.length, str2.length) / Math.max(str1.length, str2.length);
  
  // Combined similarity
  return (jaccard * 0.7 + lengthSim * 0.3);
}

/**
 * Tokenize code for similarity comparison
 */
function tokenize(code: string): string[] {
  return code
    .split(/\s+/)
    .filter(token => token.length > 0)
    .map(token => token.toLowerCase());
}

/**
 * Calculate average similarity for a group
 */
function calculateAverageSimilarity(blocks: CodeBlock[]): number {
  if (blocks.length < 2) return 1;
  
  let totalSim = 0;
  let count = 0;
  
  for (let i = 0; i < blocks.length - 1; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      totalSim += calculateSimilarity(blocks[i].normalizedText, blocks[j].normalizedText);
      count++;
    }
  }
  
  return totalSim / count;
}

/**
 * Create a duplicate violation
 */
function createDuplicateViolation(
  blocks: CodeBlock[],
  type: DRYViolation['type'],
  similarity?: number
): DRYViolation {
  const primary = blocks[0];
  const locations = blocks.map(b => ({ file: b.file, line: b.startLine }));
  
  const totalLines = blocks.reduce((sum, b) => sum + (b.endLine - b.startLine + 1), 0);
  
  return {
    analyzer: 'dry',
    file: primary.file,
    line: primary.startLine,
    severity: type === 'exact-duplicate' ? 'warning' : 'suggestion',
    type,
    message: `${type === 'exact-duplicate' ? 'Exact duplicate' : 'Similar'} code found in ${blocks.length} locations`,
    recommendation: `Consider extracting this ${primary.type} into a shared utility function`,
    locations,
    similarity,
    metrics: {
      duplicateLines: totalLines - (primary.endLine - primary.startLine + 1),
      totalLines
    },
    estimatedEffort: 'medium'
  };
}

/**
 * Create a string duplicate violation
 */
function createStringDuplicateViolation(
  str: string,
  locations: Array<{ file: string; line: number }>
): DRYViolation {
  return {
    analyzer: 'dry',
    file: locations[0].file,
    line: locations[0].line,
    severity: 'suggestion',
    type: 'exact-duplicate',
    message: `String literal "${str.substring(0, 50)}${str.length > 50 ? '...' : ''}" appears ${locations.length} times`,
    recommendation: 'Consider extracting this string into a named constant',
    locations,
    estimatedEffort: 'small'
  };
}

/**
 * Create an import duplicate violation
 */
function createImportDuplicateViolation(
  importKey: string,
  locations: Array<{ file: string; line: number; modules: string[] }>
): DRYViolation {
  const [moduleSpec] = importKey.split(':');
  
  return {
    analyzer: 'dry',
    file: locations[0].file,
    line: locations[0].line,
    severity: 'suggestion',
    type: 'pattern-duplication',
    message: `Same import pattern from "${moduleSpec}" used in ${locations.length} files`,
    recommendation: 'Consider creating a barrel export or shared import module',
    locations: locations.map(l => ({ file: l.file, line: l.line })),
    estimatedEffort: 'small'
  };
}

/**
 * Create an unused import violation
 */
function createUnusedImportViolation(
  location: { file: string; line: number; importName: string; moduleSpecifier: string }
): DRYViolation {
  return {
    analyzer: 'dry',
    file: location.file,
    line: location.line,
    severity: 'suggestion',
    type: 'pattern-duplication',
    message: `Unused import '${location.importName}' from '${location.moduleSpecifier}'`,
    recommendation: `Remove this unused import to keep the codebase clean and reduce bundle size`,
    estimatedEffort: 'small'
  };
}

/**
 * DRY Analyzer definition
 */
export const dryAnalyzer: AnalyzerDefinition = {
  name: 'dry',
  defaultConfig: DEFAULT_CONFIG,
  analyze: async (files, config, options, progressCallback) => {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    const logger = new DebugLogger(mergedConfig.debug || false);
    
    logger.log('DRY Analyzer started', {
      filesCount: files.length,
      config: mergedConfig
    });
    
    // Report initial progress
    if (progressCallback) {
      progressCallback({ 
        current: 0, 
        total: files.length, 
        analyzer: 'dry', 
        phase: 'indexing' 
      });
    }
    
    // Build code index
    const startTime = Date.now();
    const index = await buildCodeIndex(files, mergedConfig, logger);
    
    // Report analysis progress
    if (progressCallback) {
      progressCallback({ 
        current: files.length / 2, 
        total: files.length, 
        analyzer: 'dry', 
        phase: 'analyzing' 
      });
    }
    
    // Find duplicates
    const violations = findDuplicates(index, mergedConfig, logger);
    
    logger.log('DRY Analysis complete', {
      violationsFound: violations.length,
      executionTime: Date.now() - startTime
    });
    
    // Write debug log to file
    if (mergedConfig.debug && mergedConfig.debugLogPath) {
      await logger.writeToFile(mergedConfig.debugLogPath);
    }
    
    // Complete
    if (progressCallback) {
      progressCallback({ 
        current: files.length, 
        total: files.length, 
        analyzer: 'dry', 
        phase: 'complete' 
      });
    }
    
    return {
      violations,
      filesProcessed: files.length,
      executionTime: Date.now() - startTime,
      analyzerName: 'dry'
    };
  }
};