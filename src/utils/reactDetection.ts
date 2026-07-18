/**
 * React Component Detection Utilities
 * Provides AST-based detection of React components and their properties
 *
 * ## Migration: TypeScript Compiler API → tree-sitter
 *
 * ### Capability regressions (documented per Spec 08 plan Step 2.5):
 *
 * | Check                    | TS API approach                     | tree-sitter approach              | Honest outcome |
 * |--------------------------|-------------------------------------|-----------------------------------|----------------|
 * | Prop type from interface | `checker.getTypeAtLocation()`       | Parse type annotation as string   | Recovers for inline types; loses cross-file interface resolution |
 * | `PropTypes.oneOf`        | Type string from checker            | Match call pattern textually      | Full parity — doesn't need checker |
 * | Symbol resolution        | `checker.getSymbolAtLocation()`     | Not possible without checker      | Lost — falls through to parameter destructuring heuristics |
 */

import type { ASTNode } from '../languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { walkAST, findNodes, getNodeText, getLineAndColumn, getNodeName } from '../languages/adapterBridge.js';
import { ComponentMetadata, ComponentImport, HookUsage, PropDefinition } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get raw text from a tree-sitter node (stored on ASTNode.raw). */
function rawText(node: ASTNode): string {
  return (node.raw as TreeSitterNode)?.text ?? '';
}

/** Check if a tree-sitter node type is a function-like declaration. */
function isFunctionType(type: string): boolean {
  return type === 'function_declaration' || type === 'function_expression' || type === 'arrow_function';
}

/** Check if a tree-sitter node type is a JSX node. */
function isJsxType(type: string): boolean {
  return type === 'jsx_element' || type === 'jsx_fragment' || type === 'jsx_self_closing_element';
}

/**
 * Check if a name follows React component naming convention (PascalCase)
 */
function isComponentName(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
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
 * Find the first child of a given type.
 */
function findChildOfType(node: ASTNode, type: string): ASTNode | undefined {
  return node.children?.find(c => c.type === type);
}

/**
 * Find all children of a given type.
 */
function findChildrenOfType(node: ASTNode, type: string): ASTNode[] {
  return node.children?.filter(c => c.type === type) ?? [];
}

// ---------------------------------------------------------------------------
// Component detection
// ---------------------------------------------------------------------------

/**
 * Check if a node is any type of React component
 */
export function isReactComponent(node: ASTNode): boolean {
  return isFunctionalComponent(node) || isClassComponent(node);
}

/**
 * Check if a node is a functional React component
 */
export function isFunctionalComponent(node: ASTNode): boolean {
  if (node.type === 'function_declaration' || node.type === 'function_expression') {
    return returnsJSX(node);
  }

  if (node.type === 'arrow_function') {
    return returnsJSX(node);
  }

  // Check for variable declarations with arrow functions
  // tree-sitter: lexical_declaration / variable_declaration → variable_declarator
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const declarator = findChildOfType(node, 'variable_declarator');
    if (declarator) {
      // Find the value/initializer (non-identifier child)
      const initializer = declarator.children?.find(c => c.type !== 'identifier' && c.type !== 'type_annotation');
      if (initializer && initializer.type === 'arrow_function') {
        return returnsJSX(initializer);
      }
    }
  }

  return false;
}

/**
 * Check if a node returns JSX elements
 */
export function returnsJSX(node: ASTNode): boolean {
  // Check for JSX elements anywhere in the subtree
  const jsxNodes = findNodes(node, n => isJsxType(n.type));
  if (jsxNodes.length > 0) return true;

  // Check for return statements containing JSX
  const returnNodes = findNodes(node, n => n.type === 'return_statement');
  for (const ret of returnNodes) {
    for (const child of ret.children ?? []) {
      if (isJsxType(child.type)) return true;
    }
  }

  return false;
}

/**
 * Check if a node is a class component extending React.Component
 */
