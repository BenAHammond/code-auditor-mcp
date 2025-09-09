# Code Auditor MCP Tools Documentation

## Overview

Code Auditor MCP provides 6 tools for code analysis, function discovery, and AI tool configuration. Functions and React components are automatically indexed during audits for seamless code search capabilities.

### Key Features
- **React Support**: Full React component detection, analysis, and search
- **Smart Indexing**: Automatic function and component indexing during audits
- **Natural Language Search**: Query your codebase using plain English
- **Multiple Analyzers**: SOLID, DRY, Security, React, and Data Access analyzers

## Table of Contents

1. [Core Analysis Tools](#core-analysis-tools)
2. [Code Discovery Tools](#code-discovery-tools)
3. [Index Maintenance](#index-maintenance)
4. [AI Configuration](#ai-configuration)
5. [React Development](#react-development)
6. [Workflow Examples](#workflow-examples)
7. [Best Practices](#best-practices)

## Core Analysis Tools

### audit
Performs comprehensive code analysis on files or directories with automatic function indexing.

**Parameters:**
- `path` (string, optional): File or directory to audit (defaults to current directory)
- `analyzers` (array, optional): Analyzers to run ["solid", "dry", "security", "react", "data-access"]
- `minSeverity` (string, optional): Minimum severity to report ["info", "warning", "critical"]
- `indexFunctions` (boolean, optional): Automatically index functions during audit (default: true)

**Example:**
```
audit(path: "./src", analyzers: ["solid", "dry"], minSeverity: "warning")
```

**Returns:**
- Summary of violations by severity
- Detailed violation list
- Function indexing stats (added, updated, removed)
- Health score
- Recommendations

**Use Case:** Regular code quality checks with automatic function discovery. Run before code reviews or releases.

### audit_health
Quick health check providing key metrics and overall code quality assessment.

**Parameters:**
- `path` (string, optional): Directory to check (defaults to current directory)
- `threshold` (number, optional): Health score threshold 0-100 (default: 70)
- `indexFunctions` (boolean, optional): Automatically index functions during check (default: true)

**Example:**
```
audit_health(path: "./src", threshold: 80)
```

**Returns:**
- Health score (0-100)
- Pass/fail status based on threshold
- Key metrics (files analyzed, violations by severity)
- Function indexing stats

**Use Case:** CI/CD pipeline integration, quick health monitoring, pre-commit checks.

## Code Discovery Tools

### search_code
Natural language search across your indexed codebase with intelligent query understanding.

**Parameters:**
- `query` (string, required): Natural language search query
- `filters` (object, optional): Additional filters
  - `language`: Filter by programming language
  - `filePath`: Filter by file path pattern
  - `dependencies`: Filter by dependencies used
- `limit` (number, optional): Maximum results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Example:**
```
# Natural language queries
search_code(query: "validate user input")
search_code(query: "authentication", filters: { language: "typescript" })

# Technical searches
search_code(query: "useState hooks")
search_code(query: "async database operations")

# React-specific searches
search_code(query: "entity:component")  # Find all React components
search_code(query: "component:functional")  # Find functional components
search_code(query: "component:class")  # Find class components
search_code(query: "hook:useState")  # Find components using useState
search_code(query: "prop:onClick")  # Find components with onClick prop

# Advanced operator searches
search_code(query: "Button component:functional hook:useState")
search_code(query: "complexity:5-10 entity:component")
```

**Search Operators:**
- `entity:component` - Filter for React components only
- `component:functional|class|memo|forwardRef` - Filter by component type
- `hook:hookName` - Find components using specific hooks
- `prop:propName` - Find components with specific props
- `type:extension` - Filter by file type
- `file:pattern` - Filter by file path pattern
- `lang:language` - Filter by programming language
- `complexity:n` or `complexity:min-max` - Filter by complexity score
- `jsdoc:true|false` - Filter by JSDoc presence
- `since:date`, `before:date`, `after:date` - Filter by date

**Features:**
- Synonym expansion (e.g., "validate" → "check", "verify", "test")
- Multi-word search support
- Relevance scoring
- Natural language understanding
- Combine operators with natural language

**Use Case:** Find implementation examples, discover similar code patterns, understand codebase structure.

### find_definition
Quickly locate the exact definition of a specific function by name.

**Parameters:**
- `name` (string, required): Function name to find
- `filePath` (string, optional): Narrow search to specific file

**Example:**
```
find_definition(name: "createAuditRunner")
find_definition(name: "validateConfig", filePath: "./src/config")
```

**Returns:**
- Exact function location (file and line number)
- Function metadata (async, exported, parameters)
- Dependencies used
- Purpose and context

**Use Case:** Quick navigation, understanding function signatures, finding implementations.

## Index Maintenance

### sync_index
Manage your code index with three operation modes.

**Parameters:**
- `mode` (string, optional): Operation mode (default: "sync")
  - `"sync"`: Update all indexed functions with current signatures
  - `"cleanup"`: Remove entries for deleted files
  - `"reset"`: Clear entire index
- `path` (string, optional): Specific path to sync (only for sync mode)

**Examples:**
```
# Update all function signatures
sync_index(mode: "sync")

# Clean up deleted files
sync_index(mode: "cleanup")

# Start fresh
sync_index(mode: "reset")

# Sync specific directory
sync_index(mode: "sync", path: "./src/components")
```

**Use Case:** Manual index maintenance, recovering from index corruption.

## AI Configuration

### generate_ai_config
Generate configuration files for AI coding assistants with proper MCP server setup.

**Parameters:**
- `tools` (array, required): List of AI tools to configure
  - Supported: "cursor", "continue", "copilot", "claude", "zed", "windsurf", "cody", "aider", "cline", "pearai"
- `outputDir` (string, optional): Output directory (default: ".")

**Example:**
```
generate_ai_config(tools: ["cursor", "claude", "windsurf"])
```

**Returns:**
- List of generated configuration files
- Success/error status for each tool
- Ready-to-use configuration with MCP server URL

**Use Case:** Quick setup of AI assistants with code auditor integration.

## React Development

### Component Discovery
Find React components using specialized search operators:

```
# Find all React components
search_code(query: "entity:component")

# Find functional components
search_code(query: "component:functional")

# Find components using specific hooks
search_code(query: "hook:useState")
search_code(query: "hook:useEffect hook:useCallback")

# Find components with specific props
search_code(query: "prop:onClick")
search_code(query: "prop:disabled component:functional")

# Complex React searches
search_code(query: "Button component:functional hook:useState")
search_code(query: "entity:component complexity:5-10")
```

### React Analysis
The React analyzer checks for:
- **Hooks Rules**: Conditional hooks, custom hook naming
- **Performance**: Missing memoization, inline function props
- **Accessibility**: Missing alt attributes, click handlers on non-interactive elements
- **Best Practices**: Missing keys in lists, error boundaries
- **Complexity**: Component complexity scoring

```
# Run React-specific analysis
audit(path: "./src/components", analyzers: ["react"], minSeverity: "info")
```

### Component Metadata
Indexed components include:
- Component type (functional, class, memo, forwardRef)
- Props with types and defaults
- Hooks usage with line numbers
- JSX elements used
- Complexity score
- Export status

## Workflow Examples

### 1. Initial Project Setup
```
# 1. Analyze and index entire codebase
audit(path: ".", analyzers: ["solid", "dry", "security"])

# 2. Set up AI tools
generate_ai_config(tools: ["cursor", "claude"])

# 3. Search for specific patterns
search_code(query: "TODO FIXME")
```

### 2. Pre-Commit Workflow
```
# 1. Quick health check
audit_health(threshold: 80)

# 2. If health check fails, run detailed audit
audit(analyzers: ["solid", "dry"], minSeverity: "warning")

# 3. Search for common issues
search_code(query: "console.log debug")
```

### 3. Code Review Preparation
```
# 1. Audit changed files
audit(path: "./src/features/newFeature")

# 2. Find similar implementations
search_code(query: "similar feature pattern")

# 3. Check function definitions
find_definition(name: "mainFunction")
```

### 4. Refactoring Workflow
```
# 1. Find all usages of old pattern
search_code(query: "deprecated method")

# 2. Analyze specific files
audit(path: "./src/oldComponent.ts")

# 3. After refactoring, sync the index
sync_index(mode: "sync")
```

## Best Practices

### 1. Regular Audits with Automatic Indexing
- Run `audit` regularly - it handles both analysis and indexing
- The index stays synchronized with your code automatically
- Function deletions are tracked during audits

### 2. Search Before Implementation
- Use `search_code` to find existing patterns before writing new code
- Promotes code reuse and consistency
- Natural language queries make discovery intuitive

### 3. Health Monitoring
- Set up `audit_health` in CI/CD pipelines
- Use threshold appropriate for your project maturity
- Monitor trends over time

### 4. Index Maintenance
- The index is automatically maintained during audits
- Use `sync_index` only when needed:
  - After major refactoring without audits
  - When you suspect index corruption
  - To clean up after deleting many files

### 5. Incremental Analysis
- Audit specific directories or files during development
- Use `search_code` to understand code before modifying
- Keep feedback loops short with targeted audits

### 6. AI Tool Integration
- Generate configs for all team members' preferred tools
- Share configuration in version control
- Update configs when adding new analysis capabilities

## Available Analyzers

### SOLID Principles Analyzer
Checks adherence to SOLID principles:
- Single Responsibility Principle
- Open/Closed Principle
- Liskov Substitution Principle
- Interface Segregation Principle
- Dependency Inversion Principle

### DRY (Don't Repeat Yourself) Analyzer
Identifies code duplication:
- Exact code duplicates
- Similar code patterns
- Duplicate imports
- Repeated string literals

### Security Analyzer
Verifies security best practices:
- Authentication checks
- Authorization patterns
- SQL injection risks
- Input validation

### Component Analyzer
Analyzes UI components (React, Vue, etc):
- Error boundary usage
- Render method complexity
- Component nesting depth
- Performance patterns

### Data Access Analyzer
Reviews database access patterns:
- N+1 query detection
- Transaction usage
- Direct database access in UI layers
- Query performance patterns

## Troubleshooting

### Index seems outdated
Run an audit on the affected directory:
```
audit(path: "./src/components")
```

### Search not finding expected results
1. Check if functions are indexed: `find_definition(name: "exactFunctionName")`
2. Try broader search terms - the tool expands synonyms automatically
3. Run `audit` on the directory containing the code

### Health score unexpectedly low
Run detailed audit to see specific issues:
```
audit(minSeverity: "info")
```

### AI config not working
1. Ensure MCP server is running
2. Check the generated config file has correct server URL
3. Restart the AI tool after configuration changes