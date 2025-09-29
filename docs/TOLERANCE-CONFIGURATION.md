# Tolerance Configuration Guide

Code Auditor supports flexible tolerance configuration to adapt to your project's architectural decisions and coding standards.

## Quick Start

### Via MCP (Claude Integration) - Persistent Configuration

**NEW: Set configurations once and they persist across all audit runs!**

```javascript
// Set global SOLID configuration (persists for all projects)
await mcp.set_analyzer_config({
  analyzerName: "solid",
  config: {
    maxUnrelatedResponsibilities: 3,
    maxMethodsPerClass: 20,
    contextAwareThresholds: true
  }
});

// Set project-specific configuration
await mcp.set_analyzer_config({
  analyzerName: "dry",
  projectPath: "/path/to/project",
  config: {
    minLineThreshold: 15,
    similarityThreshold: 0.85
  }
});

// Check current configuration
await mcp.get_analyzer_config({
  analyzerName: "solid"
});

// Reset to defaults
await mcp.reset_analyzer_config({
  analyzerName: "solid"
});
```

### Via MCP - One-time Override

```javascript
// Relax SOLID thresholds for Context Providers
await mcp.audit({
  path: "/path/to/project",
  analyzers: ["solid"],
  analyzerConfigs: {
    solid: {
      maxUnrelatedResponsibilities: 3,  // Allow 3 instead of 2
      contextAwareThresholds: true      // Enable pattern-based adjustments
    }
  }
});
```

### Via Configuration File

Create `.auditrc.json` or `.code-auditor.json` in your project root:

```json
{
  "analyzerConfigs": {
    "solid": {
      "maxUnrelatedResponsibilities": 3,
      "maxMethodsPerClass": 20,
      "maxInterfaceMembers": 25
    },
    "dry": {
      "minLineThreshold": 15
    }
  }
}
```

## SOLID Analyzer Tolerances

### Available Configuration Options

```typescript
interface SOLIDAnalyzerConfig {
  // Class-level thresholds
  maxMethodsPerClass: number;         // Default: 15
  maxLinesPerMethod: number;          // Default: 50
  maxParametersPerMethod: number;     // Default: 4
  maxClassComplexity: number;         // Default: 50
  maxInterfaceMembers: number;        // Default: 20
  
  // Component-specific thresholds
  maxUnrelatedResponsibilities: number; // Default: 3
  contextAwareThresholds: boolean;      // Default: true
  checkUnrelatedResponsibilities: boolean; // Default: true
  
  // Pattern-specific overrides (optional)
  patternThresholds?: {
    [patternName: string]: {
      maxResponsibilities: number;
    };
  };
  
  // Feature toggles
  checkDependencyInversion: boolean;    // Default: false
  checkInterfaceSegregation: boolean;   // Default: true
  checkLiskovSubstitution: boolean;     // Default: true
  enableComponentSRP: boolean;          // Default: true
}
```

### Context-Aware Thresholds

When `contextAwareThresholds` is enabled, the analyzer automatically adjusts tolerances based on detected component patterns.

#### Built-in Pattern Multipliers

- **Layout Components**: 1.0x multiplier
- **SimpleUI Components**: 0.5x multiplier (stricter for simple components)
- **Form Components**: 1.5x multiplier
- **Table Components**: 1.8x multiplier
- **Dashboard Components**: 2.0x multiplier
- **Modal Components**: 1.2x multiplier
- **Page Components**: 1.5x multiplier

Example: If `maxUnrelatedResponsibilities` is 3 and a dashboard component is detected, it allows up to 6 responsibilities.

#### Pattern-Specific Overrides

You can override the multiplier-based calculation with explicit thresholds per pattern:

```javascript
await mcp.set_analyzer_config({
  analyzerName: "solid",
  config: {
    maxUnrelatedResponsibilities: 3,  // Base threshold
    contextAwareThresholds: true,
    patternThresholds: {
      "Layout": { maxResponsibilities: 4 },      // Override for Layout pattern
      "Dashboard": { maxResponsibilities: 6 },   // Override for Dashboard pattern
      "SimpleUI": { maxResponsibilities: 2 }     // Override for SimpleUI pattern
    }
  }
});
```

