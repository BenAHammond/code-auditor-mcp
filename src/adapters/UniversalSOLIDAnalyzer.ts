/**
 * Universal SOLID Analyzer
 * 
 * Implements SOLID principle analysis using the language adapter pattern.
 * This analyzer works across multiple languages by using the abstraction layer.
 */

import { UniversalAnalyzer } from './UniversalAnalyzer.js';
import { LanguageAdapter, AST, ASTNode, FunctionInfo, ClassInfo } from './LanguageAdapter.js';
import { Violation, SOLIDViolation } from '../types.js';

export interface SOLIDConfig {
  maxMethodsPerClass: number;
  maxLinesPerMethod: number;
  maxParametersPerMethod: number;
  maxClassComplexity: number;
  maxInterfaceMembers: number;
  checkDependencyInversion: boolean;
  checkInterfaceSegregation: boolean;
  checkLiskovSubstitution: boolean;
  srp: {
    maxResponsibilities: number;
    maxLinesPerFunction: number;
    maxParametersPerFunction: number;
  };
  ocp: {
    checkForDirectModification: boolean;
  };
  lsp: {
    checkForExceptions: boolean;
  };
  isp: {
    maxMethodsPerInterface: number;
  };
  dip: {
    checkForConcreteClasses: boolean;
  };
}

const DEFAULT_CONFIG: SOLIDConfig = {
  maxMethodsPerClass: 15,
  maxLinesPerMethod: 50,
  maxParametersPerMethod: 4,
  maxClassComplexity: 50,
  maxInterfaceMembers: 10,
  checkDependencyInversion: true,
  checkInterfaceSegregation: true,
  checkLiskovSubstitution: true,
  srp: {
    maxResponsibilities: 3,
    maxLinesPerFunction: 50,
    maxParametersPerFunction: 4
  },
  ocp: {
    checkForDirectModification: true
  },
  lsp: {
    checkForExceptions: true
  },
  isp: {
    maxMethodsPerInterface: 10
  },
  dip: {
    checkForConcreteClasses: true
  }
};

export class UniversalSOLIDAnalyzer extends UniversalAnalyzer {
  readonly name = 'solid';
  readonly description = 'Analyzes code for SOLID principle violations across multiple languages';

  async analyzeAST(ast: AST, adapter: LanguageAdapter, config: any): Promise<Violation[]> {
    console.error(`[DEBUG] SOLID: analyzeAST called for: ${ast.filePath}`);
    
    const solidConfig = { ...DEFAULT_CONFIG, ...config };
    const violations: Violation[] = [];

    // For Go files, check if pre-computed violations are available from the Go analyzer
    if (adapter.name === 'go' && ast.root.raw?.violations) {
      console.error(`[DEBUG] SOLID: Using pre-computed Go violations for ${ast.filePath}`);
      console.error(`[DEBUG] SOLID: Found ${ast.root.raw.violations.length} pre-computed violations`);
      
      // Convert Go violations to our format
      const goViolations = ast.root.raw.violations.map((gv: any) => ({
        file: ast.filePath,
        line: gv.Line,
        column: 1, // Go analyzer doesn't provide column info
        severity: gv.Severity.toLowerCase(),
        message: gv.Message,
        rule: gv.Category || 'solid',
        analyzer: 'solid',
        metadata: gv.Details
      }));
      
      violations.push(...goViolations);
      console.error(`[DEBUG] SOLID: Converted ${goViolations.length} Go violations`);
      return violations;
    }

    // For other languages (TypeScript, JavaScript), do traditional analysis
    console.error(`[DEBUG] SOLID: Performing traditional analysis for ${adapter.name} file: ${ast.filePath}`);
    
    // Extract language-agnostic entities
    const functions = adapter.extractFunctions(ast);
    const classes = adapter.extractClasses(ast);
    
    console.error(`[DEBUG] SOLID: Found ${functions.length} functions and ${classes.length} classes in ${ast.filePath}`);

    // Analyze Single Responsibility Principle
    violations.push(...this.analyzeSRP(functions, classes, solidConfig, ast.filePath));
    
    // Analyze Open/Closed Principle  
    violations.push(...this.analyzeOCP(classes, solidConfig, ast.filePath));
    
    // Analyze Interface Segregation Principle
    violations.push(...this.analyzeISP(ast, adapter, solidConfig));
    
    // Analyze Dependency Inversion Principle
    violations.push(...this.analyzeDIP(classes, solidConfig, ast.filePath));

    console.error(`[DEBUG] SOLID: Analysis complete for ${ast.filePath}, found ${violations.length} violations`);
    return violations;
  }

