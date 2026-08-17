/**
 * Universal SOLID Principles Analyzer
 * Works across multiple programming languages using the adapter pattern
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import { withRuleTiming } from '../ruleTiming.js';
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
  // Confirmed by the Spec-11 R3 sweep; must match src/config/defaults.ts.
  // Reverted 2026-08-14: a 50→100 / 4→6 calibration (made to clear
  // UniversalSchemaAnalyzer during Spec 33) silently dropped 660
  // single-responsibility findings on recall-protocol. Undone rather than
  // re-baselined — a threshold change must be decided on its own merits with
  // recall's numbers in front of you, not as a side effect of one file passing.
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
 * Bundled per-file inputs for the SOLID checks. `ast`, `adapter`, `sourceCode`,
 * and `config` travel together through every class/function/interface check, so
 * they are passed as one context object rather than four trailing parameters.
 */
interface SolidContext {
  ast: AST;
  adapter: LanguageAdapter;
  sourceCode: string;
  config: SOLIDAnalyzerConfig;
}

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
    if (finalConfig.skipTestFiles && isTestFile(ast.filePath)) {
      return violations;
    }

    const ctx: SolidContext = { ast, adapter, sourceCode, config: finalConfig };

    // Analyze classes
    const classes = adapter.extractClasses(ast);
    for (const cls of classes) {
      violations.push(...this.analyzeClass(cls, ctx));
    }

    // Analyze standalone functions
    const functions = adapter.extractFunctions(ast);
    for (const func of functions) {
      if (!func.isMethod) { // Skip methods as they're analyzed with their classes
        violations.push(...this.analyzeFunction(func, ctx));
      }
    }

    // Analyze interfaces if supported
    if (adapter.extractInterfaces) {
      const interfaces = adapter.extractInterfaces(ast);
      for (const iface of interfaces) {
        violations.push(...this.analyzeInterface(iface, ctx));
      }
    }

    return violations;
  }
  
  /**
   * Analyze a class for SOLID violations
   */
  private analyzeClass(cls: ClassInfo, ctx: SolidContext): Violation[] {
    const violations: Violation[] = [];

    this.checkClassSize(cls, ctx, violations);
    this.checkOpenClosed(cls, ctx, violations);
    this.checkLiskov(cls, ctx, violations);
    this.checkDependencyInversion(cls, ctx, violations);

    return violations;
  }

  /**
   * R5.2: Class size checks (method count + aggregate cyclomatic complexity).
   */
  private checkClassSize(cls: ClassInfo, ctx: SolidContext, violations: Violation[]): void {
    const { ast, config } = ctx;

    withRuleTiming('solid/class-size', () => {
      const methodsThreshold = config.classMethodsThreshold ?? config.maxMethodsPerClass ?? 15;
      if (cls.methods.length > methodsThreshold) {
        violations.push(this.createViolation(
          ast.filePath,
          cls.location.start,
          `Class "${cls.name}" has ${cls.methods.length} methods, exceeding the maximum of ${methodsThreshold}. Consider splitting responsibilities.`,
          { severity: 'suggestion', rule: 'solid/class-size', symbol: cls.name,  // R7: class-size → suggestion
            resolution: {
              action: 'split-class',
              summary: `Split class "${cls.name}" (${cls.methods.length} methods) into smaller classes by extracting a cohesive subset of its methods.`,
              symbols: cls.methods.map((m) => `${cls.name}.${m.name}`),
              files: [ast.filePath],
              lines: cls.methods.map((m) => m.location.start.line),
            } }
        ));
      }
    });

    const aggregateComplexity = this.analyzeClassMethods(cls, ctx, violations);

    withRuleTiming('solid/class-size', () => {
      const maxAggregate = config.classAggregateComplexity ?? 100;
      if (aggregateComplexity > maxAggregate) {
        violations.push(this.createViolation(
          ast.filePath,
          cls.location.start,
          `Class "${cls.name}" has aggregate cyclomatic complexity ${aggregateComplexity}, ` +
          `exceeding the maximum of ${maxAggregate}. Consider splitting the class.`,
          { severity: 'suggestion', rule: 'solid/class-size', symbol: cls.name,  // R7: class-size → suggestion
            resolution: {
              action: 'split-class',
              summary: `Split class "${cls.name}" (aggregate complexity ${aggregateComplexity}) to move its most-complex methods into a separate class.`,
              symbols: cls.methods.map((m) => `${cls.name}.${m.name}`),
              files: [ast.filePath],
              lines: cls.methods.map((m) => m.location.start.line),
            } }
        ));
      }
    });
  }

  /**
   * Analyze each method's complexity + standard size checks, returning the
   * class's aggregate cyclomatic complexity for the R5.2 aggregation check.
   */
  private analyzeClassMethods(cls: ClassInfo, ctx: SolidContext, violations: Violation[]): number {
    const { ast, adapter, config } = ctx;
    let aggregateComplexity = 0;

    for (const method of cls.methods) {
      // R5.1: Per-method cyclomatic complexity (warning)
      const methodNode = findNodeByLocation(ast.root, method.location.start);
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
            { severity: 'warning', rule: 'solid/method-complexity', symbol: `${cls.name}.${method.name}` }  // R7: method-complexity → warning
          ));
        }
      }

      // Standard function checks (params, line count)
      violations.push(...this.analyzeFunction(method, ctx));
    }

    return aggregateComplexity;
  }

  /**
   * Open/Closed Principle — check for modification patterns.
   */
  private checkOpenClosed(cls: ClassInfo, ctx: SolidContext, violations: Violation[]): void {
    if (this.hasModificationPatterns(cls, ctx.ast, ctx.adapter, ctx.sourceCode)) {
      violations.push(this.createViolation(
        ctx.ast.filePath,
        cls.location.start,
        `Class "${cls.name}" appears to be frequently modified. Consider using composition or inheritance for extension.`,
        { severity: 'suggestion', rule: 'solid/open-closed', symbol: cls.name }
      ));
    }
  }

  /**
   * Liskov Substitution Principle.
   */
  private checkLiskov(cls: ClassInfo, ctx: SolidContext, violations: Violation[]): void {
    if (ctx.config.checkLiskovSubstitution && cls.extends) {
      violations.push(...this.checkLiskovSubstitution(cls, ctx.ast, ctx.adapter));
    }
  }
  
  /**
   * Analyze a function for SOLID violations
   */
  private analyzeFunction(func: FunctionInfo, ctx: SolidContext): Violation[] {
    const violations: Violation[] = [];

    this.checkFunctionSize(func, ctx, violations);

    // R5.1: Cyclomatic complexity for standalone functions (not methods — those are
    // already checked in analyzeClass). Skip methods to avoid double-reporting.
    if (!func.isMethod) {
      this.checkFunctionComplexity(func, ctx, violations);
    }

    return violations;
  }

  /**
   * R5.1/R5.2: Function size checks (parameter count + line count).
   */
  private checkFunctionSize(func: FunctionInfo, ctx: SolidContext, violations: Violation[]): void {
    const { ast, config } = ctx;

    withRuleTiming('solid/single-responsibility', () => {
      if (func.parameters.length > (config.maxParametersPerMethod || 4)) {
        violations.push(this.createViolation(
          ast.filePath,
          func.location.start,
          `Function "${func.name}" has ${func.parameters.length} parameters, exceeding the maximum of ${config.maxParametersPerMethod || 4}. Consider using an options object.`,
          { severity: 'warning', rule: 'solid/single-responsibility', symbol: func.name,
            resolution: {
              action: 'bundle-params',
              summary: `Bundle the ${func.parameters.length} parameters of "${func.name}" into an options object.`,
              symbols: func.parameters.map((p) => p.name),
              files: [ast.filePath],
              lines: [func.location.start.line],
            } }
        ));
      }
    });

    withRuleTiming('solid/single-responsibility', () => {
      const lineCount = func.location.end.line - func.location.start.line + 1;
      if (lineCount > (config.maxLinesPerMethod || 50)) {
        violations.push(this.createViolation(
          ast.filePath,
          func.location.start,
          `Function "${func.name}" has ${lineCount} lines, exceeding the maximum of ${config.maxLinesPerMethod || 50}. Consider breaking it down.`,
          { severity: 'warning', rule: 'solid/single-responsibility', symbol: func.name,
            resolution: {
              action: 'break-down-function',
              summary: `Break "${func.name}" (${lineCount} lines) into smaller functions, extracting named helper blocks.`,
              symbols: [func.name],
              files: [ast.filePath],
              lines: [func.location.start.line],
            } }
        ));
      }
    });
  }

  /**
   * R5.1: Cyclomatic complexity for a standalone function.
   */
  private checkFunctionComplexity(func: FunctionInfo, ctx: SolidContext, violations: Violation[]): void {
    const funcNode = findNodeByLocation(ctx.ast.root, func.location.start);
    if (!funcNode) return;

    const cyclomaticComplexity = ctx.adapter.getComplexity(funcNode);
    const maxMethod = ctx.config.maxMethodComplexity ?? 50;
    if (cyclomaticComplexity > maxMethod) {
      violations.push(this.createViolation(
        ctx.ast.filePath,
        func.location.start,
        `Function "${func.name}" has cyclomatic complexity ${cyclomaticComplexity}, ` +
        `exceeding the maximum of ${maxMethod}. Consider breaking it into smaller functions.`,
        { severity: 'warning', rule: 'solid/method-complexity', symbol: func.name }  // R7: method-complexity → warning
      ));
    }
  }
  
  /**
   * Analyze an interface for Interface Segregation Principle
   */
  private analyzeInterface(iface: InterfaceInfo, ctx: SolidContext): Violation[] {
    const { ast, config } = ctx;
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
        { severity: 'warning', rule: 'solid/interface-segregation', symbol: iface.name }
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
    const classNode = findNodeByLocation(ast.root, cls.location.start);
    if (!classNode) return false;

    let hasTypeChecking = false;

    walkAST(classNode, node => {
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
      const methodNode = findNodeByLocation(ast.root, method.location.start);
      if (methodNode) {
        let hasThrow = false;
        walkAST(methodNode, node => {
          if (node.type === 'throw_statement') {
            hasThrow = true;
          }
        });
        
        if (hasThrow) {
          violations.push(this.createViolation(
            ast.filePath,
            method.location.start,
            `Method "${cls.name}.${method.name}" throws exceptions. Ensure this doesn't violate parent class contract.`,
            { severity: 'suggestion', rule: 'solid/liskov-substitution', symbol: `${cls.name}.${method.name}` }
          ));
        }
      }
    }
    
    return violations;
  }
  
  /**
   * Check Dependency Inversion Principle
   */
  private checkDependencyInversion(cls: ClassInfo, ctx: SolidContext, violations: Violation[]): void {
    const classNode = findNodeByLocation(ctx.ast.root, cls.location.start);
    if (!classNode) {
      return;
    }

    if (this.hasDirectInstantiation(cls, classNode, ctx)) {
      violations.push(this.createViolation(
        ctx.ast.filePath,
        cls.location.start,
        `Class "${cls.name}" directly instantiates a concrete dependency. Consider depending on abstractions.`,
        { severity: 'suggestion', rule: 'solid/dependency-inversion', symbol: cls.name }
      ));
    }
  }

  /**
   * True if the class body directly instantiates a concrete type (`new Foo()`),
   * which is the dependency-inversion signal.
   *
   * The signal is a *bare* construction of a PascalCase type name, regardless of
   * where the type comes from — a statically-imported class, a CommonJS
   * `require()` binding, or a class defined locally in the same file. The prior
   * implementation gated on a statically-imported-name table, which made the rule
   * dead on locally-defined classes (the common case — `AppGenerator`,
   * `ResetPasswordError`, …) and on every `require()`-based codebase. Provenance is
   * not a DIP concern: instantiating a concrete type violates the principle whether
   * the type was imported or defined next door.
   */
  private hasDirectInstantiation(cls: ClassInfo, classNode: ASTNode, ctx: SolidContext): boolean {
    const { adapter, sourceCode } = ctx;

    let hasDirectInstantiation = false;
    walkAST(classNode, node => {
      if (node.type !== 'new_expression') return;

      // The constructor is the direct child that is neither the argument list
      // nor a type-argument clause. It must be a bare `identifier`: a member
      // access (`new this.Foo()`, `new ns.Foo()`), a parenthesized expression
      // (`new (ctor())()`), or a call are not a concrete-type signal.
      const ctor = (node.children ?? []).find(
        c => c.type !== 'arguments' && c.type !== 'type_arguments'
      );
      if (!ctor || ctor.type !== 'identifier') return;

      const ctorName = adapter.getNodeText(ctor, sourceCode).trim();
      // A lowercase binding is an instance, not a type; only PascalCase names
      // are treated as concrete classes (the JS/TS naming convention).
      if (!/^[A-Z]/.test(ctorName)) return;
      // Platform primitives / error types are not application dependencies.
      if (BUILTIN_TYPES.has(ctorName)) return;
      // A class instantiating itself (singleton `new ThisClass()`) is not a
      // dependency.
      if (ctorName === cls.name) return;

      hasDirectInstantiation = true;
    });

    return hasDirectInstantiation;
  }
}

// --- Module-level helpers (pure tree/path utilities, no `this`) ---------------

/** True when the path is a test/spec file (used by SOLID's skipTestFiles). */
function isTestFile(filePath: string): boolean {
  const testPatterns = [
    /\.test\.[jt]sx?$/,
    /\.spec\.[jt]sx?$/,
    /__tests__\//,
    /test\//,
    /tests\//
  ];

  return testPatterns.some(pattern => pattern.test(filePath));
}

/** Breadth-first search for the node whose start position matches `location`. */
function findNodeByLocation(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
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

/** Depth-first walk over a subtree, invoking `callback` on every node. */
function walkAST(node: ASTNode, callback: (node: ASTNode) => void): void {
  callback(node);
  if (node.children) {
    for (const child of node.children) {
      walkAST(child, callback);
    }
  }
}