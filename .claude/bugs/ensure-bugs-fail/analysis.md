# Bug Analysis: Code Analyzers Not Detecting Issues

## Root Cause Analysis

### Investigation Steps
1. Examine analyzer implementation
2. Check AuditRunner analyzer registration
3. Verify file content is reaching analyzers
4. Test AST parsing functionality
5. Debug analyzer pattern matching

### Findings

#### Primary Issue: TypeScript Parsing Error
- **Location**: `src/utils/astUtils.ts` in `parseTypeScriptFile()` function
- **Problem**: Creating TypeScript program without proper library definitions
- **Error**: "Cannot find global type 'Array'" preventing AST generation
- **Impact**: No AST = no analysis could occur

#### Secondary Issue: Uninitialized Analyzer Configs
- **Location**: All analyzer constructors (SOLID, DRY, Security, Component, DataAccess)
- **Problem**: `this.config` was undefined, causing runtime errors
- **Error**: Cannot read properties of undefined when accessing config values
- **Impact**: Analyzers crashed before performing any analysis

### Technical Details

#### AST Parsing Fix
The original implementation attempted to create a full TypeScript program:
```typescript
const program = ts.createProgram({
  rootNames: [filePath],
  options: { target: ts.ScriptTarget.Latest },
  host: compilerHost
});
```

This required complex compiler host setup with library definitions. Simplified to:
```typescript
const sourceFile = ts.createSourceFile(
  filePath,
  content,
  ts.ScriptTarget.Latest,
  true
);
```

#### Config Initialization Fix
Added to all analyzer constructors:
```typescript
constructor(config: Partial<SecurityAnalyzerConfig> = {}) {
  super();
  this.config = { ...DEFAULT_CONFIG };
}
```

## Affected Components
- `src/utils/astUtils.ts` - parseTypeScriptFile function
- All analyzer implementations - constructor initialization
- TypeScript compiler API usage
- Config management in analyzers

## Dependencies
- TypeScript AST parsing - now working correctly
- File system operations - were working correctly
- Analyzer instantiation - fixed with config initialization

## Risk Assessment
- **Severity**: Critical - Core functionality was completely broken
- **Scope**: All code analysis features were non-functional
- **User Impact**: Tool provided no value before fix
- **Fix Risk**: Low - Changes are isolated and straightforward

## Additional Finding: MCP Path Issue

### Issue
The MCP server is not passing the `projectRoot` to AuditRunner:
```typescript
// Line 147: calculates auditPath but doesn't use it
const auditPath = path.resolve((args.path as string) || process.cwd());
const options: AuditRunnerOptions = {
  enabledAnalyzers: (args.enabledAnalyzers as string[]) || ['solid', 'dry', 'security'],
  minSeverity: ((args.minSeverity as string) || 'warning') as Severity,
  verbose: false,
  // Missing: projectRoot: auditPath
};
```

### Impact
- MCP server always analyzes the current working directory
- The `path` parameter is ignored
- Cannot analyze different directories via MCP

### Fix Required
Add `projectRoot: auditPath` to the options object in all MCP tool handlers.