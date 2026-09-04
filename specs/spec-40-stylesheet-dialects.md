# Spec 40 — Stylesheet Dialects

## The instance

`section-divider-tight` and `kit-cite` are flagged as undefined CSS classes on recall-protocol. Both are defined — in Astro `:global()` scoped style blocks, at `HeroPageBehavior.astro:31` and `DuoArticleInline.astro:451`. The extractor does not index them.

Four false positives on one corpus.

## The class

This is the third instance of the same shape. SCSS was the first — Spec 26 routed `.css` through the AST and deliberately left `.scss` on the regex path, which turned out to carry a live defect. `@theme` discovery by hardcoded filename was the second — `globals.css` searched, `global.css` missed, and every class in an undiscovered stylesheet reported undefined.

The pattern: **a stylesheet-bearing format the extractor cannot read produces a false `undefined-class` finding for every class defined in it, and nothing in the output says the styles were not read.**

That last clause is the serious part. The tool reports the classes as undefined. It does not report that it could not find their definitions. A user cannot distinguish "your class is genuinely undefined" from "I did not read the file that defines it."

## Why this gates advertising

`undefined-class` is the most immediately legible rule the tool has — a user can verify it in seconds, which is what makes it good, and also what makes a false positive expensive.

Every untested stylesheet dialect is a wall of wrong findings waiting for the first user on that stack. A Vue or Svelte project pointed at this today likely gets one, and nothing in the report explains it. That is a permanent loss of a first-time user, and it is discoverable in an afternoon.

The output of this spec is also a marketing fact worth having: the stacks the tool is verified against.

---

## R1 — Enumerate the dialects

Before fixing Astro, establish what else is unread.

For each of the following, determine whether the extractor indexes class definitions from it, and whether class *usages* are extracted from the same file:

- `.astro` — `<style>` blocks, and `:global()` within them
- `.vue` — `<style>`, `<style scoped>`, `<style module>`
- `.svelte` — `<style>`, and `:global()`
- CSS Modules — `.module.css`, `.module.scss`
- CSS-in-JS — styled-components, emotion, template-literal styles
- `.less`, `.styl`
- `@layer` blocks in files containing no `@theme`
- `<style>` blocks in plain `.html`

For each: indexed, partially indexed, or not indexed. Where partial, say which construct is missed.

**A dialect where usages are extracted but definitions are not is the false-positive case**, and it is worse than not handling the format at all — the tool sees the class used and never sees it defined.

Report the matrix. This is the deliverable of R1 regardless of what gets fixed.

## R2 — Never report undefined when styles were unread

This is the fix that matters more than any individual dialect, because it bounds the damage from every dialect not yet supported.

`undefined-class` requires a complete picture of definitions. Where the extractor knows it could not read a stylesheet-bearing file — unsupported dialect, parse failure, an `@import` it could not resolve — the rule must not assert a class is undefined.

Requirements:

- The extractor records unread stylesheet sources: path and reason.
- Where any exist, `undefined-class` reports `notApplicable` for the affected scope with a reason naming what was unread, rather than emitting findings against an incomplete definition set.
- Unread sources appear in coverage output. This is the same law as `notRun` versus zero findings, applied one level down.
- Scope is a decision to make and record: whole-run, or per-directory, or per-file. Whole-run is safest and coarsest; state which was chosen and why.

Fail loud, not silent. A user with a Svelte project should be told the tool cannot read their styles — not handed a list of classes it claims do not exist.

## R3 — Astro `:global()`

The instance that prompted this. `:global()` blocks in `.astro` `<style>` sections define real, globally-scoped classes.

Index them. Confirm `section-divider-tight` and `kit-cite` resolve on recall.

While here: `.astro` scoped (non-`:global`) styles define classes scoped to that component. Decide and record whether those are indexed as definitions — they are real definitions, and treating them as undefined is the same bug.

## R4 — Fix what R1 finds, in order of exposure

Every dialect where usages are extracted and definitions are not, fixed or explicitly excluded from usage extraction. The second option is legitimate: if the tool cannot read `.vue` styles, it should also not extract class usages from `.vue` templates, so the rule stays silent rather than wrong.

Report the decision per dialect: indexed, or excluded from usage extraction with the reason.

## R5 — A fixture per dialect

Each supported dialect gets a fixture: one class defined in that dialect, used once, asserting zero `undefined-class` findings.

Each unsupported dialect gets a fixture asserting the R2 behaviour — the tool reports it could not read the styles, and emits no `undefined-class` finding for classes it cannot verify.

These are the regression guards, and collectively they are the verified-stack list.

---

## Acceptance

1. R1's matrix, complete, for every dialect listed.
2. Recall: `section-divider-tight` ×3 and `kit-cite` ×1 no longer reported. `styles/undefined-class` drops 38 → 34, styles 114 → 110, total 5,912 → 5,908. Every other analyzer exact.
3. R2 demonstrated: construct a project with an unreadable stylesheet dialect and a class defined only there. The tool reports the unread source and emits no `undefined-class` for it — forced-failure transcript.
4. Coverage output includes unread stylesheet sources.
5. A fixture per dialect, supported and unsupported, per R5.
6. The verified-stack list, derived from R5 — which dialects are indexed, which are excluded, which are unsupported-and-reported.
7. The 20 remaining dead class hooks on recall still report. They are correct findings and must not be suppressed by R2's caution.
8. `npx tsc --noEmit` exit 0. Suite and integration suite green. Baselines exact on knex, primer/css, blitz.

## Reporting

Standing reporting contract. Every requirement met, failed, or not run.

R1's matrix is posted in full. A dialect reported as "handled" without a fixture proving it is not handled.
