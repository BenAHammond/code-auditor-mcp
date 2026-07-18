# Code Auditor

Code Auditor enforces architectural invariants and code quality rules inside your AI agent's edit loop. When an agent writes code that violates your project's rules — importing a banned library, breaking a module boundary, calling a restricted function — Code Auditor blocks the edit and tells the agent why. It also runs traditional static analysis (SOLID, DRY, security, documentation) and builds a searchable index of every function and component in your codebase. MCP server, CLI, and Claude Code plugin. TypeScript, JavaScript, Go.

## The loop, shown not told

Given this `.codeauditor.json` in the project root:

```json
{
  "rules": [
    {
      "id": "no-lokijs",
      "kind": "import-ban",
      "severity": "critical",
      "module": "lokijs",
      "message": "lokijs was replaced by better-sqlite3 in v3.1.0. Use the SQLite-backed CodeIndexDB instead."
    }
  ]
}
```

An agent writes `import loki from 'lokijs'` in `src/broken.ts`. The Claude Code plugin hook fires on the edit and runs:

```bash
code-audit changed --json --fail-on critical
```

The output:

```json
[
  {
    "analyzer": "documentation",
    "rule": "file-documentation",
    "severity": "warning",
    "message": "File lacks proper documentation header",
    "file": "src/broken.ts",
    "line": 1,
    "column": 1,
    "enclosingSymbol": "",
    "suggestion": "",
    "details": ""
  },
  {
    "analyzer": "invariants",
    "rule": "no-lokijs",
    "severity": "critical",
    "message": "lokijs was replaced by better-sqlite3 in v3.1.0. Use the SQLite-backed CodeIndexDB instead.",
    "file": "src/broken.ts",
    "line": 4,
    "column": 1,
    "enclosingSymbol": "",
    "suggestion": "",
    "details": "import-ban"
  },
  {
    "analyzer": "schema",
    "rule": "unknown-table",
    "severity": "warning",
    "message": "Reference to unknown table 'lokijs'",
    "file": "src/broken.ts",
    "line": 4,
    "column": 13,
    "enclosingSymbol": "",
    "suggestion": "",
    "details": "Reference to unknown table 'lokijs'"
  }
]
```

Exit code 2 (because a `critical` severity violation exists). The agent sees the violations, removes the import, and the next run is clean:

```bash
code-audit changed --quiet && echo "clean"
# → clean
```

The agent never sees a generic "something is wrong" — it sees your rule's exact message, with the file and line, and can fix it immediately.

## Quick start

### Claude Code plugin (two commands)

```bash
claude plugin marketplace add BenAHammond/code-auditor-mcp
claude plugin install code-auditor
```

The plugin registers a hook that runs `code-audit changed` after every edit. Violations at `critical` severity block the edit and give the agent your rule's message.

### Generic MCP

```bash
# Claude Code
claude mcp add code-auditor -- npx code-auditor-mcp

# Cursor (.cursor/mcp.json)
{
  "mcpServers": {
    "code-auditor": {
      "command": "npx",
      "args": ["code-auditor-mcp", "--stdio"]
    }
  }
}
```

MCP tools available: `audit`, `search`, `index`, `config`, `code_map`, `tasks`, `guide`.

> **Note: `--ignore-scripts` installs are unsupported.** Code Auditor depends on two native packages — `better-sqlite3` and `@ast-grep/napi` — that ship platform binaries via install scripts. Running `npm install` with `--ignore-scripts` prevents those binaries from downloading and the tool won't start. Stock npm doesn't use this flag by default; it is only active in security-hardened or CI environments that configure it intentionally. If your environment requires `--ignore-scripts`, run `npm install` without the flag first, or use `npm approve-scripts` (npm 11+) to allow the specific packages.

### CLI

```bash
npx code-audit                         # full audit, HTML report
npx code-audit -f json                 # JSON for CI/CD
npx code-audit -f sarif                # SARIF for GitHub Code Scanning
npx code-audit changed --json          # diff-scoped audit
npx code-audit map -p .                # codebase map to stdout
npx code-audit search "calls:validate" # search the index
```

## Invariant rules

Code Auditor enforces five kinds of project-specific rules on every audit run, including diff-scoped agent-loop runs. Rules live in `.codeauditor.json` in the project root.

### import-ban

Prevent any file from importing a banned module.

```json
{
  "id": "no-lokijs",
  "kind": "import-ban",
  "severity": "critical",
  "module": "lokijs",
  "message": "lokijs was replaced by better-sqlite3 in v3.1.0."
}
```

Optional `except` field exempts specific files from the ban.

### call-constraint

Restrict which files may call a function — useful for API boundaries and security-sensitive entry points.

```json
{
  "id": "payment-calls-auth",
  "kind": "call-constraint",
  "severity": "critical",
  "callee": "src/services/paymentService.ts#chargeCustomer",
  "allowFrom": ["src/api/**"],
  "message": "chargeCustomer() may only be called from API route handlers."
}
```

### module-boundary

Prevent files matching one glob from importing from files matching another.

```json
{
  "id": "languages-no-analyzers",
  "kind": "module-boundary",
  "severity": "critical",
  "from": "src/languages/**",
  "to": "src/analyzers/**",
  "message": "The languages/ module must not depend on analyzers."
}
```

### naming

Enforce naming conventions for exported symbols in specific directories.

```json
{
  "id": "hook-prefix",
  "kind": "naming",
  "severity": "warning",
  "path": "src/hooks/**",
  "exports": "^use[A-Z]",
  "message": "Hooks in src/hooks/ must be prefixed with 'use'."
}
```

