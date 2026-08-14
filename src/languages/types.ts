/**
 * Core types for multi-language support
 */

/**
 * Represents a parsed Abstract Syntax Tree
 */
export interface AST {
  root: ASTNode;
  language: string;
  filePath: string;
  errors: ParseError[];
  /** Called by the pipeline after all visitors process a file to reclaim WASM tree memory. */
  dispose?: () => void;
}

/**
 * Generic AST node that can represent nodes from any language
 */
export interface ASTNode {
  type: string;
  range: [number, number]; // Start and end byte positions
  location: SourceLocation;
  children?: ASTNode[];
  parent?: ASTNode;
  // Language-specific data preserved here
  raw: any;
}

/**
 * Location information for source mapping
 */
export interface SourceLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

/**
 * Parse error information
 */
export interface ParseError {
  message: string;
  location: SourceLocation;
  severity: 'error' | 'warning';
}

/**
 * Pattern for matching AST nodes
 */
export interface NodePattern {
  type?: string | string[];
  name?: string | RegExp;
  hasChild?: NodePattern;
  hasParent?: NodePattern;
  custom?: (node: ASTNode) => boolean;
}

/**
 * Function information extracted from AST
 */
export interface FunctionInfo {
  name: string;
  location: SourceLocation;
  parameters: ParameterInfo[];
  returnType?: string;
  isAsync: boolean;
  isExported: boolean;
  isMethod: boolean;
  className?: string;
  jsDoc?: string;
}

/**
 * Parameter information
 */
export interface ParameterInfo {
  name: string;
  type?: string;
  optional: boolean;
  defaultValue?: string;
}

/**
 * Class information extracted from AST
 */
export interface ClassInfo {
  name: string;
  location: SourceLocation;
  methods: FunctionInfo[];
  properties: PropertyInfo[];
  extends?: string;
  implements?: string[];
  isAbstract: boolean;
  isExported: boolean;
  jsDoc?: string;
}

/**
 * Property information
 */
export interface PropertyInfo {
  name: string;
  type?: string;
  visibility?: 'public' | 'private' | 'protected';
  isStatic: boolean;
  isReadonly: boolean;
}

/**
 * Import information extracted from AST
 */
export interface ImportInfo {
  source: string;
  specifiers: ImportSpecifier[];
  location: SourceLocation;
}

/**
 * Import specifier details
 */
export interface ImportSpecifier {
  name: string;
  alias?: string;
  isDefault: boolean;
  isNamespace: boolean;
}

/**
 * Export information extracted from AST
 */
export interface ExportInfo {
  name: string;
  location: SourceLocation;
  isDefault: boolean;
  source?: string; // For re-exports
}

/**
 * A sub-part of a string construction node.
 *
 * - For template literals: the expressions inside \${...}
 * - For binary + concatenations: the non-string-literal operands
 * - For fmt.Sprintf: the non-literal arguments after the format string
 */
export interface DynamicPart {
  text: string;
  /** True when the part is a simple identifier (which may be resolvable). */
  isIdentifier: boolean;
  /** The AST node for this part, when available.  Set for identifier parts
   *  so callers can resolve them via resolveLocalConstant(). */
  node?: ASTNode;
}

/**
 * Result of resolving a local constant/let/var identifier.
 * Null means unresolvable (complex expression, call result, parameter, etc.).
 */
export interface ResolvedConstant {
  /** The RHS text of the declaration (initializer expression). */
  initText: string;
  /** True if the initText is static/placeholder-safe (no dynamic injection). */
  isStatic: boolean;
  /** The line of the declaration, for reassignment checking. */
  declLine: number;
}

/**
 * Parser role: file detection and AST production.
 */
export interface LanguageParser {
  readonly name: string;
  readonly fileExtensions: string[];

  /**
   * Parse a file into an AST
   */
  parse(filePath: string, content: string): Promise<AST>;

  /**
   * Check if this adapter supports a file
   */
  supportsFile(filePath: string): boolean;
}

/**
 * AST navigation role: structural traversal of the parsed tree.
 */
export interface AstNavigation {
  findNodes(ast: AST, pattern: NodePattern): ASTNode[];
  getParent(node: ASTNode): ASTNode | null;
  getChildren(node: ASTNode): ASTNode[];
  getSiblings(node: ASTNode): ASTNode[];
}

/**
 * Node information role: reading type/text/name/location off a node.
 */
export interface NodeIntrospection {
  getNodeType(node: ASTNode): string;
  getNodeText(node: ASTNode, sourceCode: string): string;
  getNodeName(node: ASTNode): string | null;
  getNodeLocation(node: ASTNode): SourceLocation;
}

/**
 * Language-specific extraction role: pull structured entities out of an AST.
 */
