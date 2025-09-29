/**
 * SOLID Principles Analyzer - Functional Implementation
 * Detects violations of SOLID principles in TypeScript/JavaScript code
 */

import * as ts from 'typescript';
import { 
  Violation, 
  AnalyzerDefinition, 
  ComponentPatternConfig,
  SOLIDViolation,
  ComponentMetadata,
  ResponsibilityType,
  ComponentPattern,
  ComponentResponsibility
} from '../types.js';
import {
  FileAnalyzerFunction,
  createViolation,
  getNodePosition,
  findNodesOfType,
  getNodeName,
  traverseAST,
  processFiles,
  calculateComplexity
} from './analyzerUtils.js';
import { 
  isReactComponent, 
  getComponentName, 
  detectComponentType,
  extractHooks,
  extractPropTypes 
} from '../utils/reactDetection.js';
import { detectComponentResponsibilities, areResponsibilitiesRelated } from '../utils/componentResponsibility.js';
import { detectComponentPattern, getUnrelatedResponsibilities, DEFAULT_PATTERNS } from '../utils/componentPatterns.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { WhitelistType } from '../types/whitelist.js';

/**
 * Configuration for SOLID analyzer
 */
export interface SOLIDAnalyzerConfig {
  maxMethodsPerClass: number;
  maxLinesPerMethod: number;
  maxParametersPerMethod: number;
  maxClassComplexity: number;
  maxInterfaceMembers: number;
  checkDependencyInversion: boolean;
  checkInterfaceSegregation: boolean;
  checkLiskovSubstitution: boolean;
  // Component-specific SRP options
  enableComponentSRP?: boolean;
  componentPatterns?: ComponentPatternConfig;
  maxUnrelatedResponsibilities?: number;
  contextAwareThresholds?: boolean;
  checkUnrelatedResponsibilities?: boolean;  // New option to control unrelated group checking
  patternThresholds?: {
    [patternName: string]: {
      maxResponsibilities: number;
    };
  };
}

/**
 * Default configuration
 */
// Database instance for whitelist checking
let dbInstance: CodeIndexDB | null = null;

async function getDB(): Promise<CodeIndexDB> {
  if (!dbInstance) {
    dbInstance = CodeIndexDB.getInstance();
    await dbInstance.initialize();
  }
  return dbInstance;
}

const DEFAULT_CONFIG: SOLIDAnalyzerConfig = {
  maxMethodsPerClass: 15,      // Increased from 10 - reasonable for service classes
  maxLinesPerMethod: 50,
  maxParametersPerMethod: 4,
  maxClassComplexity: 50,
  maxInterfaceMembers: 20,     // Increased from 15 - configuration interfaces need more flexibility
  checkDependencyInversion: false,  // Disabled by default - DI is not standard pattern
  checkInterfaceSegregation: true,
  checkLiskovSubstitution: true,
  // Component-specific defaults
  enableComponentSRP: true,
  componentPatterns: {
    patterns: [],
    customPatterns: undefined,
    enablePatternDetection: true
  },
  maxUnrelatedResponsibilities: 3,  // Increased from 2 - allow URL management + UI + state
  contextAwareThresholds: true,
  checkUnrelatedResponsibilities: true  // Check for unrelated responsibilities by default
};

/**
 * Helper: Check if import is from a framework/library
 */
function isFrameworkImport(importPath: string): boolean {
  const frameworkPatterns = [
    // React ecosystem
    /^(react|react-dom|react-router|react-redux)/,
    // Next.js
    /^(next|@next)\//,
    // Vue ecosystem
    /^(vue|vue-router|vuex|@vue)/,
    // Angular
    /^(@angular|angular)/,
    // UI frameworks
    /^@(mui|mantine|chakra-ui|ant-design|arco-design)/,
    // Node frameworks
    /^(express|fastify|koa|hapi|@nestjs)/,
    // Auth libraries
    /^(@clerk|@auth0|@stackframe|next-auth)/,
    // Database clients
    /^(pg|mongodb|@prisma|redis|ioredis)/,
    // HTTP clients
    /^(axios|node-fetch|got|ky)/,
    // Testing
    /^(@testing-library|jest|vitest|mocha|chai)/,
    // Build tools
    /^(webpack|vite|rollup|parcel|esbuild)/,
    // Common utilities that shouldn't trigger DI violations
    /^(lodash|underscore|ramda|date-fns|moment|dayjs)/,
    // Node modules indicator
    /node_modules/,
    // Anything from npm scope
    /^@[\w-]+\//
  ];
  
  return frameworkPatterns.some(pattern => pattern.test(importPath));
}

