# Code Auditor

Architectural invariants enforced inside your AI agent's edit loop. When the agent writes code that breaks a project rule, Code Auditor catches it and blocks the edit. The agent sees the rule's message and fixes itself.

## Install

```bash
npm install -g code-auditor-mcp
code-audit install --agent all
```

Two commands to install everywhere. `code-audit install --agent all` copies the skill to every AI coding tool on your machine. Use `--agent` for specific tools.

What you get per tool: the skill (SKILL.md), MCP server access, and hook wiring where the tool supports it (blocking on Claude Code and Codex, advisory on Cursor).

```bash
code-audit install --list   # see the support matrix
```

Claude Code users can also install via plugin:

```bash
claude plugin marketplace add BenAHammond/code-auditor-mcp
claude plugin install code-auditor
```

The hook auto-installs the auditor on first use via npx.

## Prompt examples

**"Index the codebase and run a full audit. Create tasks from any violations."**

**"Create a `.codeauditor.json` that bans lodash imports and prevents `src/languages/` from importing anything in `src/analyzers/`."**

**"Run a full code audit and create tasks from the violations."**

**"Sync the code index and audit only what changed vs main."**

**"Add an ast-pattern rule that blocks `new Function(...)`."**

**"Add a naming rule requiring hooks in `src/hooks/` to start with `use`."**

**"Add a call-constraint so `chargeCustomer()` in `src/services/payment.ts` can only be called from `src/api/`."**

## Rule kinds

Five kinds. The agent writes them to `.codeauditor.json`. Bad configs fail the audit, not silently.

| Kind | What it blocks |
|------|---------------|
| `import-ban` | Banned module imports |
| `call-constraint` | Function calls from unauthorized files |
| `module-boundary` | Imports across module boundaries |
| `naming` | Exported symbols not matching a pattern |
| `ast-pattern` | AST nodes matching an ast-grep pattern |
| `style-mechanism` | Unapproved style mechanisms per file/glob |
| `no-raw-values` | Hardcoded values for specific CSS properties |

## Works with your agent

One skill, one CLI, one MCP server. Every agent gets the same audit engine — the hook contract is the only difference.

| Agent | Skill | Hooks / Blocking | MCP | Verified |
|-------|-------|------------------|-----|----------|
| Claude Code | Plugin or `code-audit install` | **Yes — blocking** | Yes | 2026-07-19 |
| Cursor | `code-audit install --agent cursor` (project-only) | **Advisory** | Yes | 2026-07-19 |
| Codex | `code-audit install --agent codex` + plugin | **Yes — blocking** | Yes | 2026-07-19 |
| Gemini CLI | `code-audit install --agent gemini` | No | Yes | 2026-07-19 |
| VS Code / Copilot | `code-audit install --agent agents` | No | Yes | 2026-07-19 |
| Other SKILL.md tools | `code-audit install --agent agents` | No | Yes | 2026-07-19 |

Hook behavior: **Blocking** means violations at or above `--fail-on` severity prevent the edit from landing (the agent sees the violation and fixes inline). **Advisory** means violations are reported through the strongest available feedback channel but the edit has already occurred. Cursor's `afterFileEdit` hook is fire-and-forget with no output consumption. MCP is available everywhere for shell-less use.

## Findings: Deterministic vs Advisory

Code Auditor's built-in rules fall into two categories:

| Category | Meaning | Examples |
|----------|---------|----------|
| **Deterministic** | Structural fact — an engineer would act on every finding | `single-responsibility` (300-line functions), `solid/method-complexity` (cyclomatic complexity > 20), `solid/class-size` (40+ method classes), `dependency-inversion` (concrete imports where an interface exists) |
| **Advisory** | Heuristic signal — may be wrong depending on domain | `sql-injection-risk` (AST-level string-pattern matching without type info), `missing-org-filter` (domain-specific — assumes SaaS tenant isolation), `unknown-table` (requires user-provided schema), `dry/duplicate` (token-identical blocks) |

