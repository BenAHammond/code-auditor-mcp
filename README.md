# Code Auditor: AI-Powered Multi-Language Code Intelligence

**Your AI understands your code across languages.** Code Auditor indexes your entire codebase (TypeScript, JavaScript, and Go) and provides real-time analysis that AI assistants like Claude can actually use to help you write better code.

## The Problem It Solves

AI coding assistants are powerful, but they're flying blind. They can't search your codebase, don't know your patterns, and miss critical context. Code Auditor changes that by creating a searchable index of every function, component, and pattern in your code.

## How It Works

1. **Index** - Automatically catalogs functions, React components, Go structs, and dependencies
2. **Analyze** - Detects SOLID violations, code duplication, and security issues across multiple languages
3. **Connect** - AI assistants access your code index via MCP (Model Context Protocol)
4. **Iterate** - Get intelligent suggestions based on your actual codebase patterns

## Quick Start (2 minutes)

```bash
# Add to your project with Claude Code CLI
claude mcp add code-auditor -- npx code-auditor-mcp

# That's it! Now ask Claude:
# "What authentication functions exist in my codebase?"
# "Find all API endpoints and check for rate limiting"
# "Show me Go structs that handle user data"
# "Compare TypeScript and Go implementations of the same feature"
```

## Core Features That Matter

### 🔍 Multi-Language Code Search
```
"Find all functions that validate user input"
"Show me where we're calling the payment API"
"What Go structs implement the User interface?"
"Compare error handling patterns between TypeScript and Go"
```

### 🎯 Smart Code Analysis
- **SOLID Principles** - Catch architecture issues before they spread
- **DRY Violations** - Find duplicate code that should be refactored
- **Security Patterns** - Verify auth, rate limiting, SQL injection protection
- **Dead Code** - Identify unused imports and functions

### 🤖 AI Tool Integration
Auto-generates configurations for:
- Claude (via MCP)
- Cursor
- Continue
- GitHub Copilot
- 10+ other AI assistants

### ⚙️ Persistent Configuration
Set your analyzer preferences once:
```
You: "Set SOLID analyzer to allow 3 responsibilities for components"
Claude: Configuration saved! All future audits will use this setting.
```

## Real Examples

### Example 1: Finding Authentication Patterns
```
You: "Show me all authentication-related functions"
Claude: Found 23 functions across 8 files:
- `validateToken()` in auth/tokens.ts:45
- `requireAuth()` in middleware/auth.ts:12
- `checkPermissions()` in auth/permissions.ts:78
...
```

### Example 2: Analyzing Code Quality
```
You: "Audit the user service for issues"
Claude: Found 3 critical issues:
- Single Responsibility violation: UserService handles both auth and profile updates
- SQL injection risk: Raw query in getUserByEmail() at line 234
- Missing rate limiting on password reset endpoint
```

### Example 3: Discovering Patterns
```
You: "Find React components similar to DataTable"
Claude: Found 4 similar components:
- `UserTable` - extends DataTable with user-specific columns
- `OrderGrid` - implements similar pagination pattern
- `ProductList` - uses same filtering approach
```

## Installation Options

### Global Install
```bash
npm install -g code-auditor-mcp
code-audit  # Run analysis
```

### Project Install
```bash
npm install --save-dev code-auditor
npx code-audit
```

### CI/CD Integration
```yaml
# GitHub Actions
- name: Code Audit
  run: npx code-audit --fail-on-critical
```

## Key Commands

```bash
code-audit                    # Full analysis with HTML report
code-audit -f json           # JSON output for CI/CD
code-audit -a solid,dry      # Run specific analyzers
code-audit --health          # Quick health score (0-100)
```

## The Feedback Loop

1. **Write Code** → Code Auditor indexes it automatically
2. **Ask AI** → "Is there a function to validate emails?"
3. **Get Context** → AI finds `validateEmail()` and similar patterns
4. **Improve** → AI suggests using existing validation instead of duplicating
5. **Repeat** → Your AI gets smarter about YOUR codebase

## Configuration

Set custom thresholds for your architecture:
```javascript
// Via MCP
mcp.set_analyzer_config({
  analyzerName: "solid",
  config: {
    maxUnrelatedResponsibilities: 4,
    patternThresholds: {
      "Dashboard": { maxResponsibilities: 6 }
    }
  }
});
```

## Advanced Search Operators

| What You Want | Search Query |
|--------------|--------------|
| Complex functions | `complexity:>10` |
| Go functions only | `lang:go` |
| TypeScript components | `lang:typescript component:functional` |
| Undocumented exports | `exported:true jsdoc:false` |
| React hooks usage | `component:functional hook:useState` |
| Go struct methods | `lang:go entity:struct` |
| Find dependencies | `calls:validateUser` |
| Cross-language patterns | `name:validateEmail` |
| Unused imports | `unused-imports file:src` |

## Performance

- Indexes 10,000+ functions in seconds
- Incremental updates on file changes
- LokiJS for fast in-memory search
- FlexSearch for intelligent queries

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - Use it anywhere, anytime.

---

**Ready to give your AI x-ray vision into your code?**
```bash
claude mcp add code-auditor -- npx code-auditor-mcp
```