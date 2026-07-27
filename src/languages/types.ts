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
 * Language adapter interface - must be implemented for each language
 */
export interface LanguageAdapter {
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
  
  // AST Navigation
  findNodes(ast: AST, pattern: NodePattern): ASTNode[];
  getParent(node: ASTNode): ASTNode | null;
  getChildren(node: ASTNode): ASTNode[];
  getSiblings(node: ASTNode): ASTNode[];
  
  // Node Information
  getNodeType(node: ASTNode): string;
  getNodeText(node: ASTNode, sourceCode: string): string;
  getNodeName(node: ASTNode): string | null;
  getNodeLocation(node: ASTNode): SourceLocation;
  
  // Language-Specific Extraction
  extractFunctions(ast: AST): FunctionInfo[];
  extractClasses(ast: AST): ClassInfo[];
  extractImports(ast: AST): ImportInfo[];
  extractExports(ast: AST): ExportInfo[];
  
  // Pattern Matching Helpers
  isClass(node: ASTNode): boolean;
  isFunction(node: ASTNode): boolean;
  isMethod(node: ASTNode): boolean;
  isInterface(node: ASTNode): boolean;
  isImport(node: ASTNode): boolean;
  isExport(node: ASTNode): boolean;
  isLoop(node: ASTNode): boolean;
  isConditional(node: ASTNode): boolean;
  isVariableDeclaration(node: ASTNode): boolean;
  
  // Advanced Features
  getTypeInfo(node: ASTNode): string | null;
  getDocumentation(node: ASTNode): string | null;
  getComplexity(node: ASTNode): number;
  
  // Optional: Extract interfaces (for languages that support them)
  extractInterfaces?(ast: AST): InterfaceInfo[];

  // Optional: Extract raw import info including dynamic/require forms
  extractRawImports?(filePath: string, content: string): Array<{
    moduleSpecifier: string;
    isStatic: boolean;
    isDynamic: boolean;
    isRequire: boolean;
    line: number;
  }>;

  // Optional: Extract exported symbol names from an AST
  extractExportedSymbols?(ast: AST): Array<{ name: string; line: number }>;

  // Optional: String construction capabilities for SQL injection detection.
  // These replace text-pattern heuristics with AST-level knowledge of how
  // each host language constructs dynamic strings.
  //
  // When a language adapter does not implement these, the caller falls back
  // to the legacy text-pattern approach (Legacy check disabled in v3.4.7 —
  // if no adapter capability is present, no injection risk is flagged).

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
}

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