When `patternThresholds` are specified, they take precedence over the multiplier-based calculation.

### Real-World Examples

#### Example 1: Allow Context Providers to Manage Multiple Concerns

```json
{
  "analyzerConfigs": {
    "solid": {
      "maxUnrelatedResponsibilities": 3,
      "contextAwareThresholds": true
    }
  }
}
```

This allows components like `OrganizationProvider` to:
- Manage organization state
- Handle authentication context
- Provide data fetching methods

#### Example 2: Relax Class Size Limits for Service Layers

```json
{
  "analyzerConfigs": {
    "solid": {
      "maxMethodsPerClass": 25,
      "maxClassComplexity": 75
    }
  }
}
```

Useful for:
- Repository classes with many query methods
- Service classes handling multiple related operations
- API client classes with numerous endpoints

#### Example 3: Adjust for Complex Business Logic

```json
{
  "analyzerConfigs": {
    "solid": {
      "maxLinesPerMethod": 75,
      "maxParametersPerMethod": 6
    }
  }
}
```

## DRY Analyzer Tolerances

### Available Configuration Options

```typescript
interface DRYAnalyzerConfig {
  minLineThreshold: number;           // Default: 10
  similarityThreshold: number;        // Default: 0.90
  checkImports: boolean;              // Default: true
  unusedImportsConfig: {
    checkLevel: 'function' | 'file';  // Default: 'function'
    includeTypeOnlyImports: boolean;  // Default: false
    ignorePatterns: string[];         // Default: ["React", "^_"]
  }
}
```

### Example: Less Strict Duplication Detection

```json
{
  "analyzerConfigs": {
    "dry": {
      "minLineThreshold": 20,        // Only flag 20+ line duplicates
      "similarityThreshold": 0.85,   // Allow 15% variation
      "unusedImportsConfig": {
        "checkLevel": "file",         // File-level instead of function-level
        "ignorePatterns": ["React", "^_", "test.*", "mock.*"]
      }
    }
  }
}
```

## Security Analyzer Tolerances

```json
{
  "analyzerConfigs": {
    "security": {
      "checkAuthentication": true,
      "checkAuthorization": true,
      "checkRateLimiting": false,     // Disable rate limit checks
      "allowedUnprotectedRoutes": [
        "/api/health",
        "/api/public/*",
        "/webhooks/*"
      ]
    }
  }
}
```

## Per-File Overrides (Coming Soon)

Future support for pattern-based overrides:

```json
{
  "overrides": [
    {
      "files": ["**/context/*.tsx", "**/providers/*.tsx"],
      "analyzerConfigs": {
        "solid": {
          "maxUnrelatedResponsibilities": 4
        }
      }
    },
    {
      "files": ["**/utils/*.ts"],
      "analyzerConfigs": {
        "solid": {
          "maxMethodsPerClass": 30
        }
      }
    }
  ]
}
```

## CLI Usage

```bash
# Use custom config file
code-audit -c custom-tolerances.json

# Override specific tolerance via environment
AUDIT_SOLID_MAX_METHODS=30 code-audit
```

## Best Practices

1. **Start with defaults**: Only adjust tolerances when you have specific architectural needs
2. **Document your decisions**: Add comments in your config file explaining why tolerances were adjusted
3. **Review periodically**: Tolerances that were needed initially may become unnecessary as code improves
4. **Be consistent**: Use the same tolerances across your team via shared config files

## Troubleshooting

### "Component has too many responsibilities" for Context Providers

Enable context-aware thresholds:
```json
{
  "analyzerConfigs": {
    "solid": {
      "contextAwareThresholds": true,
      "maxUnrelatedResponsibilities": 3
    }
  }
}
```

### Too many "duplicate code" warnings

Increase the minimum line threshold:
```json
{
  "analyzerConfigs": {
    "dry": {
      "minLineThreshold": 15
    }
  }
}
```

### False positives for framework classes

The analyzer automatically detects and allows framework patterns like:
- React Context/Providers
- Redux stores
- Database models
- API clients

No configuration needed for these common patterns.