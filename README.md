# Code Auditor

A comprehensive TypeScript/JavaScript code quality audit tool that analyzes your codebase for SOLID principles compliance, DRY violations, security patterns, and more.

## Features

- **SOLID Principles Analysis** - Detect violations of Single Responsibility, Open/Closed, and other SOLID principles
- **DRY (Don't Repeat Yourself)** - Find code duplication and suggest refactoring opportunities
- **Security Pattern Analysis** - Verify authentication, authorization, and rate limiting implementations
- **Component Architecture Review** - Analyze component structure, complexity, and best practices
- **Data Access Patterns** - Check for SQL injection risks, performance issues, and security patterns
- **Code Function Indexing** - Index and search functions across your codebase with intelligent tokenization
- **AI Tool Configuration** - Auto-generate configurations for 10+ AI coding assistants
- **Advanced Search** - Natural language search with synonym expansion and camelCase support
- **Index Maintenance** - Bulk cleanup and deep synchronization tools for accurate indexing
- **Multiple Output Formats** - Generate HTML, JSON, or CSV reports
- **Highly Configurable** - Customize thresholds, patterns, and analysis rules
- **Framework Support** - Built-in support for React, Vue, Angular, Svelte, and Node.js
- **MCP Server Integration** - Use with AI assistants like Claude for interactive code analysis

## Installation

### Global Installation
```bash
npm install -g code-auditor
```

### Local Installation
```bash
npm install --save-dev code-auditor
```

### From Source
```bash
git clone https://github.com/code-auditor/code-auditor.git
cd code-auditor
npm install
npm run build
npm link
```

## Quick Start

### Basic Usage
```bash
# Run with default settings
code-audit

# Generate a sample configuration
code-audit --init

# Use a specific configuration
code-audit -c .auditrc.json

# Analyze a specific directory
code-audit -p ./src
```

### Common Options
```bash
# Generate multiple report formats
code-audit -f html -f json -f csv

# Run specific analyzers only
code-audit -a solid -a dry

# Set minimum severity level
code-audit -s warning

# Show detailed progress
code-audit -v
```

## Configuration

The auditor looks for configuration in these locations (in order):
1. Command line arguments
2. `.auditrc.json` in the current directory
3. `audit.config.json` in the current directory
4. `audit.config.js` in the current directory
5. Environment variables (with `AUDIT_` prefix)

### Basic Configuration Example

```json
{
  "includePaths": [
    "src/**/*.{ts,tsx,js,jsx}"
  ],
  "excludePaths": [
    "**/node_modules/**",
    "**/*.test.ts"
  ],
  "enabledAnalyzers": [
    "solid",
    "dry",
    "security",
    "component",
    "data-access"
  ],
  "outputFormats": ["html", "json"],
  "outputDirectory": "./audit-reports",
  "thresholds": {
    "maxCritical": 0,
    "maxWarnings": 50,
    "minHealthScore": 80
  }
}
```

### Project-Specific Configurations

See the `examples/` directory for pre-configured setups:
- `nextjs.auditrc.json` - Next.js projects
- `react.auditrc.json` - React applications
- `node-api.auditrc.json` - Node.js APIs

## Available Analyzers

### SOLID Analyzer
Checks for violations of SOLID principles:
- Single Responsibility Principle
- Open/Closed Principle
- Liskov Substitution Principle
- Interface Segregation Principle
- Dependency Inversion Principle

### DRY Analyzer
Detects code duplication:
- Duplicate code blocks
- Similar function implementations
- Repeated imports
- String literal duplication

### Security Analyzer
Verifies security patterns:
- Authentication wrapper usage
- Authorization checks
- Rate limiting implementation
- Public endpoint identification

### Component Analyzer
Analyzes UI components:
- Component complexity
- Error boundary usage
- Prop validation
- Nesting depth

### Data Access Analyzer
Reviews database interactions:
- SQL injection vulnerabilities
- Query performance issues
- Missing security filters
- Connection patterns

## CLI Options

```
Options:
  -c, --config <file>        Load configuration from file
  -p, --project <dir>        Project root directory
  -i, --include <pattern>    Include files matching pattern
  -e, --exclude <pattern>    Exclude files matching pattern
  -a, --analyzers <name>     Enable specific analyzers
  -f, --format <format>      Output format: html, json, csv
  -o, --output <dir>         Output directory for reports
  -s, --severity <level>     Minimum severity: critical, warning, suggestion
  --fail-on-critical         Exit with error code if critical issues found
  --no-progress              Disable progress bar
  -v, --verbose              Show detailed progress
  --init                     Create a sample configuration file
  -h, --help                 Show help
```

## Programmatic API

### Basic Usage
```typescript
import { AuditRunner } from 'code-auditor';

const runner = new AuditRunner({
  includePaths: ['src/**/*.ts'],
  enabledAnalyzers: ['solid', 'dry']
});

const result = await runner.run();
console.log(`Found ${result.summary.totalViolations} issues`);
```

### Quick Audit Function
```typescript
import { runAudit } from 'code-auditor';

const result = await runAudit({
  projectRoot: './my-project',
  outputFormats: ['html', 'json']
});
```

### Project-Specific Runner
```typescript
import { createAuditRunner } from 'code-auditor';

// Pre-configured for Next.js projects
const runner = createAuditRunner('nextjs', {
  thresholds: {
    maxCritical: 0
  }
});

const result = await runner.run();
```

### Custom Analyzer
```typescript
import { BaseAnalyzer, AuditRunner } from 'code-auditor';

class MyCustomAnalyzer extends BaseAnalyzer {
  async analyzeFile(filePath: string, content: string) {
    // Your analysis logic here
  }
}

const runner = new AuditRunner();
runner.registerAnalyzer('custom', {
  name: 'My Custom Analyzer',
  instance: new MyCustomAnalyzer()
});
```

## Understanding Reports

### Health Score
The health score (0-100) is calculated based on:
- Number of violations per file
- Severity of violations (critical issues have more impact)
- Overall code coverage analyzed

### Severity Levels
- **Critical** 🔴 - Must be fixed immediately (security vulnerabilities, major bugs)
- **Warning** 🟡 - Should be addressed soon (poor patterns, minor security issues)
- **Suggestion** 🔵 - Nice to have improvements (optimizations, best practices)

### Report Formats

#### HTML Report
Interactive web report with:
- Summary dashboard
- Sortable violation lists
- Code snippets with line numbers
- Recommendations with examples
- Trend charts (when historical data available)

#### JSON Report
Machine-readable format containing:
- Complete violation details
- Metrics and statistics
- Recommendations
- MCP-compatible format option

#### CSV Report
Spreadsheet-friendly format with:
- Summary metrics
- Violation counts by category
- Trend data for tracking

## CI/CD Integration

### GitHub Actions
```yaml
- name: Run Code Audit
  run: |
    npm install -g code-auditor
    code-audit -c .auditrc.json --fail-on-critical
```

### GitLab CI
```yaml
code-audit:
  script:
    - npm install -g code-auditor
    - code-audit -f json -o reports/
  artifacts:
    reports:
      paths:
        - reports/
```

### Jenkins
```groovy
stage('Code Audit') {
  steps {
    sh 'npm install -g code-auditor'
    sh 'code-audit --fail-on-critical'
  }
}
```

## Environment Variables

- `AUDIT_OUTPUT_DIR` - Override output directory
- `AUDIT_VERBOSE` - Enable verbose output
- `AUDIT_MIN_SEVERITY` - Set minimum severity level
- `AUDIT_FAIL_ON_CRITICAL` - Exit with error on critical issues
- `AUDIT_ENABLED_ANALYZERS` - Comma-separated list of analyzers

## MCP Server Integration

Code Auditor includes a built-in MCP (Model Context Protocol) server that enables AI assistants like Claude to analyze your code interactively.

### Using with Claude Code CLI

The easiest way to use Code Auditor with Claude is through the Claude Code CLI:

```bash
# Add the Code Auditor MCP server to your project
claude mcp add code-auditor -- npx code-auditor-mcp

# The MCP server is now available in your Claude Code session
# Just ask Claude to analyze your code!
```

Alternative installation methods:

```bash
# Using npm start (if installed locally)
claude mcp add code-auditor -- npm start

# Using global installation
npm install -g code-auditor-mcp
claude mcp add code-auditor -- code-auditor-mcp
```

### Manual Setup with Claude Desktop

If you prefer to configure Claude Desktop manually:

1. Install code-auditor globally:
   ```bash
   npm install -g code-auditor-mcp
   ```

2. Add to your Claude Desktop configuration:
   ```json
   {
     "mcpServers": {
       "code-auditor": {
         "command": "npx",
         "args": ["code-auditor-mcp"]
       }
     }
   }
   ```

   Configuration file locations:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Linux: `~/.config/Claude/claude_desktop_config.json`

3. Restart Claude Desktop

### Available MCP Tools

#### Code Analysis Tools
- **audit_run** - Run a comprehensive code audit
- **audit_analyze_file** - Analyze a specific file for issues
- **audit_check_health** - Get a quick health score for your codebase
- **audit_list_analyzers** - List all available analyzers and their capabilities

#### Code Index Tools
- **index_functions** - Index functions from TypeScript/JavaScript files
- **search_functions** - Search indexed functions with natural language queries
- **find_definition** - Find the exact definition of a specific function
- **register_functions** - Manually register functions with metadata
- **get_index_stats** - Get statistics about the code index
- **clear_index** - Clear all indexed functions

#### AI Configuration Tools
- **generate_ai_configs** - Generate configs for AI coding assistants (Cursor, Continue, Copilot, etc.)
- **list_ai_tools** - List all supported AI tools
- **get_ai_tool_info** - Get detailed info about a specific AI tool
- **validate_ai_config** - Validate an AI tool configuration

#### Maintenance Tools
- **bulk_cleanup** - Remove index entries for deleted files
- **deep_sync** - Deep synchronize all indexed files

### Advanced Search Functionality

The `search_functions` tool (and `search_code` in MCP) supports powerful search operators that enable precise code discovery. You can use natural language queries combined with special operators to find exactly what you need.

#### Search Operators Reference

| Operator | Description | Example |
|----------|-------------|---------|
| `file:` | Filter by file path | `file:utils` `file:src/components` |
| `type:` | Filter by file type | `type:ts` `type:tsx` |
| `lang:` `language:` | Filter by language | `lang:typescript` |
| `entity:` | Filter by entity type | `entity:function` `entity:component` |
| `async:` | Filter async functions | `async:true` `async:false` |
| `exported:` | Filter by export status | `exported:true` |
| `kind:` | Filter by function kind | `kind:arrow` `kind:method` |
| `complexity:` | Filter by complexity | `complexity:>10` `complexity:5-10` |
| `jsdoc:` `doc:` | Filter by documentation | `jsdoc:true` `doc:false` |
| **Dependency Operators** | | |
| `dep:` `dependency:` `uses:` | Find dependency usage | `dep:lodash` `uses:react` |
| `calls:` | Functions calling a function | `calls:validateUser` |
| `calledby:` `dependents-of:` | Functions called by | `calledby:handleRequest` |
| `unused-imports` | Find unused imports | `unused-imports` |
| **React Operators** | | |
| `component:` | Filter component type | `component:functional` |
| `hook:` `hooks:` | Find hook usage | `hook:useState` |
| `prop:` `props:` | Find prop usage | `prop:onClick` |
| **Search Modifiers** | | |
| `-` | Exclude terms | `validate -test` |
| `"..."` | Exact phrase | `"user authentication"` |
| `~` `fuzzy` | Enable fuzzy search | `~ authenticaton` |
| `stem` `stemming` | Enable stemming | `stem render` |

#### Example Searches

```bash
# Find complex functions that need refactoring
search_code "complexity:>10 -test"

# Find undocumented exported functions
search_code "exported:true jsdoc:false"

# Find React components using hooks
search_code "component:functional hook:useState"

# Find functions with unused imports
search_code "unused-imports file:src"

# Find what depends on a function
search_code "dependents-of:authenticate"

# Combine multiple operators
search_code "Button component:functional prop:onClick file:components"
```

### Usage Examples with Claude

```
# Code Analysis
"Run a code audit on my project and show me the critical issues"
"Check the health score of the src directory"
"Analyze my code for SOLID principle violations"
"Find security vulnerabilities in my authentication code"
"Show me all code duplication in the components folder"

# Code Search & Discovery
"Search for functions that validate email addresses"
"Find all user authentication functions"
"Show me any existing data table components"
"Search for functions that send notifications"

# AI Tool Configuration
"Generate AI configurations for Cursor and Claude"
"List all supported AI coding tools"
"Set up my AI tools to use the code index"

# Maintenance
"Clean up stale entries in the code index"
"Sync all indexed files to update function signatures"
```

See [TOOLS-DOCUMENTATION.md](TOOLS-DOCUMENTATION.md) for comprehensive documentation on all MCP tools.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/code-auditor/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/code-auditor/discussions)
- **Documentation**: [Full Documentation](https://yourusername.github.io/code-auditor)

## Acknowledgments

Originally extracted from the HHRA ORG-Tracker project, this tool has been generalized for use with any TypeScript/JavaScript codebase.