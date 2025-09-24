import { 
  ComponentPattern, 
  ResponsibilityType,
  PatternIndicator 
} from '../types.js';
import { areResponsibilitiesRelated } from './componentResponsibility.js';

// Form component pattern
export const FORM_PATTERN: ComponentPattern = {
  name: 'Form',
  indicators: [
    { type: 'name', pattern: /Form|form/i, weight: 1.0 },
    { type: 'path', pattern: /\/forms?\//i, weight: 0.8 },
    { type: 'props', pattern: /onSubmit|initialValues|validation/i, weight: 0.9 },
    { type: 'hooks', pattern: /useForm|useField|useFormik/i, weight: 1.0 },
    { type: 'imports', pattern: /react-hook-form|formik|react-final-form/i, weight: 1.0 }
  ],
  allowedResponsibilities: [
    ResponsibilityType.FormHandling,
    ResponsibilityType.UIState,
    ResponsibilityType.EventHandling,
    ResponsibilityType.DataTransformation,
    ResponsibilityType.ErrorHandling
  ],
  relatedResponsibilities: [
    [ResponsibilityType.FormHandling, ResponsibilityType.UIState],
    [ResponsibilityType.FormHandling, ResponsibilityType.EventHandling]
  ],
  complexityMultiplier: 1.5,
  description: 'Form components are expected to have multiple state hooks and event handlers'
};

// Table/List component pattern
export const TABLE_PATTERN: ComponentPattern = {
  name: 'Table',
  indicators: [
    { type: 'name', pattern: /Table|List|Grid|DataGrid/i, weight: 1.0 },
    { type: 'path', pattern: /\/(tables?|lists?|grids?)\//i, weight: 0.8 },
    { type: 'props', pattern: /columns|rows|data|onSort|onFilter/i, weight: 0.9 },
    { type: 'hooks', pattern: /useTable|usePagination|useSort/i, weight: 1.0 },
    { type: 'imports', pattern: /react-table|ag-grid|material-table/i, weight: 1.0 }
  ],
  allowedResponsibilities: [
    ResponsibilityType.UIState,
    ResponsibilityType.DataTransformation,
    ResponsibilityType.EventHandling,
    ResponsibilityType.Layout
  ],
  relatedResponsibilities: [
    [ResponsibilityType.UIState, ResponsibilityType.DataTransformation],
    [ResponsibilityType.UIState, ResponsibilityType.EventHandling]
  ],
  complexityMultiplier: 1.8,
  description: 'Table components handle sorting, filtering, pagination, and selection'
};

// Dashboard component pattern
export const DASHBOARD_PATTERN: ComponentPattern = {
  name: 'Dashboard',
  indicators: [
    { type: 'name', pattern: /Dashboard|Overview|Analytics|Report/i, weight: 1.0 },
    { type: 'path', pattern: /\/(dashboard|analytics|reports?)\//i, weight: 0.8 },
    { type: 'props', pattern: /metrics|charts|widgets/i, weight: 0.7 }
  ],
  allowedResponsibilities: [
    ResponsibilityType.DataFetching,
    ResponsibilityType.DataTransformation,
    ResponsibilityType.UIState,
    ResponsibilityType.Layout,
    ResponsibilityType.Subscriptions
  ],
  relatedResponsibilities: [
    [ResponsibilityType.DataFetching, ResponsibilityType.DataTransformation],
    [ResponsibilityType.DataFetching, ResponsibilityType.Subscriptions]
  ],
  complexityMultiplier: 2.0,
  description: 'Dashboard components orchestrate multiple data sources and visualizations'
};

// Modal/Dialog component pattern
export const MODAL_PATTERN: ComponentPattern = {
  name: 'Modal',
  indicators: [
    { type: 'name', pattern: /Modal|Dialog|Popup|Drawer|Sheet/i, weight: 1.0 },
    { type: 'path', pattern: /\/(modals?|dialogs?|popups?)\//i, weight: 0.8 },
    { type: 'props', pattern: /open|isOpen|onClose|onDismiss/i, weight: 0.9 }
  ],
  allowedResponsibilities: [
    ResponsibilityType.UIState,
    ResponsibilityType.EventHandling,
    ResponsibilityType.FormHandling,
    ResponsibilityType.Layout
  ],
  relatedResponsibilities: [
    [ResponsibilityType.UIState, ResponsibilityType.EventHandling],
    [ResponsibilityType.FormHandling, ResponsibilityType.UIState]
  ],
  complexityMultiplier: 1.2,
  description: 'Modal components manage open/close state and may contain forms'
};

// Page/Route component pattern
export const PAGE_PATTERN: ComponentPattern = {
  name: 'Page',
  indicators: [
    { type: 'name', pattern: /Page|Route|Screen|View$/i, weight: 1.0 },
    { type: 'path', pattern: /\/(pages?|routes?|screens?|views?)\//i, weight: 0.9 },
    { type: 'imports', pattern: /next\/router|react-router|reach-router/i, weight: 0.8 }
  ],
  allowedResponsibilities: [
    ResponsibilityType.DataFetching,
    ResponsibilityType.Routing,
    ResponsibilityType.Authentication,
    ResponsibilityType.Layout,
    ResponsibilityType.UIState
  ],
  relatedResponsibilities: [
    [ResponsibilityType.DataFetching, ResponsibilityType.Routing],
    [ResponsibilityType.Authentication, ResponsibilityType.Routing]
  ],
  complexityMultiplier: 1.5,
  description: 'Page components can orchestrate data fetching and routing'
};

// Layout component pattern
export const LAYOUT_PATTERN: ComponentPattern = {
  name: 'Layout',
  indicators: [
    { type: 'name', pattern: /Layout|Container|Wrapper|Shell|Frame/i, weight: 1.0 },
    { type: 'path', pattern: /\/(layouts?|containers?|shell)\//i, weight: 0.8 },
    { type: 'props', pattern: /children|header|footer|sidebar/i, weight: 0.7 }
  ],
  allowedResponsibilities: [
    ResponsibilityType.Layout,
    ResponsibilityType.UIState,
    ResponsibilityType.Routing
  ],
  relatedResponsibilities: [
    [ResponsibilityType.Layout, ResponsibilityType.UIState]
  ],
  complexityMultiplier: 1.0,
  description: 'Layout components should focus on structure, not business logic'
};

// Button/Simple UI component pattern
export const SIMPLE_UI_PATTERN: ComponentPattern = {
  name: 'SimpleUI',
  indicators: [
    { type: 'name', pattern: /^(Button|Icon|Badge|Chip|Tag|Label|Avatar)$/i, weight: 1.0 },
    { type: 'path', pattern: /\/(ui|components?|atoms)\//i, weight: 0.6 }
  ],
  allowedResponsibilities: [
    ResponsibilityType.UIState,
    ResponsibilityType.EventHandling,
    ResponsibilityType.Layout
  ],
  relatedResponsibilities: [
    [ResponsibilityType.UIState, ResponsibilityType.EventHandling]
  ],
  complexityMultiplier: 0.5,
  description: 'Simple UI components should have minimal responsibilities'
};

// Default patterns collection
export const DEFAULT_PATTERNS: ComponentPattern[] = [
  FORM_PATTERN,
  TABLE_PATTERN,
  DASHBOARD_PATTERN,
  MODAL_PATTERN,
  PAGE_PATTERN,
  LAYOUT_PATTERN,
  SIMPLE_UI_PATTERN
];

/**
 * Detects which pattern a component matches based on various indicators
 */
export function detectComponentPattern(
  componentName: string,
  filePath: string,
  props: string[] = [],
  hooks: string[] = [],
  imports: string[] = []
): ComponentPattern | undefined {
  let bestMatch: { pattern: ComponentPattern; score: number } | undefined;
  
  for (const pattern of DEFAULT_PATTERNS) {
    let score = 0;
    let matchedIndicators = 0;
    
    for (const indicator of pattern.indicators) {
      let matches = false;
      
      switch (indicator.type) {
        case 'name':
          if (typeof indicator.pattern === 'string') {
            matches = componentName.includes(indicator.pattern);
          } else {
            matches = indicator.pattern.test(componentName);
          }
          break;
          
        case 'path':
          if (typeof indicator.pattern === 'string') {
            matches = filePath.includes(indicator.pattern);
          } else {
            matches = indicator.pattern.test(filePath);
          }
          break;
          
        case 'props':
          matches = props.some(prop => {
            if (typeof indicator.pattern === 'string') {
              return prop.includes(indicator.pattern);
            } else {
              return indicator.pattern.test(prop);
            }
          });
          break;
          
        case 'hooks':
          matches = hooks.some(hook => {
            if (typeof indicator.pattern === 'string') {
              return hook.includes(indicator.pattern);
            } else {
              return indicator.pattern.test(hook);
            }
          });
          break;
          
        case 'imports':
          matches = imports.some(imp => {
            if (typeof indicator.pattern === 'string') {
              return imp.includes(indicator.pattern);
            } else {
              return indicator.pattern.test(imp);
            }
          });
          break;
      }
      
      if (matches) {
        matchedIndicators++;
        score += indicator.weight || 1.0;
      }
    }
    
    // Require at least one indicator match and better score than previous best
    if (matchedIndicators > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { pattern, score };
    }
  }
  
  // Return the best matching pattern if score is above threshold
  return bestMatch && bestMatch.score >= 0.5 ? bestMatch.pattern : undefined;
}

/**
 * Checks if a set of responsibilities is allowed for a given pattern
 */
export function areResponsibilitiesAllowedForPattern(
  responsibilities: ResponsibilityType[],
  pattern: ComponentPattern
): boolean {
  return responsibilities.every(resp => 
    pattern.allowedResponsibilities.includes(resp)
  );
}

/**
 * Gets unrelated responsibilities for a pattern
 */
export function getUnrelatedResponsibilities(
  responsibilities: ResponsibilityType[],
  pattern: ComponentPattern
): ResponsibilityType[][] {
  const unrelatedGroups: ResponsibilityType[][] = [];
  const disallowedResponsibilities: ResponsibilityType[] = [];
  
  // First, collect all disallowed responsibilities
  for (const resp of responsibilities) {
    if (!pattern.allowedResponsibilities.includes(resp)) {
      disallowedResponsibilities.push(resp);
    }
  }
  
  // Only create a group if there are multiple disallowed responsibilities
  if (disallowedResponsibilities.length >= 2) {
    unrelatedGroups.push(disallowedResponsibilities);
  }
  
  // Check allowed responsibilities for unrelated pairs
  const allowedInComponent = responsibilities.filter(r => 
    pattern.allowedResponsibilities.includes(r)
  );
  
  for (let i = 0; i < allowedInComponent.length; i++) {
    for (let j = i + 1; j < allowedInComponent.length; j++) {
      const resp1 = allowedInComponent[i];
      const resp2 = allowedInComponent[j];
      
      // Check if they're in a related group for this pattern
      const areRelatedInPattern = pattern.relatedResponsibilities?.some(group =>
        group.includes(resp1) && group.includes(resp2)
      ) || false;
      
      // Also check general relationship rules
      const areGenerallyRelated = areResponsibilitiesRelated(resp1, resp2);
      
      if (!areRelatedInPattern && !areGenerallyRelated) {
        // These form an unrelated pair
        unrelatedGroups.push([resp1, resp2]);
      }
    }
  }
  
  return unrelatedGroups;
}