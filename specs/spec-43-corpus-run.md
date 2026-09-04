# Spec 43 — Corpus Run: Adjudicated Finding Classification

## The problem

The tool produces findings. The open question is whether they are **defects** or
**noise**. Every downstream consumer — the agent hook that blocks mid-edit, the
message the agent reads as a prompt, the severity that earns blocking rights —
treats a finding as if it were true. That trust has never been measured at scale.

Two gaps have already been closed and are prerequisite, not sufficient:

- **Symbol collapse** — styles and solid findings sharing one fingerprint within a
  (rule, file) pair hid 1-from-40 mistakes behind the baseline ratchet. Fixed in
  `b388716`: styles emits a value-scoped symbol (`property: value`), solid emits a
  named or `anonymous@line:column` symbol.
- **Cold==warm determinism** — per-analyzer totals hid a per-rule skew (styles
  92↔41) behind a stable sum. Fixed with `scripts/verify-cold-warm.mjs`, which
  diffs per-rule and fails on any divergence.

Neither fix says whether the finding is *right*. A stable, distinct false positive
is still a false positive. The remaining work is to run every analyzer over a
varied corpus and judge each finding. That is what this spec does, and all it
does: **a measurement run, not a fix run.** The output is a classified finding set
with reasoning. Nothing in this spec patches a finding or writes into a corpus.

## What already exists

- **Seven corpora with committed baselines** (spec 41 acceptance 5, spec 42
  baselines): recall-protocol, knex, primer/css, blitz, OpenStatus, Directus,
  Twenty. Every analyzer's per-rule count on these is a known quantity.
- **A triage taxonomy** (spec 11 R4): every finding is exactly one of **true**
  (real issue, correctly located, actionable), **false** (not a real issue),
  **true-but-useless** (technically correct, no reasonable action follows), with a
  one-sentence rationale each.
- **Per-rule cold==warm determinism** as a run-time assertion
  (`scripts/verify-cold-warm.mjs`).

## R1 — A dropped language is silent; the guard is a fixture, not a note

The Go handler was **built**, not missing. A native Go analyzer sits on disk
(`src/languages/go/analyzer-src/` — a full SOLID/indexer/parser program, compiled
to `analyzer-binary`) with zero remaining TypeScript references. It was validated
against cloned repos, then dropped without an announcement across a series of
individually-reasonable refactors: `functionScanner.ts`'s `getLanguageFromPath`
stopped mapping `.go`, and `CrossLanguageSOLIDAnalyzer` was deleted in Spec 33
*because it appeared in no run* — which reads, in hindsight, as removing something
already orphaned, not something dead. Not unbuilt: **abandoned silently**.

That is the file-accounting failure one level up. A file silently dropped is a
hard error; a *language* silently dropped is not. `.go` files were discovered,
parsed, and handed to nobody — and nothing said so.

Today the tree-sitter `TreeSitterGoAdapter` plus the universal SOLID and
documentation analyzers still emit findings on Go (verified: a `.go` and a `.ts`
file each report `documentation::function-documentation`), but the chain —
`getLanguageFromPath` → adapter registration → analyzer dispatch — has no guard.
The fix is a permanent one, not a re-wire:

- **`verify:languages`** (wired into `verify:self`): a mixed-language fixture with
  one `.go` and one `.ts` file, each an undocumented exported function, asserting
  both produce findings **and** share a rule. Any refactor that unwires Go makes
  the `.go` file emit nothing and fails the gate. This is the language-level
  analogue of the file-accounting hard error — the loss becomes unshippable
  instead of discoverable months later.

Svelte is the genuinely-never-run half of the same finding: spec 42 added `.svelte`
stylesheet extraction and it has never been run against a real SvelteKit app. It is
new code awaiting its first real input, not a re-wire to be rediscovered.

The fixture proves the *wiring*; real code proves the *rules*. So the corpus run
still clones the real inputs:

- **A mid-size Go project** — `gin-gonic/gin`, pinned at a recorded SHA (already
  named as the Go corpus in spec 11 R4) — exercises the Go rules the fixture only
  proves are reachable.
- **A SvelteKit application** — `sveltejs/realworld`, pinned at a recorded SHA —
  gives spec 42's `.svelte` extraction its first real codebase.

Both are cloned into a gitignored corpus location (`bench/real/`, per spec 11 R4),
never vendored into the repo. A corpus found too thin to be meaningful at run time
is replaced with a documented substitution, not silently retained.

## R2 — The corpus: external repos are the measurement, own repos are tracked separately

The question the run answers is: **on code neither of us wrote, which findings are
defects a maintainer would act on?** Only external repos answer that. A finding on
code Ben wrote is colored by knowing the intent behind it, so own repos serve
specific axes but never the headline number.

**External corpus (9).** Seven on-disk external repos, plus the two R1 clones.

| # | Repo | Stack | Why it is in the set |
|---|------|-------|----------------------|
| 1 | knex | TS, SQL query builder | data-access / schema surface. |
| 2 | primer/css | plain CSS design system | styles surface, no framework. |
| 3 | blitz | Next.js, TS | Next.js app (596 ts). |
| 4 | OpenStatus | TS monorepo | status-page platform; 2238 ts. |
| 5 | Directus | TS + Vue | **the Vue corpus** — 587 `.vue`; exercises spec 42 dialect work. |
| 6 | Twenty | React, TS | scale (23391 ts) + **1467 css-in-js files** (styled-components/emotion). |
| 7 | stylex | StyleX, TS | **`.stylex.ts` css-in-js** — a dialect Twenty's styled-components does not cover. |
| 8 | gin-gonic/gin (cloned) | Go | the Go adapter's first real input (R1). |
| 9 | sveltejs/realworld (cloned) | SvelteKit | the Svelte dialect's first real input (R1). |

