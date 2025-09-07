# Code Auditor MCP Tools Documentation

## Overview

Code Auditor MCP provides a comprehensive suite of tools for code analysis, function indexing, and AI tool configuration management. This document covers all available tools and how to integrate them into your development workflow.

## Table of Contents

1. [Code Analysis Tools](#code-analysis-tools)
2. [Code Index Tools](#code-index-tools)
3. [AI Configuration Tools](#ai-configuration-tools)
4. [Maintenance Tools](#maintenance-tools)
5. [Workflow Integration](#workflow-integration)
6. [Best Practices](#best-practices)

## Code Analysis Tools

### audit_run
Performs comprehensive code analysis on your codebase.

**Parameters:**
- `path` (string, optional): Directory to audit (defaults to current directory)
- `enabledAnalyzers` (array, optional): Analyzers to run ["solid", "dry", "security", "component", "data-access"]
- `minSeverity` (string, optional): Minimum severity to report ["info", "warning", "critical"]

**Example:**
```
audit_run(path: "./src", enabledAnalyzers: ["solid", "dry"], minSeverity: "warning")
```

**Use Case:** Run before code reviews or releases to identify potential issues.

### audit_analyze_file
Analyzes a specific file for code quality issues.

**Parameters:**
- `filePath` (string, required): File to analyze
- `analyzers` (array, optional): Specific analyzers to run

**Example:**
```
audit_analyze_file(filePath: "./src/components/UserProfile.tsx", analyzers: ["solid"])
```

**Use Case:** Quick analysis of files you're currently working on.

### audit_check_health
Quick health check providing key metrics about your codebase.

**Parameters:**
- `path` (string, optional): Directory to check
- `threshold` (number, optional): Health score threshold (0-100)

**Example:**
```
audit_check_health(path: "./src", threshold: 80)
```

**Use Case:** Regular health monitoring, CI/CD integration.

### audit_list_analyzers
Lists all available code analyzers and their capabilities.

**Example:**
```
audit_list_analyzers()
```

**Use Case:** Discover available analysis options.

## Code Index Tools

### index_functions
Indexes functions from TypeScript/JavaScript files for searchability.

**Parameters:**
- `path` (string, required): File or directory to index
- `recursive` (boolean, optional): Recursively index directories
- `fileTypes` (array, optional): File extensions to process

**Example:**
```
index_functions(path: "./src", recursive: true, fileTypes: [".ts", ".tsx"])
```

**Use Case:** Initial indexing of your codebase or adding new directories.

### search_functions
Search indexed functions with advanced query capabilities.

**Parameters:**
- `query` (string, required): Search query
- `filters` (object, optional): Filter criteria
- `limit` (number, optional): Maximum results
- `offset` (number, optional): Pagination offset

**Example:**
```
search_functions(query: "user authentication", filters: { language: "typescript" })
```

**Supported Search Patterns:**
- Natural language: "validate email", "user login"
- CamelCase: Searches "getUserProfile" with "get user"
- Operators: `type:string`, `param:userId`, `lang:typescript`
- Synonyms: "create" also searches "make", "new", "generate"

**Use Case:** Check if functionality exists before implementing new features.

### find_definition
Find the exact definition of a specific function.

**Parameters:**
- `name` (string, required): Function name
- `filePath` (string, optional): File path to narrow search

**Example:**
```
find_definition(name: "validateEmail", filePath: "./src/utils/validation.ts")
```

**Use Case:** Navigate to function definitions, understand implementations.

### register_functions
Manually register functions with metadata.

**Parameters:**
- `functions` (array, required): Array of function metadata
- `overwrite` (boolean, optional): Overwrite existing entries

**Example:**
```
register_functions(functions: [{
  name: "customValidator",
  filePath: "./src/validators.ts",
  purpose: "Validates custom business rules",
  dependencies: ["joi"]
}])
```

**Use Case:** Add metadata for dynamically generated functions or external libraries.

### get_index_stats
Get statistics about the code index.

**Example:**
```
get_index_stats()
```

**Returns:**
- Total functions indexed
- Language breakdown
- Top dependencies
- Files indexed
- Last update time

**Use Case:** Monitor index coverage and health.

### clear_index
Clear all indexed functions.

**Parameters:**
- `confirm` (boolean, optional): Confirmation flag

**Example:**
```
clear_index(confirm: true)
```

**Use Case:** Fresh start or before major refactoring.

## AI Configuration Tools

### generate_ai_configs
Generate configuration files for AI coding assistants.

**Parameters:**
- `tools` (array, required): AI tools ["cursor", "continue", "copilot", "claude", etc.]
- `outputDir` (string, optional): Output directory
- `overwrite` (boolean, optional): Overwrite existing files
- `serverUrl` (string, optional): MCP server URL

**Example:**
```
generate_ai_configs(tools: ["cursor", "claude"], outputDir: "./ai-configs", overwrite: true)
```

**Supported Tools:**
- Cursor
- Continue
- GitHub Copilot
- Claude Desktop
- Zed
- Windsurf
- Cody
- Aider
- Cline
- PearAI

**Use Case:** Ensure AI assistants are properly configured to use your code index.

### list_ai_tools
List all supported AI tools.

**Example:**
```
list_ai_tools()
```

**Use Case:** Discover available AI tool integrations.

### get_ai_tool_info
Get detailed information about a specific AI tool.

**Parameters:**
- `tool` (string, required): Tool name

**Example:**
```
get_ai_tool_info(tool: "cursor")
```

**Returns:**
- Configuration requirements
- Setup instructions
- Sample configuration

**Use Case:** Learn how to configure specific tools.

### validate_ai_config
Validate an AI tool configuration.

**Parameters:**
- `tool` (string, required): Tool name
- `config` (object, required): Configuration to validate

**Example:**
```
validate_ai_config(tool: "cursor", config: { mcpServers: {...} })
```

**Use Case:** Verify configurations before deployment.

## Maintenance Tools

### bulk_cleanup
Remove index entries for deleted files.

**Example:**
```
bulk_cleanup()
```

**Returns:**
- Scanned files count
- Removed entries count
- List of removed files
- Any errors encountered

**Use Case:** Periodic maintenance, after file deletions or moves.

### deep_sync
Deep synchronization of all indexed files.

**Example:**
```
deep_sync()
```

**Returns:**
- Synced files count
- Added functions
- Updated functions
- Removed functions
- Any errors encountered

**Features:**
- Re-scans all indexed files
- Updates function signatures
- Removes stale entries
- Handles renamed functions

**Use Case:** After major refactoring, ensure index accuracy.

## Workflow Integration

### 1. Initial Setup

```bash
# 1. Install and configure
npm install -g code-auditor-mcp

# 2. Index your codebase
index_functions(path: "./src", recursive: true)

# 3. Generate AI configurations
generate_ai_configs(tools: ["cursor", "claude"], outputDir: ".")

# 4. Check code health
audit_check_health(path: "./src")
```

### 2. Daily Development Flow

**Before implementing new features:**
```
# Search for existing implementations
search_functions(query: "user authentication")
search_functions(query: "email validation")
search_functions(query: "data table component")
```

**While coding:**
```
# Analyze current file
audit_analyze_file(filePath: "./src/newFeature.ts")

# Find function definitions
find_definition(name: "validateUserInput")
```

**After changes:**
```
# Sync modified files
deep_sync()

# Run health check
audit_check_health()
```

### 3. Code Review Preparation

```bash
# 1. Full audit
audit_run(enabledAnalyzers: ["solid", "dry", "security"])

# 2. Update index
deep_sync()

# 3. Generate report
audit_check_health(threshold: 85)
```

### 4. Maintenance Schedule

**Daily:**
- Use `search_functions` before implementing new features
- Run `audit_analyze_file` on modified files

**Weekly:**
- Run `bulk_cleanup()` to remove stale entries
- Execute `audit_check_health()` to monitor trends

**Monthly:**
- Perform `deep_sync()` for full synchronization
- Run comprehensive `audit_run()`
- Update AI configurations with `generate_ai_configs()`

## Best Practices

### 1. Search Before You Code

Always search for existing functionality:
```
# Natural language searches
search_functions(query: "validate credit card")
search_functions(query: "send email notification")
search_functions(query: "format date")

# Component searches
search_functions(query: "user profile card")
search_functions(query: "data table")
search_functions(query: "authentication form")
```

### 2. Keep Index Updated

```bash
# After adding new files
index_functions(path: "./src/newFeature", recursive: true)

# After refactoring
deep_sync()

# After deleting files
bulk_cleanup()
```

### 3. Use Filters Effectively

```
# Search by language
search_functions(query: "validate", filters: { language: "typescript" })

# Search by file type
search_functions(query: "render", filters: { fileType: ".tsx" })

# Search with dependencies
search_functions(query: "fetch", filters: { hasAnyDependency: ["axios"] })
```

### 4. Integrate with CI/CD

```yaml
# Example GitHub Actions
- name: Code Audit
  run: |
    audit_run(minSeverity: "warning")
    audit_check_health(threshold: 80)
```

### 5. Monitor Code Health Trends

Track metrics over time:
- Function count growth
- Complexity trends
- Violation patterns
- Dependency usage

### 6. Configure AI Tools Properly

```bash
# Generate configs for all your tools
generate_ai_configs(tools: ["cursor", "claude", "copilot"])

# Validate configurations
validate_ai_config(tool: "cursor", config: {...})
```

## Troubleshooting

### Index Not Finding Functions

1. Ensure files are indexed: `get_index_stats()`
2. Check file types: `index_functions(fileTypes: [".ts", ".tsx", ".js"])`
3. Try different search terms: Use synonyms and partial words

### Search Returns Too Many Results

1. Use more specific queries
2. Apply filters: `filters: { language: "typescript", filePath: "components" }`
3. Use exact function names with `find_definition()`

### Bulk Cleanup Not Working

1. Check file permissions
2. Ensure index is initialized
3. Run `deep_sync()` instead for full refresh

### AI Configurations Not Loading

1. Check file paths in generated configs
2. Ensure MCP server is running
3. Validate config with `validate_ai_config()`

## Advanced Usage

### Custom Search Queries

```
# Type-specific searches
search_functions(query: "type:Promise")
search_functions(query: "param:userId")

# Combined queries
search_functions(query: "async user type:Promise")

# Exclude terms
search_functions(query: "validate -email")
```

### Programmatic Integration

```javascript
// Use in build scripts
const stats = await get_index_stats();
if (stats.totalFunctions < 100) {
  await index_functions({ path: "./src", recursive: true });
}

// Automated cleanup
const cleanup = await bulk_cleanup();
console.log(`Removed ${cleanup.removedCount} stale entries`);
```

### Performance Optimization

1. Index incrementally: Index new files as they're added
2. Use file filters: Only index relevant file types
3. Schedule maintenance: Run cleanup during off-hours
4. Limit search results: Use appropriate limits for large codebases

## Conclusion

The Code Auditor MCP tools provide a comprehensive solution for:
- Preventing duplicate implementations
- Maintaining code quality
- Enabling effective AI-assisted development
- Managing technical debt

By integrating these tools into your daily workflow, you can significantly improve code quality, reduce duplication, and make your codebase more maintainable.