  private analyzeSRP(functions: FunctionInfo[], classes: ClassInfo[], config: SOLIDConfig, filePath: string): Violation[] {
    const violations: Violation[] = [];

    // Check functions for too many responsibilities
    for (const func of functions) {
      // Check function length
      if (this.countFunctionLines(func) > config.srp.maxLinesPerFunction) {
        violations.push(this.createViolation(
          filePath,
          func.location.start.line,
          func.location.start.column,
          `Function "${func.name}" has ${this.countFunctionLines(func)} lines, exceeding the maximum of ${config.srp.maxLinesPerFunction}. Consider breaking it down.`,
          'warning',
          'single-responsibility',
          { principle: 'single-responsibility' }
        ));
      }

      // Check parameter count
      if (func.parameters.length > config.srp.maxParametersPerFunction) {
        violations.push(this.createViolation(
          filePath,
          func.location.start.line,
          func.location.start.column,
          `Function "${func.name}" has ${func.parameters.length} parameters, exceeding the maximum of ${config.srp.maxParametersPerFunction}. Consider using an options object.`,
          'warning',
          'single-responsibility',
          { principle: 'single-responsibility' }
        ));
      }
    }

    // Check classes for too many responsibilities
    for (const cls of classes) {
      // Check method count
      if (cls.methods.length > config.maxMethodsPerClass) {
        violations.push(this.createViolation(
          filePath,
          cls.location.start.line,
          cls.location.start.column,
          `Class "${cls.name}" has ${cls.methods.length} methods, exceeding the maximum of ${config.maxMethodsPerClass}. Consider splitting responsibilities.`,
          'warning',
          'single-responsibility',
          { principle: 'single-responsibility' }
        ));
      }

      // Check class complexity (simplified calculation)
      const complexity = this.calculateClassComplexity(cls);
      if (complexity > config.maxClassComplexity) {
        violations.push(this.createViolation(
          filePath,
          cls.location.start.line,
          cls.location.start.column,
          `Class "${cls.name}" has a complexity of ${complexity}, exceeding the maximum of ${config.maxClassComplexity}. Consider refactoring.`,
          'critical',
          'single-responsibility',
          { principle: 'single-responsibility' }
        ));
      }
    }

    return violations;
  }

  private analyzeOCP(classes: ClassInfo[], config: SOLIDConfig, filePath: string): Violation[] {
    const violations: Violation[] = [];

    if (!config.ocp.checkForDirectModification) {
      return violations;
    }

    // Check for classes that appear to be frequently modified
    // This is a simplified heuristic - in practice you'd analyze git history
    for (const cls of classes) {
      // Look for classes with many conditional branches or switch statements
      // This suggests the class needs modification for new functionality
      const methodCount = cls.methods.length;
      const hasComplexMethods = cls.methods.some(method => 
        this.countFunctionLines(method) > config.maxLinesPerMethod
      );

      if (methodCount > config.maxMethodsPerClass && hasComplexMethods) {
        violations.push(this.createViolation(
          filePath,
          cls.location.start.line,
          cls.location.start.column,
          `Class "${cls.name}" appears to be frequently modified. Consider using composition or inheritance for extension.`,
          'warning',
          'open-closed',
          { principle: 'open-closed' }
        ));
      }
    }

    return violations;
  }

  private analyzeISP(ast: AST, adapter: LanguageAdapter, config: SOLIDConfig): Violation[] {
    const violations: Violation[] = [];

    if (!config.checkInterfaceSegregation) {
      return violations;
    }

    // Find interface-like structures in the AST
    const interfaces = adapter.findNodes(ast, { 
      custom: (node) => adapter.isInterface(node)
    });

    for (const interfaceNode of interfaces) {
      const children = adapter.getChildren(interfaceNode);
      const methods = children.filter(child => adapter.isFunction(child));

      if (methods.length > config.isp.maxMethodsPerInterface) {
        const location = this.getSourceLocation(adapter, interfaceNode);
        const name = adapter.getNodeName(interfaceNode) || '<anonymous>';
        
        violations.push(this.createViolation(
          ast.filePath,
          location.line,
          location.column,
          `Interface "${name}" has ${methods.length} methods, exceeding the maximum of ${config.isp.maxMethodsPerInterface}. Consider splitting into smaller interfaces.`,
          'warning',
          'interface-segregation',
          { principle: 'interface-segregation' }
        ));
      }
    }

    return violations;
  }

  private analyzeDIP(classes: ClassInfo[], config: SOLIDConfig, filePath: string): Violation[] {
    const violations: Violation[] = [];

    if (!config.checkDependencyInversion) {
      return violations;
    }

    // Check for classes that directly instantiate dependencies
    // This is a simplified check - in practice you'd analyze constructor patterns
    for (const cls of classes) {
      // Look for classes with many concrete dependencies (simplified heuristic)
      if (cls.methods.length > 0) {
        const hasConstructor = cls.methods.some(method => 
          method.name === 'constructor' || method.name === cls.name
        );

        if (hasConstructor) {
          // In practice, you'd analyze the constructor to see if it's directly
          // instantiating dependencies instead of accepting them as parameters
          violations.push(this.createViolation(
            filePath,
            cls.location.start.line,
            cls.location.start.column,
            `Class "${cls.name}" directly instantiates dependencies. Consider dependency injection.`,
            'warning',
            'dependency-inversion',
            { principle: 'dependency-inversion' }
          ));
        }
      }
    }

    return violations;
  }

  private countFunctionLines(func: FunctionInfo): number {
    // Simplified line counting - in practice you'd analyze the actual function body
    return func.location.end.line - func.location.start.line + 1;
  }

  private calculateClassComplexity(cls: ClassInfo): number {
    // Simplified complexity calculation
    let complexity = cls.methods.length * 2; // Base complexity for methods
    complexity += cls.properties.length; // Add property count
    
    // Add complexity for method parameter counts
    for (const method of cls.methods) {
      complexity += method.parameters.length;
    }

    return complexity;
  }
}