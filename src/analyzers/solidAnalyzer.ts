/**
 * SOLID Principles Analyzer - Functional Implementation
 * Detects violations of SOLID principles in TypeScript/JavaScript code
 */

import * as ts from 'typescript';
import { Violation, AnalyzerDefinition } from '../types.js';
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
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: SOLIDAnalyzerConfig = {
  maxMethodsPerClass: 10,
  maxLinesPerMethod: 50,
  maxParametersPerMethod: 4,
  maxClassComplexity: 50,
  maxInterfaceMembers: 10,
  checkDependencyInversion: true,
  checkInterfaceSegregation: true,
  checkLiskovSubstitution: true
};

/**
 * Analyze a file for SOLID violations
 */
const analyzeFile: FileAnalyzerFunction = (filePath, sourceFile, config: SOLIDAnalyzerConfig) => {
  const violations: Violation[] = [];
  
  // Check Single Responsibility Principle
  const classes = findNodesOfType(sourceFile, ts.isClassDeclaration);
  classes.forEach(cls => {
    violations.push(...checkSingleResponsibility(cls, sourceFile, filePath, config));
  });
  
  // Check Open/Closed Principle
  traverseAST(sourceFile, node => {
    violations.push(...checkOpenClosed(node, sourceFile, filePath, config));
  });
  
  // Check Liskov Substitution Principle
  if (config.checkLiskovSubstitution) {
    violations.push(...checkLiskovSubstitution(sourceFile, filePath, config));
  }
  
  // Check Interface Segregation Principle
  if (config.checkInterfaceSegregation) {
    const interfaces = findNodesOfType(sourceFile, ts.isInterfaceDeclaration);
    interfaces.forEach(iface => {
      violations.push(...checkInterfaceSegregation(iface, sourceFile, filePath, config));
    });
  }
  
  // Check Dependency Inversion Principle
  if (config.checkDependencyInversion) {
    violations.push(...checkDependencyInversion(sourceFile, filePath, config));
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
function checkDependencyInversion(
  sourceFile: ts.SourceFile,
  filePath: string,
  config: SOLIDAnalyzerConfig
): Violation[] {
  const violations: Violation[] = [];
  
  // Check for direct imports of concrete implementations
  const imports = findNodesOfType(sourceFile, ts.isImportDeclaration);
  imports.forEach(imp => {
    const moduleSpecifier = imp.moduleSpecifier;
    if (ts.isStringLiteral(moduleSpecifier)) {
      const importPath = moduleSpecifier.text;
      
      // Check for concrete implementation imports
      if (isConcreteDependency(importPath)) {
        const { line, column } = getNodePosition(sourceFile, imp);
        violations.push(createViolation({
        analyzer: 'solid',
          file: filePath,
          line,
          column,
          severity: 'warning',
          message: `Direct import of concrete implementation: "${importPath}"`,
          type: 'solid',
          principle: 'dependency-inversion',
          recommendation: 'Depend on abstractions (interfaces) rather than concrete implementations',
          details: {
            importPath
          }
        }));
      }
    }
  });
  
  // Check for 'new' expressions (direct instantiation)
  const newExpressions = findNodesOfType(sourceFile, ts.isNewExpression);
  newExpressions.forEach(expr => {
    if (ts.isIdentifier(expr.expression)) {
      const className = expr.expression.text;
      if (isConcreteClass(className)) {
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
            className
          }
        }));
      }
    }
  });
  
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
function isConcreteDependency(importPath: string): boolean {
  // Common concrete dependencies
  const concretePatterns = [
    'mysql', 'postgres', 'mongodb', 'redis',
    'express', 'axios', 'fs', 'path', 'crypto',
    'aws-sdk', 'stripe', 'twilio'
  ];
  
  return concretePatterns.some(pattern => importPath.includes(pattern));
}

/**
 * Helper: Check if class name represents concrete implementation
 */
function isConcreteClass(className: string): boolean {
  // Skip common allowed instantiations
  const allowed = ['Date', 'Error', 'Array', 'Map', 'Set', 'Promise', 'RegExp'];
  if (allowed.includes(className)) return false;
  
  // Concrete if it doesn't start with 'I' or end with 'Interface'
  return !className.startsWith('I') && !className.endsWith('Interface');
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