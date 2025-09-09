/**
 * React Component Detection Utilities
 * Provides AST-based detection of React components and their properties
 */

import * as ts from 'typescript';
import { ComponentMetadata, ComponentImport, HookUsage, PropDefinition } from '../types.js';

/**
 * Check if a node is any type of React component
 */
export function isReactComponent(node: ts.Node): boolean {
  return isFunctionalComponent(node) || isClassComponent(node);
}

/**
 * Check if a node is a functional React component
 */
export function isFunctionalComponent(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return returnsJSX(node);
  }
  
  if (ts.isArrowFunction(node)) {
    return returnsJSX(node);
  }
  
  // Check for variable declarations with arrow functions
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaration && declaration.initializer && ts.isArrowFunction(declaration.initializer)) {
      return returnsJSX(declaration.initializer);
    }
  }
  
  return false;
}

/**
 * Check if a node returns JSX elements
 */
export function returnsJSX(node: ts.Node): boolean {
  let hasJSX = false;
  
  function visit(child: ts.Node): void {
    if (ts.isJsxElement(child) || ts.isJsxFragment(child) || 
        ts.isJsxSelfClosingElement(child)) {
      hasJSX = true;
    }
    
    // Check return statements
    if (ts.isReturnStatement(child) && child.expression) {
      if (ts.isJsxElement(child.expression) || 
          ts.isJsxFragment(child.expression) || 
          ts.isJsxSelfClosingElement(child.expression)) {
        hasJSX = true;
      }
    }
    
    if (!hasJSX) {
      ts.forEachChild(child, visit);
    }
  }
  
  ts.forEachChild(node, visit);
  return hasJSX;
}

/**
 * Check if a node is a class component extending React.Component
 */
export function isClassComponent(node: ts.Node): boolean {
  if (!ts.isClassDeclaration(node)) {
    return false;
  }
  
  // Check if class extends React.Component or React.PureComponent
  if (node.heritageClauses) {
    for (const clause of node.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const type of clause.types) {
          const expression = type.expression;
          
          // Check for React.Component or React.PureComponent
          if (ts.isPropertyAccessExpression(expression)) {
            const obj = expression.expression;
            const prop = expression.name;
            
            if (ts.isIdentifier(obj) && obj.text === 'React' &&
                ts.isIdentifier(prop) && (prop.text === 'Component' || prop.text === 'PureComponent')) {
              return true;
            }
          }
          
          // Check for Component (when imported directly)
          if (ts.isIdentifier(expression) && 
              (expression.text === 'Component' || expression.text === 'PureComponent')) {
            return true;
          }
        }
      }
    }
  }
  
  return false;
}

/**
 * Extract hooks usage from a component node
 */
export function extractHooks(node: ts.Node, sourceFile: ts.SourceFile): HookUsage[] {
  const hooks: HookUsage[] = [];
  
  function visit(child: ts.Node): void {
    if (ts.isCallExpression(child)) {
      const expression = child.expression;
      
      // Check for hook calls (functions starting with 'use')
      if (ts.isIdentifier(expression) && expression.text.startsWith('use')) {
        const line = sourceFile.getLineAndCharacterOfPosition(expression.getStart()).line + 1;
        hooks.push({
          name: expression.text,
          line,
          customHook: !isBuiltInHook(expression.text)
        });
      }
    }
    
    ts.forEachChild(child, visit);
  }
  
  ts.forEachChild(node, visit);
  return hooks;
}

/**
 * Check if a hook name is a built-in React hook
 */
function isBuiltInHook(hookName: string): boolean {
  const builtInHooks = [
    'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
    'useMemo', 'useRef', 'useImperativeHandle', 'useLayoutEffect',
    'useDebugValue', 'useId', 'useDeferredValue', 'useTransition',
    'useSyncExternalStore', 'useInsertionEffect'
  ];
  
  return builtInHooks.includes(hookName);
}

/**
 * Extract prop types from a component (TypeScript interfaces/types)
 */