/**
 * Helper: Find import declaration for an identifier
 */
function findImportForIdentifier(sourceFile: ts.SourceFile, identifier: string): string | undefined {
  let importPath: string | undefined;
  
  ts.forEachChild(sourceFile, node => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier.text;
      
      // Check named imports
      if (node.importClause && node.importClause.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            if (element.name.text === identifier || 
                (element.propertyName && element.propertyName.text === identifier)) {
              importPath = moduleSpecifier;
              return;
            }
          }
        }
      }
      
      // Check default import
      if (node.importClause && node.importClause.name && node.importClause.name.text === identifier) {
        importPath = moduleSpecifier;
      }
    }
  });
  
  return importPath;
}

/**
 * Architectural layer detection for context-aware analysis
 */
enum ArchitecturalLayer {
  Route = 'route',
  Middleware = 'middleware',
  Component = 'component',
  Library = 'library',
  Repository = 'repository',
  Service = 'service',
  Hook = 'hook',
  Utility = 'utility',
  Config = 'config'
}

/**
 * Helper: Detect architectural layer from file path
 */
function detectArchitecturalLayer(filePath: string): ArchitecturalLayer {
  const patterns: [ArchitecturalLayer, RegExp][] = [
    // Next.js App Router patterns
    [ArchitecturalLayer.Route, /\/(app|pages)\/.*\/(route|page|layout|error|loading|not-found)\.(ts|tsx|js|jsx)$/],
    [ArchitecturalLayer.Route, /\/api\/.*\/route\.(ts|js)$/],
    
    // Middleware patterns
    [ArchitecturalLayer.Middleware, /middleware\.(ts|js)$/],
    [ArchitecturalLayer.Middleware, /\/(middleware|middlewares)\/.*\.(ts|js)$/],
    
    // Component patterns
    [ArchitecturalLayer.Component, /\/(components?|ui)\/.*\.(tsx|jsx)$/],
    
    // Repository patterns
    [ArchitecturalLayer.Repository, /\/(repositories|repository|repos?|dal|data-access)\/.*\.(ts|js)$/],
    
    // Service patterns
    [ArchitecturalLayer.Service, /\/(services?|use-cases|domain|business)\/.*\.(ts|js)$/],
    
    // Hook patterns
    [ArchitecturalLayer.Hook, /\/(hooks?)\/.*\.(ts|tsx|js|jsx)$/],
    [ArchitecturalLayer.Hook, /use[A-Z]\w+\.(ts|tsx|js|jsx)$/],
    
    // Utility patterns
    [ArchitecturalLayer.Utility, /\/(utils?|utilities|helpers?|lib)\/.*\.(ts|js)$/],
    
    // Config patterns
    [ArchitecturalLayer.Config, /\/(config|constants)\/.*\.(ts|js)$/],
    [ArchitecturalLayer.Config, /\.(config|constants)\.(ts|js)$/]
  ];
  
  for (const [layer, pattern] of patterns) {
    if (pattern.test(filePath)) {
      return layer;
    }
  }
  
  // Default to library for unmatched files
  return ArchitecturalLayer.Library;
}

/**
 * Helper: Get context-aware thresholds based on architectural layer
 */
