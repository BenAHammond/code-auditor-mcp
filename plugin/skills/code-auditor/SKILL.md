---
name: code-auditor
description: Audit code quality, search the codebase semantically, enforce invariants, and fix violations inline.
---

# Code Auditor Skill

You have the `code-audit` CLI available. It indexes every function, component, and struct in the codebase for semantic search and invariant enforcement. Use these commands instead of raw grep/find whenever possible.

## When to use which command

### `code-audit search` — find code by meaning, not just text

Use `code-audit search <query>` with its operator syntax instead of `grep` or `rg`. The full operator reference is in `SKILL-SEARCH.md`.

Key operators:
- `calls:<fn>` — every caller of a function (uses the call graph, not regex)
- `dep:<module>` — everything importing a module
- `lang:<lang> complexity:>N` — complex functions in a specific language
- `exported:` — public API surface
- `file:<glob>` — scope to matching file paths
- `unused-imports` — dead imports to clean up

Free-text terms search function names, signatures, JSDoc, and bodies via FTS5. This is almost always faster and more accurate than grepping.

```bash
code-audit search "calls:validateUser lang:typescript complexity:>5" --limit 20 --json
code-audit search --definition "UserService.createUser"   # look up a specific symbol
code-audit search "dep:express exported:" --language go   # Go functions that import express and are exported
```

### `code-audit audit` — run analysis before claiming work is done

Run an audit before declaring a task complete:

```bash
code-audit audit --path .                           # Full audit
code-audit changed --json --fail-on critical         # Diff-scoped audit (hook contract)
```

Use `code-audit changed` after edits to confirm you haven't introduced violations. If the hook is active it already runs `code-audit changed --fail-on critical` automatically on Write/Edit — pay attention to its output.

Expected output: JSON violation list (with `--json`) or colored terminal summary. Non-zero exit code means violations at or above `--fail-on` severity were found.

### `code-audit config` — know the project's laws

At session start, check for invariant rules:

```bash
code-audit config rules-list                         # List active rules
code-audit config rules-check                        # Validate .codeauditor.json
code-audit config profiles                           # Show active path profiles
code-audit config profiles --file src/utils/helper.ts  # See which profiles match a file
```

These are the codebase's declared constraints — "no importing X from Y," "module A must not import module B," "exported names must match this pattern," "ban specific AST patterns." You can't comply with rules you don't know about. The full rule-kind reference is in `SKILL-RULE-KINDS.md`.

### Path Profiles — "my scripts directory is noisy"

When an audit produces too many findings in scripts, tests, or fixtures, use **path profiles** in `.codeauditor.json` to cap severity per directory:

```json
{
  "pathProfiles": [
    { "name": "source-strict", "paths": ["src/**"], "overrides": { "requireFunctionDocs": true } },
    { "name": "scripts-lenient", "paths": ["scripts/**"], "overrides": { "severityCap": "suggestion" } }
  ]
}
```

Path profiles are an ordered array — files matching multiple profiles merge overrides (later wins). The `severityCap` key caps all violations in matching files at that severity. Caps are applied **after** global `severityOverrides`, so a path-level "this zone is lenient" always beats a global per-rule promotion.

A **built-in** `scripts-and-tests` profile ships with every install — it caps `scripts/**`, `tests/**`, `__tests__/**`, `fixtures/**`, and `*.test.*`/`*.spec.*` files at `suggestion`. Disable it with `"builtin": false` in `.codeauditor.json`.

Invariant violations are **immune** to path profile caps — invariants enforce declared laws and their severity is absolute.

### `code-audit tasks` — queue remediation work

```bash
code-audit tasks list                                # List all tasks
code-audit tasks create --title "Fix SQL injection" --priority high
code-audit tasks get <taskId>                        # Get task details
code-audit tasks update <taskId> --status in_progress
code-audit tasks complete <taskId>                   # Mark task done
code-audit tasks delete <taskId>                     # Delete a task
code-audit tasks from-audit                          # Create tasks from audit violations
```

Use `tasks from-audit` to convert audit violations into a tracked task list. This lets you triage findings: fix criticals now, file warnings for later, dismiss suggestions. Tasks carry fingerprints so duplicates are automatically deduplicated across audit runs.

### `code-audit index` — refresh the index after structural changes

```bash
code-audit index sync --path .
```

If you've added, renamed, or deleted files, run this so searches and audits reflect the current state. The index is rebuilt incrementally; a full sync is fast.

### `code-audit map` — get a structural overview

```bash
code-audit map -p .                                  # Generate a codebase map
```

Use this for a high-level architecture overview. Useful when orienting in an unfamiliar codebase.

### `code-audit generate-config` — create a default config