export function extractPropTypes(node: ts.Node, sourceFile: ts.SourceFile, typeChecker?: ts.TypeChecker): PropDefinition[] {
  const props: PropDefinition[] = [];
  
  // Handle variable declarations with type annotations (e.g., const Button: React.FC<Props>)
  if (ts.isVariableDeclaration(node) && node.type && node.initializer) {
    // Check if it's a React.FC<Props> type
    if (ts.isTypeReferenceNode(node.type) && node.type.typeArguments?.length) {
      const propsType = node.type.typeArguments[0];
      if (ts.isTypeReferenceNode(propsType) && ts.isIdentifier(propsType.typeName)) {
        // This is a reference to a Props interface, but without TypeChecker we can't resolve it
        // Instead, check the function parameters for destructured props
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
          const firstParam = node.initializer.parameters[0];
          if (firstParam && ts.isObjectBindingPattern(firstParam.name)) {
            for (const element of firstParam.name.elements) {
              if (ts.isBindingElement(element) && element.name && ts.isIdentifier(element.name)) {
                props.push({
                  name: element.name.text,
                  type: 'any',
                  required: !element.dotDotDotToken && !element.initializer,
                  hasDefault: !!element.initializer
                });
              }
            }
          }
        }
      }
    }
  }
  
  // For functional components, check the first parameter
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const firstParam = node.parameters[0];
    if (firstParam) {
      // Check if parameter is destructured (common React pattern)
      if (ts.isObjectBindingPattern(firstParam.name)) {
        for (const element of firstParam.name.elements) {
          if (ts.isBindingElement(element) && element.name && ts.isIdentifier(element.name)) {
            props.push({
              name: element.name.text,
              type: 'any', // Without full type resolution
              required: !element.dotDotDotToken && !element.initializer,
              hasDefault: !!element.initializer
            });
          }
        }
      }
      
      // Extract props from type annotation
      if (firstParam.type) {
        if (ts.isTypeLiteralNode(firstParam.type)) {
          extractPropsFromTypeLiteral(firstParam.type, props);
        } else if (ts.isTypeReferenceNode(firstParam.type) && typeChecker) {
          // Handle interface references
          const symbol = typeChecker.getSymbolAtLocation(firstParam.type.typeName);
          if (symbol) {
            const type = typeChecker.getTypeOfSymbolAtLocation(symbol, firstParam.type);
            const propSymbols = type.getProperties();
            
            for (const propSymbol of propSymbols) {
              const propType = typeChecker.getTypeOfSymbolAtLocation(propSymbol, propSymbol.valueDeclaration!);
              props.push({
                name: propSymbol.getName(),
                type: typeChecker.typeToString(propType),
                required: !(propSymbol.flags & ts.SymbolFlags.Optional),
                hasDefault: false // TODO: Detect default props
              });
            }
          }
        }
      }
    }
  }
  
  // For class components, check Props interface/type
  if (ts.isClassDeclaration(node) && node.heritageClauses) {
    // Look for Props type in extends clause (e.g., React.Component<Props>)
    for (const clause of node.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const type of clause.types) {
          if (type.typeArguments && type.typeArguments.length > 0) {
            const propsType = type.typeArguments[0];
            if (ts.isTypeLiteralNode(propsType)) {
              extractPropsFromTypeLiteral(propsType, props);
            }
          }
        }
      }
    }
  }
  
  return props;
}

/**
 * Extract props from a TypeScript type literal
 */
function extractPropsFromTypeLiteral(typeLiteral: ts.TypeLiteralNode, props: PropDefinition[]): void {
  for (const member of typeLiteral.members) {
    if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
      props.push({
        name: member.name.text,
        type: member.type ? member.type.getText() : 'any',
        required: !member.questionToken,
        hasDefault: false
      });
    }
  }
}

/**
 * Extract component imports from a source file
 */
export function extractComponentImports(sourceFile: ts.SourceFile): ComponentImport[] {
  const imports: ComponentImport[] = [];
  
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        const importPath = moduleSpecifier.text;
        
        // Check if it's likely a component import (local files, not node_modules)
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
          const importClause = node.importClause;
          if (importClause) {
            // Default import
            if (importClause.name) {
              const name = importClause.name.text;
              if (isComponentName(name)) {
                imports.push({
                  name,
                  path: importPath,
                  isDefault: true
                });
              }
            }
            
            // Named imports
            if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
              for (const element of importClause.namedBindings.elements) {
                const name = element.name.text;
                if (isComponentName(name)) {
                  imports.push({
                    name,
                    path: importPath,
                    isDefault: false
                  });
                }
              }
            }
          }
        }
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return imports;
}

/**
 * Check if a name follows React component naming convention (PascalCase)
 */
function isComponentName(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

/**
 * Detect the specific type of component (functional, class, memo, forwardRef)
 */
export function detectComponentType(node: ts.Node): ComponentMetadata['componentType'] | null {
  // Check for memo wrapped components
  if (ts.isCallExpression(node)) {
    const expression = node.expression;
    if ((ts.isIdentifier(expression) && expression.text === 'memo') ||
        (ts.isPropertyAccessExpression(expression) && 
         ts.isIdentifier(expression.expression) && expression.expression.text === 'React' &&
         ts.isIdentifier(expression.name) && expression.name.text === 'memo')) {
      return 'memo';
    }
    
    // Check for forwardRef
    if ((ts.isIdentifier(expression) && expression.text === 'forwardRef') ||
        (ts.isPropertyAccessExpression(expression) && 
         ts.isIdentifier(expression.expression) && expression.expression.text === 'React' &&
         ts.isIdentifier(expression.name) && expression.name.text === 'forwardRef')) {
      return 'forwardRef';
    }
  }
  
  if (isClassComponent(node)) {
    return 'class';
  }
  
  if (isFunctionalComponent(node)) {
    return 'functional';
  }
  
  return null;
}

/**
 * Get component name from various declaration patterns
 */
export function getComponentName(node: ts.Node): string {
  // Function declaration
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  
  // Class declaration
  if (ts.isClassDeclaration(node) && node.name) {
    return node.name.text;
  }
  
  // Variable declaration with arrow function or function expression
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name)) {
      return declaration.name.text;
    }
  }
  
  // Variable declaration (direct)
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  
  // For memo/forwardRef wrapped components, try to extract from the argument
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const firstArg = node.arguments[0];
    if (ts.isFunctionExpression(firstArg) && firstArg.name) {
      return firstArg.name.text;
    }
  }
  
  return 'AnonymousComponent';
}