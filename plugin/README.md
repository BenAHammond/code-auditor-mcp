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
| `hooks/hooks.json` | `PostToolUse` on `Write\|Edit` → runs `code-audit changed --stdin --json` |
| `skills/code-auditor/SKILL.md` | Teaches the agent when to use `search`, `definition`, `audit`, `next-file`, `config`, and how to interpret hook feedback |
| `scripts/hook-audit.sh` | Hook script: extracts file path from event JSON, pipes to `code-audit changed`, fails loudly if the CLI itself breaks |
| `scripts/hook-self-audit.sh` | Edit-time self-audit gate over `analyzers/` + `languages/` (the tool's own source) |
| `scripts/hook-common.sh` | Shared binary resolver + version-compatibility pinning for both hooks |

**No bundled `.mcp.json`.** The hook prefers the plugin's own bundled CLI (`dist/cli.js`, shipped in the same npm package, so it is always the exact version the plugin was built against), then falls back to a project-local install, then `PATH`, then `npx`. We deliberately chose not to bundle an MCP server in the plugin manifest: the skill + CLI path is cheaper — no standing tool-schema token cost on every context window — and equivalent to the MCP surface wherever a shell exists. The standalone MCP server (`npx code-auditor-mcp`) remains available for shell-less hosts or users who prefer the MCP transport.

## The hook

After every Write or Edit, the hook runs `code-audit changed` on the edited file. The flow:

1. **File edited** → hook fires with the event JSON on stdin
2. **Hook extracts the file path** and pipes it to `code-audit changed --stdin --json`
3. **No gating violations** → exit 0, agent continues
4. **Gating violation found** → exit 2, violation JSON is fed back to the agent, agent reads the invariant's `message` and fixes the violation
5. **The hook itself broke** (binary missing, version mismatch, CLI error) → exit 1 with a loud `[code-auditor] HOOK BROKEN: …` message. A broken hook is *not* a clean pass and is never silently swallowed.

### Disabling the hook

To disable the audit hook, remove the `PostToolUse` entry from the plugin's hooks. In your local plugin cache at `~/.claude/plugins/cache/`, edit `hooks/hooks.json` and remove or comment out the `PostToolUse` block, then restart Claude Code.

Alternatively, disable the entire plugin:
```
/plugin disable code-auditor
```
