# Spec 36 — Enforcement

## Why

The tool's consumer is an LLM, and the evidence says an LLM will route around a finding when acting on it is inconvenient. The clearest instance is in this project's own history: 727 self-audit findings were turned into a tracked count, the count became the thing reported on, and `UniversalSchemaAnalyzer` grew to 2,621 lines while the tool flagged it the whole time. Nobody decided the finding didn't matter. It stopped being visible once it was a statistic.

Advisory output is not enough. This spec makes the correct path the cheap one and removes the representations that make routing around a finding feel like progress.

**Hard constraint: no autofix.** Code-auditor does not generate code — that would require being an LLM, which is not what this is. The consumer is the LLM. The tool's job is to make the finding unambiguous enough that the consumer's judgement is needed only for the edit itself.

---

## R1 — Block at the edit, not at review

A `PostToolUse` hook runs `code-audit changed` against the file just written. If it produces a finding attributable to that edit, the write is reported as failed and the agent sees the finding in the same turn, while it still holds the context of what it just did.

This is the mechanism that prevents the 2,621-line file: method 16 fails, not method 45.

It already exists and has been failing open all month — `CLAUDE_PLUGIN_ROOT` unset, and a blocking error on out-of-repo paths. Spec 35 item 9 fixes both. This spec depends on that landing.

Requirements:

- Runs on the edited file only, never the tree.
- Exits non-zero when the edit introduced a finding.
- Output is the finding, not a summary of findings.
- A hook that cannot run — missing binary, unset variable, bad path — fails loudly. A guard that fails open looks like coverage and is worse than no guard.

## R2 — New findings block, existing ones don't

Zero findings is unreachable on an existing codebase, and a baseline is a suppression list that nobody revisits. The linter ecosystem converged on a third answer: enforce on the diff.

You touched this file, you own what you added. No baseline file, no list to maintain, and it converges as files get touched.

Requirements:

- The blocking gate compares against the file's prior state, not against a stored baseline.
- A finding at a line the edit did not touch does not block.
- A finding the edit introduced blocks, including one introduced at an untouched line by a change elsewhere in the file — moving a method past a threshold counts.
- Non-blocking findings still appear in the full report. This scopes enforcement, not visibility.

## R3 — No bare counts in agent-facing output — REVERTED by Spec 45 Amendment A (A2)

> **Reverted.** Spec 45 Amendment A (A2) removes this requirement. Counts are now
> emitted where they are useful — per analyzer, per rule, per severity, and the
> before/after gating count — on agent-facing surfaces as well as human ones.
> The original R3 text is kept below for history.

The tool never emits "727 findings" to an agent. Only findings, each with file and line.

This is the direct fix for what happened here. If the aggregate is not available, it cannot be tracked instead of the items.

Requirements (all reverted by A2):

- ~~Agent-facing surfaces — the hook, `changed`, the MCP tool response — emit findings, never a total.~~
- ~~Human-facing report surfaces may aggregate. A person reading a report needs shape; an agent deciding what to do next does not.~~
- ~~No "N remaining" progress figure anywhere an agent reads.~~

## R4 — The gate is binary

ESLint shipped warn and error, and the ecosystem spent a decade learning that a warning is a finding nobody fixes. `--max-warnings 0` and "error or off" are where it landed. This project's own data agrees: 502 of the 727 were suggestion-severity and sat untouched for months.

Severity stays in human reports. The blocking path is binary — a rule either gates or it does not.

Requirements:

- Each rule declares whether it participates in the blocking gate.
- No severity tier in the gate's decision.
- Path profiles may exclude a file from the gate entirely; they may not soften a finding within it. Capping to suggestion is how 672 findings became invisible without being excluded.

## R5 — Three resolutions, all machine-checkable

A finding resolves exactly one of three ways and there is no fourth:

1. **Fix the code.** The finding disappears on re-run.
2. **Fix the rule.** The rule changes, and a test proves the new behaviour.
3. **Calibrate the threshold.** The config changes, and a rationale field is required alongside it.

There is no acknowledged state, no deferred state, no annotation that makes a finding quiet without one of the above.

The threshold path needs its own guard, because Spec 33's item 15 was closed by moving `maxLinesPerMethod` 50→100 while chasing a zero, which dropped recall's `single-responsibility` by 660. Requirements:

- A threshold change requires a `rationale` string in config. Missing rationale is a config error.
- A threshold change is reported as a threshold change — the run states which thresholds differ from default and by how much.
- The cost of deferring must exceed the cost of fixing. A committed config change with a written justification that shows up in review is more expensive than adding a JSDoc comment. That asymmetry is the mechanism.

## R6 — A rule that cannot name the next action does not gate

If a rule can only say what is wrong and not what to do, it belongs in the human report, not the blocking path.

This is a real filter and it would have caught the failure here early: `class-size` firing on a 44-method class without naming which methods to move is a finding an agent will negotiate with rather than act on.

Requirements:

- Each gating rule produces a resolution alongside the finding. Spec 37 defines that contract.
- A gating rule with no resolution for a given occurrence emits the finding non-blocking and records that it could not name an action. That record is itself a defect in the rule.

## R7 — Suppressions decay

If a suppression mechanism exists at all, it must expire when it stops being necessary. TypeScript's `@ts-expect-error` errors when the error goes away; ESLint back-ported the same idea as `--report-unused-disable-directives`.

A suppression that outlives its reason is a baseline entry with better branding.

Requirements:

- Any suppression carries a required reason.
- An unnecessary suppression — the finding no longer fires — is itself an error.
- Suppressions are reported: how many exist, where, and how many are unnecessary.

## R8 — The list lives in the tool

The board that took fifteen items and a direct question to surface existed only as prose in an agent's notes, and died at every compaction.

Outstanding work is re-derived from the tool on every invocation. Nothing durable lives in the agent's head or its scratch files.

Requirements:

- `code-audit` answers "what is outstanding" from the codebase, not from a stored list.
- A compacted agent asking that question gets the same answer as an uncompacted one.
- No progress file, no tracked count, no state that can drift from the code.

---

## Acceptance

Each requirement gets a forced-failure transcript. A gate never observed failing is not a gate — that lesson cost three dark analyzers, a dead `filesProcessed` check, an inverted threshold, and a hand-built status.

1. **R1** — edit a file to introduce a finding; the write reports failure with the finding. Then unset `CLAUDE_PLUGIN_ROOT`; the hook fails loudly rather than passing.
2. **R2** — a file with a pre-existing finding: edit an unrelated line, confirm no block. Introduce a new finding, confirm block. Move a method past a threshold without editing its line, confirm block.
3. **R3** — `grep` agent-facing output for a total. Zero matches.
4. **R4** — a rule declared non-gating produces a finding without blocking. A path profile excludes a file entirely; confirm no soften-in-place path exists.
5. **R5** — a threshold change without a rationale is a config error. A run with a non-default threshold reports it.
6. **R6** — a gating rule that cannot name an action for an occurrence emits non-blocking and records the gap.
7. **R7** — an unnecessary suppression errors. A suppression without a reason errors.
8. **R8** — ask for outstanding work twice, once after clearing all agent state. Identical answers.

Plus: all recall, knex, primer/css and blitz baselines exact. This spec adds enforcement and changes no rule's logic.

## Reporting

Standing reporting contract. Every requirement met, failed, or not run.
