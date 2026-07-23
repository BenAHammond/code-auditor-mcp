/**
 * Universal SOLID Principles Analyzer
 * Works across multiple programming languages using the adapter pattern
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode, ClassInfo, FunctionInfo, InterfaceInfo } from '../../languages/types.js';

/**
 * Configuration for SOLID analyzer
 *
 * Spec-17 R5: maxClassComplexity (heuristic) is DEPRECATED — replaced by
 * maxMethodComplexity (per-method cyclomatic complexity, solid/method-complexity)
 * and classAggregateComplexity (class-size aggregation, solid/class-size).
 */
export interface SOLIDAnalyzerConfig {
  maxMethodsPerClass?: number;
  maxLinesPerMethod?: number;
  maxParametersPerMethod?: number;
  /** @deprecated Use maxMethodComplexity instead — this was a heuristic (1 + 2×methods + 5×extends + Σ(lines/10)) */
  maxClassComplexity?: number;
  maxInterfaceMembers?: number;
  // R5.1: Per-method cyclomatic complexity threshold (true McCC via adapter.getComplexity())
  maxMethodComplexity?: number;
  // R5.2: Class-level aggregation thresholds
  classMethodsThreshold?: number;
  classAggregateComplexity?: number;
  checkDependencyInversion?: boolean;
  checkInterfaceSegregation?: boolean;
  checkLiskovSubstitution?: boolean;
  skipTestFiles?: boolean;
}

export const DEFAULT_SOLID_CONFIG: SOLIDAnalyzerConfig = {
  maxMethodsPerClass: 15,
  maxLinesPerMethod: 50,
  maxParametersPerMethod: 4,
  maxClassComplexity: 50,              // DEPRECATED — kept for back-compat
  maxInterfaceMembers: 20,
  // R5.1: Per-method cyclomatic complexity (true McCC)
  maxMethodComplexity: 50,
  // R5.2: Class-level aggregation
  classMethodsThreshold: 15,
  classAggregateComplexity: 100,
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
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_SOLID_CONFIG, ...config };

    // Skip test files if configured
    if (finalConfig.skipTestFiles && this.isTestFile(ast.filePath)) {
      return violations;
    }

    // Analyze classes
    const classes = adapter.extractClasses(ast);
    for (const cls of classes) {
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
      const interfaces = adapter.extractInterfaces(ast);
      for (const iface of interfaces) {
        violations.push(...this.analyzeInterface(iface, ast, adapter, sourceCode, finalConfig));
      }
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

    // ── R5.2: Class size (suggestion) ──────────────────────────────────

    const methodsThreshold = config.classMethodsThreshold ?? config.maxMethodsPerClass ?? 15;
    if (cls.methods.length > methodsThreshold) {
      violations.push(this.createViolation(
        ast.filePath,
        cls.location.start,
        `Class "${cls.name}" has ${cls.methods.length} methods, exceeding the maximum of ${methodsThreshold}. Consider splitting responsibilities.`,
        'suggestion',                                          // R7: class-size → suggestion
        'solid/class-size',
        undefined,
        cls.name
      ));
    }

    // Analyze each method for complexity + standard size checks
    let aggregateComplexity = 0;

    for (const method of cls.methods) {
      // R5.1: Per-method cyclomatic complexity (warning)
      const methodNode = this.findNodeByLocation(ast.root, method.location.start);
      if (methodNode) {
        const methodComplexity = adapter.getComplexity(methodNode);
        aggregateComplexity += methodComplexity;

        const maxMethod = config.maxMethodComplexity ?? 50;
        if (methodComplexity > maxMethod) {
          violations.push(this.createViolation(
            ast.filePath,
            method.location.start,
            `Method "${cls.name}.${method.name}" has cyclomatic complexity ${methodComplexity}, ` +
            `exceeding the maximum of ${maxMethod}. Consider breaking it into smaller methods.`,
            'warning',                                         // R7: method-complexity → warning
            'solid/method-complexity',
            undefined,
            `${cls.name}.${method.name}`
          ));
        }
      }

      // Standard function checks (params, line count)
      violations.push(...this.analyzeFunction(method, ast, adapter, sourceCode, config));
    }

    // R5.2: Class aggregate complexity (suggestion)
    const maxAggregate = config.classAggregateComplexity ?? 100;
    if (aggregateComplexity > maxAggregate) {
      violations.push(this.createViolation(
        ast.filePath,
        cls.location.start,
        `Class "${cls.name}" has aggregate cyclomatic complexity ${aggregateComplexity}, ` +
        `exceeding the maximum of ${maxAggregate}. Consider splitting the class.`,
        'suggestion',                                          // R7: class-size → suggestion
        'solid/class-size',
        undefined,
        cls.name
      ));
    }

    // Open/Closed Principle - check for modification patterns
    if (this.hasModificationPatterns(cls, ast, adapter, sourceCode)) {
      violations.push(this.createViolation(
        ast.filePath,
        cls.location.start,
        `Class "${cls.name}" appears to be frequently modified. Consider using composition or inheritance for extension.`,
        'suggestion',
        'open-closed',
        undefined,
        cls.name
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
        'single-responsibility',
        undefined,
        func.name
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
        'single-responsibility',
        undefined,
        func.name
      ));
    }

    // R5.1: Cyclomatic complexity for standalone functions (not methods — those are
    // already checked in analyzeClass). Skip methods to avoid double-reporting.
    if (!func.isMethod) {
      const funcNode = this.findNodeByLocation(ast.root, func.location.start);
      if (funcNode) {
        const cyclomaticComplexity = adapter.getComplexity(funcNode);
        const maxMethod = config.maxMethodComplexity ?? 50;
        if (cyclomaticComplexity > maxMethod) {
          violations.push(this.createViolation(
            ast.filePath,
            func.location.start,
            `Function "${func.name}" has cyclomatic complexity ${cyclomaticComplexity}, ` +
            `exceeding the maximum of ${maxMethod}. Consider breaking it into smaller functions.`,
            'warning',                                          // R7: method-complexity → warning
            'solid/method-complexity',
            undefined,
            func.name
          ));
        }
      }
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

    if (!config.checkInterfaceSegregation) {
      return violations;
    }

    const memberCount = iface.members?.length || 0;
    const maxMembers = config.maxInterfaceMembers || 20;

    if (memberCount > maxMembers) {
      violations.push(this.createViolation(
        ast.filePath,
        iface.location.start,
        `Interface "${iface.name}" has ${memberCount} members, exceeding the maximum of ${maxMembers}. Consider splitting into smaller interfaces.`,
        'warning',
        'interface-segregation',
        undefined,
        iface.name
      ));
    }

    return violations;
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
      if (node.type === 'switch_statement') {
        hasTypeChecking = true;
      }
      
      // Check for instanceof chains
      if (node.type === 'binary_expression' && adapter.getNodeText(node, sourceCode).includes('instanceof')) {
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
          if (node.type === 'throw_statement') {
            hasThrow = true;
          }
        });
        
        if (hasThrow) {
          violations.push(this.createViolation(
            ast.filePath,
            method.location.start,
            `Method "${cls.name}.${method.name}" throws exceptions. Ensure this doesn't violate parent class contract.`,
            'suggestion',
            'liskov-substitution',
            undefined,
            `${cls.name}.${method.name}`
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

    // Check for direct instantiation of dependencies
    const classNode = this.findNodeByLocation(ast.root, cls.location.start);
    if (!classNode) {
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
      if (node.type === 'new_expression') {
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
        'dependency-inversion',
        undefined,
        cls.name
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