function getLayerThresholds(layer: ArchitecturalLayer, config: SOLIDAnalyzerConfig): Partial<SOLIDAnalyzerConfig> {
  const layerConfigs: Record<ArchitecturalLayer, Partial<SOLIDAnalyzerConfig>> = {
    [ArchitecturalLayer.Route]: {
      maxMethodsPerClass: 20, // Routes can have more methods
      maxUnrelatedResponsibilities: 4 // Routes often coordinate multiple concerns
    },
    [ArchitecturalLayer.Component]: {
      maxUnrelatedResponsibilities: 3, // Components can manage UI + state + events
      maxMethodsPerClass: 12
    },
    [ArchitecturalLayer.Repository]: {
      maxMethodsPerClass: 25, // Repositories can have many data access methods
      maxUnrelatedResponsibilities: 1 // Should focus on data access only
    },
    [ArchitecturalLayer.Service]: {
      maxMethodsPerClass: 15,
      maxUnrelatedResponsibilities: 2
    },
    [ArchitecturalLayer.Hook]: {
      maxMethodsPerClass: 5,
      maxUnrelatedResponsibilities: 1 // Hooks should have single purpose
    },
    [ArchitecturalLayer.Middleware]: {
      maxMethodsPerClass: 8,
      maxUnrelatedResponsibilities: 1
    },
    [ArchitecturalLayer.Utility]: {
      maxMethodsPerClass: 20, // Utility modules can have many functions
      maxUnrelatedResponsibilities: 3 // Utilities may group related functions
    },
    [ArchitecturalLayer.Config]: {
      maxMethodsPerClass: 50, // Config files may export many settings
      maxInterfaceMembers: 30 // Config interfaces need flexibility
    },
    [ArchitecturalLayer.Library]: {
      // Use defaults from config
    }
  };
  
  return config.contextAwareThresholds ? (layerConfigs[layer] || {}) : {};
}

/**
 * Helper: Check if file is a test file
 */
function isTestFile(filePath: string): boolean {
  const testPatterns = [
    /\.test\.[jt]sx?$/,
    /\.spec\.[jt]sx?$/,
    /\.test-d\.ts$/,
    /__tests__\//,
    /test\//,
    /tests\//,
    /spec\//,
    /\.e2e\.[jt]s$/,
  ];
  
  return testPatterns.some(pattern => pattern.test(filePath));
}

/**
 * Analyze a file for SOLID violations
 */
const analyzeFile: FileAnalyzerFunction = async (filePath, sourceFile, config: SOLIDAnalyzerConfig) => {
  const violations: Violation[] = [];
  const isTest = isTestFile(filePath);
  
  // Detect architectural layer for context-aware analysis
  const layer = detectArchitecturalLayer(filePath);
  const layerThresholds = getLayerThresholds(layer, config);
  // Layer thresholds should not override explicit user configuration
  // Only apply layer defaults if the user hasn't configured them
  const effectiveConfig = { ...layerThresholds, ...config };
  
  // Check Single Responsibility Principle for classes
  const classes = findNodesOfType(sourceFile, ts.isClassDeclaration);
  classes.forEach(cls => {
    violations.push(...checkSingleResponsibility(cls, sourceFile, filePath, effectiveConfig));
  });
  
  // Check Single Responsibility Principle for React components
  if (config.enableComponentSRP) {
    const processedComponents = new Set<ts.Node>();
    
    traverseAST(sourceFile, node => {
      if (isReactComponent(node)) {
        // Skip if this is an arrow function that's part of a variable declaration
        // that we've already processed
        if (ts.isArrowFunction(node) && node.parent && 
            ts.isVariableDeclaration(node.parent) && 
            processedComponents.has(node.parent)) {
          return;
        }
        
        // For variable declarations with arrow functions, process the declaration
        // not the arrow function itself
        if (ts.isVariableDeclaration(node) && node.initializer && 
            ts.isArrowFunction(node.initializer)) {
          if (!processedComponents.has(node)) {
            processedComponents.add(node);
            violations.push(...checkComponentSRP(node, sourceFile, filePath, effectiveConfig));
          }
        } else if (!processedComponents.has(node)) {
          processedComponents.add(node);
          violations.push(...checkComponentSRP(node, sourceFile, filePath, effectiveConfig));
        }
      }
    });
  }
  
  // Check Open/Closed Principle
  traverseAST(sourceFile, node => {
    violations.push(...checkOpenClosed(node, sourceFile, filePath, effectiveConfig));
  });
  
  // Check Liskov Substitution Principle
  if (effectiveConfig.checkLiskovSubstitution) {
    violations.push(...checkLiskovSubstitution(sourceFile, filePath, effectiveConfig));
  }
  
  // Check Interface Segregation Principle
  if (effectiveConfig.checkInterfaceSegregation) {
    const interfaces = findNodesOfType(sourceFile, ts.isInterfaceDeclaration);
    interfaces.forEach(iface => {
      violations.push(...checkInterfaceSegregation(iface, sourceFile, filePath, effectiveConfig));
    });
  }
  
  // Check Dependency Inversion Principle (skip for test files)
  if (effectiveConfig.checkDependencyInversion && !isTest) {
    violations.push(...await checkDependencyInversion(sourceFile, filePath, effectiveConfig));
  }
  
  return violations;
};