```bash
code-audit generate-config                           # Create .codeauditor.json from defaults
```

Creates a `.codeauditor.json` configuration file with invariant rules for your project. Use the interactive mode (`--interactive`) to build rules step-by-step, or generate a scaffold with sensible defaults.

### `code-audit conventions` — mine and propose rules

Code Auditor learns your codebase's unwritten conventions from the function index and flags deviations at suggestion severity. Use these to discover norms an unfamiliar agent would otherwise break:

```bash
code-audit conventions list                          # See what conventions were mined
code-audit conventions list --domain naming          # Filter to naming conventions only
code-audit conventions list --json                   # Machine-readable output
code-audit conventions propose                       # Emit ready-to-paste .codeauditor.json rules
code-audit conventions propose --domain naming       # Propose only naming rules
code-audit conventions propose --json                # JSON proposal array
```

**Five convention domains:**
- **usage-pair** — function calls that always co-occur (e.g. `handleError` callers also call `logError`)
- **import-form** — dominant import style per module (`default`, `named`, `namespace`, etc.)
- **error-handling** — dominant error pattern (`try/catch`, `.catch()`, `if (err)`)
- **export-shape** — dominant export style (`default` vs `named`)
- **naming** — dominant casing convention (`PascalCase`, `camelCase`, `UPPER_SNAKE`, etc.)

**Which domains produce rules?** Only `naming` and `import-form` map to existing rule kinds (`naming` and `import-ban` rules). The other three domains are detector-only — conventions are checked at audit time but cannot be converted to `.codeauditor.json` rules.

**Usage:** Run a full audit or `code-audit index sync` to mine conventions from the codebase index. Then `code-audit conventions list` to see what was found, and `code-audit conventions propose` to get the rules. Paste the proposals into the `rules` array in `.codeauditor.json`.

All convention violations ship at `suggestion` severity by default. Promote them with `severityOverrides` if your team treats them as blocking.

## Interpreting hook feedback

When an edit hook blocks your edit with a violation message:

1. **Read the violation** — it includes the invariant rule's `message` field explaining *why* the edit was blocked
2. **Fix the violation** — change your approach to comply with the invariant
3. **Do NOT retry the same edit** — the hook will block it again
4. The hook runs `code-audit changed --fail-on critical`, so only critical-severity invariant violations block edits. Warnings and suggestions pass through as non-blocking output — still worth fixing.

The hook auto-installs the package via npx on first use — no manual npm step needed. If the hook reports `[code-auditor] code-audit could not run`, the npx auto-install failed (network, unsupported platform). The agent should try again; if it persists, `npm install code-auditor-mcp` is the manual fix.

## Host-specific notes

- **Claude Code**: This skill is bundled in the `code-auditor` plugin (`claude plugin install code-auditor`). The plugin also ships a `PostToolUse` hook on `Write|Edit` that runs `code-audit changed --fail-on critical` automatically — the hook feedback section above describes that behavior. The MCP server is available as `mcp__code-auditor__*` tools for shell-less use.
- **Cursor**: Skill install via `code-audit install --agent cursor`. Cursor's `afterFileEdit` hook is advisory (fires after the edit; cannot block retroactively) — violations are reported through the strongest available feedback channel.
- **Codex**: Skill install via `code-audit install --agent codex`. Codex's `PostToolUse` hook provides blocking feedback via exit code 2, replacing the tool result with violation messages.
- **Gemini CLI**: Skill install only (`code-audit install --agent gemini`). No hook system exists; MCP covers shell-less use.
- **Other SKILL.md-compliant tools**: Install via `code-audit install --agent agents`. The skill teaches the `code-audit` CLI, which is identical everywhere. The MCP server is the shell-less side door.

## Quick reference

| Task | Command |
|------|---------|
| Find callers | `code-audit search "calls:<fn>"` |
| Find by import | `code-audit search "dep:<module>"` |
| Complex functions | `code-audit search "lang:go complexity:>10"` |
| Look up symbol | `code-audit search --definition "<name>"` |
| Diff-scoped audit | `code-audit changed --json --fail-on critical` |
| List invariant rules | `code-audit config rules-list` |
| Inspect path profiles | `code-audit config profiles` |
| Resolve file profiles | `code-audit config profiles --file <path>` |
| Triage violations | `code-audit tasks from-audit` |
| Sync index | `code-audit index sync --path .` |
| Codebase map | `code-audit map -p .` |
| Mine conventions | `code-audit conventions list` |
| Propose convention rules | `code-audit conventions propose` |
| Rule reference | See `SKILL-RULE-KINDS.md` |
| Search reference | See `SKILL-SEARCH.md` |
