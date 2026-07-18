/**
 * Component Responsibility Detection Utilities
 * Detects and categorizes responsibilities within React components
 */

import type { ASTNode } from '../languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { walkAST, getLineAndColumn } from '../languages/adapterBridge.js';
import {
  ComponentResponsibility,
  ResponsibilityType,
  ComponentMetadata,
  HookUsage
} from '../types.js';
import { extractHooks } from './reactDetection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get raw text from a tree-sitter node (stored on ASTNode.raw). */
function rawText(node: ASTNode): string {
  return (node.raw as TreeSitterNode)?.text ?? '';
}

// ---------------------------------------------------------------------------
// Main detection entry point
// ---------------------------------------------------------------------------

/**
 * Detects and categorizes responsibilities within a React component
 */
export function detectComponentResponsibilities(
  component: ASTNode,
  metadata?: ComponentMetadata
): ComponentResponsibility[] {
  const responsibilities: ComponentResponsibility[] = [];
  const seenTypes = new Set<ResponsibilityType>();

  // Analyze different aspects of the component
  const hookResponsibilities = analyzeHookUsage(component, metadata);
  const eventResponsibilities = analyzeEventHandlers(component);
  const effectResponsibilities = analyzeEffects(component);
  const renderingResponsibilities = analyzeRenderingLogic(component);

  // Combine and deduplicate responsibilities
  [...hookResponsibilities, ...eventResponsibilities, ...effectResponsibilities, ...renderingResponsibilities]
    .forEach(resp => {
      // Check if this is a duplicate type
      if (seenTypes.has(resp.type)) {
        // Merge indicators if same type
        const existing = responsibilities.find(r => r.type === resp.type);
        if (existing) {
          existing.indicators.push(...resp.indicators);
          // Upgrade severity if needed
          if (resp.severity === 'unrelated' && existing.severity !== 'unrelated') {
            existing.severity = 'unrelated';
          }
        }
      } else {
        seenTypes.add(resp.type);
        responsibilities.push(resp);
      }
    });

  return responsibilities;
}

// ---------------------------------------------------------------------------
// Pattern detection helpers
// ---------------------------------------------------------------------------

/**
 * Identifies data fetching patterns in code
 */
export function containsDataFetching(node: ASTNode): boolean {
  let hasDataFetching = false;

  walkAST(node, (n) => {
    // Check for fetch, axios, API calls
    if (n.type === 'call_expression') {
      const exprNode = n.children?.[0]; // identifier or member_expression
      if (exprNode) {
        const callText = rawText(exprNode);
        if (callText.includes('fetch') ||
            callText.includes('axios') ||
            callText.includes('api') ||
            callText.includes('http') ||
            callText.includes('request')) {
          hasDataFetching = true;
        }
      }
    }

    // Check for async/await patterns
    if (n.type === 'await_expression') {
      hasDataFetching = true;
    }
  });

  return hasDataFetching;
}

/**
 * Identifies form handling patterns
 */
export function containsFormHandling(node: ASTNode): boolean {
  let hasFormHandling = false;

  walkAST(node, (n) => {
    // Check for form-related method calls
    if (n.type === 'call_expression') {
      const exprNode = n.children?.[0];
      if (exprNode) {
        const callText = rawText(exprNode);
        if (callText.includes('preventDefault') ||
            callText.includes('handleSubmit') ||
            callText.includes('validate') ||
            callText.includes('setFieldValue')) {
          hasFormHandling = true;
        }
      }
    }

    // Check for form state patterns in identifiers
    if (n.type === 'identifier') {
      const text = rawText(n);
      if (text.includes('form') || text.includes('Field') || text.includes('input')) {
        hasFormHandling = true;
      }
    }
  });

  return hasFormHandling;
}

/**
 * Identifies business logic patterns
 */
export function containsBusinessLogic(node: ASTNode): boolean {
  let hasBusinessLogic = false;
  let statementCount = 0;
  let hasComplexConditions = false;

  walkAST(node, (n) => {
    // Count statements in blocks
    if (n.type === 'statement_block') {
      statementCount += (n.children ?? []).length;
    }

    // Check for complex conditions
    if (n.type === 'if_statement' || n.type === 'ternary_expression') {
      const conditionText = rawText(n);
      if (conditionText.includes('&&') && conditionText.includes('||')) {
        hasComplexConditions = true;
      }
    }

    // Check for calculations or transformations (binary expressions)
    if (n.type === 'binary_expression') {
      // Check operator token in raw tree-sitter children
      const raw = n.raw as TreeSitterNode;
      const opChild = raw?.children?.find(c => !c.isNamed);
      if (opChild && (opChild.type === '*' || opChild.type === '/' || opChild.type === '%')) {
        hasBusinessLogic = true;
      }
    }

    // Check for array operations suggesting data transformation
    if (n.type === 'call_expression') {
      const exprNode = n.children?.[0];
      if (exprNode && exprNode.type === 'member_expression') {
        // Property of member expression is the last child
        const propNode = exprNode.children?.[exprNode.children.length - 1];
        if (propNode) {
          const methodName = rawText(propNode);
          if (['map', 'filter', 'reduce', 'sort', 'groupBy'].includes(methodName)) {
            hasBusinessLogic = true;
          }
        }
      }
    }
  });

  // Consider it business logic if there are complex conditions or many statements
  return hasBusinessLogic || (statementCount > 10 && hasComplexConditions);
}

