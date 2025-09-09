/**
 * React Component Analyzer
 * Analyzes React components for best practices, performance issues, and common violations
 */

import * as ts from 'typescript';
import { 
  AnalyzerDefinition, 
  AnalyzerResult, 
  ReactViolation,
  ReactAnalyzerConfig,
  ComponentMetadata,
  ComponentScanResult
} from '../types.js';
import { processFiles } from './analyzerUtils.js';
import { scanFiles, buildComponentTree } from '../componentScanner.js';

/**
 * Default configuration for React analyzer
 */
export const DEFAULT_REACT_CONFIG: ReactAnalyzerConfig = {
  // Component Detection
  detectFunctionalComponents: true,
  detectClassComponents: true,
  detectMemoComponents: true,
  
  // Quality Checks
  requirePropTypes: false, // TypeScript provides type safety
  requireErrorBoundaries: true,
  checkHooksRules: true,
  maxComponentComplexity: 10,
  
  // Performance
  checkUnnecessaryRerenders: true,
  requireMemoization: false, // Only suggest, don't require
  
  // Best Practices
  checkAccessibility: true,
  preventDirectDOMAccess: true,
  requireKeyProps: true
};

/**
 * React analyzer definition
 */
export const reactAnalyzer: AnalyzerDefinition = {
  name: 'react',
  defaultConfig: DEFAULT_REACT_CONFIG,
  analyze: async (files, config, options, progressCallback) => {
    const startTime = Date.now();
    const violations: ReactViolation[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    
    try {
      // Filter for React component files
      const reactFiles = files.filter(file => 
        file.endsWith('.tsx') || file.endsWith('.jsx') || 
        (file.endsWith('.ts') || file.endsWith('.js'))
      );
      
      if (reactFiles.length === 0) {
        return {
          violations: [],
          filesProcessed: 0,
          executionTime: Date.now() - startTime,
          analyzerName: 'react'
        };
      }
      
      // Phase 1: Component scanning
      if (progressCallback) {
        progressCallback({
          current: 0,
          total: reactFiles.length,
          analyzer: 'react',
          phase: 'scanning'
        });
      }
      
      const scanResults = await scanFiles(reactFiles, {
        includeTests: false,
        includeStories: false,
        extractProps: true,
        extractHooks: config.checkHooksRules,
        extractImports: true,
        detectComplexity: true
      }, (current, total) => {
        if (progressCallback) {
          progressCallback({
            current,
            total,
            analyzer: 'react',
            phase: 'scanning'
          });
        }
      });
      
      // Phase 2: Component analysis
      let componentsAnalyzed = 0;
      const totalComponents = scanResults.reduce((sum, r) => sum + r.components.length, 0);
      
      for (const scanResult of scanResults) {
        // Check for scan errors
        if (scanResult.parseErrors) {
          errors.push({
            file: scanResult.filePath,
            error: scanResult.parseErrors.join(', ')
          });
          continue;
        }
        
        // Analyze each component
        for (const component of scanResult.components) {
          if (progressCallback) {
            progressCallback({
              current: ++componentsAnalyzed,
              total: totalComponents,
              analyzer: 'react',
              phase: 'analyzing',
              file: scanResult.filePath
            });
          }
          
          // Run all checks
          violations.push(...analyzeComponent(component, config, scanResult));
        }
      }
      
      // Phase 3: Cross-component analysis
      if (progressCallback) {
        progressCallback({
          current: totalComponents,
          total: totalComponents,
          analyzer: 'react',
          phase: 'cross-analysis'
        });
      }
      
      // Build component dependency tree
      const componentTree = buildComponentTree(scanResults);
      
      // Check for circular dependencies
      violations.push(...checkCircularDependencies(componentTree));
      
      // Check for missing error boundaries at app level
      if (config.requireErrorBoundaries) {
        violations.push(...checkErrorBoundaryUsage(scanResults));
      }
      
      return {
        violations,
        filesProcessed: reactFiles.length,
        executionTime: Date.now() - startTime,
        errors: errors.length > 0 ? errors : undefined,
        analyzerName: 'react',
        metadata: {
          totalComponents,
          componentTypes: getComponentTypeStats(scanResults),
          averageComplexity: calculateAverageComplexity(scanResults)
        }
      };
      
    } catch (error) {
      console.error('React analysis failed:', error);
      return {
        violations,
        filesProcessed: files.length,
        executionTime: Date.now() - startTime,
        errors: [{
          file: 'react-analyzer',
          error: error instanceof Error ? error.message : String(error)
        }],
        analyzerName: 'react'
      };
    }
  }
};

/**
 * Analyze a single component for violations
 */
function analyzeComponent(
  component: ComponentMetadata,
  config: ReactAnalyzerConfig,
  scanResult: ComponentScanResult
): ReactViolation[] {
  const violations: ReactViolation[] = [];
  
  // Check component complexity
  if (component.complexity && component.complexity > config.maxComponentComplexity) {
    violations.push({
      file: component.filePath,
      line: component.lineNumber,
      severity: 'warning',
      message: `Component '${component.name}' has high complexity (${component.complexity})`,
      componentName: component.name,
      violationType: 'complexity',
      details: {
        currentComplexity: component.complexity,
        maxComplexity: config.maxComponentComplexity
      },
      suggestion: 'Consider breaking this component into smaller, more focused components'
    });
  }
  
  // Check hooks rules for functional components
  if (config.checkHooksRules && component.hooks && component.hooks.length > 0) {
    violations.push(...checkHooksRules(component));
  }
  
  // Check for missing props validation (TypeScript users might skip this)
  if (config.requirePropTypes && !hasPropsValidation(component)) {
    violations.push({
      file: component.filePath,
      line: component.lineNumber,
      severity: 'warning',
      message: `Component '${component.name}' is missing prop type definitions`,
      componentName: component.name,
      violationType: 'missing-props',
      suggestion: 'Add TypeScript interface or PropTypes for component props'
    });
  }
  
  // Check for missing error boundary in complex components
  if (config.requireErrorBoundaries && shouldHaveErrorBoundary(component)) {
    violations.push({
      file: component.filePath,
      line: component.lineNumber,
      severity: 'warning',
      message: `Complex component '${component.name}' should be wrapped in an error boundary`,
      componentName: component.name,
      violationType: 'no-error-boundary',
      suggestion: 'Wrap this component in an error boundary to handle runtime errors gracefully'
    });
  }
  
  // Check for performance issues
  if (config.checkUnnecessaryRerenders) {
    violations.push(...checkPerformanceIssues(component, config));
  }
  
  // Check for accessibility issues
  if (config.checkAccessibility && component.jsxElements) {
    violations.push(...checkAccessibility(component));
  }
  
  // Check for missing keys in lists
  if (config.requireKeyProps && component.jsxElements) {
    violations.push(...checkMissingKeys(component));
  }
  
  return violations;
}

/**
 * Check React hooks rules
 */
function checkHooksRules(component: ComponentMetadata): ReactViolation[] {
  const violations: ReactViolation[] = [];
  
  if (!component.hooks) return violations;
  
  // Check for hooks called conditionally
  const conditionalHooks = component.hooks.filter(hook => {
    // This is a simplified check - real implementation would need AST analysis
    return hook.line && component.context?.includes('if') && 
           component.context?.includes(hook.name);
  });
  
  for (const hook of conditionalHooks) {
    violations.push({
      file: component.filePath,
      line: hook.line,
      severity: 'critical',
      message: `Hook '${hook.name}' may be called conditionally`,
      componentName: component.name,
      violationType: 'hooks-violation',
      details: {
        hookName: hook.name,
        rule: 'hooks-conditional'
      },
      suggestion: 'Hooks must be called at the top level of the component, not inside conditions or loops'
    });
  }
  
  // Check for custom hooks not starting with 'use'
  const invalidCustomHooks = component.hooks.filter(hook => 
    hook.customHook && !hook.name.startsWith('use')
  );
  
  for (const hook of invalidCustomHooks) {
    violations.push({
      file: component.filePath,
      line: hook.line,
      severity: 'warning',
      message: `Custom hook '${hook.name}' should start with 'use'`,
      componentName: component.name,
      violationType: 'hooks-violation',
      details: {
        hookName: hook.name,
        rule: 'hooks-naming'
      },
      suggestion: `Rename to 'use${hook.name.charAt(0).toUpperCase()}${hook.name.slice(1)}'`
    });
  }
  
  return violations;
}

/**
 * Check if component has props validation
 */
function hasPropsValidation(component: ComponentMetadata): boolean {
  // If TypeScript props are defined, consider it validated
  if (component.props && component.props.length > 0) {
    return true;
  }
  
  // Could also check for PropTypes usage, but TypeScript is preferred
  return false;
}

/**
 * Determine if component should have an error boundary
 */
function shouldHaveErrorBoundary(component: ComponentMetadata): boolean {
  // Complex components or components with async operations should have error boundaries
  return (component.complexity && component.complexity > 7) ||
         (component.hooks && component.hooks.some(h => h.name === 'useEffect'));
}

/**
 * Check for performance issues
 */
function checkPerformanceIssues(
  component: ComponentMetadata,
  config: ReactAnalyzerConfig
): ReactViolation[] {
  const violations: ReactViolation[] = [];
  
  // Check for missing memoization in complex functional components
  if (config.requireMemoization && 
      component.componentType === 'functional' &&
      component.complexity && component.complexity > 5) {
    violations.push({
      file: component.filePath,
      line: component.lineNumber,
      severity: 'suggestion',
      message: `Consider memoizing component '${component.name}' for better performance`,
      componentName: component.name,
      violationType: 'performance',
      details: {
        complexity: component.complexity,
        componentType: component.componentType
      },
      suggestion: `Wrap component with React.memo() or convert to use React.memo`
    });
  }
  
  // Check for inline function props (causes re-renders)
  if (component.jsxElements && component.context?.includes('=>') && 
      component.context?.includes('onClick')) {
    violations.push({
      file: component.filePath,
      line: component.lineNumber,
      severity: 'warning',
      message: `Component '${component.name}' may have inline function props causing unnecessary re-renders`,
      componentName: component.name,
      violationType: 'performance',
      suggestion: 'Use useCallback to memoize event handlers passed as props'
    });
  }
  
  return violations;
}

/**
 * Check for accessibility issues
 */
function checkAccessibility(component: ComponentMetadata): ReactViolation[] {
  const violations: ReactViolation[] = [];
  
  if (!component.jsxElements) return violations;
  
  // Check for img without alt
  if (component.jsxElements.includes('img') && 
      !component.context?.includes('alt=')) {
    violations.push({
      file: component.filePath,
      line: component.lineNumber,
      severity: 'warning',
      message: `Component '${component.name}' may have <img> elements without alt attributes`,
      componentName: component.name,
      violationType: 'accessibility',
      suggestion: 'All <img> elements should have descriptive alt attributes for screen readers'
    });
  }
  
  // Check for click handlers on non-interactive elements
  const nonInteractiveElements = ['div', 'span', 'section'];
  for (const element of nonInteractiveElements) {
    if (component.jsxElements.includes(element) && 
        component.context?.includes(`<${element}`) &&
        component.context?.includes('onClick')) {
      violations.push({
        file: component.filePath,
        line: component.lineNumber,
        severity: 'warning',
        message: `Component '${component.name}' has onClick on non-interactive element <${element}>`,
        componentName: component.name,
        violationType: 'accessibility',
        suggestion: `Use a <button> or add role="button" and tabIndex={0} for keyboard accessibility`
      });
    }
  }
  
  return violations;
}

/**
 * Check for missing keys in list rendering
 */
function checkMissingKeys(component: ComponentMetadata): ReactViolation[] {
  const violations: ReactViolation[] = [];
  
  // Simple heuristic: if component uses .map() and renders JSX, it should use keys
  if (component.context?.includes('.map(') && 
      component.jsxElements && component.jsxElements.length > 0 &&
      !component.context?.includes('key=')) {
    violations.push({
      file: component.filePath,
      line: component.lineNumber,
      severity: 'warning',
      message: `Component '${component.name}' may be rendering lists without keys`,
      componentName: component.name,
      violationType: 'performance',
      suggestion: 'Add a unique key prop to elements rendered in arrays/lists'
    });
  }
  
  return violations;
}

/**
 * Check for circular dependencies between components
 */
function checkCircularDependencies(
  componentTree: Map<string, Set<string>>
): ReactViolation[] {
  const violations: ReactViolation[] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  
  function hasCycle(component: string, path: string[] = []): string[] | null {
    if (recursionStack.has(component)) {
      return path.concat(component);
    }
    
    if (visited.has(component)) {
      return null;
    }
    
    visited.add(component);
    recursionStack.add(component);
    
    const dependencies = componentTree.get(component);
    if (dependencies) {
      for (const dep of dependencies) {
        const cycle = hasCycle(dep, path.concat(component));
        if (cycle) {
          return cycle;
        }
      }
    }
    
    recursionStack.delete(component);
    return null;
  }
  
  // Check each component for cycles
  for (const [component] of componentTree) {
    const cycle = hasCycle(component);
    if (cycle) {
      violations.push({
        file: 'component-dependencies',
        severity: 'critical',
        message: `Circular dependency detected: ${cycle.join(' → ')}`,
        violationType: 'complexity',
        suggestion: 'Refactor components to remove circular dependencies'
      });
      
      // Mark all components in cycle as visited to avoid duplicate reports
      cycle.forEach(c => visited.add(c));
    }
  }
  
  return violations;
}

/**
 * Check for proper error boundary usage
 */
function checkErrorBoundaryUsage(scanResults: ComponentScanResult[]): ReactViolation[] {
  const violations: ReactViolation[] = [];
  
  // Find all components with error boundaries
  const componentsWithErrorBoundary = new Set<string>();
  for (const result of scanResults) {
    for (const component of result.components) {
      if (component.hasErrorBoundary) {
        componentsWithErrorBoundary.add(component.name);
      }
    }
  }
  
  // Check if there's at least one error boundary in the app
  if (componentsWithErrorBoundary.size === 0) {
    const totalComponents = scanResults.reduce((sum, r) => sum + r.components.length, 0);
    
    if (totalComponents > 10) { // Only warn for apps with significant components
      violations.push({
        file: 'app-level',
        severity: 'warning',
        message: 'No error boundaries found in the application',
        violationType: 'no-error-boundary',
        suggestion: 'Add at least one error boundary component to handle unexpected errors gracefully'
      });
    }
  }
  
  return violations;
}

/**
 * Get component type statistics
 */
function getComponentTypeStats(scanResults: ComponentScanResult[]): Record<string, number> {
  const stats: Record<string, number> = {
    functional: 0,
    class: 0,
    memo: 0,
    forwardRef: 0
  };
  
  for (const result of scanResults) {
    for (const component of result.components) {
      stats[component.componentType]++;
    }
  }
  
  return stats;
}

/**
 * Calculate average component complexity
 */
function calculateAverageComplexity(scanResults: ComponentScanResult[]): number {
  let totalComplexity = 0;
  let componentCount = 0;
  
  for (const result of scanResults) {
    for (const component of result.components) {
      if (component.complexity) {
        totalComplexity += component.complexity;
        componentCount++;
      }
    }
  }
  
  return componentCount > 0 ? Math.round(totalComplexity / componentCount * 10) / 10 : 0;
}