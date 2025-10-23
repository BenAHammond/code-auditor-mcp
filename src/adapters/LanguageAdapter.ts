/**
 * Language Adapter Interface - Core abstraction for multi-language support
 * 
 * This follows the architecture plan in /docs/MULTI-LANGUAGE-ARCHITECTURE.md
 * Each language implements this interface to provide unified AST access.
 */

export interface SourceLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface ASTNode {
  type: string;
  range: [number, number];
  location: SourceLocation;
  // Language-specific data stored here
  raw: any;
}

export interface AST {
  root: ASTNode;
  language: string;
  filePath: string;
  errors: ParseError[];
}

export interface ParseError {
  message: string;
  location: SourceLocation;
  severity: 'error' | 'warning';
}

export interface NodePattern {
  type?: string | string[];
  name?: string | RegExp;
  hasChild?: NodePattern;
  hasParent?: NodePattern;
  custom?: (node: ASTNode) => boolean;
}

export interface FunctionInfo {
  name: string;
  location: SourceLocation;
  parameters: ParameterInfo[];
  returnType?: string;
  isAsync: boolean;
  isExported: boolean;
  isMethod: boolean;
  className?: string;
  complexity?: number;
}

export interface ParameterInfo {
  name: string;
  type?: string;
  optional: boolean;
  defaultValue?: string;
}

export interface ClassInfo {
  name: string;
  location: SourceLocation;
  methods: FunctionInfo[];
  properties: PropertyInfo[];
  extends?: string[];
  implements?: string[];
  isExported: boolean;
  isAbstract: boolean;
}

export interface PropertyInfo {
  name: string;
  type?: string;
  location: SourceLocation;
  isStatic: boolean;
  isPrivate: boolean;
  isReadonly: boolean;
}

export interface ImportInfo {
  module: string;
  items: ImportItem[];
  location: SourceLocation;
  isTypeOnly: boolean;
}

export interface ImportItem {
  name: string;
  alias?: string;
  isDefault: boolean;
}

export interface ExportInfo {
  name: string;
  type: 'function' | 'class' | 'variable' | 'type';
  location: SourceLocation;
  isDefault: boolean;
}

/**
 * Language Adapter Interface
 * 
 * Each language implements this interface to provide unified access to AST operations.
 * This abstraction allows analyzers to work across multiple languages.
 */
export interface LanguageAdapter {
  readonly name: string;
  readonly extensions: string[];
  
  // Parsing
  parse(file: string, content: string): Promise<AST>;
  supportsFile(filePath: string): boolean;
  
  // AST Navigation
  findNodes(ast: AST, pattern: NodePattern): ASTNode[];
  getParent(node: ASTNode): ASTNode | null;
  getChildren(node: ASTNode): ASTNode[];
  
  // Node Information
  getNodeType(node: ASTNode): string;
  getNodeText(node: ASTNode): string;
  getNodeLocation(node: ASTNode): SourceLocation;
  getNodeName(node: ASTNode): string | null;
  
  // Language-Specific Extraction
  extractFunctions(ast: AST): FunctionInfo[];
  extractClasses(ast: AST): ClassInfo[];
  extractImports(ast: AST): ImportInfo[];
  extractExports(ast: AST): ExportInfo[];
  
  // Pattern Matching
  isClass(node: ASTNode): boolean;
  isFunction(node: ASTNode): boolean;
  isMethod(node: ASTNode): boolean;
  isInterface(node: ASTNode): boolean;
  isImport(node: ASTNode): boolean;
  isVariable(node: ASTNode): boolean;
}

/**
 * Language Registry - Manages all language adapters
 */
export class LanguageRegistry {
  private static instance: LanguageRegistry;
  private adapters = new Map<string, LanguageAdapter>();
  
  static getInstance(): LanguageRegistry {
    if (!LanguageRegistry.instance) {
      LanguageRegistry.instance = new LanguageRegistry();
    }
    return LanguageRegistry.instance;
  }
  
  register(adapter: LanguageAdapter): void {
    this.adapters.set(adapter.name, adapter);
    console.log(`[LanguageRegistry] Registered adapter: ${adapter.name} for extensions: ${adapter.extensions.join(', ')}`);
  }
  
  getAdapter(language: string): LanguageAdapter | null {
    return this.adapters.get(language) || null;
  }
  
  getAdapterForFile(filePath: string): LanguageAdapter | null {
    const extension = this.getFileExtension(filePath);
    
    for (const adapter of this.adapters.values()) {
      if (adapter.extensions.includes(extension)) {
        return adapter;
      }
    }
    
    return null;
  }
  
  getSupportedExtensions(): string[] {
    const extensions = new Set<string>();
    for (const adapter of this.adapters.values()) {
      adapter.extensions.forEach(ext => extensions.add(ext));
    }
    return Array.from(extensions);
  }
  
  private getFileExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf('.');
    return lastDot === -1 ? '' : filePath.substring(lastDot);
  }
}