/**
 * Helper to determine if responsibilities are related
 */
export function areResponsibilitiesRelated(
  resp1: ResponsibilityType,
  resp2: ResponsibilityType
): boolean {
  // Same responsibility is always related
  if (resp1 === resp2) return true;

  const relatedGroups: ResponsibilityType[][] = [
    // Form-related
    [ResponsibilityType.FormHandling, ResponsibilityType.UIState, ResponsibilityType.EventHandling, ResponsibilityType.ErrorHandling],
    // Data-related
    [ResponsibilityType.DataFetching, ResponsibilityType.DataTransformation, ResponsibilityType.Subscriptions, ResponsibilityType.ErrorHandling],
    // Auth-related
    [ResponsibilityType.Authentication, ResponsibilityType.Routing, ResponsibilityType.ErrorHandling],
    // UI-related (including filter components that manage URL state)
    [ResponsibilityType.UIState, ResponsibilityType.Layout, ResponsibilityType.EventHandling, ResponsibilityType.Routing],
    // Business logic often relates to data
    [ResponsibilityType.BusinessLogic, ResponsibilityType.DataTransformation, ResponsibilityType.UIState],
    // Filter components: URL state + UI rendering is a common pattern
    [ResponsibilityType.Routing, ResponsibilityType.FormHandling, ResponsibilityType.UIState],
  ];

  return relatedGroups.some(group =>
    group.includes(resp1) && group.includes(resp2)
  );
}

// ---------------------------------------------------------------------------
// Sub-analyzers
// ---------------------------------------------------------------------------

/**
 * Analyzes hook usage to identify responsibilities
 */
export function analyzeHookUsage(
  component: ASTNode,
  metadata?: ComponentMetadata
): ComponentResponsibility[] {
  const responsibilities: ComponentResponsibility[] = [];
  const hooks = metadata?.hooks || extractHooks(component);

  // Define hook groups that represent cohesive responsibilities
  const hookGroups = {
    state: {
      hooks: ['useState', 'useReducer', 'useContext'],
      type: ResponsibilityType.StateManagement,
      description: 'Component state management'
    },
    routing: {
      hooks: ['useRouter', 'useNavigate', 'useParams', 'useSearchParams', 'usePathname'],
      type: ResponsibilityType.Routing,
      description: 'Navigation and URL state'
    },
    form: {
      hooks: ['useForm', 'useController', 'useFormState', 'useFieldArray', 'useWatch'],
      type: ResponsibilityType.FormHandling,
      description: 'Form state and validation'
    },
    query: {
      hooks: ['useQuery', 'useMutation', 'useSWR', 'useFetch', 'useInfiniteQuery'],
      type: ResponsibilityType.DataFetching,
      description: 'Data fetching and caching'
    }
  };

  // Track which groups are used and their hooks
  const usedGroups: Map<string, string[]> = new Map();

  // Categorize hooks into groups
  hooks.forEach(hook => {
    for (const [groupName, groupDef] of Object.entries(hookGroups)) {
      if (groupDef.hooks.includes(hook.name)) {
        if (!usedGroups.has(groupName)) {
          usedGroups.set(groupName, []);
        }
        usedGroups.get(groupName)!.push(hook.name);
        return;
      }
    }
  });

  // Create responsibilities for each used group (hooks in same group count as one responsibility)
  for (const [groupName, hookNames] of usedGroups.entries()) {
    const group = hookGroups[groupName as keyof typeof hookGroups];
    if (group) {
      responsibilities.push({
        type: group.type,
        indicators: hookNames,
        severity: 'related',
        details: `${group.description} (${hookNames.length} hook${hookNames.length > 1 ? 's' : ''})`
      });
    }
  }

  const customHooks = hooks.filter(h => h.customHook);

  // Analyze custom hooks for mixed responsibilities
  if (customHooks.length > 0) {
    customHooks.forEach(hook => {
      // Categorize based on hook name
      if (hook.name.match(/useAuth|useUser|usePermission/i)) {
        responsibilities.push({
          type: ResponsibilityType.Authentication,
          indicators: [hook.name],
          severity: 'mixed',
          line: hook.line
        });
      } else if (hook.name.match(/useFetch|useQuery|useApi|useData/i)) {
        responsibilities.push({
          type: ResponsibilityType.DataFetching,
          indicators: [hook.name],
          severity: 'mixed',
          line: hook.line
        });
      }
    });
  }

  return responsibilities;
}

