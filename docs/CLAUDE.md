# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Commands

### Development
```bash
# Install dependencies
npm install

# Build TypeScript to JavaScript
npm run build

# Development mode (run CLI without building)
npm run dev

# Watch mode for continuous compilation
npm run watch

# Run the compiled auditor
npm run audit
```

### Using the CLI
```bash
# Run audit with default settings
code-audit

# Run specific analyzers
code-audit -a solid -a dry

# Generate multiple report formats
code-audit -f html -f json -f csv

# Set output directory
code-audit -o ./audit-reports

# Run with custom config
code-audit -c .auditrc.json

# Create sample configuration
code-audit --init
```

### Testing
```bash
# No tests implemented yet
npm test  # Will exit with "No tests yet"
```

## Architecture Overview

Code Auditor is a TypeScript-based static analysis tool with a plugin architecture. Understanding the following is crucial for effective development:

### Core Design Pattern
The project uses a **plugin-based analyzer system** where each analyzer (SOLID, DRY, Security, etc.) extends `BaseAnalyzer` and implements specific analysis logic. The `AuditRunner` orchestrates these analyzers.

### Key Components

1. **AuditRunner** (`src/AuditRunner.ts`): Main orchestration engine that:
   - Discovers files based on include/exclude patterns
   - Runs selected analyzers in parallel
   - Aggregates results and generates reports
   - Manages configuration and thresholds

2. **Analyzers** (`src/analyzers/`): Each analyzer focuses on specific concerns:
   - `SOLIDAnalyzer`: Checks SOLID principles compliance
   - `DRYAnalyzer`: Detects code duplication
   - `SecurityAnalyzer`: Verifies authentication/authorization patterns
   - `ComponentAnalyzer`: Analyzes UI component structure
   - `DataAccessAnalyzer`: Reviews database interaction patterns

3. **AST Processing**: The tool heavily relies on TypeScript's Compiler API for accurate code analysis. Key utilities in `src/utils/astUtils.ts` handle AST traversal and pattern matching.

4. **Configuration System** (`src/config/`): Supports multiple configuration sources:
   - Command-line arguments (highest priority)
   - Configuration files (`.auditrc.json`, `audit.config.js`)
   - Environment variables (prefixed with `AUDIT_`)
   - Default configurations

5. **Report Generation** (`src/reporting/`): Multiple output formats through strategy pattern:
   - HTML: Interactive web reports
   - JSON: Machine-readable format
   - CSV: Spreadsheet-compatible summaries

### MCP Server Integration
The project includes an MCP (Model Context Protocol) server (`src/mcp.ts`) that exposes audit functionality to AI assistants. The server provides tools for:
- Running comprehensive audits
- Analyzing specific files
- Checking codebase health
- Listing available analyzers

### Critical Files to Understand

1. **Types** (`src/types.ts`): All TypeScript interfaces and types
2. **CLI Entry** (`src/cli.ts`): Command-line interface implementation
3. **Public API** (`src/index.ts`): Exported functions for programmatic use
4. **AST Utils** (`src/utils/astUtils.ts`): Core AST manipulation helpers

### Adding New Features

When adding a new analyzer:
1. Create a new file in `src/analyzers/` extending `BaseAnalyzer`
2. Implement the `analyzeFile` method
3. Register the analyzer in `AuditRunner`
4. Add configuration options to `src/types.ts`
5. Update default config in `src/config/defaults.ts`

### Performance Considerations
- The tool uses streaming file processing to handle large codebases
- Analyzers run in parallel when possible
- AST parsing is cached per file to avoid redundant parsing
- Large files are processed in chunks to manage memory usage