/**
 * Check Single Responsibility Principle
 */
function checkSingleResponsibility(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
  config: SOLIDAnalyzerConfig
): Violation[] {
  const violations: Violation[] = [];
  const className = getNodeName(node) || 'Anonymous';
  
  // Count methods
  const methods = findNodesOfType(node, ts.isMethodDeclaration);
  const publicMethods = methods.filter(m => 
    !m.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword)
  );
  
  if (publicMethods.length > config.maxMethodsPerClass) {
    const { line, column } = getNodePosition(sourceFile, node);
    violations.push(createViolation({
      analyzer: 'solid',
      file: filePath,
      line,
      column,
      severity: 'warning',
      message: `Class "${className}" has ${publicMethods.length} public methods (max: ${config.maxMethodsPerClass})`,
      type: 'solid',
      principle: 'single-responsibility',
      recommendation: 'Consider splitting this class into smaller, more focused classes',
      details: {
        className,
        methodCount: publicMethods.length,
        threshold: config.maxMethodsPerClass
      }
    }));
  }
  
  // Check for multiple responsibilities
  const responsibilities = detectResponsibilities(node);
  if (responsibilities.length > 1) {
    const { line, column } = getNodePosition(sourceFile, node);
    violations.push(createViolation({
      analyzer: 'solid',
      file: filePath,
      line,
      column,
      severity: 'warning',
      message: `Class "${className}" appears to have multiple responsibilities`,
      type: 'solid',
      principle: 'single-responsibility',
      recommendation: `Consider splitting based on: ${responsibilities.join(', ')}`,
      details: {
        className,
        responsibilities
      }
    }));
  }
  
  return violations;
}

/**
 * Check Open/Closed Principle
 */
function checkOpenClosed(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
  config: SOLIDAnalyzerConfig
): Violation[] {
  const violations: Violation[] = [];
  
  // Check for long if-else chains
  if (ts.isIfStatement(node)) {
    const chainLength = countIfElseChain(node);
    if (chainLength > 3) {
      const { line, column } = getNodePosition(sourceFile, node);
      violations.push(createViolation({
        analyzer: 'solid',
        file: filePath,
        line,
        column,
        severity: 'warning',
        message: `Long if-else chain (${chainLength} branches) violates Open/Closed Principle`,
        type: 'solid',
        principle: 'open-closed',
        recommendation: 'Consider using polymorphism, strategy pattern, or a mapping object',
        details: {
          chainLength
        }
      }));
    }
  }
  
  // Check for switch statements with many cases
  if (ts.isSwitchStatement(node)) {
    const cases = findNodesOfType(node, ts.isCaseClause);
    if (cases.length > 5) {
      const { line, column } = getNodePosition(sourceFile, node);
      violations.push(createViolation({
        analyzer: 'solid',
        file: filePath,
        line,
        column,
        severity: 'warning',
        message: `Switch statement with ${cases.length} cases violates Open/Closed Principle`,
        type: 'solid',
        principle: 'open-closed',
        recommendation: 'Consider using polymorphism or a strategy pattern',
        details: {
          caseCount: cases.length
        }
      }));
    }
  }
  
  return violations;
}

/**
 * Check Liskov Substitution Principle
 */
