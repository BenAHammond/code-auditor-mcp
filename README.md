# Code Auditor

Architectural invariants enforced inside your AI agent's edit loop. When the agent writes code that breaks a project rule, Code Auditor catches it and blocks the edit. The agent sees the rule's message and fixes itself.

## Install

```bash
npm install code-auditor-mcp
```

Then tell your agent to set it up:

## Prompt examples

**"Add a Claude Code hook that runs `code-audit changed --stdin --json --fail-on critical` on Write and Edit."**

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

## License

MIT
