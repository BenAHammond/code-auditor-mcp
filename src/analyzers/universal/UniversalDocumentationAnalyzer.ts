/**
 * Universal Documentation Analyzer
 * Works across multiple programming languages using the adapter pattern
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../languages/types.js';

/**
 * Configuration for documentation analyzer
 */
export interface DocumentationAnalyzerConfig {
  requireFunctionDocs: boolean;
  requireClassDocs: boolean;
  requireFileDocs: boolean;
  requireParamDocs: boolean;
  requireReturnDocs: boolean;
  minDescriptionLength: number;
  checkExportedOnly: boolean;
  exemptPatterns: string[]; // Regex patterns for files/functions to skip
}

export const DEFAULT_DOCUMENTATION_CONFIG: DocumentationAnalyzerConfig = {
  requireFunctionDocs: true,
  requireClassDocs: true,
  requireFileDocs: true,
  requireParamDocs: true,
  requireReturnDocs: true,
  minDescriptionLength: 10,
  checkExportedOnly: false,
  exemptPatterns: [
    '\\.test\\.',   // files like user.test.ts
    '\\.spec\\.',   // files like user.spec.ts  
    '\\.d\\.ts$',   // TypeScript declaration files
    'mock',         // mock files
    'fixture',      // fixture files
    '__tests__',    // __tests__ directories
    '/tests?/',     // /test/ or /tests/ directories
  ]
};

export class UniversalDocumentationAnalyzer extends UniversalAnalyzer {
  readonly name = 'documentation';
  readonly description = 'Analyzes documentation quality across the codebase';
  readonly category = 'documentation';
  
  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: DocumentationAnalyzerConfig,
    sourceCode: string
  ): Promise<Violation[]> {
    console.log('[DEBUG] UniversalDocumentationAnalyzer.analyzeAST called for:', ast.filePath);
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_DOCUMENTATION_CONFIG, ...config };
    console.log('[DEBUG] Documentation config:', finalConfig);
    
    // Check if file is exempt
    if (this.isExempt(ast.filePath, finalConfig.exemptPatterns)) {
      console.log('[DEBUG] File is exempt from documentation analysis:', ast.filePath);
      return violations;
    }
    
    console.log('[DEBUG] File is NOT exempt, proceeding with analysis:', ast.filePath);
    
    // Check file-level documentation
    if (finalConfig.requireFileDocs) {
      const fileDoc = this.getFileDocumentation(ast, adapter);
      if (!fileDoc || fileDoc.length < finalConfig.minDescriptionLength) {
        violations.push(this.createViolation(
          ast.filePath,
          { line: 1, column: 1 },
          'File lacks proper documentation header',
          'warning',
          'file-documentation'
        ));
      }
    }
    
    // Check function documentation
    if (finalConfig.requireFunctionDocs) {
      const functions = adapter.extractFunctions(ast);
      console.log('[DEBUG] Extracted functions count:', functions.length);
      
      for (const func of functions) {
        // Skip if checking exported only and function is not exported
        if (finalConfig.checkExportedOnly && !func.isExported) {
          continue;
        }
        
        // Skip if function name matches exempt pattern
        if (this.isExempt(func.name, finalConfig.exemptPatterns)) {
          continue;
        }
        
        const doc = func.jsDoc || '';
        
        // Debug logging
        console.log('[DEBUG] Checking function:', {
          name: func.name,
          jsDoc: func.jsDoc,
          docLength: doc.length,
          minLength: finalConfig.minDescriptionLength
        });
        
        // Check if documentation exists and is adequate
        if (!doc || doc.length < finalConfig.minDescriptionLength) {
          violations.push(this.createViolation(
            ast.filePath,
            func.location.start,
            `Function '${func.name}' lacks proper documentation`,
            'warning',
            'function-documentation'
          ));
        } else if (finalConfig.requireParamDocs && func.parameters.length > 0) {
          // Check parameter documentation
          const missingParamDocs = this.checkParameterDocumentation(
            doc,
            func.parameters.map(p => p.name)
          );
          
          for (const param of missingParamDocs) {
            violations.push(this.createViolation(
              ast.filePath,
              func.location.start,
              `Function '${func.name}' missing documentation for parameter '${param}'`,
              'suggestion',
              'parameter-documentation'
            ));
          }
        }
        
        // Check return documentation for non-void functions
        if (finalConfig.requireReturnDocs && 
            func.returnType && 
            func.returnType !== 'void' &&
            !this.hasReturnDocumentation(doc)) {
          violations.push(this.createViolation(
            ast.filePath,
            func.location.start,
            `Function '${func.name}' missing return value documentation`,
            'suggestion',
            'return-documentation'
          ));
        }
      }
    }
    
    // Check class documentation
    if (finalConfig.requireClassDocs) {
      const classes = adapter.extractClasses(ast);
      
      for (const cls of classes) {
        // Skip if checking exported only and class is not exported
        if (finalConfig.checkExportedOnly && !cls.isExported) {
          continue;
        }
        
        // Skip if class name matches exempt pattern
        if (this.isExempt(cls.name, finalConfig.exemptPatterns)) {
          continue;
        }
        
        const doc = cls.jsDoc || '';
        
        if (!doc || doc.length < finalConfig.minDescriptionLength) {
          violations.push(this.createViolation(
            ast.filePath,
            cls.location.start,
            `Class '${cls.name}' lacks proper documentation`,
            'warning',
            'class-documentation'
          ));
        }
        
        // Check method documentation
        if (finalConfig.requireFunctionDocs) {
          for (const method of cls.methods) {
            const methodDoc = method.jsDoc || '';
            
            if (!methodDoc || methodDoc.length < finalConfig.minDescriptionLength) {
              violations.push(this.createViolation(
                ast.filePath,
                method.location.start,
                `Method '${cls.name}.${method.name}' lacks proper documentation`,
                'warning',
                'method-documentation'
              ));
            }
          }
        }
      }
    }
    
    return violations;
  }
  
  /**
   * Check if a name matches any exempt patterns
   */
  private isExempt(name: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
      const regex = new RegExp(pattern, 'i');
      return regex.test(name);
    });
  }
  
  /**
   * Get file-level documentation (usually at the top)
   */
  private getFileDocumentation(ast: AST, adapter: LanguageAdapter): string | null {
    // Look for documentation at the beginning of the file
    const firstChild = ast.root.children?.[0];
    if (firstChild) {
      return adapter.getDocumentation(firstChild);
    }
    return null;
  }
  
  /**
   * Find a node by its location
   */
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
  
  /**
   * Check which parameters are missing documentation
   */
  private checkParameterDocumentation(doc: string, paramNames: string[]): string[] {
    const missingParams: string[] = [];
    
    for (const param of paramNames) {
      // Look for @param tags in various formats
      const paramRegex = new RegExp(`@param\\s+(?:\\{[^}]+\\}\\s+)?${param}\\b`, 'i');
      if (!paramRegex.test(doc)) {
        missingParams.push(param);
      }
    }
    
    return missingParams;
  }
  
  /**
   * Check if documentation contains return value documentation
   */
  private hasReturnDocumentation(doc: string): boolean {
    // Look for @return or @returns tags
    return /@returns?\b/i.test(doc);
  }
}