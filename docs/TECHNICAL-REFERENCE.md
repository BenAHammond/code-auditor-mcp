# Code Auditor - Technical Reference Document

## Overview

Code Auditor is a standalone TypeScript/JavaScript code quality analysis tool that performs comprehensive static analysis to identify violations of software engineering principles, security vulnerabilities, and architectural anti-patterns. Originally extracted from the HHRA ORG-Tracker project, it's designed to be framework-agnostic and extensible.

## Architecture

### Core Components

```
code-auditor/
├── src/
│   ├── AuditRunner.ts          # Main orchestration engine
│   ├── cli.ts                  # Command-line interface
│   ├── index.ts                # Public API exports
│   ├── types.ts                # TypeScript type definitions
│   ├── analyzers/              # Analysis engines
│   │   ├── BaseAnalyzer.ts     # Abstract base class
│   │   ├── ComponentAnalyzer.ts # UI component analysis
│   │   ├── DataAccessAnalyzer.ts # Database pattern analysis
│   │   ├── DRYAnalyzer.ts      # Code duplication detection
│   │   ├── SecurityAnalyzer.ts # Security pattern verification
│   │   └── SOLIDAnalyzer.ts    # SOLID principles checking
│   ├── config/                 # Configuration management
│   │   ├── ConfigLoader.ts     # Config file & env var loader
│   │   └── defaults.ts         # Default configurations
│   ├── reporting/              # Report generation
│   │   ├── BaseReportGenerator.ts
│   │   ├── CSVReportGenerator.ts
│   │   ├── HTMLReportGenerator.ts
│   │   ├── JSONReportGenerator.ts
│   │   └── ReportGenerator.ts  # Report orchestrator
│   └── utils/                  # Utility functions
│       ├── astUtils.ts         # TypeScript AST helpers
│       ├── fileDiscovery.ts    # File pattern matching
│       └── performanceUtils.ts # Performance monitoring
├── configs/                    # Pre-built configurations
│   ├── default.json           # Default settings
│   ├── strict.json            # Strict quality rules
│   ├── minimal.json           # Minimal checks
│   └── hhra-compat.json       # HHRA compatibility
├── docs/                      # Documentation
├── examples/                  # Usage examples
└── tests/                     # Test suite
```

### Design Principles

1. **Plugin Architecture**: Each analyzer is a self-contained plugin implementing the `Analyzer` interface
2. **AST-Based Analysis**: Uses TypeScript Compiler API for accurate code analysis
3. **Streaming Processing**: Handles large codebases with minimal memory footprint
4. **Framework Agnostic**: Works with any TypeScript/JavaScript project
5. **Extensible**: Easy to add new analyzers or customize existing ones

## Analyzers

### 1. SOLID Analyzer
Checks adherence to SOLID principles:

```typescript
interface SOLIDConfig {
  maxMethodsPerClass: number;      // Default: 10
  maxLinesPerMethod: number;       // Default: 50
  maxParametersPerMethod: number;  // Default: 4
  maxImportsPerFile: number;       // Default: 20
  maxComplexity: number;           // Default: 10
}
```

**Detects:**
- Single Responsibility violations (classes doing too much)
- Open/Closed violations (direct modifications instead of extensions)
- Liskov Substitution issues (incorrect inheritance)
- Interface Segregation problems (fat interfaces)
- Dependency Inversion violations (concrete dependencies)

### 2. DRY Analyzer
Identifies code duplication:

```typescript
interface DRYConfig {
  minLineThreshold: number;      // Default: 5
  similarityThreshold: number;   // Default: 0.85 (85%)
  excludePatterns: string[];     // Files to ignore
  checkImports: boolean;         // Check duplicate imports
  checkStrings: boolean;         // Check string literals
}
```

**Detects:**
- Exact code duplicates
- Similar code patterns (using similarity scoring)
- Duplicate imports
- Repeated string literals
- Copy-paste violations

### 3. Security Analyzer
Verifies security patterns:

```typescript
interface SecurityConfig {
  authPatterns: string[];        // Authentication decorators/functions
  adminPatterns: string[];       // Admin-only patterns
  rateLimitPatterns: string[];   // Rate limiting patterns
  publicPatterns: string[];      // Explicitly public endpoints
}
```

**Detects:**
- Missing authentication on API endpoints
- Inconsistent authorization patterns
- Missing rate limiting
- Potential SQL injection vulnerabilities
- Unvalidated inputs
- Missing error handling

### 4. Component Analyzer
Analyzes UI components:

```typescript
interface ComponentConfig {
  frameworkPatterns: {
    react?: { components: string[], hooks: string[] };
    vue?: { components: string[], composables: string[] };
    angular?: { components: string[], services: string[] };
  };
  checkErrorBoundaries: boolean;
  maxComplexity: number;
  maxNesting: number;
}
```

**Detects:**
- Missing error boundaries
- Complex render methods
- Deep component nesting
- Missing prop validation
- Side effects in render
- Performance anti-patterns

### 5. Data Access Analyzer
Reviews database access patterns:

```typescript
interface DataAccessConfig {
  databasePatterns: Record<string, string[]>;
  ormPatterns: Record<string, string[]>;
  securityPatterns: {
    parameterized: string[];
    sanitized: string[];
  };
  performanceThresholds: {
    maxJoins: number;
    warnOnSelectStar: boolean;
  };
}
```

**Detects:**
- SQL injection risks
- N+1 query problems
- Missing connection pooling
- Direct DB access in UI layer
- Performance issues (too many joins, SELECT *)
- Missing transaction handling

## Configuration System

### Configuration Sources (Priority Order)

1. **CLI Arguments**: Highest priority
   ```bash
   code-audit --analyzers solid,dry --severity critical
   ```

2. **Environment Variables**: 
   ```bash
   AUDIT_MIN_SEVERITY=warning
   AUDIT_OUTPUT_DIR=./reports
   ```

3. **Configuration File**:
   ```json
   {
     "enabledAnalyzers": ["solid", "dry", "security"],
     "minSeverity": "warning",
     "outputFormats": ["html", "json"]
   }
   ```

4. **Default Configuration**: Built-in defaults

### Configuration Schema

```typescript
interface AuditConfig {
  // File discovery
  includePaths?: string[];         // Glob patterns to include
  excludePaths?: string[];         // Glob patterns to exclude
  
  // Analysis control
  enabledAnalyzers?: string[];     // Which analyzers to run
  minSeverity?: Severity;          // Minimum severity to report
  
  // Output settings
  outputFormats?: ReportFormat[];  // html, json, csv
  outputDir?: string;              // Where to save reports
  
  // Behavior
  failOnCritical?: boolean;        // Exit with error code
  verbose?: boolean;               // Detailed logging
  showProgress?: boolean;          // Progress indicators
  
  // Thresholds
  thresholds?: {
    maxCritical?: number;
    maxWarnings?: number;
    minHealthScore?: number;
  };
  
  // Analyzer-specific options
  analyzerOptions?: {
    solid?: SOLIDConfig;
    dry?: DRYConfig;
    security?: SecurityConfig;
    component?: ComponentConfig;
    dataAccess?: DataAccessConfig;
  };
}
```

## Report Formats

### 1. HTML Report
Interactive web-based report with:
- Summary dashboard
- Filterable violation list
- Code snippets with syntax highlighting
- Trend charts (when historical data available)
- Export capabilities

### 2. JSON Report (MCP-Ready)
Structured data format designed for AI tool integration:

```typescript
interface MCPReport {
  version: "1.0.0";
  timestamp: string;
  summary: {
    totalViolations: number;
    bySeverity: Record<Severity, number>;
    byAnalyzer: Record<string, number>;
    healthScore: number;
  };
  violations: Array<{
    id: string;
    analyzer: string;
    severity: Severity;
    file: string;
    line: number;
    column: number;
    message: string;
    code?: string;
    suggestion?: string;
    context?: {
      before: string[];
      violation: string;
      after: string[];
    };
  }>;
  recommendations: Array<{
    title: string;
    priority: "high" | "medium" | "low";
    effort: "small" | "medium" | "large";
    description: string;
    affectedFiles: string[];
  }>;
}
```

### 3. CSV Report
Spreadsheet-compatible format for data analysis:
```csv
File,Line,Severity,Analyzer,Type,Message,Suggestion
src/api/users.ts,45,critical,security,missing-auth,"API endpoint lacks authentication","Add withAuth() wrapper"
```

## CLI Usage

### Basic Commands

```bash
# Run with defaults
code-audit

# Specify analyzers
code-audit --analyzers solid,dry,security

# Custom configuration
code-audit --config audit.config.json

# Multiple output formats
code-audit --format html --format json --format csv

# Filter by severity
code-audit --severity critical --fail-on-critical
```

### Advanced Options

```bash
# Include/exclude patterns
code-audit --include "src/**/*.ts" --exclude "**/*.test.ts"

# Custom output directory
code-audit --output ./audit-reports

# Verbose output with progress
code-audit --verbose --show-progress

# Initialize configuration
code-audit --init
```

## Programmatic API

### Basic Usage

```typescript
import { AuditRunner } from 'code-auditor';

const runner = new AuditRunner({
  enabledAnalyzers: ['solid', 'security'],
  minSeverity: 'warning',
  outputFormats: ['json']
});

const result = await runner.run();
console.log(`Found ${result.summary.totalViolations} violations`);
```

### Advanced Usage

