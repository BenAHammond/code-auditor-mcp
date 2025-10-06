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
        parameters: { path: '.', analyzers: ['solid', 'dry'], indexFunctions: true, generateCodeMap: true },
        description: 'Run comprehensive audit to analyze code, index functions, and generate a code map overview'
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
      'Set generateCodeMap: true to get a human-readable overview of your codebase',
      'The code map shows directory structure, function counts, and documentation quality',
      'Functions are automatically indexed for future searches',
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
        parameters: { path: './src', threshold: 80, generateCodeMap: true },
        description: 'Quick health check with code map to understand structure and identify issues'
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
      'Code maps provide a visual overview of the codebase structure',
      'Use the map to understand architecture before diving into details',
      'High complexity functions and poor documentation are flagged in the map',
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

  'understand-codebase': {
    name: 'Understanding Codebase Structure',
    description: 'Getting oriented in a new or unfamiliar codebase',
    steps: [
      {
        order: 1,
        tool: 'audit_health',
        parameters: { path: '.', generateCodeMap: true },
        description: 'Generate a code map to understand overall structure and architecture'
      },
      {
        order: 2,
        tool: 'search_code',
        parameters: { query: 'entity:component' },
        description: 'List all React components to understand UI architecture'
      },
      {
        order: 3,
        tool: 'search_code',
        parameters: { query: 'depends-on:database deps:prisma' },
        description: 'Find data access patterns and database usage'
      },
      {
        order: 4,
        tool: 'search_code',
        parameters: { query: 'file:route file:api' },
        description: 'Locate API endpoints and routing logic'
      }
    ],
    tips: [
      'Code maps show directory structure, complexity, and documentation quality at a glance',
      'Start with the map to understand architectural patterns',
      'Use dependency searches to trace data flow',
      'File path searches help locate specific functionality'
    ]
  },

  'large-audit-handling': {
    name: 'Handling Large Audits',
    description: 'Working with large codebases that generate many violations',
    steps: [
      {
        order: 1,
        tool: 'audit',
        parameters: { path: '.', analyzers: ['solid'], minSeverity: 'warning', limit: 25 },
        description: 'Run initial audit with small page size to check scope'
      },
      {
        order: 2,
        tool: 'audit',
        parameters: { auditId: 'audit_xxx_xxx', offset: 25, limit: 25 },
        description: 'Get next page using the auditId from first response',
        condition: 'When pagination.hasMore is true'
      },
      {
        order: 3,
        tool: 'audit',
        parameters: { path: './src/components', analyzers: ['solid'], limit: 50 },
        description: 'Focus on specific directories to reduce result size',
        condition: 'If you only need to review certain areas'
      }
    ],
    tips: [
      'Use minSeverity:"warning" to filter out info-level suggestions',
      'auditId is included in the pagination response for easy reference',
      'Cached results make paging through violations very fast',
      'Consider auditing subdirectories separately for better focus'
    ]
  },
  
  'analyzer-configuration': {
    name: 'Analyzer Configuration',
    description: 'Configuring analyzer tolerances and managing exceptions',
    steps: [
      {
        order: 1,
        tool: 'get_analyzer_config',
        parameters: {},
        description: 'Check current analyzer configurations'
      },
      {
        order: 2,
        tool: 'set_analyzer_config',
        parameters: { 
          analyzerName: 'solid', 
          config: { 
            maxUnrelatedResponsibilities: 3,
            maxMethodsPerClass: 20,
            contextAwareThresholds: true 
          } 
        },
        description: 'Set custom tolerances for SOLID analyzer',
        condition: 'When default thresholds are too strict for your architecture'
      },
      {
        order: 3,
        tool: 'set_analyzer_config',
        parameters: { 
          analyzerName: 'dry', 
          config: { 
            minLineThreshold: 15,
            similarityThreshold: 0.85 
          } 
        },
        description: 'Adjust DRY analyzer for less strict duplication detection',
        condition: 'When you have legitimate repeated patterns'
      },
      {
        order: 4,
        tool: 'whitelist_detect',
        parameters: { path: '.', autoPopulate: false },
        description: 'Detect framework patterns for whitelisting'
      },
      {
        order: 5,
        tool: 'whitelist_add',
        parameters: { name: 'MyContextProvider', type: 'framework-class' },
        description: 'Add specific exceptions for framework patterns'
      },
      {
        order: 6,
        tool: 'audit',
        parameters: { path: '.', analyzers: ['solid', 'dry'] },
        description: 'Re-run audit with new configurations'
      }
    ],
    tips: [
      'Analyzer configs persist across all audit runs',
      'Use set_analyzer_config once, benefit everywhere',
      'Project-specific configs override global configs',
      'Context-aware thresholds auto-adjust for component patterns',
      'Combine whitelist and config for fine-grained control',
      'Use reset_analyzer_config to revert to defaults'
    ]
  },
  
  'tolerance-configuration': {
    name: 'Tolerance Configuration',
    description: 'Setting up custom tolerances for your project architecture',
    steps: [
      {
        order: 1,
        tool: 'audit',
        parameters: { path: '.', analyzers: ['solid'] },
        description: 'Run initial audit to see what violations you get with defaults'
      },
      {
        order: 2,
        tool: 'get_analyzer_config',
        parameters: { analyzerName: 'solid' },
        description: 'Check current SOLID configuration'
      },
      {
        order: 3,
        tool: 'set_analyzer_config',
        parameters: { 
          analyzerName: 'solid', 
          config: { 
            maxUnrelatedResponsibilities: 4,
            maxMethodsPerClass: 25,
            maxInterfaceMembers: 30,
            contextAwareThresholds: true,
            checkUnrelatedResponsibilities: false,
            patternThresholds: {
              Layout: { maxResponsibilities: 4 },
              Dashboard: { maxResponsibilities: 6 },
              SimpleUI: { maxResponsibilities: 2 }
            }
          } 
        },
        description: 'Relax SOLID thresholds with pattern-specific overrides',
        condition: 'If you have Context Providers or Dashboard components'
      },
      {
        order: 4,
        tool: 'set_analyzer_config',
        parameters: { 
          analyzerName: 'solid',
          projectPath: '/path/to/project',
          config: { maxUnrelatedResponsibilities: 5 } 
        },
        description: 'Set project-specific override for even more tolerance',
        condition: 'For specific projects with unique architecture'
      },
      {
        order: 5,
        tool: 'audit',
        parameters: { path: '.', analyzers: ['solid'] },
        description: 'Re-run audit to see reduced violations'
      }
    ],
    tips: [
      'Start with small adjustments and increase if needed',
      'Use patternThresholds to override multipliers for specific patterns',
      'Set checkUnrelatedResponsibilities: false to disable unrelated groups check',
      'Dashboard components get 2x multiplier by default (unless overridden)',
      'Project configs override global configs',
      'Use get_analyzer_config without params to see all configs'
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
        description: 'Find and clean up unused imports with improved accuracy'
      }
    ],
    tips: [
      'Use dep: to find all usages of an external library',
      'Use calls: to trace function call chains',
      'Use dependents-of: to see what will be affected by changes',
      'Combine with file: to limit scope (e.g., "dep:react file:components")',
      'unused-imports helps reduce bundle size',
      'Improved type detection reduces false positives for type-only imports'
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
      'React components are automatically detected in .tsx/.jsx files',
      'Improved TypeScript support with better type-only import detection',
      'Audit results are paginated - use limit and offset parameters',
      'Cached audit results can be accessed with auditId for fast pagination',
      'Analyzer configs persist - set once, use everywhere',
      'Use set_analyzer_config to adjust tolerances for your architecture'
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
    ],
    'pagination': [
      'Default limit is 50 violations per request (max 100)',
      'Use offset parameter to get subsequent pages',
      'First request returns an auditId in pagination info',
      'Use the auditId for fast access to cached results',
      'Example: audit(limit: 25) → then audit(auditId: "...", offset: 25)',
      'Cached results expire after 24 hours',
      'Set useCache: false to disable result caching'
    ],
    'analyzer-config': [
      'set_analyzer_config persists settings across all audits',
      'Global configs apply to all projects by default',
      'Project-specific configs override global ones',
      'maxUnrelatedResponsibilities controls component complexity',
      'contextAwareThresholds auto-adjusts for patterns (Dashboard, Form, etc)',
      'Use get_analyzer_config to check current settings',
      'reset_analyzer_config reverts to defaults'
    ]
  };
}