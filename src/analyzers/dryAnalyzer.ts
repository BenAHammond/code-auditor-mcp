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

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DRYViolation,
  AnalyzerDefinition,
  Violation
} from '../types.js';
import {
  parseFile,
  walkAST,
  findNodes,
  getNodeText,
  getLineAndColumn,
  getNodeName,
  extractImports as extractRawImports,
} from '../languages/adapterBridge.js';
import type { AST, ASTNode } from '../languages/types.js';

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
  }

  async writeToFile(filePath: string): Promise<void> {
    if (!this.enabled || this.logs.length === 0) return;

    const content = this.logs.join('\n\n');
    await fs.writeFile(filePath, content, 'utf-8');
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
 * Detailed import info for unused import detection
 */
interface ImportDetail {
  importType: string;
  localName: string;
  modulePath: string;
  line: number;
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
      const content = await fs.readFile(file, 'utf-8');
      const ast = parseFile(file, content);
      if (!ast) {
        logger.log(`Failed to parse file: ${file}`);
        continue;
      }
      logger.log(`Processing file: ${file}`);

      // Extract code blocks
      const blocks = extractCodeBlocks(ast.root, content, file, config, logger);
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
        extractStringLiteralsFromAST(ast.root, content, file, index.stringLiterals, logger);
        logger.log(`Found ${index.stringLiterals.size - stringCount} new string literals`);
      }

      // Extract imports if enabled
      if (config.checkImports) {
        const importCount = index.imports.size;
        extractImportsFromAST(ast.root, content, file, index.imports, logger);
        logger.log(`Found ${index.imports.size - importCount} new import patterns`);
      }

      // Extract unused imports if enabled
      if (config.checkUnusedImports) {
        const unusedImportCount = index.unusedImports.size;
        extractUnusedImportsFromAST(ast.root, content, file, index.unusedImports, logger);
        logger.log(`Found ${index.unusedImports.size - unusedImportCount} new unused imports`);
      }
    } catch (error) {
      logger.log(`Error processing ${file}: ${error}`);
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
 * Extract code blocks from an AST
 */
function extractCodeBlocks(
  ast: ASTNode,
  sourceCode: string,
  filePath: string,
  config: DRYAnalyzerConfig,
  logger: DebugLogger
): CodeBlock[] {
  const blocks: CodeBlock[] = [];

  // Extract functions
  const functions = findNodes(ast, n => n.type === 'function_declaration');

  for (const func of functions) {
    const block = createCodeBlock(sourceCode, func, filePath, 'function', config);
    if (block && isBlockLargeEnough(block, config)) {
      blocks.push(block);
    }
  }

  // Extract arrow functions
  const arrowFunctions = findNodes(ast, n =>
    n.type === 'arrow_function' || n.type === 'function_expression'
  );

  for (const arrow of arrowFunctions) {
    const block = createCodeBlock(sourceCode, arrow, filePath, 'function', config);
    if (block && isBlockLargeEnough(block, config)) {
      blocks.push(block);
    }
  }

  // Extract methods
  const methods = findNodes(ast, n => n.type === 'method_definition');

  for (const method of methods) {
    const block = createCodeBlock(sourceCode, method, filePath, 'method', config);
    if (block && isBlockLargeEnough(block, config)) {
      blocks.push(block);
    }
  }

  // Extract class declarations
  const classes = findNodes(ast, n => n.type === 'class_declaration');

  for (const cls of classes) {
    const block = createCodeBlock(sourceCode, cls, filePath, 'class', config);
    if (block && isBlockLargeEnough(block, config)) {
      blocks.push(block);
    }
  }

  // Extract block statements (if/else, loops, etc.)
  const blockStatements = findNodes(ast, n => n.type === 'statement_block');

  for (const blockStmt of blockStatements) {
    // Only consider substantial blocks
    const block = createCodeBlock(sourceCode, blockStmt, filePath, 'block', config);
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
  sourceCode: string,
  node: ASTNode,
  filePath: string,
  type: CodeBlock['type'],
  config: DRYAnalyzerConfig
): CodeBlock | null {
  const text = getNodeText(node, sourceCode);
  const normalizedText = normalizeCode(text, config);

  if (!normalizedText.trim()) {
    return null;
  }

  const { line: startLine } = getLineAndColumn(node);
  const endLine = node.location.end.line + 1;

  // Get component/property name if available
  const name = getNodeName(node) ?? undefined;

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
 * Get string value (strip quotes from string literal)
 */
function getStringValue(node: ASTNode, sourceCode: string): string {
  const text = getNodeText(node, sourceCode);
  if ((text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  if (text.startsWith('`') && text.endsWith('`')) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Extract string literals from AST
 */
function extractStringLiteralsFromAST(
  ast: ASTNode,
  sourceCode: string,
  filePath: string,
  stringMap: Map<string, Array<{ file: string; line: number }>>,
  logger: DebugLogger
): void {
  // Find string and template_string nodes
  const stringLiterals = findNodes(ast, n =>
    n.type === 'string' || n.type === 'string_fragment' || n.type === 'template_string'
  );

  for (const literal of stringLiterals) {
    // Only process actual string content (skip quote-only nodes that might be children of template_string)
    const text = getStringValue(literal, sourceCode);

    // Skip short strings and common ones
    if (text.length < 10 || isCommonString(text)) {
      continue;
    }

    const { line } = getLineAndColumn(literal);

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
 * Extract all import names from an import statement node
 */
function extractImportNames(node: ASTNode, sourceCode: string): string[] {
  const names: string[] = [];
  walkAST(node, (child) => {
    if (child.type === 'import_specifier') {
      // named import: "import { foo } from 'bar'"
      for (const c of (child.children || [])) {
        if (c.type === 'identifier') {
          names.push(getNodeText(c, sourceCode));
        }
      }
    }
    if (child.type === 'namespace_import') {
      // "import * as foo from 'bar'"
      for (const c of (child.children || [])) {
        if (c.type === 'identifier') {
          names.push('* as ' + getNodeText(c, sourceCode));
        }
      }
    }
  });

  // Also check for default import: "import foo from 'bar'"
  for (const child of (node.children || [])) {
    if (child.type === 'import_clause') {
      for (const c of (child.children || [])) {
        if (c.type === 'identifier') {
          const name = getNodeText(c, sourceCode);
          if (!names.includes(name)) {
            names.push(name);
          }
        }
      }
    }
  }

  return names;
}

/**
 * Extract imports from AST
 */
function extractImportsFromAST(
  ast: ASTNode,
  sourceCode: string,
  filePath: string,
  importMap: Map<string, Array<{ file: string; line: number; modules: string[] }>>,
  logger: DebugLogger
): void {
  const importNodes = findNodes(ast, n => n.type === 'import_statement');

  for (const node of importNodes) {
    let moduleSpecifier = '';
    const importedNames: string[] = [];

    // Find module specifier string
    for (const child of (node.children || [])) {
      if (child.type === 'string') {
        moduleSpecifier = getNodeText(child, sourceCode).replace(/['"]/g, '');
      }
    }

    if (!moduleSpecifier) continue;

    // Extract imported names
    const names = extractImportNames(node, sourceCode);
    importedNames.push(...names);

    const { line } = getLineAndColumn(node);
    const key = `${moduleSpecifier}:${importedNames.sort().join(',')}`;

    if (!importMap.has(key)) {
      importMap.set(key, []);
    }

    importMap.get(key)!.push({
      file: filePath,
      line,
      modules: importedNames
    });
  }
}

/**
 * Extract detailed per-name import information
 */
function getImportDetails(ast: ASTNode, sourceCode: string): ImportDetail[] {
  const details: ImportDetail[] = [];
  const importNodes = findNodes(ast, n => n.type === 'import_statement');

  for (const node of importNodes) {
    let moduleSpecifier = '';
    const { line } = getLineAndColumn(node);

    // Find module specifier string
    for (const child of (node.children || [])) {
      if (child.type === 'string') {
        moduleSpecifier = getNodeText(child, sourceCode).replace(/['"]/g, '');
      }
    }

    // Check for side-effect import (no import clause, no names)
    let hasImportClause = false;
    for (const child of (node.children || [])) {
      if (child.type === 'import_clause') {
        hasImportClause = true;
        break;
      }
    }

    if (!hasImportClause) {
      details.push({
        importType: 'side-effect',
        localName: moduleSpecifier,
        modulePath: moduleSpecifier,
        line
      });
      continue;
    }

    // Extract per-name imports
    const names = extractImportNames(node, sourceCode);
    for (const name of names) {
      details.push({
        importType: 'static',
        localName: name,
        modulePath: moduleSpecifier,
        line
      });
    }

    // If no names extracted but has import clause, it might be a namespace or default import not captured
    if (names.length === 0 && moduleSpecifier) {
      details.push({
        importType: 'static',
        localName: moduleSpecifier,
        modulePath: moduleSpecifier,
        line
      });
    }
  }

  return details;
}

/**
 * Extract identifier usage map from AST
 * Returns a Map of identifier name -> locations where it's used
 */
function extractIdentifierUsageFromAST(
  ast: ASTNode,
  sourceCode: string,
  targetNames: Set<string>
): Map<string, Array<{ line: number }>> {
  const usageMap = new Map<string, Array<{ line: number }>>();

  // Find all identifiers in the AST
  const identifiers = findNodes(ast, n => n.type === 'identifier');

  for (const id of identifiers) {
    const name = getNodeText(id, sourceCode);
    if (targetNames.has(name)) {
      if (!usageMap.has(name)) {
        usageMap.set(name, []);
      }
      usageMap.get(name)!.push({ line: getLineAndColumn(id).line });
    }
  }

  return usageMap;
}

/**
 * Extract unused imports from an AST
 */
function extractUnusedImportsFromAST(
  ast: ASTNode,
  sourceCode: string,
  filePath: string,
  unusedImportsMap: Map<string, Array<{ file: string; line: number; importName: string; moduleSpecifier: string }>>,
  logger: DebugLogger
): void {
  // Get detailed imports
  const detailedImports = getImportDetails(ast, sourceCode);
  const importNames = new Set(
    detailedImports
      .filter(imp => imp.importType !== 'side-effect')
      .map(imp => imp.localName)
  );

  // Extract identifier usage across the entire file
  const usageMap = extractIdentifierUsageFromAST(ast, sourceCode, importNames);

  // Find unused imports
  for (const imp of detailedImports) {
    // Skip side-effect imports - they're never "unused"
    if (imp.importType === 'side-effect') continue;

    if (!usageMap.has(imp.localName)) {
      const key = `${filePath}:${imp.localName}`;

      if (!unusedImportsMap.has(key)) {
        unusedImportsMap.set(key, []);
      }

      unusedImportsMap.get(key)!.push({
        file: filePath,
        line: imp.line,
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