/**
 * Analyzes useEffect hooks for side effects and data fetching
 */
export function analyzeEffects(
  component: ASTNode
): ComponentResponsibility[] {
  const responsibilities: ComponentResponsibility[] = [];

  // Walk children only, not the component node itself (matches old ts.forEachChild behavior)
  for (const child of component.children ?? []) {
    walkAST(child, (node) => {
      if (node.type === 'call_expression') {
        const callee = node.children?.[0];
        if (callee && callee.type === 'identifier') {
          const calleeText = rawText(callee);
          if (calleeText === 'useEffect' || calleeText === 'useLayoutEffect') {
            const argsNode = node.children?.find(c => c.type === 'arguments');
            const argList = argsNode?.children ?? [];
            // First argument is the effect callback
            const effectBody = argList.find(c => c.type !== '(' && c.type !== ')');
            if (effectBody) {
              const effectText = rawText(effectBody);
              const { line } = getLineAndColumn(node);

              // Check for data fetching
              if (containsDataFetching(effectBody)) {
                responsibilities.push({
                  type: ResponsibilityType.DataFetching,
                  indicators: ['fetch in useEffect', 'async data loading'],
                  severity: 'mixed',
                  line,
                  details: 'Data fetching in effect hook'
                });
              }

              // Check for subscriptions
              if (effectText.match(/addEventListener|subscribe|on\(/)) {
                responsibilities.push({
                  type: ResponsibilityType.Subscriptions,
                  indicators: ['event subscription', 'listener setup'],
                  severity: 'mixed',
                  line
                });
              }

              // Check for side effects (analytics, logging)
              if (effectText.match(/track|analytics|log|console|gtag|ga\(/i)) {
                responsibilities.push({
                  type: ResponsibilityType.SideEffects,
                  indicators: ['analytics', 'tracking', 'logging'],
                  severity: 'unrelated',
                  line,
                  details: 'Analytics/logging side effects'
                });
              }
            }
          }
        }
      }
    });
  }

  return responsibilities;
}

/**
 * Analyzes event handlers in a component
 */
export function analyzeEventHandlers(
  component: ASTNode
): ComponentResponsibility[] {
  const responsibilities: ComponentResponsibility[] = [];
  const eventHandlers: { name: string; complexity: number; line: number }[] = [];

  // Walk children only, not the component node itself
  for (const child of component.children ?? []) {
    walkAST(child, (node) => {
      // Check JSX attributes for event handlers
      if (node.type === 'jsx_attribute') {
        const nameNode = node.children?.find(c => c.type === 'property_identifier');
        if (nameNode) {
          const attrName = rawText(nameNode);
          if (attrName.startsWith('on')) {
            const { line } = getLineAndColumn(node);

            // Calculate complexity of the handler
            let complexity = 0;
            const initializer = node.children?.find(c => c.type === 'jsx_expression');
            if (initializer) {
              // The expression inside jsx_expression (skip `{` and `}`)
              const expr = initializer.children?.find(c => c.type !== '{' && c.type !== '}');
              if (expr && (expr.type === 'arrow_function' || expr.type === 'function_expression')) {
                complexity = calculateHandlerComplexity(expr);
              }
            }

            eventHandlers.push({
              name: attrName,
              complexity,
              line
            });
          }
        }
      }

      // Check for method definitions that look like event handlers
      if (node.type === 'method_definition' || node.type === 'public_field_definition') {
        const nameNode = node.children?.find(c => c.type === 'identifier' || c.type === 'property_identifier');
        if (nameNode) {
          const name = rawText(nameNode);
          if (name.match(/^(handle|on)[A-Z]/)) {
            const { line } = getLineAndColumn(node);
            const complexity = node.type === 'method_definition'
              ? calculateHandlerComplexity(node)
              : 0;

            eventHandlers.push({ name, complexity, line });
          }
        }
      }
    });
  }

  // Analyze the collected event handlers
  if (eventHandlers.length > 0) {
    // Check for complex business logic in handlers
    const complexHandlers = eventHandlers.filter(h => h.complexity > 10);
    if (complexHandlers.length > 0) {
      responsibilities.push({
        type: ResponsibilityType.BusinessLogic,
        indicators: complexHandlers.map(h => `${h.name} (${h.complexity} lines)`),
        severity: 'unrelated',
        line: complexHandlers[0].line,
        details: 'Complex business logic in event handlers'
      });
    }

    // Check for mixed event handling concerns
    const handlerTypes = new Set<string>();
    eventHandlers.forEach(h => {
      if (h.name.match(/submit|form/i)) handlerTypes.add('form');
      if (h.name.match(/click|mouse|touch/i)) handlerTypes.add('ui');
      if (h.name.match(/scroll|resize|load/i)) handlerTypes.add('browser');
      if (h.name.match(/key|input|change/i)) handlerTypes.add('input');
    });

    if (handlerTypes.size > 2 || eventHandlers.length > 7) {
      responsibilities.push({
        type: ResponsibilityType.EventHandling,
        indicators: eventHandlers.map(h => h.name),
        severity: handlerTypes.has('form') ? 'mixed' : 'unrelated',
        details: `${eventHandlers.length} event handlers across ${handlerTypes.size} categories`
      });
    }
  }

  return responsibilities;
}

/**
 * Calculates the complexity of an event handler
 */
function calculateHandlerComplexity(node: ASTNode): number {
  let lineCount = 0;

  // Use location for line span calculation
  if (node.location?.start && node.location?.end) {
    lineCount = node.location.end.line - node.location.start.line + 1;
  }

  // Also check for complexity indicators
  const hasBusinessLogic = containsBusinessLogic(node);

  return hasBusinessLogic ? lineCount * 1.5 : lineCount;
}

/**
 * Analyzes rendering logic and JSX complexity
 */
export function analyzeRenderingLogic(
  component: ASTNode
): ComponentResponsibility[] {
  const responsibilities: ComponentResponsibility[] = [];
  let jsxElementCount = 0;
  let conditionalRenderCount = 0;
  let hasComplexStyling = false;
  let hasLayoutLogic = false;

  // Walk children only, not the component node itself
  for (const child of component.children ?? []) {
    walkAST(child, (node) => {
      // Count JSX elements
      if (node.type === 'jsx_element') {
        jsxElementCount++;

        // Check for layout components — find tag name from open_tag child
        const openTag = node.children?.find(c => c.type === 'open_tag');
        if (openTag) {
          const tagNode = openTag.children?.find(c =>
            c.type === 'identifier' || c.type === 'member_expression');
          if (tagNode) {
            const tagName = rawText(tagNode);
            if (tagName.match(/Grid|Flex|Layout|Container|Row|Col/i)) {
              hasLayoutLogic = true;
            }
          }
        }
      }

      if (node.type === 'jsx_self_closing_element') {
        jsxElementCount++;

        // Check tag name (first named child that's not `<`)
        const tagNode = node.children?.find(c =>
          c.type === 'identifier' || c.type === 'member_expression');
        if (tagNode) {
          const tagName = rawText(tagNode);
          if (tagName.match(/Grid|Flex|Layout|Container|Row|Col/i)) {
            hasLayoutLogic = true;
          }
        }
      }

      // Check for conditional rendering (ternary in JSX expression or return statement)
      if (node.type === 'ternary_expression' && node.parent) {
        const parentType = node.parent.type;
        if (parentType === 'jsx_expression' || parentType === 'return_statement') {
          conditionalRenderCount++;
        }
      }

      // Check for complex styling logic
      if (node.type === 'jsx_attribute') {
        const nameNode = node.children?.find(c => c.type === 'property_identifier');
        if (nameNode) {
          const attrName = rawText(nameNode);

          if (attrName === 'style') {
            const jsxExpr = node.children?.find(c => c.type === 'jsx_expression');
            if (jsxExpr) {
              const styleExpr = jsxExpr.children?.find(c => c.type !== '{' && c.type !== '}');
              if (styleExpr && styleExpr.type !== 'object') {
                // Dynamic style calculation
                hasComplexStyling = true;
              }
            }
          }

          if (attrName === 'className') {
            const jsxExpr = node.children?.find(c => c.type === 'jsx_expression');
            if (jsxExpr) {
              const classExpr = jsxExpr.children?.find(c => c.type !== '{' && c.type !== '}');
              if (classExpr && classExpr.type !== 'string') {
                // Dynamic className
                hasComplexStyling = true;
              }
            }
          }
        }
      }
    });
  }

  // Add layout responsibility only if it's significant
  // Don't flag basic styling in forms or simple components
  if ((hasLayoutLogic && jsxElementCount > 20) || (hasComplexStyling && !hasLayoutLogic)) {
    responsibilities.push({
      type: ResponsibilityType.Layout,
      indicators: [
        hasLayoutLogic ? 'layout components' : '',
        hasComplexStyling ? 'complex styling logic' : ''
      ].filter(Boolean),
      severity: 'related',
      details: 'Layout and styling logic'
    });
  }

  // Check for overly complex rendering
  if (jsxElementCount > 50 || conditionalRenderCount > 5) {
    responsibilities.push({
      type: ResponsibilityType.UIState,
      indicators: [`${jsxElementCount} JSX elements`, `${conditionalRenderCount} conditionals`],
      severity: 'mixed',
      details: 'Complex rendering logic'
    });
  }

  return responsibilities;
}