**Own repos (3), tracked separately.** recall-protocol (the pinned validation
baseline), felaria (the small-project axis), open-design (the second-Astro
dimension). They run through the same pipeline and get the same triage, but their
judged-true rates are reported in a separate column and never folded into the
headline external number.

## R3 — Run method: all analyzers, determinism asserted, read-only

1. Every analyzer runs on every corpus: solid, dry, data-access, react,
   documentation, styles, conventions, cross-domain, schema, schema-code, and
   invariants where the corpus has a `.codeauditor.json`.
2. Each run is a **cold** run against the corpus (fresh `CODE_AUDITOR_DATA_DIR`),
   per the determinism law from spec 36: the result must not depend on index
   warmth.
3. `scripts/verify-cold-warm.mjs <corpus>` is run once per corpus and must pass —
   per-rule cold==warm identity — before that corpus's findings are triaged. A
   divergence is a bug to fix first, not a finding to classify.
4. Each corpus's git SHA and the analyzed-file content hash are recorded with the
   run (spec 41 R3 provenance). No finding is triaged without a reproducible
   source identity.
5. **No writes into any corpus.** The only artifact touching a corpus is
   `CODE_AUDITOR_DATA_DIR` pointed elsewhere and the read-only audit itself. No
   patches, no `.codeauditor.json` edits, no `node_modules` installs. The
   recall-protocol baseline is not re-pinned by this spec.

## R4 — Classification: the finding set is the deliverable

1. Every advisory finding across all twelve corpora is triaged into exactly one of
   `true` / `false` / `true-but-useless`, each with a one-sentence rationale.
   `invariants` findings are deterministic and are recorded, not triaged by hand —
   they are facts, and a false one is a bug reported separately.
2. High-volume rules may be triaged on a random sample of ≥50 findings per rule
   per corpus, with the sampling stated. Everything else is exhaustive. The
   sampling decision is recorded per rule, not buried in a total.
3. Output is a committed report — `specs/evidence/spec-43/` — holding, per
   analyzer and per rule: finding count, the three-way breakdown, judged-true rate,
   and the per-finding classification with rationale. The raw audit JSON is
   retained alongside as evidence, not summarized away.
4. No runtime LLM enters the classification. Triage is implementor labor producing
   a committed, reviewable artifact.

## R5 — The honest read: which findings are defects, which are tuning noise

From R4, one table: per analyzer and per rule, the judged-true rate. The headline
is the **external** rate — defects a maintainer would want to know about, in repos
with no connection to Ben. The own-repo rate is a separate column, present for the
small-project and Astro dimensions it uniquely covers, but never the number quoted.

The table separates the tool's output into **deterministic** (invariants, and any
rule with judged-true = 1.0 across the external set) from **advisory** (everything
else, with its measured rate). This is the adjudication data the downstream
recalibration work consumes — this spec only *produces* the data.

The report also flags, per rule, the **false-positive signature**: what the finding
looked like when it was wrong (the shared shape of its `false` cells). A rule that
is right 40% of the time and wrong 60% has a recognizable failure mode, and naming
it is the whole point — it is what tells a future consumer "this finding is the
noisy kind" versus "this finding is a defect."

## Acceptance

1. The R2 table is reproduced in the report with each corpus's recorded git SHA,
   file count, and stack — the twelve are real, not aspirational — and the external
   (9) / own (3) split is visible in the table itself, not only in prose.
2. The two R1 clones exist in `bench/real/` at a recorded SHA and are gitignored;
   the Go adapter and the Svelte dialect have each run against real input once.
3. `verify:languages` is green in `verify:self` — the mixed-language fixture proves
   `.go` and `.ts` both emit findings from a shared rule, so a future language drop
   fails the gate rather than surfacing months later.
4. Per-rule cold==warm passes on all twelve corpora; transcripts posted. Any corpus
   where it fails is fixed before triage begins, and the fix is a code change, not
   a skipped assertion.
5. The full classified finding set — every advisory finding (or its stated sample)
   across all twelve corpora, each with `true`/`false`/`true-but-useless` and a
   rationale — is committed, not summarized.
6. The per-rule judged-true table from R5, external and own rates shown as separate
   columns, with the false-positive signature per rule.
7. `npx tsc --noEmit` exit 0; suite and integration suite green (the only code
   touched by this spec is, at most, a run harness and the determinism script).

## Explicitly out of scope

- **Any patch to a finding.** False positives are classified and reported; they are
  not fixed here. The fixes are a separate spec, informed by this report.
- **Severity recalibration / blocking-rights changes** — that is spec 11's R5, and
  it consumes this report; it does not happen inside it.
- **Writes into any corpus** — the corpora are read-only reference. The only
  exception, and it is not part of this spec, is the separately-authorized
  recall-protocol baseline re-pin.
- **Publishing** — nothing here publishes. The clones are gitignored inputs, not
  deliverables.

## Reporting

Standing reporting contract. Every requirement met, failed, or not run. The
classified finding set and the judged-true table are posted in full — a summary of
them is not the deliverable; the individual classifications are.