function checkLiskovSubstitution(
  sourceFile: ts.SourceFile,
  filePath: string,
  config: SOLIDAnalyzerConfig
): Violation[] {
  const violations: Violation[] = [];
  
  // Find method overrides that throw errors
  traverseAST(sourceFile, node => {
    if (ts.isMethodDeclaration(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.OverrideKeyword)) {
      const hasThrow = findNodesOfType(node, ts.isThrowStatement).length > 0;
      const isNotImplemented = node.body?.statements.length === 0 ||
        (node.body?.statements.length === 1 && ts.isThrowStatement(node.body.statements[0]));
      
      if (hasThrow || isNotImplemented) {
        const { line, column } = getNodePosition(sourceFile, node);
        const methodName = getNodeName(node) || 'unknown';
        violations.push(createViolation({
        analyzer: 'solid',
          file: filePath,
          line,
          column,
          severity: 'critical',
          message: 'Method override throws error or is not implemented',
          type: 'solid',
          principle: 'liskov-substitution',
          recommendation: 'All overridden methods should maintain behavioral compatibility with base class',
          details: {
            methodName
          }
        }));
      }
    }
  });
  
  return violations;
}

/**
 * Check Interface Segregation Principle
 */
function checkInterfaceSegregation(
  node: ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
  config: SOLIDAnalyzerConfig
): Violation[] {
  const violations: Violation[] = [];
  const interfaceName = getNodeName(node) || 'Anonymous';
  
  if (node.members.length > config.maxInterfaceMembers) {
    const { line, column } = getNodePosition(sourceFile, node);
    violations.push(createViolation({
      analyzer: 'solid',
      file: filePath,
      line,
      column,
      severity: 'critical',
      message: `Interface "${interfaceName}" has too many members (${node.members.length})`,
      type: 'solid',
      principle: 'interface-segregation',
      recommendation: 'Split this interface into smaller, more focused interfaces',
      details: {
        interfaceName,
        memberCount: node.members.length,
        threshold: config.maxInterfaceMembers
      }
    }));
  }
  
  return violations;
}

/**
 * Check Dependency Inversion Principle
 */
async function checkDependencyInversion(
  sourceFile: ts.SourceFile,
  filePath: string,
  config: SOLIDAnalyzerConfig
): Promise<Violation[]> {
  const violations: Violation[] = [];
  
  // Skip import checking - DI principle should focus on instantiation, not imports
  // Imports are necessary and checking them creates too many false positives
  
  // Check for 'new' expressions (direct instantiation)
  const newExpressions = findNodesOfType(sourceFile, ts.isNewExpression);
  for (const expr of newExpressions) {
    if (ts.isIdentifier(expr.expression)) {
      const className = expr.expression.text;
      
      // Skip if this is inside a singleton pattern
      if (isInsideSingletonPattern(expr)) {
        continue;
      }
      
      // Skip if this is inside a factory method
      if (isInsideFactoryMethod(expr)) {
        continue;
      }
      
      // Skip Error classes - they need to be instantiated
      if (isErrorClass(className)) {
        continue;
      }
      
      // Check if this class is imported from a framework/library
      const importPath = findImportForIdentifier(sourceFile, className);
      if (importPath && isFrameworkImport(importPath)) {
        continue; // Skip framework classes
      }
      
      if (await isConcreteClass(className)) {
        const { line, column } = getNodePosition(sourceFile, expr);
        violations.push(createViolation({
        analyzer: 'solid',
          file: filePath,
          line,
          column,
          severity: 'warning',
          message: `Direct instantiation of concrete class "${className}"`,
          type: 'solid',
          principle: 'dependency-inversion',
          recommendation: 'Consider using dependency injection or factory pattern',
          details: {
            className,
            importPath: importPath || 'local'
          }
        }));
      }
    }
  }
  
  return violations;
}

/**
 * Helper: Detect responsibilities in a class
 */
