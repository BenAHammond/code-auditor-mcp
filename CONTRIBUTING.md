# Contributing to Code Auditor

Thank you for your interest in contributing to Code Auditor! This guide will help you get started with contributing new analyzers, fixing bugs, or improving the codebase.

## Table of Contents
1. [Getting Started](#getting-started)
2. [Development Setup](#development-setup)
3. [Architecture Overview](#architecture-overview)
4. [Data Flow Standards](#data-flow-standards)
5. [Creating a New Analyzer](#creating-a-new-analyzer)
6. [Testing](#testing)
7. [Code Style](#code-style)
8. [Submitting Changes](#submitting-changes)

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/yourusername/code-auditor.git`
3. Create a feature branch: `git checkout -b feature/your-feature-name`
4. Make your changes
5. Submit a pull request

## Development Setup

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Watch mode for development
npm run watch

# Run the CLI in development mode
npm run dev
```

## Architecture Overview

The codebase follows a plugin-based architecture:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   CLI/MCP   │────▶│ AuditRunner  │────▶│  Analyzers  │
└─────────────┘     └──────────────┘     └─────────────┘
                            │                     │
                            ▼                     ▼
                    ┌──────────────┐     ┌─────────────┐
                    │   Reports    │◀────│ Violations  │
                    └──────────────┘     └─────────────┘
```

### Key Components

- **AuditRunner**: Orchestrates the analysis process
- **BaseAnalyzer**: Abstract base class for all analyzers
- **Analyzers**: Specific implementations (SOLID, DRY, Security, etc.)
- **AST Utils**: TypeScript AST parsing and traversal utilities
- **Report Generators**: Output formatters (HTML, JSON, CSV)

## Creating a New Analyzer

We support both functional and class-based analyzers. The functional approach is preferred for its simplicity and composability.

### Functional Approach (Recommended)

Create a new file in `src/analyzers/yourAnalyzer.ts`:

```typescript
import * as ts from 'typescript';
import { Violation } from '../types.js';
import {
  AnalyzerFunction,
  createAnalyzer,
  createViolation,
  getNodePosition,
  traverseAST
} from './analyzerUtils.js';

// Define your configuration
interface YourAnalyzerConfig {
  threshold: number;
  patterns: string[];
}

// Default configuration
const DEFAULT_CONFIG: YourAnalyzerConfig = {
  threshold: 10,
  patterns: []
};

// File analyzer function
const analyzeFile = async (
  filePath: string,
  sourceFile: ts.SourceFile,
  config: YourAnalyzerConfig
): Promise<Violation[]> => {
  const violations: Violation[] = [];
  
  traverseAST(sourceFile, (node) => {
    if (isViolation(node, config)) {
      const { line, column } = getNodePosition(sourceFile, node);
      
      violations.push(createViolation('your-analyzer', {
        file: filePath,
        line,
        column,
        severity: 'warning',
        message: 'Your violation message',
        type: 'your-type',
        recommendation: 'How to fix this issue',
        details: {
          metric: calculateMetric(node)
        }
      }));
    }
  });
  
  return violations;
};

// Helper functions
function isViolation(node: ts.Node, config: YourAnalyzerConfig): boolean {
  // Your detection logic
  return false;
}

function calculateMetric(node: ts.Node): number {
  // Your metric calculation
  return 0;
}

// Export the analyzer
export const yourAnalyzer: AnalyzerFunction = createAnalyzer(
  'your-analyzer',
  analyzeFile,
  DEFAULT_CONFIG
);
```

### Step 2: Register the Analyzer

For functional analyzers, add to `src/AuditRunner.ts`:

```typescript
import { yourAnalyzer } from './analyzers/yourAnalyzer.js';
import { FunctionalAnalyzerAdapter } from './analyzers/FunctionalAnalyzerAdapter.js';

// In registerDefaultAnalyzers() method:
this.registerAnalyzer(
  new FunctionalAnalyzerAdapter(
    'your-analyzer',
    yourAnalyzer,
    this.options.yourAnalyzer
  )
);
```

### Step 3: Update Types

Add configuration types to `src/types.ts`:

```typescript
export interface AuditRunnerOptions {
  // ... existing options ...
  yourAnalyzer?: {
    yourThreshold?: number;
    yourPatterns?: string[];
  };
}
```

### Step 4: Add Default Configuration

Update `src/config/defaults.ts`:

```typescript
export const DEFAULT_CONFIG: AuditConfig = {
  // ... existing config ...
  yourAnalyzer: {
    yourThreshold: 10,
    yourPatterns: []
  }
};
```

## Data Flow Standards

To ensure consistency and make it easier to contribute new analyzers, we follow standardized data flow patterns.

### Core Data Flow

```
Files → BaseAnalyzer → YourAnalyzer → Violations → AnalyzerResult → AuditRunner → Reports
```

### Standard Interfaces

#### Violation Interface
All analyzers must output violations in this format:

```typescript
interface Violation {
  // Required fields
  file: string;              // File path
  line: number;              // Line number (1-based)
  column: number;            // Column number (1-based)
  severity: 'critical' | 'warning' | 'suggestion';
  message: string;           // Human-readable description
  analyzer: string;          // Your analyzer name
  type: string;              // Violation category (e.g., 'god-class', 'sql-injection')
  
  // Optional fields
  principle?: string;        // e.g., "single-responsibility"
  recommendation?: string;   // How to fix it
  estimatedEffort?: 'small' | 'medium' | 'large';
  
  // Analyzer-specific data
  details?: {
    [key: string]: any;
  };
}
```

#### AnalyzerResult Interface
Analyzers must return results in this format:

```typescript
interface AnalyzerResult {
  violations: Violation[];
  filesProcessed: number;
  executionTime: number;
  analyzerName: string;
  
  // Optional
  errors?: Array<{
    file: string;
    error: string;
  }>;
  
  // Analyzer-specific metrics
  metadata?: {
    [key: string]: any;
  };
}
```

### Available Analyzer Utilities

The `analyzerUtils.ts` module provides composable functions for analyzer development:

```typescript
// Main functions
export function createAnalyzer(name, fileAnalyzer, defaultConfig): AnalyzerFunction
export function processFiles(files, analyzeFile, name, config): Promise<AnalyzerResult>
export function createViolation(analyzerName, data): Violation

// AST helpers
export function getNodePosition(sourceFile, node): { line: number; column: number }
export function isNodeExported(node): boolean
export function getNodeName(node): string | undefined
export function traverseAST(node, visitor): void
export function findNodesOfType<T>(node, predicate): T[]
export function countNodesOfType<T>(node, predicate): number

// Analysis helpers  
export function calculateComplexity(functionNode): number
export function filterViolationsBySeverity(violations, minSeverity): Violation[]
export function sortViolations(violations): Violation[]
```

### Data Flow Best Practices

1. **Consistent Severity Levels**:
   - **Critical**: Security vulnerabilities, data loss risks
   - **Warning**: SOLID violations, performance issues
   - **Suggestion**: Style issues, minor improvements

2. **Clear Messages**: Include context in messages
   ```typescript
   // Good
   `Class "${className}" has ${methodCount} methods (threshold: ${threshold})`
   
   // Bad
   "Too many methods"
   ```

3. **Meaningful Types**: Use descriptive violation types
   ```typescript
   type: 'god-class'           // Not 'violation'
   type: 'n-plus-one-query'    // Not 'performance'
   ```

4. **Standardized Metadata**: Keep analyzer-specific data in the `details` field
   ```typescript
   details: {
     methodCount: 25,
     threshold: 10,
     complexity: 42
   }
   ```

## Testing

### Manual Testing

Test your analyzer with example code:

```bash
# Create a test file
mkdir test-examples
echo "your test code" > test-examples/test.ts

# Run your analyzer
npm run dev -- --analyzers your-analyzer --path test-examples
```

### Writing Unit Tests (Future)

```typescript
// test/analyzers/YourAnalyzer.test.ts
import { YourAnalyzer } from '../../src/analyzers/YourAnalyzer';
import { parseTypeScriptFile } from '../../src/utils/astUtils';

describe('YourAnalyzer', () => {
  const analyzer = new YourAnalyzer();
  
  it('should detect violations', async () => {
    const code = `
      // Your test code
    `;
    
    const sourceFile = parseTypeScriptFile('test.ts', code);
    const violations = await analyzer.analyzeFile('test.ts', sourceFile);
    
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('expected message');
  });
});
```

## Code Style

### TypeScript Guidelines

1. **Use ES Modules**: Import with `.js` extension
2. **Type Everything**: Avoid `any` types
3. **Async/Await**: Prefer over callbacks
4. **Const First**: Use `const` by default
5. **Early Returns**: Reduce nesting

### Naming Conventions

- **Classes**: PascalCase (e.g., `SecurityAnalyzer`)
- **Interfaces**: PascalCase with descriptive names
- **Methods**: camelCase, verb-first (e.g., `analyzeFile`)
- **Constants**: UPPER_SNAKE_CASE
- **Files**: PascalCase for classes, camelCase for utilities

### Code Organization

```typescript
// 1. Imports (sorted: node, external, internal)
import * as fs from 'fs';
import * as ts from 'typescript';
import { BaseAnalyzer } from './BaseAnalyzer.js';

// 2. Types and Interfaces
interface MyConfig { }

// 3. Constants
const DEFAULT_THRESHOLD = 10;

// 4. Class Definition
export class MyAnalyzer extends BaseAnalyzer {
  // 4a. Properties
  private config: MyConfig;
  
  // 4b. Constructor
  constructor() { }
  
  // 4c. Public methods
  async analyze() { }
  
  // 4d. Protected methods
  protected helper() { }
  
  // 4e. Private methods
  private implementation() { }
}
```

## Submitting Changes

### Pull Request Process

1. **Update Documentation**: If you've added features, update the README
2. **Add Examples**: Include example configurations if applicable
3. **Test Your Changes**: Ensure all existing functionality still works
4. **Write Clear Commit Messages**: Use conventional commits
   ```
   feat(analyzer): add PHP code analyzer
   fix(dry): improve duplicate detection accuracy
   docs: update contribution guide
   ```

5. **PR Description Template**:
   ```markdown
   ## Summary
   Brief description of changes
   
   ## Type of Change
   - [ ] Bug fix
   - [ ] New feature
   - [ ] Breaking change
   - [ ] Documentation update
   
   ## Testing
   - [ ] Tested locally
   - [ ] Added test cases
   - [ ] All tests pass
   
   ## Checklist
   - [ ] Code follows style guidelines
   - [ ] Self-review completed
   - [ ] Documentation updated
   ```

### Review Process

1. **Automated Checks**: Ensure TypeScript compiles without errors
2. **Code Review**: Maintainers will review for:
   - Code quality and style
   - Performance implications
   - Breaking changes
   - Test coverage
3. **Feedback**: Address reviewer comments
4. **Merge**: Once approved, your PR will be merged

## Getting Help

- **Questions**: Open a GitHub issue with the "question" label
- **Bugs**: Use the bug report template
- **Features**: Use the feature request template
- **Discord**: Join our community (link in README)

## Recognition

Contributors will be:
- Listed in the README
- Mentioned in release notes
- Given credit in commit messages

Thank you for contributing to making code quality analysis better for everyone!