### ast-pattern

Match AST node patterns in source using ast-grep. This example bans `new Function(...)` — eval-by-another-name that bypasses static analysis.

```json
{
  "id": "no-new-function",
  "kind": "ast-pattern",
  "severity": "critical",
  "pattern": "new Function($$$)",
  "message": "new Function() is eval-by-another-name — forbidden in this codebase"
}
```

Optional `language` field restricts to `"typescript"`, `"javascript"`, or `"go"`. Optional `path` field restricts to files matching a glob.

Rules are validated on startup — bad globs, duplicate IDs, missing fields, or mutually-exclusive options fail the audit rather than being silently skipped. Use `config rules_list` and `config rules_check` from the MCP server to introspect the rules your agent is operating under.

## Analyzers

Six built-in code quality analyzers run alongside invariant rules:

| Analyzer | What it detects |
|----------|----------------|
| **SOLID** | God classes, long methods, too many parameters, dependency inversion violations |
| **DRY** | Near-duplicate blocks across files using normalized token comparison |
| **React** | Missing key props, unused state, useEffect dependency issues, component size |
| **Documentation** | Missing or insufficient JSDoc on exported functions, classes, and parameters |
| **Data Access** | Raw SQL queries missing parameterization, N+1 query patterns |
| **Schema** | Zod/JSON Schema validation gaps on API boundaries |

Each analyzer's thresholds are configurable via `config.set` in the MCP server or via `.codeauditor.json`:

```json
{
  "analyzerConfigs": {
    "dry": { "similarityThreshold": 0.8, "minLineThreshold": 5 },
    "solid": { "maxMethodsPerClass": 12, "maxParametersPerMethod": 4 }
  }
}
```

## Diff-scoped auditing and hooks

`code-audit changed` audits only the functions whose content has changed since the last index sync. It is fast enough to sit inside an agent's edit loop.

### Scope options

| Scope | Description |
|-------|-------------|
| `changed` (default) | Files modified since last index sync |
| `git:<ref>` | Files changed vs. a git ref (`git:origin/main`) |
| `[paths...]` | Specific files or directories |
| `--stdin` | Read file paths from stdin (one per line) |

### Hook contract

```bash
# Audit changed files, output JSON, exit 2 on critical violations
code-audit changed --json --fail-on critical

# Audit specific files from stdin
git diff --name-only HEAD | code-audit changed --stdin --json

# Quiet mode: no output when clean
code-audit changed --quiet && echo "clean"
```

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable violation array to stdout |
| `--quiet` | Suppress output when zero violations |
| `--fail-on <severity>` | Nonzero exit (code 2) when violations at or above severity exist. Default: `critical` |
| `--stdin` | Read file paths from stdin, one per line |

### Claude Code hook recipe

In `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "command": "cat - | code-audit changed --stdin --json --fail-on critical"
      }
    ]
  }
}
```

## Code intelligence

A searchable index of every function, component, struct, and dependency is maintained as supporting infrastructure for AI assistants. It is built during audits and synced on file changes.

### Search operators

| What you want | Query |
|--------------|-------|
| Complex functions | `complexity:>10` |
| Go functions only | `lang:go` |
| React components | `component:functional` |
| Functions calling a specific function | `calls:validateUser` |
| Exported but undocumented | `exported:true jsdoc:false` |
| Find by name | `name:validateEmail` |
| Unused imports | `unused-imports file:src` |
| Go structs | `lang:go entity:struct` |
| Functions with a specific dependency | `dep:lodash` |

### Code maps

`code-audit map` generates a human-readable file tree with function annotations, complexity scores, and dependency arrows. In the MCP server, `code_map.get` returns this as structured data.

### Task queue

The `tasks` MCP tool maintains a per-project task list in the local database (titles, status, priorities, due dates, blockers, related files/symbols). `tasks from_audit` populates the task queue from audit violations — each critical issue becomes a task with file locations and fix suggestions. Tasks survive `index reset`: clearing the analysis index does not delete your task list.

## CI and SARIF

Upload audit results to GitHub Code Scanning so violations appear as PR annotations:

```yaml
# .github/workflows/code-audit.yml
name: Code Audit

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Run code audit
        run: npx code-auditor-mcp -f sarif -o results.sarif

      - name: Upload SARIF to GitHub
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
```

For diff-scoped PR runs, use `changed --scope git:origin/main -f sarif` and pass `--sarif-category` to the upload action so scoped results don't overwrite full-branch results.

## Configuration

### Persistent analyzer settings

Set custom thresholds via the MCP `config` tool:

```
config.set analyzerName="solid" config={"maxMethodsPerClass":12}
```

Settings persist across audits and survive index resets.

### Data directory

The index file defaults to `<cwd>/.code-index/index.db`. Point at a dedicated location with the `CODE_AUDITOR_DATA_DIR` environment variable:

```bash
# Environment variable
CODE_AUDITOR_DATA_DIR=/path/to/data code-audit

# CLI
code-auditor-mcp --data-dir /path/to/data
```

Cursor `.cursor/mcp.json` example:

```json
{
  "mcpServers": {
    "code-auditor": {
      "command": "npx",
      "args": ["code-auditor-mcp", "--stdio"],
      "env": {
        "CODE_AUDITOR_DATA_DIR": "/Users/you/Library/Application Support/code-auditor"
      }
    }
  }
}
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on adding new analyzers, language adapters, and invariant rule kinds.

## License

MIT