function detectResponsibilities(node: ts.ClassDeclaration): string[] {
  const responsibilities: Set<string> = new Set();
  
  const methods = findNodesOfType(node, ts.isMethodDeclaration);
  methods.forEach(method => {
    const name = getNodeName(method)?.toLowerCase() || '';
    
    // Detect different concerns
    if (name.includes('save') || name.includes('load') || name.includes('persist')) {
      responsibilities.add('data persistence');
    }
    if (name.includes('validate') || name.includes('check')) {
      responsibilities.add('validation');
    }
    if (name.includes('render') || name.includes('display') || name.includes('show')) {
      responsibilities.add('presentation');
    }
    if (name.includes('send') || name.includes('fetch') || name.includes('request')) {
      responsibilities.add('communication');
    }
    if (name.includes('calculate') || name.includes('compute') || name.includes('process')) {
      responsibilities.add('business logic');
    }
    if (name.includes('log') || name.includes('track') || name.includes('monitor')) {
      responsibilities.add('logging/monitoring');
    }
  });
  
  // Check for too many public methods as a responsibility
  const publicMethods = methods.filter(m => 
    !m.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword)
  );
  if (publicMethods.length > 10) {
    responsibilities.add('too many methods');
  }
  
  return Array.from(responsibilities);
}

/**
 * Helper: Count if-else chain length
 */
function countIfElseChain(node: ts.IfStatement): number {
  let count = 1;
  let current = node.elseStatement;
  
  while (current) {
    count++;
    if (ts.isIfStatement(current)) {
      current = current.elseStatement;
    } else {
      break;
    }
  }
  
  return count;
}

/**
 * Helper: Check if import is a concrete dependency
 */
async function isConcreteDependency(importPath: string): Promise<boolean> {
  try {
    const db = await getDB();
    
    // Skip relative paths (they're project internal) - don't flag these
    if (importPath.startsWith('.') || importPath.startsWith('/')) {
      return false;  // Internal modules are fine
    }
    
    // Check if it's whitelisted directly
    if (db.isWhitelisted(importPath, WhitelistType.NodeBuiltin) ||
        db.isWhitelisted(importPath, WhitelistType.SharedLibrary) ||
        db.isWhitelisted(importPath, WhitelistType.ProjectDependency) ||
        db.isWhitelisted(importPath, WhitelistType.FrameworkClass)) {
      return false;
    }
    
    // For Node.js built-ins, also check the base module name
    // e.g., "fs/promises" -> check "fs", "node:fs/promises" -> check "fs"
    const baseModule = importPath.replace(/^node:/, '').split('/')[0];
    if (baseModule !== importPath) {
      if (db.isWhitelisted(baseModule, WhitelistType.NodeBuiltin)) {
        return false;
      }
    }
    
    // If not whitelisted, it's potentially a concrete dependency
    return true;
  } catch (error) {
    // If database is not available, be conservative and don't flag
    console.warn('Database not available for dependency check:', error);
    return false;
  }
}

/**
 * Helper: Check if class name is an Error class
 */
function isErrorClass(className: string): boolean {
  return className.endsWith('Error') || 
         className.endsWith('Exception') ||
         className === 'Error';
}

/**
 * Helper: Check if node is inside a singleton pattern
 */
function isInsideSingletonPattern(node: ts.Node): boolean {
  let parent = node.parent;
  while (parent) {
    // Check if we're inside a method named getInstance, instance, singleton, etc.
    if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) {
      const methodName = getNodeName(parent)?.toLowerCase();
      if (methodName && (
        methodName.includes('getinstance') ||
        methodName === 'instance' ||
        methodName === 'singleton' ||
        methodName === 'create' && parent.parent && ts.isClassDeclaration(parent.parent)
      )) {
        return true;
      }
    }
    
    // Check if we're inside a static property initialization
    if (ts.isPropertyDeclaration(parent) && 
        parent.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) {
      const propName = getNodeName(parent)?.toLowerCase();
      if (propName && (propName === 'instance' || propName === '_instance')) {
        return true;
      }
    }
    
    parent = parent.parent;
  }
  return false;
}

/**
 * Helper: Check if node is inside a factory method
 */
