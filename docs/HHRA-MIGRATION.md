# HHRA Migration Guide

This guide helps migrate from the integrated HHRA audit system to the extracted code-auditor tool.

## Overview

The code audit functionality has been extracted from HHRA into a standalone `code-auditor` subdirectory. This enables reuse across projects and prepares for future MCP server integration.

## Key Changes

### 1. Analyzer Name Changes

Several analyzers have been renamed for clarity and generalization:

| Old Name | New Name | Reason |
|----------|----------|---------|
| `page` | `component` | More generic, works for any UI framework |
| `route` | `security` | Merged with auth analyzer for comprehensive security checks |
| `auth` | `security` | Combined authentication and authorization checks |

### 2. Import Path Changes

All imports must now reference the code-auditor package:

```typescript
// Before
import { runAudit } from './scripts/audit/analyzers/pageAnalyzer';
import { SecurityAnalyzer } from './scripts/audit/analyzers/routeAnalyzer';

// After
import { AuditRunner } from './code-auditor/dist';
import { SecurityAnalyzer } from './code-auditor/dist/analyzers';
```

### 3. Configuration File Changes

#### Location
- **Before**: `scripts/audit/audit.config.json`
- **After**: `code-auditor/configs/hhra-compat.json` (or any custom location)

#### Structure Changes
```json
// Before
{
  "analyzers": {
    "page": { /* ... */ },
    "route": { /* ... */ },
    "auth": { /* ... */ }
  }
}

// After
{
  "enabledAnalyzers": ["component", "security", "solid", "dry", "data-access"],
  "analyzerConfig": {
    "component": { /* ... */ },
    "security": { 
      // Combines route and auth patterns
      "authPatterns": ["withAuth", "withAdminAuth"],
      "rateLimitPatterns": ["rateLimit", "withRateLimit"]
    }
  }
}
```

### 4. API Changes

#### Running Audits

```typescript
// Before - Direct script execution
import { runAudit } from './scripts/audit/runAudit';
const results = await runAudit({
  analyzers: ['page', 'route', 'auth']
});

// After - Using AuditRunner class
import { AuditRunner } from './code-auditor/dist';
const runner = new AuditRunner({
  enabledAnalyzers: ['component', 'security']
});
const results = await runner.run();
```

#### Progress Callbacks

```typescript
// Before
runAudit({
  onProgress: (analyzer, file) => {
    console.log(`Running ${analyzer} on ${file}`);
  }
});

// After
new AuditRunner({
  progressCallback: (progress) => {
    console.log(`${progress.phase}: ${progress.message}`);
  }
});
```

### 5. Report Format Changes

The report structure has been standardized:

```typescript
// Before
{
  "pageViolations": [...],
  "routeViolations": [...],
  "authViolations": [...]
}

// After
{
  "violations": [
    {
      "analyzer": "component",  // was "page"
      "type": "COMPONENT_COMPLEXITY",
      "severity": "warning",
      "file": "app/page.tsx",
      "line": 45,
      "message": "Component exceeds complexity threshold"
    }
  ],
  "summary": {
    "byAnalyzer": {
      "component": { /* stats */ },
      "security": { /* stats */ }
    }
  }
}
```

## Migration Steps

### Step 1: Update package.json

Add the audit scripts if not already present:

```json
{
  "scripts": {
    "audit": "npx tsx scripts/audit/runAudit.ts",
    "audit:build": "cd code-auditor && npm run build",
    "audit:verbose": "npx tsx scripts/audit/runAudit.ts -v"
  },
  "workspaces": ["code-auditor"]
}
```

### Step 2: Build the Code Auditor

```bash
# Install dependencies
cd code-auditor
npm install

# Build the tool
npm run build

# Return to project root
cd ..
```

### Step 3: Update Your Configuration

1. Copy your existing configuration:
   ```bash
   cp scripts/audit/audit.config.json code-auditor/configs/my-config.json
   ```

2. Update analyzer names in the configuration:
   - Replace `"page"` with `"component"`
   - Replace `"route"` and `"auth"` with `"security"`

3. Update any custom patterns or thresholds

### Step 4: Update Any Custom Scripts

If you have scripts that use the audit system:

```typescript
// Update imports
import { AuditRunner } from '../code-auditor/dist';

// Update analyzer names
const analyzers = ['component', 'security', 'solid', 'dry', 'data-access'];

// Use new API
const runner = new AuditRunner({ enabledAnalyzers: analyzers });
const results = await runner.run();
```

### Step 5: Verify the Migration

Run the audit to ensure it works:

```bash
# Using npm scripts
npm run audit

# Or directly
npx tsx scripts/audit/runAudit.ts

# With custom config
npx tsx scripts/audit/runAudit.ts -c code-auditor/configs/my-config.json
```

## Breaking Changes

### 1. Removed Features
- Direct analyzer imports (must use AuditRunner)
- Individual analyzer scripts (all unified in AuditRunner)
- HHRA-specific hardcoded paths (now configurable)

### 2. Changed Behavior
- Progress reporting is now event-based
- Error handling is more granular
- Configuration loading is more flexible

### 3. New Requirements
- Node.js 16+ (was 14+)
- TypeScript 5.0+ (was 4.5+)
- Must build before use (no direct TS execution)

## Troubleshooting

### Issue: "Cannot find module './code-auditor/dist'"
**Solution**: Run `npm run audit:build` to build the code-auditor

### Issue: "Unknown analyzer: page"
**Solution**: Update to use `component` instead of `page`

### Issue: "Missing auth patterns"
**Solution**: Auth patterns are now under `security` analyzer config

### Issue: Configuration not loading
**Solution**: Check that paths are relative to project root, not script location

## Benefits of Migration

1. **Reusability**: Use the same audit tool across multiple projects
2. **Maintainability**: Centralized analyzer code
3. **Extensibility**: Easy to add custom analyzers
4. **Future-Ready**: Prepared for MCP server integration
5. **Better Testing**: Standalone tool is easier to test

## Getting Help

- Check the [README](./README.md) for general usage
- See [EXTRACTION.md](./EXTRACTION.md) for technical details
- Review [MCP-INTEGRATION.md](./MCP-INTEGRATION.md) for future plans
- Examine example configs in `code-auditor/configs/`

## Quick Reference

### Command Line Changes

```bash
# Before
node scripts/audit/runAudit.js --analyzer page

# After
npx tsx scripts/audit/runAudit.ts --analyzers component
# or
npm run audit -- --analyzers component
```

### Common Mappings

- `pageAnalyzer` → `ComponentAnalyzer`
- `routeAnalyzer` → `SecurityAnalyzer`
- `authPatternAnalyzer` → `SecurityAnalyzer`
- Page violations → Component violations
- Route violations → Security violations
- Auth violations → Security violations

### Config File Locations

- Old: `scripts/audit/*.config.json`
- New: `code-auditor/configs/*.json`
- Compatibility: `code-auditor/configs/hhra-compat.json`