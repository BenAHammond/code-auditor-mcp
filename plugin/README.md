# code-auditor Claude Code Plugin

Diff-scoped code quality auditing on every edit. Indexes your codebase, enforces invariants, and feeds violations back to the agent so fixes happen inline.

## Verified documentation

Plugin/marketplace manifest formats verified against the Claude Code plugin documentation at `code.claude.com/docs` as of **2026-07-16**. The plugin uses:

- `.claude-plugin/plugin.json` — manifest with name, description, version, author
- `.claude-plugin/marketplace.json` — marketplace catalog at repo root
- `hooks/hooks.json` — PostToolUse hook on Write|Edit
- `skills/code-auditor/SKILL.md` — skill teaching the agent when to audit, search, and enforce invariants

If the plugin format iterates in a future Claude Code release, update the manifests to match the live docs and bump the verified date above.

## What's included

| Component | Purpose |
|-----------|---------|
| `hooks/hooks.json` | `PostToolUse` on `Write\|Edit` → runs `code-audit changed --stdin --json --fail-on critical` |
| `skills/code-auditor/SKILL.md` | Teaches the agent when to use `search`, `definition`, `audit`, `config`, `tasks`, and how to interpret hook feedback |
| `scripts/hook-audit.sh` | Hook script: extracts file path from event JSON, pipes to `code-audit changed`, degrades cleanly when the package isn't installed |

**No bundled `.mcp.json`.** The hook calls `code-audit` via the CLI, which resolves through the user's `PATH` (global install or `npx`). We deliberately chose not to bundle an MCP server in the plugin manifest: the skill + CLI path is cheaper — no standing tool-schema token cost on every context window — and equivalent to the MCP surface wherever a shell exists. The standalone MCP server (`npx code-auditor-mcp`) remains available for shell-less hosts or users who prefer the MCP transport.

## The hook

After every Write or Edit, the hook runs `code-audit changed` on the edited file with `--fail-on critical`. The flow:

1. **File edited** → hook fires with the event JSON on stdin
2. **Hook extracts the file path** and pipes it to `code-audit changed --stdin --json --fail-on critical`
3. **No critical violations** → exit 0, agent continues
4. **Critical violation found** → exit 2, violation JSON is fed back to the agent, agent reads the invariant's `message` and fixes the violation
5. **code-audit not installed** → exit 0 with one-line notice, agent continues uninterrupted

### Disabling the hook

To disable the audit hook, remove the `PostToolUse` entry from the plugin's hooks. In your local plugin cache at `~/.claude/plugins/cache/`, edit `hooks/hooks.json` and remove or comment out the `PostToolUse` block, then restart Claude Code.

Alternatively, disable the entire plugin:
```
/plugin disable code-auditor
```
