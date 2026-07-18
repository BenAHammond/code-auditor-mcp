---
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
```

These are the codebase's declared constraints — "no importing X from Y," "module A must not import module B," "exported names must match this pattern," "ban specific AST patterns." You can't comply with rules you don't know about. The full rule-kind reference is in `SKILL-RULE-KINDS.md`.

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

## Interpreting hook feedback

When the PostToolUse hook blocks your edit with a violation message:

1. **Read the violation** — it includes the invariant rule's `message` field explaining *why* the edit was blocked
2. **Fix the violation** — change your approach to comply with the invariant
3. **Do NOT retry the same edit** — the hook will block it again
4. The hook runs `code-audit changed --fail-on critical`, so only critical-severity invariant violations block edits. Warnings and suggestions pass through as non-blocking output — still worth fixing.

If the hook says `[code-auditor] code-audit not installed`, the package isn't available in this environment. Install it with `npm install -g code-auditor-mcp` or use `npx code-auditor-mcp`.

## Quick reference

| Task | Command |
|------|---------|
| Find callers | `code-audit search "calls:<fn>"` |
| Find by import | `code-audit search "dep:<module>"` |
| Complex functions | `code-audit search "lang:go complexity:>10"` |
| Look up symbol | `code-audit search --definition "<name>"` |
| Diff-scoped audit | `code-audit changed --json --fail-on critical` |
| List invariant rules | `code-audit config rules-list` |
| Triage violations | `code-audit tasks from-audit` |
| Sync index | `code-audit index sync --path .` |
| Codebase map | `code-audit map -p .` |
| Rule reference | See `SKILL-RULE-KINDS.md` |
| Search reference | See `SKILL-SEARCH.md` |
