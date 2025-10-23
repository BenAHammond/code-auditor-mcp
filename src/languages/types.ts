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