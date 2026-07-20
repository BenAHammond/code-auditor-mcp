# Spec 16 — Multi-Agent Distribution

**Ships as:** v3.7.0 (tag `spec-16`)
**Depends on:** Spec 15 merged and tagged. (Independent of 12–15's detectors; sequenced last only to keep one workstream.)
**Ground truth basis:** July 2026 ecosystem research. Agent Skills (SKILL.md) is an open standard (agentskills.io, stewarded by the Agentic AI Foundation) adopted by ~40 tools including OpenAI Codex, Cursor, Gemini CLI, GitHub Copilot/VS Code, Windsurf, Goose, and JetBrains Junie. Cursor and Codex CLI both ship stdin-JSON lifecycle hooks with blocking semantics. Because these surfaces iterate, every integration below carries the same rule as Spec 07 R1.2: **verify the current format against each tool's live documentation at implementation time; training memory and this spec's snapshot are not sources.** Record verified doc dates in the docs matrix (R5).

## Context

The tool is host-agnostic by design; until now only Claude Code got first-class packaging. The skill is already portable — SKILL.md is the cross-vendor standard — so this spec closes the remaining gaps: putting the skill where each tool looks, adapting the blocking hook to each tool that has hooks, and listing on the registries where users discover skills.

## R1 — Universal skill audit

1. Sweep SKILL.md and companions for host-specific assumptions (Claude-specific tool names, slash-command syntax, plugin references). The skill body must be host-neutral: it teaches the `code-audit` CLI, which is identical everywhere. Host-specific notes (e.g., "in Claude Code this is also available as the code-auditor plugin") are permitted only in a clearly marked final section.
2. Frontmatter conforms to the base agentskills.io spec — `name` and `description` only; no vendor extension fields. The description names cross-tool trigger phrases.
3. The skill ships with zero bundled scripts (the CLI is the executable). This is stated in the skill README as a security property: nothing to review but markdown, in an ecosystem that has already had a malicious-skills incident.

## R2 — `code-audit install` (our installer beats a paths page)

1. New subcommand: `code-audit install --agent <claude|cursor|codex|gemini|agents|all> [--scope user|project]`. Copies the skill folder to the correct location per agent and scope: `~/.claude/skills/` / `.claude/skills/`; `.cursor/skills/`; `~/.codex/skills/` / `.codex/skills/`; `~/.gemini/skills/` / `.gemini/skills/`; `agents` targets the neutral `~/.agents/skills/` / `.agents/skills/` alias. `--agent all` does all of the above, skipping paths whose parent tool directory doesn't exist and saying so.
2. For agents with hook support (below), `install` also offers hook wiring: writes or merges the hook entry into the tool's hooks config **only with explicit confirmation per file it will touch**, showing the exact JSON it will add. Never silently edits a user's hooks.json. `--hooks` / `--no-hooks` flags make it scriptable.
3. `code-audit install --list` prints the support matrix (agent, skill path, hooks available y/n, detected installed y/n).
4. Idempotent: re-running updates in place; version recorded in the copied skill folder.

## R3 — Cursor hook adapter

1. Hook entry for `.cursor/hooks.json` (project) or `~/.cursor/hooks.json` (user): `afterFileEdit` → a shipped adapter (`code-audit cursor-hook`) reading Cursor's stdin JSON (`file_path`, `edits`, `workspace_roots`), invoking the diff-scoped audit on the edited file, and responding in Cursor's expected stdout-JSON/exit-code contract.
2. Blocking semantics: implement whatever feedback the current `afterFileEdit` contract honors, verified against cursor.com's hooks documentation at implementation time; if `afterFileEdit` cannot block retroactively, the adapter reports violations through the strongest channel the event supports and the docs matrix states the difference from Claude Code/Codex honestly ("advisory on Cursor, blocking on Claude Code and Codex" if that is the truth).
3. Binary resolution and failure notices per the D3/D4 rules — npx fallback, no silent outcomes.

## R4 — Codex integration (hooks + plugin)

1. Hook entry for Codex's hooks configuration: `PostToolUse` matched to file-editing tools → the same stdin adapter pattern (`code-audit codex-hook`), exit code 2 blocking with violations on the feedback channel the contract defines. Codex's hook shape closely mirrors Claude Code's; the adapter reuses the shared core with a thin payload mapper.
2. Codex plugin: package skill + hook wiring in Codex's plugin format (plugins bundle skills, hooks, and MCP entries) and list it via Codex's marketplace mechanism, mirroring the Claude Code plugin's contents minus MCP (same A2 skill-first rationale). Verified against Codex's current plugin docs at implementation time; if the format is too unstable to ship confidently, ship hooks-config + `code-audit install --agent codex` documentation instead and record that decision with the doc evidence — that is a permitted outcome, not a hedge, because the installer path fully covers Codex either way.
3. Gemini CLI: skill install only (R2 covers it; no hook system exists there as of the research date). No Gemini-specific work beyond the installer path and docs row.

## R5 — Docs matrix and registry listing

1. README gains a "Works with your agent" section: one row per tool (Claude Code, Cursor, Codex, Gemini CLI, VS Code/Copilot, other SKILL.md-compliant tools) × columns: skill (how), hooks/blocking (yes/advisory/no), MCP (yes for shell-less), verified-against-docs date. Honest cells — no "supported" where the truth is "the standard says it should work."
2. Submit the skill to skills.sh and Agensi (the two largest registries per research), with listing metadata pointing at the GitHub repo as canonical. Registry listing evidence is the live listing URL.
3. The `config generate` action's 12 tool targets are re-verified against this matrix; stale generators (tools that migrated to SKILL.md/MCP since the generators were written) are updated or retired with a CHANGELOG note.

## R6 — Evidence

1. `install` transcripts: `--agent all --scope user` on a machine with at least Claude Code and one other agent present; `--list` matrix output; idempotent re-run.
2. Cursor transcript: hooks.json wired, violating edit in Cursor produces the adapter's response per the verified contract (captured stdin/stdout pair at minimum if end-to-end UI capture is impractical — the adapter contract test is the gate, the UI capture is bonus).
3. Codex transcript: hook fires on a violating edit with exit-2 blocking; plugin install transcript or the documented R4.2 fallback decision with doc evidence.
4. Skill-accuracy gate re-run (A2 R5.3) after the R1 neutrality sweep — every taught command still exits 0.
5. Registry listing URLs live; README matrix present with verification dates.
6. Tag `spec-16`; release commit v3.7.0.

## Out of scope

- Hook adapters for tools without hook systems (Gemini CLI, and any tool where research at implementation time finds none) — skill + MCP + CLI cover them; the matrix says so plainly.
- Windsurf/JetBrains/Kiro-specific packaging beyond standard-compliant skill install paths via `--agent agents` and documentation — added on demand, not speculatively, given ecosystem churn (e.g., Gemini CLI's announced replacement by Antigravity CLI for some tiers).
- Any change to the MCP server; it remains the shell-less side door for all hosts, unchanged.
