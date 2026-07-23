# Spec 12 — Convention Mining

**Ships as:** next minor version, assigned at release time in publish order (tag `spec-12`, one publish point per spec from here on)
**Depends on:** Spec 11 merged and tagged (bench harness, triage machinery, R5 promotion bars are standing law for every new detector).

## Context

The codebase's own corpus defines its conventions statistically: 52 callers use `parseApiSuccessEnvelope`, so the 3 that raw-parse are findings even though no rule says so. This spec learns dominant patterns from the index and flags minority deviations — invariant rules the user hasn't written yet — and proposes the writable ones as actual rules. This is the LLM-drift thesis aimed at code idioms: drift is by definition minority deviation from the codebase's own modes.

## R1 — Mined convention domains (five, exactly)

All mining runs over the existing SQLite index at sync time; results cached in a `conventions` table (domain, pattern, support, confidence, exemplar locations) and recomputed on full sync.

1. **Usage pairs** — association mining over per-function call sets: antecedent→consequent pairs (call A ⇒ also call B) with confidence ≥ `pairConfidence` (default 0.9) and support ≥ `minCorpus` (default 20). Functions containing the antecedent without the consequent are findings. This is the `parseApiSuccessEnvelope` case.
2. **Import form** — per module specifier: dominant form (alias vs relative vs deep path) at share ≥ `modeShare` (default 0.8); minority import sites flagged.
3. **Error-handling shape** — per directory: dominant shape among try/catch, promise `.catch`, and result-envelope return, computed over functions with any error handling; deviants flagged only where a mode ≥ `modeShare` exists over ≥ `minCorpus` functions.
4. **Export shape** — per directory: default vs named export mode; deviants flagged under the same thresholds.
5. **Naming** — per directory: dominant exported-symbol casing convention; deviants flagged. (Distinct from the `naming` rule kind: this is mined, not declared.)

## R2 — The `conventions` analyzer

1. Standard `AnalyzerFunction`, enabled by default, **all findings at `suggestion` severity** — promotion above suggestion only via measured clearance of Spec 11 R5 bars, recorded in the recalibration table.
2. Every finding names the convention, its numbers, and an exemplar: "38 of 41 fetch call sites parse via parseApiSuccessEnvelope (see src/api/heroes.ts:112); this one raw-parses."
3. Scoped runs (hook path) evaluate scoped functions against full-index conventions; statistics never come from the scope alone.
4. Thresholds (`pairConfidence`, `modeShare`, `minCorpus`) configurable via analyzer config and sweepable via `pnpm bench --sweep`.

## R3 — Rule proposal

1. `code-audit conventions` — lists mined conventions with stats, `--json` supported.
2. `code-audit conventions --propose` — for conventions expressible in existing rule kinds (naming → `naming`, import form → `import-ban` with `except`), emits ready-to-paste rule JSON with the mined evidence as a comment-style `message`. Conventions with no expressible kind are listed as "detector-only." Proposals are printed, never auto-written to `.codeauditor.json`.
3. The skill gains a "mine and propose rules" workflow: user asks "what conventions does this codebase have?" → agent runs the CLI, discusses, writes accepted rules via the existing rules-management duty.

## R4 — Measurement (inherited law)

Bench corpus gains convention fixtures per domain (seeded dominant pattern + seeded deviants + near-miss files where no mode exists and nothing may fire). Triage sample per Spec 11 R4 rules on the Spec 11 pinned corpora (this repo, excalidraw, gin). Numbers land in the recalibration table.

## Acceptance evidence

1. Bench green with new fixtures and baseline; sweep curves for the three thresholds with chosen defaults.
2. Transcript: full sync on this repo → `code-audit conventions` output → at least one true mined convention shown with correct numbers; `--propose` emits valid rule JSON passing `rules-check`.
3. Scoped-run transcript: a deviation introduced by an edit is caught by the hook path against full-index stats.
4. Triage report section; suggestion-severity default confirmed in shipped config.
5. Tag `spec-12`; release commit the next minor version at release.

## Out of scope

- New rule kinds. Proposals map to existing kinds or stay detector-only.
- Cross-repo/organization-level mining — a design boundary, not a deferral: the data model is one index per project, and multi-repo aggregation is a different storage and identity model. If the tool grows an org story, that is its own spec series.
