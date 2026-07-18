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
- **Analyzers**: Functional analyzer definitions registered in `DEFAULT_ANALYZERS` — each implements the `AnalyzerDefinition` interface (SOLID, DRY, Documentation, etc.)
- **Language Adapters**: tree-sitter-based multi-language AST parsing (TypeScript, JavaScript, Go) behind the `LanguageAdapter` interface
- **adapterBridge**: Synchronous facade over tree-sitter for AST parsing, traversal, and complexity calculation
- **Invariant Rules**: Project-specific rule enforcement (`import-ban`, `call-constraint`, `module-boundary`, `naming`, `ast-pattern`) via `.codeauditor.json`
- **Report Generators**: Output formatters (HTML, JSON, CSV, SARIF)

### Adding a New Language

The project uses tree-sitter with WASM grammars behind a `LanguageAdapter` interface to support multiple languages. Adding support for a new language involves exactly three steps:

1. **Get the tree-sitter grammar** for your language. Add the grammar npm package as a `devDependency` (e.g., `tree-sitter-python`). If the package ships a WASM binary, the existing `build:grammars` script will copy it to `dist/grammars/`. If not, compile it once with the tree-sitter CLI and vendor the `.wasm` file at `grammars/<name>.wasm` with an entry in `grammars/manifest.json`.

2. **Create the adapter**: `src/languages/<name>/TreeSitter<Name>Adapter.ts`. Implement the `LanguageAdapter` interface (23 methods). Use tree-sitter queries and tree traversal for all operations. Follow `src/languages/typescript/TreeSitterTypeScriptAdapter.ts` as the reference implementation.

3. **Register in LanguageRegistry**: Add extension mappings (e.g., `.py` → `python`) and register your adapter in `src/languages/LanguageRegistry.ts`. **That's it** — all analyzers, scanners, and invariant rules consume through the adapter interface. No analyzer code needs to change.

## Creating a New Analyzer

We support both functional and class-based analyzers. The functional approach is preferred for its simplicity and composability.

### Functional Approach (Recommended)

Create a new file in `src/analyzers/yourAnalyzer.ts`:

```typescript
import type { Violation, AST, AnalyzerFunction } from '../types.js';
import {
  createAnalyzer,
  createViolation,
  processFiles,
  getNodePosition,
  getNodeName,
  walkAST,
  findNodes,
  calculateComplexity,
  getNodeText,
  isExported
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
  ast: AST,
  config: YourAnalyzerConfig
): Promise<Violation[]> => {
  const violations: Violation[] = [];
  
  walkAST(ast.root, (node) => {
    if (isViolation(node, ast, config)) {
      const location = getNodePosition(node);
      
      violations.push(createViolation('your-analyzer', {
        file: filePath,
        line: location.line,
        column: location.column,
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
function isViolation(node: ASTNode, ast: AST, config: YourAnalyzerConfig): boolean {
  // Your detection logic using node.type, node.name, etc.
  return false;
}

function calculateMetric(node: ASTNode): number {
  // Your metric calculation using calculateComplexity(node)
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

Add your analyzer to the `DEFAULT_ANALYZERS` registry in `src/auditRunner.ts`:

```typescript
import { myAnalyzer } from './analyzers/myAnalyzer.js';

// In the DEFAULT_ANALYZERS record, add an entry:
'my-analyzer': myAnalyzer,
```

If your analyzer needs configuration bridging (mapping from `AuditRunnerOptions` to analyzer-specific config), wrap it similar to the existing analyzers:

```typescript
'my-analyzer': {
  name: 'my-analyzer',
  description: 'Analyzes code for custom issues',
  category: 'quality',
  analyze: async (files, config, options, progressCallback) => {
    const analyzer = new MyUniversalAnalyzer();
    const universalConfig = {
      threshold: config.myThreshold ?? 10,
    };
    return analyzer.analyze(files, universalConfig, {
      progressCallback: createProgressAdapter('my-analyzer', progressCallback),
    });
  },
},
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
Files → adapterBridge → YourAnalyzer → Violations → AnalyzerResult → AuditRunner → Reports
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
// test/analyzers/YourAnalyzer.test.ts (Vitest)
import { describe, it, expect, beforeAll } from 'vitest';
import { getASTForFile, walkAST } from '../../src/languages/adapterBridge.js';
import { initializeLanguages } from '../../src/languages/index.js';
import { initParsers } from '../../src/languages/tree-sitter/parser.js';

describe('myAnalyzer', () => {
  // Two-phase init required: sync adapter registration + async WASM loading
  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
  });

  it('should detect violations', async () => {
    const code = `
      // Your test code
    `;

    const ast = getASTForFile('test.ts', code);
    const violations = myAnalyzer.analyze(['test.ts'], { threshold: 10 });

    expect(violations).toBeDefined();
    // expect(violations).toHaveLength(1);
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
import { promises as fs } from 'fs';
import type { Violation, AnalyzerDefinition } from '../types.js';
import { getASTForFile, walkAST, calculateComplexity } from '../languages/adapterBridge.js';
import { initializeLanguages } from '../languages/index.js';

// 2. Types and Interfaces
interface MyAnalyzerConfig {
  threshold: number;
}

// 3. Constants
const DEFAULT_THRESHOLD = 10;

// 4. Analyzer function (functional pattern — no classes needed)
async function analyzeFile(
  filePath: string,
  sourceCode: string,
  config: MyAnalyzerConfig
): Promise<Violation[]> {
  const ast = getASTForFile(filePath, sourceCode);
  const violations: Violation[] = [];

  walkAST(ast.root, (node) => {
    // Detection logic using node.type, node.name, etc.
  });

  return violations;
}

// 5. Export as AnalyzerDefinition
export const myAnalyzer: AnalyzerDefinition = {
  name: 'my-analyzer',
  description: 'Analyzes code for custom issues',
  category: 'quality',
  analyze: async (files, config, options?) => {
    // Use processFiles pattern from existing analyzers
    return { violations: [], filesProcessed: 0, executionTime: 0 };
  },
};
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