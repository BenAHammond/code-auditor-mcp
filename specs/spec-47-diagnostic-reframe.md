# Spec 47 — Diagnostic Reframe

**Scope:** docs + output-vocabulary change. No analyzer behavior changes.

## Context

The tool's own vocabulary undercuts what it actually is. It calls its output
**findings** and its categories **violations**, which positions it as a judge
issuing verdicts — and then has to walk that back everywhere ("severity ranks
urgency, never whether a finding is real"). That walk-back is the symptom of the
wrong frame: a linter that says "defect" and then whispers "well, severity isn't
truth" is contradicting itself in the same sentence.

The tool is a **diagnostic instrument**, not a judge. It parses code with
tree-sitter/ast-grep, runs a fixed panel of analyzers, and reports what each
measured. That maps cleanly onto three reframes:

- **Findings are readings.** A reading is a neutral measurement — a place an
  analyzer observed a rule violation — not a pre-judged defect. The instrument
  takes the reading; the human (or agent) decides what to do with it.
- **Coverage is the panel that leads the report.** A diagnostic report opens with
  what was measured — which rules ran, which fired, which were clean, which were
  not applicable, which cannot fire in the tool — before it lists any readings.
  Coverage first answers "did we even look?" so a zero-reading report can't be
  mistaken for a clean codebase.
- **Severity is triage.** Severity is not a truth score. It is the order to act:
  `critical` = act now, `warning` = act soon, `suggestion` = act when convenient.
  A `suggestion` reading is not "less real" than a `critical` one; it is lower in
  the queue.

These three are already the de-facto semantics in the code (`buildCoverageReport`,
the gate severities, the "no noise tier" note). This spec makes the *words* match
the *behavior*, so the site, SKILL.md, the CLI, and the MCP guide stop drifting.

## Vocabulary table

| old | new | note |
|---|---|---|
| finding / findings | reading / readings | output prose; the JSON/technical contract keeps `violations` (SARIF, hook exit codes, `--fail-on` field) |
| "severity ranks urgency" | "severity is triage — the order to act" | severity names (`critical`/`warning`/`suggestion`) are unchanged |
| violations listed first | coverage panel leads, readings follow | report structure |

## Requirements

### R1 — Write-up (this file) is the source of truth

The three mappings and the vocabulary table above are canonical. Every surface
below must use them consistently; a new surface that adds its own wording is a
drift bug.

### R2 — CLI output

1. The console summary line becomes the triage frame:
   `Every reading is a measurement, not a verdict — severity is triage, the order to act.`
2. `Found N violations` → `Found N readings`; the severity-count lines stay
   (they are the triage buckets).
3. `New Findings` → `New readings`; `finding(s)` → `reading(s)` in the delta and
   top-files output.
4. A **coverage panel** leads the report: emitted after the audit runs, before the
   delta/full summary, one line stating fired/clean/unassessed/not-applicable/
   cannot-fire counts. The detailed per-state coverage breakdown stays at the end.

### R3 — MCP guide

The `audit.run`/guide message (`mcp.ts`) is the same prose as SKILL.md and must
carry the same frame — readings, triage, coverage — not a fourth wording.

### R4 — SKILL.md

The agent-facing framing paragraph ("Every finding is a defect…") is rewritten to
the readings/triage/coverage frame. The `conventions` severity note and the
hook-feedback severity note use "triage" and "reading" consistently. A short
"diagnostic frame" note near the top anchors the vocabulary so later edits don't
drift it back.

### R5 — Site

`docs/lib/messages.ts` `en` copy (the source of truth; other locales fall back to
it) uses "readings" and the triage/coverage frame in the how-it-works and
examples copy. `docs/lib/analyzers.ts` keeps its analyzer catalog but leads with
coverage-first language where it frames the report.

### R6 — No behavior change

No analyzer, severity, or gating logic changes. This spec only changes the words
the report and docs use. `npx tsc --noEmit` exit 0; test + integration suites
green.

## Acceptance

1. `grep -rn "Every finding is a defect" src/ docs/ plugin/` → zero matches.
2. The CLI prints the coverage panel before the delta/full summary — transcript
   of `code-audit audit --path <corpus>` showing the panel line above the
   readings.
3. SKILL.md, `mcp.ts`, and the site `en` copy share the same three terms
   (readings / coverage panel / triage), verified by grep of the canonical phrases.
4. `npx tsc --noEmit` exit 0; `npm run test` green; `verify:close` green.

## Explicitly out of scope

- Renaming the internal `Violation` type, `violations` JSON field, SARIF output,
  or hook exit-code contract. The machine contract is a linter contract and stays.
- Re-translating the five non-English site locales; they fall back to `en` until
  translated, and that fallback is the existing mechanism.
- Any change to which findings fire, their severity, or the gate.
