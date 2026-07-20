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

## License

MIT
