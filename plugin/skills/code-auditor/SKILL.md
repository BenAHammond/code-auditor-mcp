---
name: code-auditor
description: Audit code quality, search the codebase semantically, enforce invariants, and fix violations inline.
---

# Code Auditor Skill

> **Version 3.9.1** • Run `code-audit --version` to check your installed version.
> If versions differ, the CLI is authoritative — use `code-audit <command> --help` to see what your install actually supports.

You have the `code-audit` CLI available. It indexes every function, component, and struct in the codebase for semantic search and invariant enforcement. Use these commands instead of raw grep/find whenever possible.

## The diagnostic frame

`code-audit` is a diagnostic instrument, not a judge. Three terms carry that:

- **Reading** — the human-facing name for one rule observation. The machine contract calls the same thing a **violation** (a "finding" in the JSON). The audit *takes* readings; it does not issue verdicts.
- **Coverage panel** — the report leads with what was measured (which rules fired, which were clean, which were not applicable), so a zero-reading run is not mistaken for a clean tree.
- **Triage** — severity is urgency, not permission. Three levels, all defects, none optional: **critical** (exploitable or broken now), **severe** (wrong, and it will surface), **high** (wrong, and it has not bitten yet). The axis is how fast a reading bites you, not whether it matters — every reading blocks the edit gate. Queue order (`critical` → `severe` → `high`) is the order to act, not a license to skip.

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
code-audit changed --json                            # Diff-scoped audit (hook contract)
```

Use `code-audit changed` after edits to confirm you haven't introduced violations. If the hook is active it already runs `code-audit changed` automatically on Write/Edit — pay attention to its output.

**Every reading is a measurement, not a verdict.** The audit is a diagnostic instrument: it reports what it measured (the coverage panel) and takes one reading per rule violation. Work readings in urgency order — critical first, then severe, then high — and resolve them all. Severity is urgency, the order to act, never a judgment on whether a reading is real; there is no "noise" tier. Documentation readings (missing JSDoc) are maintainability gaps, not stylistic niceties. If you choose not to resolve one, record why before moving on — never silently dismiss it.

Expected output: JSON violation list (with `--json`) or colored terminal summary. The full `audit` command exits non-zero when violations at or above `--fail-on` severity exist. Every severity blocks: `critical`, `severe`, and `high` are all gating. The `changed` hook blocks on any violation from any rule — there is no non-blocking tier — and enforcement is not diff-scoped (a pre-existing violation in the audited file blocks exactly like a new one).

### `code-audit next-file` — fix violations one file at a time

```bash
code-audit next-file --path .        # Highest-priority file + all its readings
code-audit next-file --path . --json # Machine-readable
```

This is the refactoring loop. `next-file` audits the project and returns the single highest-priority file — ranked by highest-severity reading, then total reading count — with every reading on it, ordered critical → severe → high. Fix that file, then run it again: a still-broken file comes back, otherwise the next-worst file surfaces. `{done:true}` means the tree is clean.

There is **no skip or decline affordance**. A reading leaves the queue only by being fixed, or by editing the rule that produces it in `.codeauditor.json` (your rules editor). If a rule keeps firing on something you judge correct, change the rule — never work around it.

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

When an audit produces too many readings in scripts, tests, or fixtures, use **path profiles** in `.codeauditor.json` to exclude a directory from the blocking gate:

```json
{
  "pathProfiles": [
    { "name": "source-strict", "paths": ["src/**"], "overrides": { "requireFunctionDocs": true } },
    { "name": "scripts-lenient", "paths": ["scripts/**"], "overrides": { "excludeFromGate": true } }
  ]
}
```

Path profiles are an ordered array — files matching multiple profiles merge overrides (later wins). The `excludeFromGate: true` key excludes all violations in matching files from the blocking gate. Readings still report at their real severity — a path profile excludes a file from the gate, it never softens a reading within it.

A **built-in** `scripts-and-tests` profile ships with every install — it excludes `scripts/**`, `tests/**`, `__tests__/**`, `fixtures/**`, and `*.test.*`/`*.spec.*` files from the gate. Disable it with `"builtin": false` in `.codeauditor.json`.

Invariant violations are **immune** to path profile gate exclusion — invariants enforce declared laws and block on the same gate as every other rule (all of `critical`, `severe`, and `high`).

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

Code Auditor learns your codebase's unwritten conventions from the function index and flags deviations at high severity. Use these to discover norms an unfamiliar agent would otherwise break:

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

Convention readings ship at `high` severity by default. Severity is urgency — how fast a violation bites, not whether it matters. Every severity blocks the edit gate, so a `high` convention reading is a real defect to resolve, not a hint to ignore.

### `code-audit hotspots` — identify churn-prone code

Hotspots combine version-control churn with code complexity to identify files and functions that have changed frequently and are structurally complex — the strongest predictor of defect density.

```bash
code-audit hotspots                                   # Rank files and functions by hotspot score
code-audit hotspots --limit 10                        # Top 10 hotspots only
code-audit hotspots --path .                          # Trigger on-demand churn extraction if index is empty
code-audit hotspots --json                            # Machine-readable JSON output
```

On first use, run with `--path <dir>` to trigger on-demand churn extraction from git history. If no git repository is available, hotspots gracefully fall back with a warning. Hotspot data persists in the code index across sessions — subsequent runs don't need `--path` unless the git history has changed.

Terminal output shows each hotspot's type (file/function), score bar, commit count, author count, and a bus-factor warning when one author owns most changes. JSON output fields: `target`, `type`, `score`, `churnPercentile`, `complexityPercentile`, `commitCount`, `distinctAuthors`, `dominantAuthor`, `dominantAuthorShare`, `busFactorRisk`, `complexity`.

### `code-audit risk` — rank functions by architectural risk

Computes a composite risk score from call-graph centrality (PageRank and betweenness), code complexity, and test coverage status. High-risk functions sit at the intersection of "many things depend on this" and "this is complex" — they carry high blast radius when changed.

```bash
code-audit risk                                       # Rank top 20 functions by architectural risk
code-audit risk --limit 50                            # Top 50 functions
code-audit risk --path .                              # Target project directory
code-audit risk --json                                # Machine-readable JSON output
code-audit risk --format dot                          # Emit DOT call-graph for top functions
```

Use `--format dot` to generate a directed call-graph diagram (Graphviz DOT format) of the neighborhood around the top-risk functions. Pipe to `dot -Tsvg > graph.svg` for visualization.

Terminal output shows rank, function name, file path, PageRank percentile, betweenness percentile, complexity percentile, untested status, and composite risk score. JSON output fields: `functionName`, `filePath`, `pageRankPercentile`, `betweennessPercentile`, `complexityPercentile`, `untested`, `riskScore`.

> **Release checklist**: The version banner above is stamped by `npm run build:skills` from `package.json` (the single source of truth) — do not hand-edit it. Bump the version in `package.json`, run the build, and the skill copies it. `npm run verify:close` gates on test + integration + dist verification — the tag cannot move without all three green.

## Interpreting hook feedback

When an edit hook blocks your edit with a violation message:

1. **Read the violation** — it includes the invariant rule's `message` field explaining *why* the edit was blocked
2. **Fix the violation** — change your approach to comply with the invariant
3. **Do NOT retry the same edit** — the hook will block it again
4. The hook runs `code-audit changed`, and its gate blocks on every violation from any rule — `critical`, `severe`, and `high` all block; there is no non-blocking severity tier. A `high` reading blocks the edit exactly like a `critical` one; urgency only sets the order you fix things, never whether they gate.

The hook auto-installs the package via npx on first use — no manual npm step needed. If the hook reports `[code-auditor] code-audit could not run`, the npx auto-install failed (network, unsupported platform). The agent should try again; if it persists, `npm install code-auditor-mcp` is the manual fix.

## Host-specific notes

- **Claude Code**: This skill is bundled in the `code-auditor` plugin (`claude plugin install code-auditor`). The plugin also ships a `PostToolUse` hook on `Write|Edit` that runs `code-audit changed` automatically — the hook feedback section above describes that behavior. The MCP server is available as `mcp__code-auditor__*` tools for shell-less use.
- **Cursor**: Skill install via `code-audit install --agent cursor`. Cursor's `afterFileEdit` hook fires after the edit and cannot block retroactively, so violations are reported through the strongest available feedback channel — fix them even though the edit already landed.
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
| Diff-scoped audit | `code-audit changed --json` |
| List invariant rules | `code-audit config rules-list` |
| Inspect path profiles | `code-audit config profiles` |
| Resolve file profiles | `code-audit config profiles --file <path>` |
| Next file to fix | `code-audit next-file` |
| Sync index | `code-audit index sync --path .` |
| Codebase map | `code-audit map -p .` |
| Mine conventions | `code-audit conventions list` |
| Propose convention rules | `code-audit conventions propose` |
| Identify hotspots | `code-audit hotspots` |
| Architectural risk | `code-audit risk` |
| Rule reference | See `SKILL-RULE-KINDS.md` |
| Search reference | See `SKILL-SEARCH.md` |
