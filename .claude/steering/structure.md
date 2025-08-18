# Structure Steering Document

## Directory Organization

### Source Code Structure
```
src/
├── analyzers/         # Code quality analyzers
├── config/           # Configuration management
├── reporting/        # Report generation
├── utils/           # Shared utilities
├── AuditRunner.ts   # Main orchestration
├── cli.ts           # CLI entry point
├── index.ts         # Public API exports
├── types.ts         # TypeScript definitions
└── mcp.ts          # MCP server implementation
```

### Analyzer Organization
- Each analyzer in separate file under `src/analyzers/`
- Consider dropping "Analyzer" suffix as directory implies purpose
- Future structure: `src/analyzers/solid.ts` instead of `SOLIDAnalyzer.ts`
- Group related analyzers if needed (e.g., `src/analyzers/security/`)

### Test Structure (Future)
```
tests/
├── fixtures/        # Test code with known issues
├── analyzers/       # Analyzer-specific tests
├── integration/     # End-to-end tests
└── utils/          # Test utilities
```

## Naming Conventions

### Files
- **Analyzers**: PascalCase without suffix (e.g., `SOLID.ts`, `Security.ts`)
- **Utilities**: camelCase (e.g., `astUtils.ts`, `fileDiscovery.ts`)
- **Config**: camelCase (e.g., `defaults.ts`, `loader.ts`)
- **Types**: Singular `types.ts` at root

### Code Patterns
- **Interfaces**: Prefix with `I` only when needed to avoid conflicts
- **Types**: PascalCase (e.g., `AuditResult`, `ViolationType`)
- **Classes**: PascalCase (e.g., `AuditRunner`, `HTMLReportGenerator`)
- **Functions**: camelCase (e.g., `runAudit`, `parseFile`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `DEFAULT_SEVERITY`, `MAX_FILE_SIZE`)

### Analyzer Patterns
```typescript
// Each analyzer should follow this structure
export class SecurityAnalyzer extends BaseAnalyzer {
  name = 'Security';
  
  async analyzeFile(filePath: string, content: string): Promise<Violation[]> {
    // Implementation
  }
}
```

## Import Organization
1. Node.js built-ins
2. External dependencies
3. Internal modules (use relative paths)
4. Types/interfaces

Example:
```typescript
import { readFile } from 'fs/promises';
import chalk from 'chalk';
import { BaseAnalyzer } from './BaseAnalyzer.js';
import type { Violation, AnalyzerConfig } from '../types.js';
```

## Configuration Files

### Project Configuration
- `.auditrc.json` - User configuration
- `audit.config.js` - Dynamic configuration
- `.claude/` - AI assistant context

### Build Configuration
- `tsconfig.json` - TypeScript settings
- `package.json` - Dependencies and scripts

## Feature Organization

### Adding New Analyzers
1. Create new file in `src/analyzers/`
2. Extend `BaseAnalyzer` class
3. Implement required methods
4. Register in `AuditRunner`
5. Add configuration interface to `types.ts`
6. Update default config
7. Add tests in `tests/analyzers/`

### Adding Report Formats
1. Create new file in `src/reporting/`
2. Extend base report interface
3. Register in report factory
4. Add format option to CLI

## Documentation Standards

### Code Documentation
- JSDoc for public APIs
- Inline comments for complex logic
- README in each major directory
- Examples in documentation

### MCP Documentation
- Tool descriptions should be self-contained
- Each tool reports its capabilities
- No separate documentation needed

## Development Workflow

### Branch Strategy
- `main` - Stable releases
- `develop` - Active development
- `feature/*` - New features
- `fix/*` - Bug fixes

### Commit Patterns
- Conventional commits preferred
- Clear, descriptive messages
- Reference issues when applicable

## Scaling Considerations

### Future Growth
- Analyzer subdirectories for related analyzers
- Shared analyzer utilities in `src/analyzers/utils/`
- Language-specific subdirectories if expanded
- Performance test suites

### Contribution Guidelines
- New analyzers via PR
- Follow existing patterns
- Include tests (once framework established)
- Update relevant documentation

## File Size Guidelines
- Keep files under 500 lines
- Split large analyzers into helpers
- One concept per file
- Compose complex functionality