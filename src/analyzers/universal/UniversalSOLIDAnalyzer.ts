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
  // CALIBRATED 50→100 (recorded rationale): line count is a weak SRP signal
  // for AST/visitor code, where a single switch/if-ladder over node types is
  // the correct OCP-idiomatic shape and must not be split into artificial
  // helpers. The real SRP signal is maxMethodComplexity: 50 (unchanged), which
  // still flags genuinely over-branched methods. 100 is the hard "truly too
  // long to hold in the head" backstop.
  maxLinesPerMethod: 100,
  // CALIBRATED 4→6 (recorded rationale): universal analyzers thread a context
  // tuple (ast, adapter, sourceCode, config) plus a target through private
  // methods — 5-6 positional parameters is that idiom's natural shape, not an
  // SRP smell. The threshold still catches real options-object candidates
  // (7+ params), which are fixed individually rather than waived.
  maxParametersPerMethod: 6,
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

/**
 * Builtin / standard-library type names excluded from the open-closed and
 * dependency-inversion checks. These are platform primitives and runtime error
 * types, not application types a class should abstract over. `instanceof` or
 * `new` against one of these is a legitimate runtime concern, not an
 * extensibility (OCP) or coupling (DIP) signal.
 */
const BUILTIN_TYPES = new Set<string>([
  // Primitives & boxed types
  'Date', 'Array', 'Object', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'RegExp', 'Number', 'String', 'Boolean', 'Symbol', 'BigInt',
  'Function', 'JSON', 'Math', 'Reflect', 'Proxy',
  // Errors — throwing an error is not "instantiating a dependency"
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError',
  // Typed arrays & buffers
  'ArrayBuffer', 'DataView', 'SharedArrayBuffer',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray',
  // Web / Node platform types
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Buffer',
  'FormData', 'Blob', 'AbortController', 'AbortSignal',
]);

/**
 * Universal solid analyzer.
 */
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

    const members = iface.members || [];
    const memberCount = members.length;
    const maxMembers = config.maxInterfaceMembers || 20;

    // ISP governs *behavior* contracts — "clients should not be forced to
    // depend on methods they do not use." A pure data-shape interface (every
    // member is an optional `property_signature`, e.g. a config/options bag) is
    // a record type, not a fat behavior interface; flagging it is a false
    // positive. Only interfaces that expose methods carry the ISP smell.
    const hasMethodMembers = members.some(member => member.type === 'method');

    if (hasMethodMembers && memberCount > maxMembers) {
      violations.push(this.createViolation(
        ast.filePath,
        iface.location.start,
        `Interface "${iface.name}" has ${memberCount} members, exceeding the maximum of ${maxMembers}. Consider splitting into smaller interfaces.`,
        'warning',
        'interface-segregation',
        iface.name
      ));
    }

    return violations;
  }
  
  /**
   * Check for modification patterns (Open/Closed Principle)
   *
   * The OCP smell is type-checking against *user-defined* concrete types
   * (`x instanceof MyClass`): adding a new subtype then forces editing this
   * branch. `switch` statements are intentionally NOT flagged — a switch on a
   * value (enum/string) is ordinary data dispatch, not extensibility pressure,
   * and a switch on a node type in a tree-sitter adapter is the visitor
   * pattern, which is exactly how OCP is satisfied. `instanceof` against a
   * builtin/error type is a legitimate runtime check, not an extension point.
   */
  private hasModificationPatterns(
    cls: ClassInfo,
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string
  ): boolean {
    const classNode = this.findNodeByLocation(ast.root, cls.location.start);
    if (!classNode) return false;

    let hasTypeChecking = false;

    this.walkAST(classNode, node => {
      if (node.type !== 'binary_expression') return;
      const text = adapter.getNodeText(node, sourceCode);
      const m = /\binstanceof\s+([A-Za-z_$][\w$]*)/.exec(text);
      if (!m) return;
      if (!BUILTIN_TYPES.has(m[1])) {
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
    const classNode = this.findNodeByLocation(ast.root, cls.location.start);
    if (!classNode) {
      return violations;
    }

    // Names statically imported from other modules. Directly instantiating one
    // of these (`new Foo()`) is depending on a concrete type instead of an
    // abstraction — the DIP signal. Composition-root wiring via dynamic
    // `await import(...)` is deliberately not resolvable from this static
    // import table, so factories/orchestrators are not flagged.
    const importedNames = new Set<string>();
    for (const imp of adapter.extractImports(ast)) {
      for (const spec of imp.specifiers) {
        importedNames.add(spec.alias ?? spec.name);
      }
    }

    let hasDirectInstantiation = false;
    this.walkAST(classNode, node => {
      if (node.type !== 'new_expression') return;
      const text = adapter.getNodeText(node, sourceCode);
      const m = /\bnew\s+([A-Za-z_$][\w$]*)/.exec(text);
      if (!m) return;
      const ctorName = m[1];
      // Platform primitives / error types are not application dependencies.
      if (BUILTIN_TYPES.has(ctorName)) return;
      // A class instantiating itself (singleton `new ThisClass()`) is not a
      // dependency.
      if (ctorName === cls.name) return;
      if (importedNames.has(ctorName)) {
        hasDirectInstantiation = true;
      }
    });

    if (hasDirectInstantiation) {
      violations.push(this.createViolation(
        ast.filePath,
        cls.location.start,
        `Class "${cls.name}" directly instantiates a concrete dependency. Consider depending on abstractions.`,
        'suggestion',
        'dependency-inversion',
        cls.name
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