export interface LanguageExtraction {
  extractFunctions(ast: AST): FunctionInfo[];
  extractClasses(ast: AST): ClassInfo[];
  extractImports(ast: AST): ImportInfo[];
  extractExports(ast: AST): ExportInfo[];
}

/**
 * Node predicate role: classify AST nodes by kind.
 */
export interface NodePredicates {
  isClass(node: ASTNode): boolean;
  isFunction(node: ASTNode): boolean;
  isMethod(node: ASTNode): boolean;
  isInterface(node: ASTNode): boolean;
  isImport(node: ASTNode): boolean;
  isExport(node: ASTNode): boolean;
  isLoop(node: ASTNode): boolean;
  isConditional(node: ASTNode): boolean;
  isVariableDeclaration(node: ASTNode): boolean;
}

/**
 * Advanced analysis role: type info, documentation, and complexity.
 */
export interface AdvancedAnalysis {
  getTypeInfo(node: ASTNode): string | null;
  getDocumentation(node: ASTNode): string | null;
  getComplexity(node: ASTNode): number;
}

/**
 * Optional capabilities a language may or may not provide.
 *
 * String-construction capabilities replace text-pattern heuristics for SQL
 * injection detection with AST-level knowledge of how each host language
 * constructs dynamic strings. When a language adapter does not implement
 * these, the caller falls back to the legacy text-pattern approach (Legacy
 * check disabled in v3.4.7 — if no adapter capability is present, no
 * injection risk is flagged).
 */
export interface OptionalCapabilities {
  /** Extract interfaces (for languages that support them). */
  extractInterfaces?(ast: AST): InterfaceInfo[];

  /** Extract raw import info including dynamic/require forms. */
  extractRawImports?(filePath: string, content: string): Array<{
    moduleSpecifier: string;
    isStatic: boolean;
    isDynamic: boolean;
    isRequire: boolean;
    line: number;
  }>;

  /** Extract exported symbol names from an AST. */
  extractExportedSymbols?(ast: AST): Array<{ name: string; line: number }>;

  /**
   * Returns true if the node is a dynamically-constructed string —
   * template literal with interpolation, binary + concatenation,
   * fmt.Sprintf call, etc. A plain string literal or raw string without
   * interpolation returns false.
   */
  isDynamicStringConstruction?(node: ASTNode): boolean;

  /**
   * Returns the dynamic sub-parts of a string construction node.
   * For template literals: the template_substitution children.
   * For binary + concatenations: the non-string-literal operands.
   * For fmt.Sprintf: the non-literal arguments after the format string.
   * Returns an empty array for static strings (plain literals).
   */
  getDynamicParts?(node: ASTNode, sourceCode: string): DynamicPart[];

  /**
   * Resolve a local constant/let/var declaration for an identifier node.
   * Searches the enclosing function scope for a declaration matching the
   * identifier's text. Returns null when the identifier cannot be
   * statically resolved (complex expression, parameter, reassigned, etc.).
   *
   * @param identifierNode - An identifier node to resolve
   * @param ast - The full AST for scope traversal
   * @param sourceCode - The source text
   */
  resolveLocalConstant?(identifierNode: ASTNode, ast: AST, sourceCode: string): ResolvedConstant | null;

  /**
   * Returns true if an interpolated expression is provably safe to embed in a
   * SQL string — a compile-time constant, quote-escaped sanitizer, ternary of
   * safe branches, static-array `.map().join()`, local function call with a
   * safe body and safe call sites, or a guard-validated parameter.  Used to
   * clear cross-function false positives without weakening raw-input detection.
   *
   * @param node - The expression node inside a ${…} substitution (or operand).
   * @param ast - The full AST for scope traversal.
   * @param sourceCode - The source text.
   */
  isSafeInterpolation?(node: ASTNode, ast: AST, sourceCode: string): boolean;
}

/**
 * Language adapter interface - must be implemented for each language.
 *
 * Composed from role interfaces (Spec-33 interface-segregation): a single
 * 35-member interface once forced every adapter to implement all members at
 * once, bloating each adapter class (the TypeScript adapter grew to 78
 * methods, Go to 53). Splitting into roles lets adapters implement the
 * capabilities they support and compose them back into a full adapter.
 */
export interface LanguageAdapter
  extends LanguageParser,
    AstNavigation,
    NodeIntrospection,
    LanguageExtraction,
    NodePredicates,
    AdvancedAnalysis,
    OptionalCapabilities {}

/**
 * Interface information extracted from AST
 */
export interface InterfaceInfo {
  name: string;
  location: SourceLocation;
  members: Array<{
    name: string;
    type: 'method' | 'property';
    location: SourceLocation;
  }>;
  extends?: string[];
  isExported: boolean;
}