function isInsideFactoryMethod(node: ts.Node): boolean {
  let parent = node.parent;
  while (parent) {
    // Check if we're inside a method with 'create' or 'factory' in its name
    if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) {
      const methodName = getNodeName(parent)?.toLowerCase();
      if (methodName && (
        methodName.includes('create') ||
        methodName.includes('factory') ||
        methodName.includes('make') ||
        methodName.includes('build')
      )) {
        return true;
      }
    }
    
    // Check if we're inside a class with Factory in its name
    if (ts.isClassDeclaration(parent)) {
      const className = getNodeName(parent);
      if (className && className.toLowerCase().includes('factory')) {
        return true;
      }
    }
    
    parent = parent.parent;
  }
  return false;
}

/**
 * Helper: Check if class name represents concrete implementation
 */
async function isConcreteClass(className: string): Promise<boolean> {
  try {
    const db = await getDB();
    
    // Check if it's whitelisted (platform API or framework class)
    if (db.isWhitelisted(className, WhitelistType.PlatformAPI) ||
        db.isWhitelisted(className, WhitelistType.FrameworkClass)) {
      return false;
    }
    
    // Skip if it looks like a type/interface name
    if (className.startsWith('I') && className.length > 2 && className[1] === className[1].toUpperCase()) {
      return false; // e.g., IUserService
    }
    
    if (className.endsWith('Interface') || className.endsWith('Type') || className.endsWith('Schema')) {
      return false;
    }
    
    return true;
  } catch (error) {
    // If database is not available, be conservative and don't flag
    console.warn('Database not available for class check:', error);
    return false;
  }
}

/**
 * Check Component Single Responsibility Principle
 */
function checkComponentSRP(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
  config: SOLIDAnalyzerConfig
): Violation[] {
  const violations: Violation[] = [];
  
  // Extract component metadata
  const componentType = detectComponentType(node);
  if (!componentType) return violations;
  
  const componentName = getComponentName(node) || 'AnonymousComponent';
  const hooks = extractHooks(node, sourceFile);
  const props = extractPropTypes(node, sourceFile);
  
  const componentInfo: ComponentMetadata = {
    name: componentName,
    filePath,
    lineNumber: getNodePosition(sourceFile, node).line,
    language: 'typescript',
    dependencies: [],
    purpose: '',
    context: '',
    entityType: 'component',
    componentType,
    hooks,
    props,
    isExported: true
  };
  
  // Detect component responsibilities
  const responsibilities = detectComponentResponsibilities(sourceFile, node, componentInfo);
  
  // Detect component pattern
  const patterns = config.componentPatterns?.patterns || DEFAULT_PATTERNS;
  const pattern = detectComponentPattern(
    componentName,
    filePath,
    componentInfo.props?.map(p => p.name) || [],
    componentInfo.hooks?.map(h => h.name) || [],
    [] // TODO: Extract imports if needed
  );
  
  // Apply context-aware thresholds
  let effectiveMaxResponsibilities = config.maxUnrelatedResponsibilities!;
  
  if (config.contextAwareThresholds && pattern) {
    // Check for pattern-specific override first
    if (config.patternThresholds?.[pattern.name]?.maxResponsibilities) {
      effectiveMaxResponsibilities = config.patternThresholds[pattern.name].maxResponsibilities;
    } else {
      // Fall back to multiplier-based calculation
      effectiveMaxResponsibilities = Math.ceil(config.maxUnrelatedResponsibilities! * pattern.complexityMultiplier);
    }
  }
  
  // Get unrelated responsibilities
  const uniqueTypes = [...new Set(responsibilities.map(r => r.type))];
  const unrelatedGroups: ResponsibilityType[][] = [];
  
  if (pattern) {
    // Use pattern-specific analysis
    const patternUnrelated = getUnrelatedResponsibilities(uniqueTypes, pattern);
    unrelatedGroups.push(...patternUnrelated);
  } else {
    // Generic analysis - check for unrelated responsibility pairs
    for (let i = 0; i < uniqueTypes.length; i++) {
      for (let j = i + 1; j < uniqueTypes.length; j++) {
        if (!areResponsibilitiesRelated(uniqueTypes[i], uniqueTypes[j])) {
          unrelatedGroups.push([uniqueTypes[i], uniqueTypes[j]]);
        }
      }
    }
  }
  
  // Create violations only if there are actually unrelated responsibilities
  // Skip if there's only one responsibility or all responsibilities are related
  // Filter out single-element groups which aren't violations
  const realUnrelatedGroups = unrelatedGroups.filter(group => group.length >= 2);
  
  // Only check for unrelated groups if enabled in config
  if (config.checkUnrelatedResponsibilities && realUnrelatedGroups.length > 0 && uniqueTypes.length > 1) {
    const { line, column } = getNodePosition(sourceFile, node);
    
    // Main violation for mixed responsibilities
    violations.push(createViolation({
      analyzer: 'solid',
      file: filePath,
      line,
      column,
      severity: 'warning',
      message: `Component "${componentName}" has ${uniqueTypes.length} responsibilities with ${realUnrelatedGroups.length} unrelated groups`,
      type: 'solid',
      principle: 'single-responsibility',
      componentName,
      recommendation: generateComponentRefactoringRecommendation(responsibilities, pattern),
      details: {
        componentName,
        componentType: componentInfo.componentType,
        pattern: pattern?.name,
        responsibilities: uniqueTypes,
        unrelatedGroups: realUnrelatedGroups,
        hookCount: componentInfo.hooks?.length || 0,
        effectCount: responsibilities.filter(r => r.type === ResponsibilityType.SideEffects).length
      }
    }));
  }
  
  // Check for too many responsibilities overall
  if (uniqueTypes.length > effectiveMaxResponsibilities) {
    const { line, column } = getNodePosition(sourceFile, node);
    violations.push(createViolation({
      analyzer: 'solid',
      file: filePath,
      line,
      column,
      severity: 'critical',
      message: `Component "${componentName}" has too many responsibilities (${uniqueTypes.length} > ${effectiveMaxResponsibilities})`,
      type: 'solid',
      principle: 'single-responsibility',
      componentName,
      recommendation: 'Split this component into smaller, focused components',
      details: {
        componentName,
        responsibilityCount: uniqueTypes.length,
        threshold: effectiveMaxResponsibilities,
        detectedPattern: pattern?.name
      }
    }));
  }
  
  return violations;
}

