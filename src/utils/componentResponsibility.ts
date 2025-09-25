import * as ts from 'typescript';
import { 
  ComponentResponsibility, 
  ResponsibilityType, 
  ComponentMetadata,
  HookUsage 
} from '../types.js';
import { extractHooks } from './reactDetection.js';

/**
 * Detects and categorizes responsibilities within a React component
 */
export function detectComponentResponsibilities(
  sourceFile: ts.SourceFile,
  component: ts.Node,
  metadata?: ComponentMetadata
): ComponentResponsibility[] {
  const responsibilities: ComponentResponsibility[] = [];
  const seenTypes = new Set<ResponsibilityType>();
  
  // Analyze different aspects of the component
  const hookResponsibilities = analyzeHookUsage(sourceFile, component, metadata);
  const eventResponsibilities = analyzeEventHandlers(sourceFile, component);
  const effectResponsibilities = analyzeEffects(sourceFile, component);
  const renderingResponsibilities = analyzeRenderingLogic(sourceFile, component);
  
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

/**
 * Identifies data fetching patterns in code
 */
export function containsDataFetching(node: ts.Node): boolean {
  let hasDataFetching = false;
  
  const checkNode = (n: ts.Node) => {
    // Check for fetch, axios, API calls
    if (ts.isCallExpression(n)) {
      const callText = n.expression.getText();
      if (callText.includes('fetch') || 
          callText.includes('axios') || 
          callText.includes('api') ||
          callText.includes('http') ||
          callText.includes('request')) {
        hasDataFetching = true;
      }
    }
    
    // Check for async/await patterns
    if (ts.isAwaitExpression(n)) {
      hasDataFetching = true;
    }
    
    ts.forEachChild(n, checkNode);
  };
  
  checkNode(node);
  return hasDataFetching;
}

/**
 * Identifies form handling patterns
 */
export function containsFormHandling(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let hasFormHandling = false;
  
  const checkNode = (n: ts.Node) => {
    // Check for form-related method calls
    if (ts.isCallExpression(n)) {
      const callText = n.expression.getText();
      if (callText.includes('preventDefault') || 
          callText.includes('handleSubmit') ||
          callText.includes('validate') ||
          callText.includes('setFieldValue')) {
        hasFormHandling = true;
      }
    }
    
    // Check for form state patterns
    if (ts.isIdentifier(n)) {
      const text = n.getText();
      if (text.includes('form') || text.includes('Field') || text.includes('input')) {
        hasFormHandling = true;
      }
    }
    
    ts.forEachChild(n, checkNode);
  };
  
  checkNode(node);
  return hasFormHandling;
}

/**
 * Identifies business logic patterns
 */
export function containsBusinessLogic(node: ts.Node): boolean {
  let hasBusinessLogic = false;
  let statementCount = 0;
  let hasComplexConditions = false;
  
  const checkNode = (n: ts.Node) => {
    // Count statements in functions
    if (ts.isBlock(n)) {
      statementCount += n.statements.length;
    }
    
    // Check for complex conditions
    if (ts.isIfStatement(n) || ts.isConditionalExpression(n)) {
      // Check if condition is complex
      const conditionText = n.getFullText();
      if (conditionText.includes('&&') && conditionText.includes('||')) {
        hasComplexConditions = true;
      }
    }
    
    // Check for calculations or transformations
    if (ts.isBinaryExpression(n)) {
      const operator = n.operatorToken.kind;
      if (operator === ts.SyntaxKind.AsteriskToken || 
          operator === ts.SyntaxKind.SlashToken ||
          operator === ts.SyntaxKind.PercentToken) {
        hasBusinessLogic = true;
      }
    }
    
    // Check for array operations suggesting data transformation
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const methodName = n.expression.name.getText();
      if (['map', 'filter', 'reduce', 'sort', 'groupBy'].includes(methodName)) {
        hasBusinessLogic = true;
      }
    }
    
    ts.forEachChild(n, checkNode);
  };
  
  checkNode(node);
  
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

/**
 * Analyzes hook usage to identify responsibilities
 */
export function analyzeHookUsage(
  sourceFile: ts.SourceFile,
  component: ts.Node,
  metadata?: ComponentMetadata
): ComponentResponsibility[] {
  const responsibilities: ComponentResponsibility[] = [];
  const hooks = metadata?.hooks || extractHooks(component, sourceFile);
  
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
  
  // Group hooks by type for backward compatibility
  const stateHooks = hooks.filter(h => h.name === 'useState' || h.name === 'useReducer');
  const effectHooks = hooks.filter(h => h.name === 'useEffect' || h.name === 'useLayoutEffect');
  const contextHooks = hooks.filter(h => h.name === 'useContext');
  const routerHooks = hooks.filter(h => h.name === 'useRouter' || h.name === 'useNavigate' || h.name === 'useParams' || h.name === 'useSearchParams');
  const customHooks = hooks.filter(h => h.customHook);
  
  // Additional analysis for custom hooks only (standard hooks already handled by groups)
  const uncategorizedHooks = hooks.filter(hook => {
    // Skip if already in a group
    for (const [_, hookNames] of usedGroups.entries()) {
      if (hookNames.includes(hook.name)) return false;
    }
    return true;
  });
  
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
  sourceFile: ts.SourceFile,
  component: ts.Node
): ComponentResponsibility[] {
  const responsibilities: ComponentResponsibility[] = [];
  
  ts.forEachChild(component, function visit(node) {
    if (ts.isCallExpression(node) && 
        ts.isIdentifier(node.expression) && 
        (node.expression.text === 'useEffect' || node.expression.text === 'useLayoutEffect')) {
      
      const effectBody = node.arguments[0];
      if (effectBody) {
        // Check for data fetching
        if (containsDataFetching(effectBody)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          responsibilities.push({
            type: ResponsibilityType.DataFetching,
            indicators: ['fetch in useEffect', 'async data loading'],
            severity: 'mixed',
            line: line + 1,
            details: 'Data fetching in effect hook'
          });
        }
        
        // Check for subscriptions
        if (effectBody.getText().match(/addEventListener|subscribe|on\(/)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          responsibilities.push({
            type: ResponsibilityType.Subscriptions,
            indicators: ['event subscription', 'listener setup'],
            severity: 'mixed',
            line: line + 1
          });
        }
        
        // Check for side effects (analytics, logging)
        if (effectBody.getText().match(/track|analytics|log|console|gtag|ga\(/i)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          responsibilities.push({
            type: ResponsibilityType.SideEffects,
            indicators: ['analytics', 'tracking', 'logging'],
            severity: 'unrelated',
            line: line + 1,
            details: 'Analytics/logging side effects'
          });
        }
      }
    }
    
    ts.forEachChild(node, visit);
  });
  
  return responsibilities;
}

/**
 * Helper to find a node at a specific line number
 */
function findNodeAtLine(root: ts.Node, targetLine: number): ts.Node | null {
  let result: ts.Node | null = null;
  
  function visit(node: ts.Node) {
    if (result) return;
    
    const sourceFile = node.getSourceFile();
    if (sourceFile) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      if (line + 1 === targetLine) {
        result = node;
        return;
      }
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(root);
  return result;
}

/**
 * Analyzes event handlers in a component
 */
export function analyzeEventHandlers(
  sourceFile: ts.SourceFile,
  component: ts.Node
): ComponentResponsibility[] {
  const responsibilities: ComponentResponsibility[] = [];
  const eventHandlers: { name: string; complexity: number; line: number }[] = [];
  
  ts.forEachChild(component, function visit(node) {
    // Check JSX attributes for event handlers
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const attrName = node.name.text;
      if (attrName.startsWith('on')) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        
        // Calculate complexity of the handler
        let complexity = 0;
        if (node.initializer && ts.isJsxExpression(node.initializer)) {
          const expr = node.initializer.expression;
          if (expr) {
            // Inline function or arrow function
            if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
              complexity = calculateHandlerComplexity(expr);
            }
          }
        }
        
        eventHandlers.push({
          name: attrName,
          complexity,
          line: line + 1
        });
      }
    }
    
    // Check for method definitions that look like event handlers
    if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && node.name) {
      const name = node.name.getText();
      if (name.match(/^(handle|on)[A-Z]/)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const complexity = ts.isMethodDeclaration(node) && node.body 
          ? calculateHandlerComplexity(node) 
          : 0;
        
        eventHandlers.push({ name, complexity, line: line + 1 });
      }
    }
    
    ts.forEachChild(node, visit);
  });
  
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
function calculateHandlerComplexity(node: ts.Node): number {
  let lineCount = 0;
  const sourceFile = node.getSourceFile();
  
  if (sourceFile && node.getStart() && node.getEnd()) {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    lineCount = end.line - start.line + 1;
  }
  
  // Also check for complexity indicators
  let hasBusinessLogic = containsBusinessLogic(node);
  
  return hasBusinessLogic ? lineCount * 1.5 : lineCount;
}

/**
 * Analyzes rendering logic and JSX complexity
 */
export function analyzeRenderingLogic(
  sourceFile: ts.SourceFile,
  component: ts.Node
): ComponentResponsibility[] {
  const responsibilities: ComponentResponsibility[] = [];
  let jsxElementCount = 0;
  let conditionalRenderCount = 0;
  let hasComplexStyling = false;
  let hasLayoutLogic = false;
  
  ts.forEachChild(component, function visit(node) {
    // Count JSX elements
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      jsxElementCount++;
      
      // Check for layout components
      const tagName = ts.isJsxElement(node) 
        ? node.openingElement.tagName.getText() 
        : node.tagName.getText();
      
      if (tagName.match(/Grid|Flex|Layout|Container|Row|Col/i)) {
        hasLayoutLogic = true;
      }
    }
    
    // Check for conditional rendering
    if (ts.isConditionalExpression(node) && node.parent && 
        (ts.isJsxExpression(node.parent) || ts.isReturnStatement(node.parent))) {
      conditionalRenderCount++;
    }
    
    // Check for complex styling logic
    if (ts.isJsxAttribute(node) && node.name && node.name.getText() === 'style') {
      if (node.initializer && ts.isJsxExpression(node.initializer)) {
        const styleExpr = node.initializer.expression;
        if (styleExpr && !ts.isObjectLiteralExpression(styleExpr)) {
          // Dynamic style calculation
          hasComplexStyling = true;
        }
      }
    }
    
    // Check for className with complex logic
    if (ts.isJsxAttribute(node) && node.name && node.name.getText() === 'className') {
      if (node.initializer && ts.isJsxExpression(node.initializer)) {
        const classExpr = node.initializer.expression;
        if (classExpr && !ts.isStringLiteral(classExpr)) {
          // Dynamic className
          hasComplexStyling = true;
        }
      }
    }
    
    ts.forEachChild(node, visit);
  });
  
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