export function isClassComponent(node: ASTNode): boolean {
  if (node.type !== 'class_declaration') return false;

  // Check heritage clauses for extends React.Component / PureComponent
  for (const child of node.children ?? []) {
    if (child.type !== 'heritage_clause') continue;

    // Check if this is an 'extends' clause (not 'implements')
    const raw = child.raw as TreeSitterNode;
    if (!raw?.children) continue;
    const isExtends = raw.children.some(c => !c.isNamed && c.type === 'extends');
    if (!isExtends) continue;

    // Check each type in the extends clause
    for (const typeNode of child.children ?? []) {
      if (typeNode.type === 'member_expression') {
        // React.Component or React.PureComponent
        const parts = typeNode.children ?? [];
        if (parts.length >= 2) {
          const obj = parts[0];
          const prop = parts[parts.length - 1];
          if (obj.type === 'identifier' && rawText(obj) === 'React' &&
              prop.type === 'property_identifier' &&
              (rawText(prop) === 'Component' || rawText(prop) === 'PureComponent')) {
            return true;
          }
        }
      }

      if (typeNode.type === 'identifier') {
        const name = rawText(typeNode);
        if (name === 'Component' || name === 'PureComponent') {
          return true;
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Hook extraction
// ---------------------------------------------------------------------------

/**
 * Extract hooks usage from a component node
 */
export function extractHooks(node: ASTNode): HookUsage[] {
  const hooks: HookUsage[] = [];

  // Find all call expressions in the component
  const callExprs = findNodes(node, n => n.type === 'call_expression');

  for (const call of callExprs) {
    // The expression being called is the first child (identifier or member_expression)
    const callee = call.children?.[0];
    if (!callee) continue;

    if (callee.type === 'identifier') {
      const name = rawText(callee);
      if (name.startsWith('use')) {
        const { line } = getLineAndColumn(callee);
        hooks.push({
          name,
          line,
          customHook: !isBuiltInHook(name)
        });
      }
    }
  }

  return hooks;
}

// ---------------------------------------------------------------------------
// Prop type extraction
// ---------------------------------------------------------------------------

/**
 * Extract props from a TypeScript type literal / object_type node.
 */
function extractPropsFromTypeLiteral(typeLiteral: ASTNode): PropDefinition[] {
  const props: PropDefinition[] = [];

  for (const member of typeLiteral.children ?? []) {
    if (member.type !== 'property_signature') continue;

    const nameNode = member.children?.find(c => c.type === 'identifier' || c.type === 'property_identifier');
    if (!nameNode) continue;

    const typeChild = member.children?.find(c => c.type === 'type_annotation');
    const typeStr = typeChild ? getNodeText(typeChild, '') || rawText(typeChild) : 'any';

    // Check for optional marker
    const raw = member.raw as TreeSitterNode;
    const hasQuestion = raw?.children?.some(c => !c.isNamed && c.type === '?') ?? false;

    props.push({
      name: rawText(nameNode),
      type: typeStr,
      required: !hasQuestion,
      hasDefault: false
    });
  }

  return props;
}

/**
 * Extract prop types from a component (TypeScript interfaces/types)
 *
 * NOTE: Cross-file interface resolution via TypeChecker is NOT available
 * with tree-sitter. We recover inline types and parameter destructuring,
 * but type references (e.g. `React.FC<Props>`) without inline definition
 * will fall through to parameter heuristics.
 */
export function extractPropTypes(node: ASTNode): PropDefinition[] {
  const props: PropDefinition[] = [];

  // Handle variable declarations with type annotations (e.g., const Button: React.FC<Props>)
  if (node.type === 'variable_declarator') {
    const typeAnnot = findChildOfType(node, 'type_annotation');
    const initializer = node.children?.find(c => c.type !== 'identifier' && c.type !== 'type_annotation');

    // If there's a type annotation, extract props from destructured parameters
    if (initializer && (initializer.type === 'arrow_function' || initializer.type === 'function_expression')) {
      const params = findChildOfType(initializer, 'formal_parameters');
      if (params) {
        const firstParam = params.children?.[0];
        if (firstParam) {
          // Check for destructured parameter (object pattern)
          if (firstParam.type === 'object_pattern' || firstParam.type === 'object_binding_pattern') {
            for (const element of firstParam.children ?? []) {
              if (element.type !== 'binding_element' && element.type !== 'pair_pattern' &&
                  element.type !== 'shorthand_property_identifier_pattern') continue;

              const nameNode = element.children?.find(c =>
                c.type === 'identifier' || c.type === 'property_identifier');
              if (!nameNode) continue;

              const raw = element.raw as TreeSitterNode;
              const hasRest = raw?.children?.some(c => !c.isNamed && c.type === '...') ?? false;
              const hasDefault = element.children?.some(c => c.type !== 'identifier' && c.type !== 'property_identifier') ?? false;

              props.push({
                name: rawText(nameNode),
                type: 'any',
                required: !hasRest && !hasDefault,
                hasDefault
              });
            }
          }
        }
      }
    }
  }

  // For functional components, check the first parameter
  if (isFunctionType(node.type)) {
    const params = findChildOfType(node, 'formal_parameters');
    if (params) {
      const firstParam = params.children?.[0];
      if (firstParam) {
        // Check if parameter is destructured
        if (firstParam.type === 'object_pattern' || firstParam.type === 'object_binding_pattern') {
          for (const element of firstParam.children ?? []) {
            if (element.type !== 'binding_element' && element.type !== 'shorthand_property_identifier_pattern') continue;

            const nameNode = element.children?.find(c =>
              c.type === 'identifier' || c.type === 'property_identifier');
            if (!nameNode) continue;

            const raw = element.raw as TreeSitterNode;
            const hasRest = raw?.children?.some(c => !c.isNamed && c.type === '...') ?? false;
            const hasDefault = element.children?.some(c => c.type !== 'identifier' && c.type !== 'property_identifier') ?? false;

            props.push({
              name: rawText(nameNode),
              type: 'any',
              required: !hasRest && !hasDefault,
              hasDefault
            });
          }
        }

        // Extract props from type annotation on parameter
        const typeAnnot = findChildOfType(firstParam, 'type_annotation');
        if (typeAnnot && typeAnnot.children?.[0]) {
          const typeNode = typeAnnot.children[0];
          if (typeNode.type === 'object_type' || typeNode.type === 'type_literal') {
            props.push(...extractPropsFromTypeLiteral(typeNode));
          }
          // NOTE: type_reference (interface references) can't be resolved
          // without TypeChecker — this is a known tree-sitter limitation.
        }
      }
    }
  }

  // For class components, check Props in extends clause
  if (node.type === 'class_declaration') {
    for (const child of node.children ?? []) {
      if (child.type !== 'heritage_clause') continue;

      const raw = child.raw as TreeSitterNode;
      const isExtends = raw?.children?.some(c => !c.isNamed && c.type === 'extends') ?? false;
      if (!isExtends) continue;

      for (const typeNode of child.children ?? []) {
        if (typeNode.type === 'generic_type') {
          // React.Component<Props> — type_arguments contain the props type
          const typeArgs = findChildOfType(typeNode, 'type_arguments');
          if (typeArgs?.children) {
            const firstArg = typeArgs.children[0];
            if (firstArg?.type === 'object_type' || firstArg?.type === 'type_literal') {
              props.push(...extractPropsFromTypeLiteral(firstArg));
            }
          }
        }
      }
    }
  }

  return props;
}

// ---------------------------------------------------------------------------
// Component import extraction
// ---------------------------------------------------------------------------

/**
 * Extract component imports from an AST.
 */
export function extractComponentImports(astRoot: ASTNode): ComponentImport[] {
  const imports: ComponentImport[] = [];

  const importNodes = findNodes(astRoot, n => n.type === 'import_statement');

  for (const imp of importNodes) {
    // Find module specifier (string child)
    const moduleNode = findChildOfType(imp, 'string');
    if (!moduleNode) continue;

    const rawSpecifier = rawText(moduleNode);
    const importPath = rawSpecifier.replace(/^["']|["']$/g, '');

    // Only check local imports (not node_modules)
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

    const importClause = findChildOfType(imp, 'import_clause');
    if (!importClause) continue;

    // Default import (identifier child of import_clause)
    for (const child of importClause.children ?? []) {
      if (child.type === 'identifier') {
        const name = rawText(child);
        if (isComponentName(name)) {
          imports.push({ name, path: importPath, isDefault: true });
        }
      }

      // Named imports
      if (child.type === 'named_imports') {
        for (const spec of child.children ?? []) {
          if (spec.type !== 'import_specifier') continue;
          // The last identifier in the specifier is the local name
          const identifiers = spec.children?.filter(c => c.type === 'identifier') ?? [];
          const localName = identifiers[identifiers.length - 1];
          if (localName) {
            const name = rawText(localName);
            if (isComponentName(name)) {
              imports.push({ name, path: importPath, isDefault: false });
            }
          }
        }
      }
    }
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Component type detection
// ---------------------------------------------------------------------------

/**
 * Detect the specific type of component (functional, class, memo, forwardRef)
 */
export function detectComponentType(node: ASTNode): ComponentMetadata['componentType'] | null {
  // Check for call expression wrapping (memo, forwardRef)
  if (node.type === 'call_expression') {
    const callee = node.children?.[0];
    if (callee) {
      if (callee.type === 'identifier') {
        const name = rawText(callee);
        if (name === 'memo') return 'memo';
        if (name === 'forwardRef') return 'forwardRef';
      }

      if (callee.type === 'member_expression') {
        const parts = callee.children ?? [];
        if (parts.length >= 2) {
          const obj = parts[0];
          const prop = parts[parts.length - 1];
          if (obj.type === 'identifier' && rawText(obj) === 'React') {
            const propName = rawText(prop);
            if (propName === 'memo') return 'memo';
            if (propName === 'forwardRef') return 'forwardRef';
          }
        }
      }
    }
  }

  if (isClassComponent(node)) return 'class';
  if (isFunctionalComponent(node)) return 'functional';

  return null;
}

// ---------------------------------------------------------------------------
// Component name extraction
// ---------------------------------------------------------------------------

/**
 * Get component name from various declaration patterns
 */
export function getComponentName(node: ASTNode): string {
  // Function declaration
  if (node.type === 'function_declaration') {
    const nameNode = findChildOfType(node, 'identifier');
    if (nameNode) return rawText(nameNode);
  }

  // Class declaration
  if (node.type === 'class_declaration') {
    const nameNode = findChildOfType(node, 'identifier');
    if (nameNode) return rawText(nameNode);
  }

  // Variable declaration / lexical declaration
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const declarator = findChildOfType(node, 'variable_declarator');
    if (declarator) {
      const nameNode = declarator.children?.find(c => c.type === 'identifier');
      if (nameNode) return rawText(nameNode);
    }
  }

  // Variable declarator (direct)
  if (node.type === 'variable_declarator') {
    const nameNode = node.children?.find(c => c.type === 'identifier');
    if (nameNode) return rawText(nameNode);
  }

  // For memo/forwardRef wrapped components, try to extract from the argument
  if (node.type === 'call_expression') {
    const args = findChildOfType(node, 'arguments');
    if (args?.children) {
      const firstArg = args.children[0];
      if (firstArg?.type === 'function_expression') {
        const nameNode = findChildOfType(firstArg, 'identifier');
        if (nameNode) return rawText(nameNode);
      }
    }
  }

  return 'AnonymousComponent';
}
