# Code Auditor Extraction Documentation

## Overview

This document details the extraction of the code auditor from the HHRA ORG-Tracker project into a standalone, reusable tool. The extraction was completed to create a generic code quality auditor that can be used on any TypeScript/JavaScript project.

## What Was Extracted

### Core Components

1. **Analyzers** (from `src/lib/audit/analyzers/`)
   - `BaseAnalyzer.ts` → Unchanged, provides base class for all analyzers
   - `SOLIDAnalyzer.ts` → Made configurable with thresholds
   - `DRYAnalyzer.ts` → Enhanced with configurable similarity thresholds
   - `RouteAnalyzer.ts` → Renamed to `SecurityAnalyzer.ts` and generalized
   - `PageAnalyzer.ts` → Renamed to `ComponentAnalyzer.ts` and made framework-agnostic
   - `DataAccessAnalyzer.ts` → Removed hardcoded database names
   - `AuthPatternAnalyzer.ts` → Merged into SecurityAnalyzer

2. **Report Generators** (from `src/lib/audit/reporting/`)
   - `ReportGenerator.ts` → Enhanced with configurable options
   - `HTMLReportGenerator.ts` → Added theming and feature toggles
   - `JSONReportGenerator.ts` → Added MCP-compatible format option
   - `CSVReportGenerator.ts` → Rebuilt without external dependencies

3. **Utilities** (from `src/lib/audit/`)
   - `astParser.ts` → Copied unchanged (already generic)
   - `fileDiscovery.ts` → Made exclude patterns configurable
   - `types.ts` → Removed HHRA-specific types

4. **Runner** (from `scripts/audit/runAudit.ts`)
   - Converted from script to `AuditRunner` class
   - Added programmatic API
   - Enhanced with progress callbacks
   - Created new `cli.ts` with improved user experience

## HHRA-Specific Code Removed

### 1. Database References
- **Original**: Hardcoded `app-db` and `org-tracker-db` references
- **Changed**: Made database patterns configurable in DataAccessAnalyzer

### 2. Authentication Patterns
- **Original**: Hardcoded `withAuth`, `withAdminAuth` patterns
- **Changed**: Configurable auth patterns in SecurityAnalyzer config

### 3. Next.js Specific Checks
- **Original**: Checks for `SessionAuth`, `AppShell`, `PageHeader`
- **Changed**: Generic component structure analysis with configurable patterns

### 4. Import Paths
- **Original**: Used `@/` alias and relative imports from HHRA structure
- **Changed**: All imports updated to new standalone structure

### 5. Report Branding
- **Original**: "HHRA Architecture & Code Quality Audit"
- **Changed**: Configurable report titles and themes

### 6. File Paths
- **Original**: Assumed HHRA project structure (`app/`, specific patterns)
- **Changed**: Configurable include/exclude paths with sensible defaults

## Configuration Changes

### For HHRA Users

To continue using the auditor in HHRA, create a `.auditrc.json` file:

```json
{
  "projectRoot": ".",
  "reportTitle": "HHRA Architecture & Code Quality Audit",
  
  "includePaths": [
    "app/**/*.{ts,tsx}",
    "src/**/*.{ts,tsx}"
  ],
  
  "excludePaths": [
    "**/node_modules/**",
    "**/.next/**",
    "**/tests/**"
  ],
  
  "analyzerConfig": {
    "security": {
      "authPatterns": ["withAuth", "requireAuth"],
      "adminPatterns": ["withAdminAuth", "requireAdmin"]
    },
    "component": {
      "frameworkPatterns": {
        "react": {
          "components": ["*.tsx"],
          "hooks": ["use*"]
        }
      }
    },
    "data-access": {
      "databasePatterns": {
        "postgres": ["app-db", "org-tracker-db"]
      }
    }
  }
}
```

### Analyzer Name Mappings

| Original Name | New Name | Reason |
|--------------|----------|---------|
| PageAnalyzer | ComponentAnalyzer | More generic, supports any UI framework |
| RouteAnalyzer | SecurityAnalyzer | Broader scope beyond just routes |
| AuthPatternAnalyzer | (merged into SecurityAnalyzer) | Consolidated security checks |

## Breaking Changes

1. **Import Paths**: All imports must be updated to use the new structure
2. **Analyzer Names**: Use new generic names in configuration
3. **Configuration**: Now requires explicit configuration for HHRA-specific patterns
4. **API Changes**: Script interface replaced with class-based API

## New Features Added

1. **Configuration System**
   - Support for `.auditrc.json` files
   - Environment variable support
   - Project type presets

2. **Enhanced CLI**
   - Colored output
   - Progress bars
   - Better error messages
   - `--init` command for setup

3. **Plugin Architecture**
   - Register custom analyzers
   - Configurable analyzer behavior
   - Progress callbacks

4. **MCP Compatibility**
   - JSON reports can generate MCP-compatible format
   - Prepared for future MCP server conversion

## Migration Guide

### Step 1: Update Dependencies

```bash
# Remove old audit scripts
rm -rf scripts/audit

# Install code-auditor (if published)
npm install code-auditor

# Or use as workspace
npm install ./code-auditor
```

### Step 2: Update Scripts

Replace in `package.json`:
```json
{
  "scripts": {
    "audit": "code-audit -c .auditrc.json"
  }
}
```

### Step 3: Create Configuration

Run:
```bash
code-audit --init
```

Then customize `.auditrc.json` for HHRA patterns.

### Step 4: Update Imports

If using programmatically:
```typescript
// Old
import { runAudit } from './scripts/audit/runAudit';

// New
import { AuditRunner } from 'code-auditor';
```

## Future Considerations

### MCP Server Integration
The code is structured to facilitate conversion to an MCP server:
- Analyzers are self-contained
- Results are JSON-serializable
- Clear separation of concerns

### Additional Analyzers
New analyzers can be added by:
1. Extending `BaseAnalyzer`
2. Registering with `AuditRunner`
3. Adding configuration schema

### Framework Support
Current support includes:
- React/Next.js
- Vue.js
- Angular
- Svelte
- Node.js

Additional frameworks can be supported through configuration.