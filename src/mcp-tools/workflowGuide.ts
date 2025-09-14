/**
 * Workflow Guide Tool
 * Provides guidance on optimal tool usage patterns and workflows
 */

export interface WorkflowScenario {
  name: string;
  description: string;
  steps: WorkflowStep[];
  tips?: string[];
}

export interface WorkflowStep {
  order: number;
  tool: string;
  parameters?: Record<string, any>;
  description: string;
  condition?: string;
}

export const WORKFLOW_SCENARIOS: Record<string, WorkflowScenario> = {
  'initial-setup': {
    name: 'Initial Project Setup',
    description: 'First time analyzing a codebase',
    steps: [
      {
        order: 1,
        tool: 'audit',
        parameters: { path: '.', analyzers: ['solid', 'dry'], indexFunctions: true },
        description: 'Run comprehensive audit to analyze code and index all functions/components'
      },
      {
        order: 2,
        tool: 'generate_ai_config',
        parameters: { tools: ['cursor', 'claude'] },
        description: 'Set up AI tool configurations for the project',
        condition: 'If you plan to use AI assistants with this project'
      },
      {
        order: 3,
        tool: 'search_code',
        parameters: { query: 'TODO FIXME' },
        description: 'Find any outstanding tasks or issues marked in code'
      }
    ],
    tips: [
      'The initial audit indexes all functions automatically',
      'You can re-run audit on specific directories later',
      'Search operators become available after indexing'
    ]
  },
  
  'react-development': {
    name: 'React Component Analysis',
    description: 'Analyzing React components and finding specific patterns',
    steps: [
      {
        order: 1,
        tool: 'audit',
        parameters: { path: './src/components', analyzers: ['react'], indexFunctions: true },
        description: 'Audit components directory with React analyzer'
      },
      {
        order: 2,
        tool: 'search_code',
        parameters: { query: 'entity:component' },
        description: 'List all React components in the codebase'
      },
      {
        order: 3,
        tool: 'search_code',
        parameters: { query: 'component:functional hook:useState' },
        description: 'Find functional components using state'
      },
      {
        order: 4,
        tool: 'search_code',
        parameters: { query: 'prop:onClick' },
        description: 'Find components accepting onClick handlers'
      }
    ],
    tips: [
      'Use entity:component to find all React components',
      'Combine operators like component:functional hook:useState',
      'Props are automatically extracted from destructured parameters'
    ]
  },
  
  'code-review': {
    name: 'Code Review Preparation',
    description: 'Preparing for or conducting a code review',
    steps: [
      {
        order: 1,
        tool: 'audit_health',
        parameters: { path: './src', threshold: 80 },
        description: 'Quick health check of the code to review'
      },
      {
        order: 2,
        tool: 'audit',
        parameters: { path: './src', analyzers: ['solid', 'dry'], minSeverity: 'warning' },
        description: 'Run detailed audit if health check shows issues',
        condition: 'If health score is below threshold'
      },
      {
        order: 3,
        tool: 'search_code',
        parameters: { query: 'complexity:8-10' },
        description: 'Find high complexity functions that may need refactoring'
      },
      {
        order: 4,
        tool: 'find_definition',
        parameters: { name: 'functionName' },
        description: 'Look up specific function definitions during review'
      }
    ],
    tips: [
      'Start with health check for quick overview',
      'Use complexity search to find code smells',
      'Functions are indexed during audit for fast lookup'
    ]
  },
  
  'find-patterns': {
    name: 'Finding Code Patterns',
    description: 'Searching for specific patterns or implementations',
    steps: [
      {
        order: 1,
        tool: 'sync_index',
        parameters: { mode: 'sync' },
        description: 'Ensure index is up to date',
        condition: 'If you have made recent changes'
      },
      {
        order: 2,
        tool: 'search_code',
        parameters: { query: 'natural language query' },
        description: 'Search using natural language (e.g., "validate user input")'
      },
      {
        order: 3,
        tool: 'search_code',
        parameters: { query: 'lang:typescript file:utils' },
        description: 'Use operators to filter results'
      }
    ],
    tips: [
      'Natural language search uses synonym expansion',
      'Combine text search with operators for precision',
      'Use find_definition for exact function lookup'
    ]
  },
  
  'maintenance': {
    name: 'Codebase Maintenance',
    description: 'Regular maintenance and cleanup tasks',
    steps: [
      {
        order: 1,
        tool: 'audit',
        parameters: { path: '.', analyzers: ['solid', 'dry', 'security'] },
        description: 'Run full audit to identify issues'
      },
      {
        order: 2,
        tool: 'search_code',
        parameters: { query: 'console.log debug' },
        description: 'Find debug statements to remove'
      },
      {
        order: 3,
        tool: 'sync_index',
        parameters: { mode: 'cleanup' },
        description: 'Clean up stale entries from deleted files'
      }
    ],
    tips: [
      'Regular audits help maintain code quality',
      'sync_index cleanup removes entries for deleted files',
      'Search for common antipatterns like console.log'
    ]
  },
  
  'dependency-analysis': {
    name: 'Dependency Analysis',
    description: 'Analyzing dependencies and refactoring impact',
    steps: [
      {
        order: 1,
        tool: 'audit',
        parameters: { path: '.', indexFunctions: true },
        description: 'Ensure functions are indexed with dependency tracking'
      },
      {
        order: 2,
        tool: 'search_code',
        parameters: { query: 'dep:lodash' },
        description: 'Find all functions using a specific dependency',
        condition: 'To see impact of updating/removing a package'
      },
      {
        order: 3,
        tool: 'search_code',
        parameters: { query: 'calls:calculateTotal' },
        description: 'Find all functions that call a specific function',
        condition: 'To understand impact before refactoring'
      },
      {
        order: 4,
        tool: 'search_code',
        parameters: { query: 'dependents-of:authenticate' },
        description: 'Find what depends on a function you want to change'
      },
      {
        order: 5,
        tool: 'search_code',
        parameters: { query: 'unused-imports' },
        description: 'Find and clean up unused imports'
      }
    ],
    tips: [
      'Use dep: to find all usages of an external library',
      'Use calls: to trace function call chains',
      'Use dependents-of: to see what will be affected by changes',
      'Combine with file: to limit scope (e.g., "dep:react file:components")',
      'unused-imports helps reduce bundle size'
    ]
  }
};

export function getWorkflowGuide(scenario?: string): WorkflowScenario | Record<string, WorkflowScenario> {
  if (scenario) {
    const workflow = WORKFLOW_SCENARIOS[scenario];
    if (!workflow) {
      throw new Error(`Unknown workflow scenario: ${scenario}. Available: ${Object.keys(WORKFLOW_SCENARIOS).join(', ')}`);
    }
    return workflow;
  }
  return WORKFLOW_SCENARIOS;
}

export function getWorkflowTips(): Record<string, string[]> {
  return {
    'general': [
      'Always run audit with indexFunctions:true to enable search',
      'Use audit_health for quick checks before detailed analysis',
      'Combine natural language with operators in search queries',
      'React components are automatically detected in .tsx/.jsx files'
    ],
    'search-operators': [
      'entity:component - Find all React components',
      'component:functional|class - Filter by component type',
      'hook:hookName - Find components using specific hooks',
      'prop:propName - Find components with specific props',
      'complexity:5-10 - Filter by complexity range',
      'Combine operators: "Button component:functional hook:useState"'
    ],
    'performance': [
      'Index is built during audit, no separate indexing needed',
      'Use specific paths in audit to analyze only changed code',
      'search_code is fast even on large codebases',
      'find_definition is optimized for exact name lookup'
    ]
  };
}