```typescript
import { 
  AuditRunner, 
  AuditOptions, 
  AuditProgress,
  Analyzer 
} from 'code-auditor';

// Custom analyzer
class CustomAnalyzer implements Analyzer {
  name = 'custom';
  
  async analyze(files: string[], options?: AuditOptions) {
    // Analysis logic
    return {
      violations: [],
      filesProcessed: files.length,
      executionTime: Date.now()
    };
  }
}

// Configure runner
const runner = new AuditRunner({
  enabledAnalyzers: ['solid', 'custom'],
  progressCallback: (progress: AuditProgress) => {
    console.log(`${progress.phase}: ${progress.message}`);
  },
  errorCallback: (error: Error, context: string) => {
    console.error(`Error in ${context}:`, error);
  }
});

// Register custom analyzer
runner.registerAnalyzer(new CustomAnalyzer());

// Run with custom configuration
await runner.loadConfiguration('./my-config.json');
const result = await runner.run();

// Generate specific report
const htmlReport = await runner.generateReport(result, 'html');
```

## Extension Points

### Creating Custom Analyzers

```typescript
import { BaseAnalyzer, Violation } from 'code-auditor';

export class MyAnalyzer extends BaseAnalyzer {
  name = 'my-analyzer';
  
  protected getDefaultConfig() {
    return {
      myOption: 'default-value'
    };
  }
  
  async analyzeFile(
    filePath: string, 
    sourceFile: ts.SourceFile
  ): Promise<Violation[]> {
    const violations: Violation[] = [];
    
    // Your analysis logic here
    ts.forEachChild(sourceFile, node => {
      if (this.isViolation(node)) {
        violations.push({
          file: filePath,
          line: this.getLineNumber(node),
          severity: 'warning',
          message: 'Description of violation',
          analyzer: this.name
        });
      }
    });
    
    return violations;
  }
  
  private isViolation(node: ts.Node): boolean {
    // Detection logic
    return false;
  }
}
```

### Custom Report Formats

```typescript
import { BaseReportGenerator, AuditResult } from 'code-auditor';

export class MarkdownReportGenerator extends BaseReportGenerator {
  generate(result: AuditResult): string {
    let markdown = `# Code Audit Report\n\n`;
    markdown += `Generated: ${result.timestamp}\n\n`;
    
    // Build markdown report
    for (const [analyzer, data] of Object.entries(result.analyzerResults)) {
      markdown += `## ${analyzer}\n`;
      markdown += `Found ${data.violations.length} issues\n\n`;
      // ... format violations
    }
    
    return markdown;
  }
}
```

## Performance Considerations

### Memory Management
- Processes files in batches (default: 10 files)
- Clears AST cache after each batch
- Streams large reports to disk

### Optimization Strategies
```typescript
const runner = new AuditRunner({
  batchSize: 20,              // Process more files at once
  parallel: true,             // Use worker threads
  cacheStrategy: 'aggressive', // Cache ASTs longer
  memoryLimit: 2048           // MB limit before clearing cache
});
```

## Integration Examples

### GitHub Actions

```yaml
name: Code Quality Audit
on: [push, pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Run Code Audit
        run: npx code-auditor --fail-on-critical
        
      - name: Upload reports
        uses: actions/upload-artifact@v3
        with:
          name: audit-reports
          path: audit-reports/
```

### Pre-commit Hook

```json
// package.json
{
  "scripts": {
    "pre-commit": "code-audit --analyzers security --severity critical"
  }
}
```

### VS Code Integration

```json
// .vscode/tasks.json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Run Code Audit",
      "type": "shell",
      "command": "npx code-auditor --format json --output ${workspaceFolder}/.audit",
      "problemMatcher": {
        "pattern": {
          "regexp": "^(.+):(\\d+):(\\d+):\\s+(\\w+):\\s+(.+)$",
          "file": 1,
          "line": 2,
          "column": 3,
          "severity": 4,
          "message": 5
        }
      }
    }
  ]
}
```

## MCP Server Integration (Future)

The tool is designed to be converted into an MCP (Model Context Protocol) server, enabling AI assistants to:

1. **Analyze code during conversations**
   ```
   "Can you check if my UserService follows SOLID principles?"
   → AI uses code-auditor MCP tools to analyze
   ```

2. **Suggest improvements based on violations**
   ```
   "What security issues exist in my API?"
   → AI identifies missing auth, SQL injection risks
   ```

3. **Generate fixes for violations**
   ```
   "Fix the DRY violations in this file"
   → AI uses analysis to refactor duplicated code
   ```

See `MCP-INTEGRATION.md` for detailed MCP conversion plans.

## Contributing

### Development Setup

```bash
# Clone repository
git clone https://github.com/yourusername/code-auditor.git
cd code-auditor

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Development mode
npm run dev
```

### Adding New Analyzers

1. Create analyzer in `src/analyzers/`
2. Extend `BaseAnalyzer`
3. Register in `AuditRunner`
4. Add tests in `tests/analyzers/`
5. Update documentation

### Code Style

- TypeScript strict mode
- ESLint configuration provided
- Prettier for formatting
- Conventional commits

## License

MIT License - See LICENSE file for details

## Roadmap

- [ ] MCP server implementation
- [ ] Language support (Python, Java, Go)
- [ ] IDE plugins (VS Code, IntelliJ)
- [ ] Cloud-based analysis service
- [ ] Historical trend tracking
- [ ] Team collaboration features
- [ ] Custom rule definitions via config
- [ ] Machine learning for pattern detection