/**
 * Universal SOLID Principles Analyzer
 * Works across multiple programming languages using the adapter pattern
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode, ClassInfo, FunctionInfo, InterfaceInfo } from '../../languages/types.js';

/**
 * Configuration for SOLID analyzer
 */
export interface SOLIDAnalyzerConfig {
  maxMethodsPerClass?: number;
  maxLinesPerMethod?: number;
  maxParametersPerMethod?: number;
  maxClassComplexity?: number;
  maxInterfaceMembers?: number;
  checkDependencyInversion?: boolean;
  checkInterfaceSegregation?: boolean;
  checkLiskovSubstitution?: boolean;
  skipTestFiles?: boolean;
}

export const DEFAULT_SOLID_CONFIG: SOLIDAnalyzerConfig = {
  maxMethodsPerClass: 15,
  maxLinesPerMethod: 50,
  maxParametersPerMethod: 4,
  maxClassComplexity: 50,
  maxInterfaceMembers: 20,
  checkDependencyInversion: true,
  checkInterfaceSegregation: true,
  checkLiskovSubstitution: true,
  skipTestFiles: true
};

export class UniversalSOLIDAnalyzer extends UniversalAnalyzer {
  readonly name = 'solid';
  readonly description = 'Detects violations of SOLID principles';
  readonly category = 'architecture';
  
  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: SOLIDAnalyzerConfig,
    sourceCode: string
  ): Promise<Violation[]> {
    console.error('[DEBUG] SOLID: analyzeAST called for:', ast.filePath);
    console.error('[DEBUG] SOLID: Input config:', config);
    console.error('[DEBUG] SOLID: DEFAULT_SOLID_CONFIG:', DEFAULT_SOLID_CONFIG);
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_SOLID_CONFIG, ...config };
    console.error('[DEBUG] SOLID: Final config:', finalConfig);
    
    // Skip test files if configured
    if (finalConfig.skipTestFiles && this.isTestFile(ast.filePath)) {
      return violations;
    }
    
    // Analyze classes
    const classes = adapter.extractClasses(ast);
    console.error(`[DEBUG] SOLID: Extracted ${classes.length} classes:`, classes.map(c => c.name));
    for (const cls of classes) {
      console.error(`[DEBUG] SOLID: Analyzing class: ${cls.name}`);
      violations.push(...this.analyzeClass(cls, ast, adapter, sourceCode, finalConfig));
    }
    
    // Analyze standalone functions
    const functions = adapter.extractFunctions(ast);
    for (const func of functions) {
      if (!func.isMethod) { // Skip methods as they're analyzed with their classes
        violations.push(...this.analyzeFunction(func, ast, adapter, sourceCode, finalConfig));
      }
    }
    
    // Analyze interfaces if supported
    if (adapter.extractInterfaces) {
      console.error('[DEBUG] SOLID: extractInterfaces method exists, calling it...');
      const interfaces = adapter.extractInterfaces(ast);
      console.error('[DEBUG] SOLID: Extracted interfaces count:', interfaces.length);
      for (const iface of interfaces) {
        console.error('[DEBUG] SOLID: Analyzing interface:', iface.name, 'with', iface.members.length, 'members');
        violations.push(...this.analyzeInterface(iface, ast, adapter, sourceCode, finalConfig));
      }
    } else {
      console.error('[DEBUG] SOLID: extractInterfaces method not available on adapter');
    }
    
    return violations;
  }
  
  /**
   * Analyze a class for SOLID violations
   */
  private analyzeClass(
    cls: ClassInfo,
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
    config: SOLIDAnalyzerConfig
  ): Violation[] {
    const violations: Violation[] = [];
    
    // Single Responsibility Principle - too many methods
    if (cls.methods.length > (config.maxMethodsPerClass || 15)) {
      violations.push(this.createViolation(
        ast.filePath,
        cls.location.start,
        `Class "${cls.name}" has ${cls.methods.length} methods, exceeding the maximum of ${config.maxMethodsPerClass || 15}. Consider splitting responsibilities.`,
        'warning',
        'single-responsibility'
      ));
    }
    
    // Calculate class complexity
    const complexity = this.calculateClassComplexity(cls, ast, adapter, sourceCode);
    if (complexity > (config.maxClassComplexity || 50)) {
      violations.push(this.createViolation(
        ast.filePath,
        cls.location.start,
        `Class "${cls.name}" has a complexity of ${complexity}, exceeding the maximum of ${config.maxClassComplexity || 50}. Consider refactoring.`,
        'critical',
        'single-responsibility'
      ));
    }
    
    // Analyze each method
    for (const method of cls.methods) {
      violations.push(...this.analyzeFunction(method, ast, adapter, sourceCode, config));
    }
    
    // Open/Closed Principle - check for modification patterns
    if (this.hasModificationPatterns(cls, ast, adapter, sourceCode)) {
      violations.push(this.createViolation(
        ast.filePath,
        cls.location.start,
        `Class "${cls.name}" appears to be frequently modified. Consider using composition or inheritance for extension.`,
        'suggestion',
        'open-closed'
      ));
    }
    
    // Liskov Substitution Principle
    if (config.checkLiskovSubstitution && cls.extends) {
      const lspViolations = this.checkLiskovSubstitution(cls, ast, adapter);
      violations.push(...lspViolations);
    }
    
    // Dependency Inversion Principle
    if (config.checkDependencyInversion) {
      const dipViolations = this.checkDependencyInversion(cls, ast, adapter, sourceCode);
      violations.push(...dipViolations);
    }
    
    return violations;
  }
  
  /**
   * Analyze a function for SOLID violations
   */
  private analyzeFunction(
    func: FunctionInfo,
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
    config: SOLIDAnalyzerConfig
  ): Violation[] {
    const violations: Violation[] = [];
    
    // Too many parameters
    if (func.parameters.length > (config.maxParametersPerMethod || 4)) {
      violations.push(this.createViolation(
        ast.filePath,
        func.location.start,
        `Function "${func.name}" has ${func.parameters.length} parameters, exceeding the maximum of ${config.maxParametersPerMethod || 4}. Consider using an options object.`,
        'warning',
        'single-responsibility'
      ));
    }
    
    // Function too long
    const lineCount = func.location.end.line - func.location.start.line + 1;
    if (lineCount > (config.maxLinesPerMethod || 50)) {
      violations.push(this.createViolation(
        ast.filePath,
        func.location.start,
        `Function "${func.name}" has ${lineCount} lines, exceeding the maximum of ${config.maxLinesPerMethod || 50}. Consider breaking it down.`,
        'warning',
        'single-responsibility'
      ));
    }
    
    return violations;
  }
  
  /**
   * Analyze an interface for Interface Segregation Principle
   */
  private analyzeInterface(
    iface: InterfaceInfo,
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
    config: SOLIDAnalyzerConfig
  ): Violation[] {
    const violations: Violation[] = [];
    
    console.error(`[DEBUG] SOLID: analyzeInterface called for ${iface.name}`);
    console.error(`[DEBUG] SOLID: checkInterfaceSegregation = ${config.checkInterfaceSegregation}`);
    console.error(`[DEBUG] SOLID: maxInterfaceMembers = ${config.maxInterfaceMembers}`);
    
    if (!config.checkInterfaceSegregation) {
      console.error(`[DEBUG] SOLID: Skipping interface segregation check for ${iface.name}`);
      return violations;
    }
    
    const memberCount = iface.members?.length || 0;
    const maxMembers = config.maxInterfaceMembers || 20;
    console.error(`[DEBUG] SOLID: Interface ${iface.name} has ${memberCount} members, max allowed: ${maxMembers}`);
    
    if (memberCount > maxMembers) {
      console.error(`[DEBUG] SOLID: Creating violation for ${iface.name}`);
      violations.push(this.createViolation(
        ast.filePath,
        iface.location.start,
        `Interface "${iface.name}" has ${memberCount} members, exceeding the maximum of ${maxMembers}. Consider splitting into smaller interfaces.`,
        'warning',
        'interface-segregation'
      ));
    } else {
      console.error(`[DEBUG] SOLID: No violation for ${iface.name} (${memberCount} <= ${maxMembers})`);
    }
    
    return violations;
  }
  
  /**
   * Calculate class complexity
   */
  private calculateClassComplexity(
    cls: ClassInfo,
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string
  ): number {
    let complexity = 0;
    
    // Base complexity for the class itself
    complexity += 1;
    
    // Add complexity for each method
    complexity += cls.methods.length * 2;
    
    // Add complexity for properties
    complexity += cls.properties.length;
    
    // Add complexity for inheritance
    if (cls.extends) complexity += 5;
    if (cls.implements && cls.implements.length > 0) {
      complexity += cls.implements.length * 2;
    }
    
    // Add complexity based on method sizes
    for (const method of cls.methods) {
      const lineCount = method.location.end.line - method.location.start.line + 1;
      complexity += Math.floor(lineCount / 10);
    }
    
    return complexity;
  }
  
  /**
   * Check for modification patterns (Open/Closed Principle)
   */
  private hasModificationPatterns(
    cls: ClassInfo,
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string
  ): boolean {
    // Look for switch statements or if-else chains that check types
    const classNode = this.findNodeByLocation(ast.root, cls.location.start);
    if (!classNode) return false;
    
    let hasTypeChecking = false;
    
    this.walkAST(classNode, node => {
      // Check for switch statements
      if (node.type.includes('Switch')) {
        hasTypeChecking = true;
      }
      
      // Check for instanceof chains
      if (node.type.includes('Binary') && adapter.getNodeText(node, sourceCode).includes('instanceof')) {
        hasTypeChecking = true;
      }
    });
    
    return hasTypeChecking;
  }
  
  /**
   * Check Liskov Substitution Principle
   */
  private checkLiskovSubstitution(
    cls: ClassInfo,
    ast: AST,
    adapter: LanguageAdapter
  ): Violation[] {
    const violations: Violation[] = [];
    
    // Check if class overrides parent methods with incompatible signatures
    // This would require more sophisticated type analysis
    // For now, we'll check basic patterns
    
    for (const method of cls.methods) {
      if (method.name === 'constructor') continue;
      
      // Check for methods that throw exceptions when parent doesn't
      const methodNode = this.findNodeByLocation(ast.root, method.location.start);
      if (methodNode) {
        let hasThrow = false;
        this.walkAST(methodNode, node => {
          if (node.type.includes('Throw')) {
            hasThrow = true;
          }
        });
        
        if (hasThrow) {
          violations.push(this.createViolation(
            ast.filePath,
            method.location.start,
            `Method "${cls.name}.${method.name}" throws exceptions. Ensure this doesn't violate parent class contract.`,
            'suggestion',
            'liskov-substitution'
          ));
        }
      }
    }
    
    return violations;
  }
  
  /**
   * Check Dependency Inversion Principle
   */
  private checkDependencyInversion(
    cls: ClassInfo,
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string
  ): Violation[] {
    const violations: Violation[] = [];
    console.error(`[DEBUG] SOLID: checkDependencyInversion called for class: ${cls.name}`);
    
    // Check for direct instantiation of dependencies
    const classNode = this.findNodeByLocation(ast.root, cls.location.start);
    if (!classNode) {
      console.error(`[DEBUG] SOLID: Could not find class node for ${cls.name}`);
      return violations;
    }
    
    let hasDirectInstantiation = false;
    let concreteImports = 0;
    
    // Count concrete class imports vs interface imports
    const imports = adapter.extractImports(ast);
    for (const imp of imports) {
      if (imp.source.includes('/') && !imp.source.includes('interface') && !imp.source.includes('types')) {
        concreteImports++;
      }
    }
    
    this.walkAST(classNode, node => {
      // Check for 'new' expressions
      if (node.type.includes('New')) {
        const text = adapter.getNodeText(node, sourceCode);
        // Ignore primitive constructors like Date, Array, etc.
        if (!this.isPrimitiveConstructor(text)) {
          hasDirectInstantiation = true;
        }
      }
    });
    
    if (hasDirectInstantiation) {
      violations.push(this.createViolation(
        ast.filePath,
        cls.location.start,
        `Class "${cls.name}" directly instantiates dependencies. Consider dependency injection.`,
        'suggestion',
        'dependency-inversion'
      ));
    }
    
    if (concreteImports > 3) {
      violations.push(this.createViolation(
        ast.filePath,
        cls.location.start,
        `Class "${cls.name}" imports ${concreteImports} concrete implementations. Consider depending on abstractions.`,
        'suggestion',
        'dependency-inversion'
      ));
    }
    
    return violations;
  }
  
  /**
   * Helper methods
   */
  private isTestFile(filePath: string): boolean {
    const testPatterns = [
      /\.test\.[jt]sx?$/,
      /\.spec\.[jt]sx?$/,
      /__tests__\//,
      /test\//,
      /tests\//
    ];
    
    return testPatterns.some(pattern => pattern.test(filePath));
  }
  
  private isPrimitiveConstructor(text: string): boolean {
    const primitives = ['Date', 'Array', 'Object', 'Map', 'Set', 'Promise', 'Error', 'RegExp'];
    return primitives.some(p => text.includes(`new ${p}`));
  }
  
  private findNodeByLocation(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
    const queue: ASTNode[] = [root];
    
    while (queue.length > 0) {
      const node = queue.shift()!;
      
      if (node.location.start.line === location.line &&
          node.location.start.column === location.column) {
        return node;
      }
      
      if (node.children) {
        queue.push(...node.children);
      }
    }
    
    return null;
  }
  
  private walkAST(node: ASTNode, callback: (node: ASTNode) => void): void {
    callback(node);
    if (node.children) {
      for (const child of node.children) {
        this.walkAST(child, callback);
      }
    }
  }
}