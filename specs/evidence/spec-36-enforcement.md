# Spec 36 — Enforcement — Evidence

Date: 2026-08-15

---

## Criteria

| # | Requirement | Status |
|---|---|---|
| R1 | Block at the edit, not at review | **Met** — hook runs `changed` on the edited file only, fails loudly when it cannot run |
| R2 | New findings block, existing ones don't | **Met** — `diffGate.ts` compares against prior file state, not a stored baseline |
| R3 | No bare counts in agent-facing output | **Met** — agent surfaces emit findings only, no total |
| R4 | The gate is binary | **Met** — per-rule `gating` flag; no severity tier in the gate decision |
| R5 | Three resolutions, all machine-checkable | **Met** — threshold `rationale` required; threshold-change reported |
| R6 | A rule that cannot name the next action does not gate | **Met** — `gating ⇒ resolvable` enforced; unresolvable occurrence emits non-blocking + records gap |
| R7 | Suppressions decay | **Met** — required reason; unnecessary suppression errors; reported |
| R8 | The list lives in the tool | **Met** — `code-audit outstanding` re-derives from the codebase |

Acceptance 1–8: **Met** — each requirement has a forced-failure transcript (unit tests in `src/enforcement/*.spec.ts` + the live hook transcript below).

---

## What changed

The enforcement layer that did not exist when the prior report was written is now implemented and green:

- **R1/R4/R6 — binary gate.** `src/enforcement/gate.ts` (`computeGatingDecision` / `computeDiffGatingDecision`) decides blocking from the per-rule `gating` flag, not from a severity tier. A rule participates in the gate or it does not; there is no "suggestion" softening inside the gate. The 8 gating rules are all `resolvable: true`; a gating rule that cannot name an action for a given occurrence emits the finding non-blocking and records the gap (R6's runtime fallback).
- **R2 — diff against prior state.** `src/enforcement/diffGate.ts` compares a file's current findings against its prior state (the edit's untouched lines do not block; an introduced finding blocks, including one moved past a threshold by an elsewhere edit). No baseline file, no stored suppression list.
- **R3 — findings, never totals.** The `outstanding` command and the hook/`changed` JSON path emit findings with file + line; there is no `Found N violations` aggregate in agent-facing output. The source comments in `outstanding` state the invariant explicitly: "findings, never a total."
- **R5 — threshold rationale.** `src/config/thresholdRationales.ts` requires a `rationale` string on every threshold change; a missing rationale is a config error, and a run with a non-default threshold reports the change and its delta. The project's own `dry.minLineThreshold` / `dry.similarityThreshold` overrides carry rationale entries, visible in `print-config`.
- **R7 — suppressions with decay.** `src/enforcement/suppressions.ts` requires a reason on every suppression, errors on an unnecessary suppression (the finding no longer fires), and reports the count/location of suppressions and how many are unnecessary.
- **R8 — outstanding re-derived from the codebase.** `code-audit outstanding` runs the analyzer against the tree and sorts findings deterministically (file, line, rule) so a compacted and an uncompacted agent get the same answer. Nothing is read from a progress file or a stored count.

Unit tests cover the enforcement contracts: `gate.spec.ts`, `diffGate.spec.ts`, `suppressions.spec.ts` all pass in the green suite (997 tests / 64 files).

---

## Evidence

### R1 — hook fails loudly when it cannot run (live transcript)

The source-tree guard in `app/plugin/hooks/hooks.json` exits 1 with a clear message when `CLAUDE_PLUGIN_ROOT` is unset:

```
$ CLAUDE_PLUGIN_ROOT="" bash -c 'if [ -z "${CLAUDE_PLUGIN_ROOT}" ]; then echo "[code-auditor] CLAUDE_PLUGIN_ROOT is unset; audit hook did not run" >&2; exit 1; fi; …'
[code-auditor] CLAUDE_PLUGIN_ROOT is unset; audit hook did not run
guard exit code: 1
```

The hook also no-ops cleanly on out-of-repo edits:

```
$ echo '{"tool_input":{"file_path":"/tmp/not-in-repo.ts"}}' | CLAUDE_PROJECT_DIR=… bash plugin/scripts/hook-audit.sh
out-of-repo exit code: 0
```

### R3 — no bare count in agent-facing output

`outstanding` emits one `file:line [rule] message` line per finding (icon + location + message), sorted deterministically — no total, no "N remaining." The `--json` path emits an array of finding objects, again without a total.

### R4/R5 — binary gate + threshold rationale wired into config

`print-config` names `rationales` as a `project-config [differs from default]` key, so a threshold change is visible and carries its written justification. `failOnCritical` / `minSeverity` remain human-report surfaces; the blocking decision reads only the per-rule `gating` flag.

### Full verification chain (this pass)

```
$ npm run test             → 997 tests / 64 files  pass
$ npm run test:integration → 266 tests / 9 files   pass
$ npx tsc --noEmit         → exit 0
$ npm run verify:self       → 0 scoped violations  PASS
$ npm run verify:gate-budget→ gate 183.0 ms < 300 ms  PASS
$ npm run verify:dist       → 7 guards PASS (self-contained)
```

---

## Findings

1. **The installed plugin hook is still the old unguarded command.** The source-tree guard (R1) is correct and verified, but the installed marketplace plugin (`~/.claude/plugins/marketplaces/code-auditor-mcp/plugin/hooks/hooks.json`) and its cached copy (`~/.claude/plugins/cache/code-auditor-mcp/code-auditor/3.4.0/hooks/hooks.json`) still run `"${CLAUDE_PLUGIN_ROOT}"/scripts/hook-audit.sh`. With `CLAUDE_PLUGIN_ROOT` unset this expands to `/scripts/hook-audit.sh` (not found) and blocks every Write/Edit. This is the Spec 35 item 9 propagation gap — the enforcement point Spec 36 R1 depends on — and fixing it requires touching `~/.claude/plugins/` (outside the repo) or republishing (forbidden).
2. **The gate's correctness is proven by unit tests, not by live end-to-end hook runs.** R1/R2/R4/R5/R7/R8 each have a forced-failure test in `src/enforcement/*.spec.ts`, but the live hook path cannot be exercised against the installed plugin (Finding 1). The mechanisms are complete; the one surface that cannot be demonstrated live is the installed hook's binary gate.

## Not done

- **Installed-plugin hook propagation** — the R1 enforcement point runs the stale unguarded command until the plugin is republished (out of scope). Source-tree R1 is complete and verified.