Deterministic rules ship at `critical` or `warning`. Advisory rules ship at `warning` or `suggestion`. Rules proven near-zero precision on a real corpus are **disabled by default** (`off`) — users opt in when the rule matches their domain.

### Recalibration

Built-in severity defaults are recalibrated from real-corpus triage. The current defaults reflect measurement on three corpora: this tool's own codebase, [Gin](https://github.com/gin-gonic/gin), and [Excalidraw](https://github.com/excalidraw/excalidraw). Six data-access rules that produced near-zero precision across all three corpora are disabled by default.

Every disabled rule documents what corpus it *would* be useful on. Users can restore any rule via `severityOverrides` in `.codeauditor.json`:

```json
{
  "severityOverrides": {
    "sql-injection-risk": "warning",
    "missing-org-filter": "critical",
    "loop-query": "warning"
  }
}
```

Severity overrides apply globally (before per-directory path profile caps). Setting a rule to `"off"` removes it from the output entirely.

### SQL Injection Detection

The `sql-injection-risk` rule is **disabled by default** (`off`) after recalibration. On the self-audit corpus, it produced 0% precision — the analyzer misinterpreted TypeScript pattern-matching code (string constants like `'SELECT'`, `'FROM'`, `'WHERE'` used for the tool's own SQL detection) as database queries. On the Gin and Excalidraw corpora, precision was also near zero.

**When to re-enable it**: your project's SQL is constructed via string concatenation or template literals in functions whose sole purpose is query assembly. The rule detects those patterns. For codebases using ORMs or parameterized queries exclusively, the rule produces noise.

**To re-enable and block on SQL injection**:

```json
{
  "severityOverrides": {
    "sql-injection-risk": "critical"
  }
}
```

With `sql-injection-risk: critical` and `code-audit changed --fail-on critical`, your agent's hook will block edits that introduce AST-level SQL injection patterns.

## Style Intelligence

Code Auditor indexes every style declaration in your project — CSS, SCSS, Tailwind, inline styles, and CSS-in-JS. The styles analyzer reads global distributions and flags fragmentation that no single-file linter can see.

**7 detectors, 10 rule IDs:**

| Detector | What it finds |
|----------|---------------|
| **Value drift** | Near-duplicate color values (delta-E < 2.0) and exact-value outliers where one value dominates |
| **Off-scale** | Margin/padding/gap/font-size values not on the inferred project scale |
| **Undefined class** | `className` values with no matching CSS selector or Tailwind utility |
| **Token bypass** | Hardcoded values that match a design token but don't reference it |
| **Mechanism fragmentation** | Same `(property, value)` delivered via ≥ 3 mechanisms (CSS, inline, Tailwind) |
| **Declaration-set similarity** | Two CSS rule blocks with > 90% identical declarations |
| **Z-index sprawl** | Project-wide z-index inventory — too many distinct values or orphan singletons |

The analyzer reads from a project-wide SQLite index, so scoped runs (changed files only) still compare against the full project baseline. A fresh `#273828` drift color in a scoped run is caught against the full corpus of `#1e2328` values.

**Style invariant rules:**

```json
{
  "rules": [
    {
      "kind": "style-mechanism",
      "message": "Only Tailwind in src/components/",
      "allow": ["tailwind"],
      "path": "src/components/**"
    },
    {
      "kind": "no-raw-values",
      "message": "No raw colors in src/pages/ — use design tokens",
      "properties": ["color", "background-color"],
      "path": "src/pages/**"
    }
  ]
}
```

**Style search operators** — search by property, value, mechanism, or token:

```bash
code-audit search "css:margin-top value:16px"          # specific value
code-audit search "mechanism:inline css:color"          # inline color declarations
code-audit search "token:--color-primary"                # bypassing a design token
```

**The React analyzer** also gains raw-element detection: if your project has a `Button` wrapper, raw `<button>` usages outside `Button`'s definition become warnings.

## License

MIT