/**
 * Generate component-specific refactoring recommendations
 */
function generateComponentRefactoringRecommendation(
  responsibilities: ComponentResponsibility[],
  pattern?: ComponentPattern
): string {
  const types = [...new Set(responsibilities.map(r => r.type))];
  
  // Check for common anti-patterns
  if (types.includes(ResponsibilityType.DataFetching) && types.includes(ResponsibilityType.UIState)) {
    return 'Consider using container/presenter pattern: extract data fetching into a container component';
  }
  
  if (types.includes(ResponsibilityType.BusinessLogic) && types.includes(ResponsibilityType.FormHandling)) {
    return 'Extract business logic into custom hooks or utility functions';
  }
  
  if (types.includes(ResponsibilityType.SideEffects) && types.includes(ResponsibilityType.UIState)) {
    return 'Move side effects (analytics, logging) to a higher-level component or custom hook';
  }
  
  if (pattern?.name === 'Form' && types.includes(ResponsibilityType.DataFetching)) {
    return 'Forms should not fetch data directly. Move data fetching to parent component';
  }
  
  if (pattern?.name === 'SimpleUI' && types.length > 2) {
    return 'Simple UI components should only handle presentation. Extract logic to parent or hooks';
  }
  
  // Generic recommendation
  return 'Consider splitting by responsibility: ' + types.join(', ');
}

/**
 * SOLID analyzer definition
 */
export const solidAnalyzer: AnalyzerDefinition = {
  name: 'solid',
  defaultConfig: DEFAULT_CONFIG,
  analyze: async (files, config, options, progressCallback) => {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    return processFiles(files, analyzeFile, 'solid', mergedConfig, progressCallback ? 
      (current, total, file) => progressCallback({ current, total, analyzer: 'solid', file }) :
      undefined
    );
  }
};