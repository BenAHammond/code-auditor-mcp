# Spec 22 — Signal Hotfix 2: The New Analyzers Meet Reality

**Tag:** `spec-22` (no version work; release when Ben says cut)
**Source data:** the post-release dogfood triage of code-auditor-mcp@3.4.1 on the recall corpus (8,160 findings; ~21% real; ~79% false, concentrated in styles/conventions/cross-domain). Committed verbatim, hash-asserted, at `/Users/ben/playground/code-auditor/app/specs/test-feedback/test-feedback.md`. Every requirement cites it.

## Context

The Spec 17–19 hardened analyzers passed their first hostile post-release contact (SOLID ~100% judged-real, DRY all real, data-access ~50%). The Spec 10/12/15 detectors — shipped against synthetic fixtures only — produced ~6,400 false positives across six defect classes. All affected rules are suggestion-tier (entry rule held; no hook ever blocked), so this is report-trust damage, not gate damage. This spec is Spec 17's playbook applied to the new detectors: fix defect classes at the root, seed every class as a permanent fixture, measure the delta.

## R1 — Styles: undefined-class false positives (2,837 findings, the largest single noise source)

Standard Tailwind utilities (`rounded-xl`, `mb-2`, `px-4`, `whitespace-pre-wrap`) and project theme classes (`bg-accent-orange`) are flagged "no matching definition."

1. Diagnose which tier failed: the bundled default-utility dictionary (incomplete), the project-config resolution (v3 JS / v4 `@theme` never loaded for this project), or the undefined-class detector not consulting the expander at all. The diagnosis sentence goes in the CHANGELOG.
2. Fixes accordingly: the undefined-class check validates against the full expansion path — bundled default theme + arbitrary-value grammar (`mt-[17px]`) + variant prefixes + resolved project config. The bundled dictionary is generated from the Tailwind default theme, not hand-curated.
3. **Fail-open rule:** if project Tailwind config resolution fails, the undefined-class detector disables for that project with one visible warning naming the failure — a claim that a class "does not exist" may not ship on a known-incomplete dictionary. (Same principle as the negative-claim law.)
4. Fixtures: a file of ~40 standard utilities across categories → zero findings; a project-config custom class → zero findings; a genuinely undefined class (`bg-tyop-blue`) → exactly one finding.

## R2 — Styles: token-bypass on definitions and token references (~1,200 findings)

1. A CSS custom-property **definition site** (`--x: <value>` in a declaration block) is never a bypass — it is where token values are allowed to be literal. Aliased tokens (two tokens deliberately sharing a value, per the triage's `--accent`/`--brand-action` case) produce zero findings.
2. A `var(--token)` **reference** is never a bypass, regardless of what value the token resolves to. Token-bypass flags exactly one shape: a raw literal value (hex, rgb, length) in a *usage* position whose normalized value matches a defined token. Semantic aliasing between tokens is the token system working, not a violation.
3. Fixtures: definition site with alias → zero; `var(--surface-raised)` where value collides with another token → zero; raw `#22d3ee` in a component style where `--accent` exists → one finding naming the token.

## R3 — Styles: value-drift on categorical properties (~130 findings)

1. Drift analysis applies only to **continuous** value domains: lengths, colors, numeric values. Categorical properties are excluded — shipped exclusion list: `display, position, flex-direction, flex-wrap, align-items, align-content, justify-content, justify-items, text-align, vertical-align, overflow, overflow-x, overflow-y, white-space, cursor, pointer-events, visibility, float, clear, box-sizing, text-transform, font-style` — plus the structural rule: a property whose observed values are keywords (non-numeric, non-color) is treated as categorical regardless of the list. List configurable.
2. Fixture: 431 `align-items: center` + 4 `align-items: stretch` → zero drift findings; 47 `#1e2327` + 2 `#1e2328` → one drift finding (the original motivating case still fires).

## R4 — SQL extraction regression: JS identifiers as SQL (~120 findings) + alias parsing

The most serious item: `map`, `lower`, `is`, `escape`, `the`, `SET` reported as tables/injection sites — the pre-Spec-17 defect class, which is fixture-guarded. Protocol:

1. **Regression triage first:** run the Spec 17/19 fixture set (`word-the-in-comment`, `import-node-builtin`, the injection context fixtures). If any fail, it is a regression in the shared gate — fix there. If all pass while production emits these findings, a **second extraction path bypasses the shared DB-call gate** — prime suspects: Spec 15's `schema_usage` population in `UniversalSchemaAnalyzer.analyzeAST()`, the ORM adapters' `extractTableReferences()`, and the cross-domain lifecycle queries consuming what they wrote. Identify the emitter of "unfiltered query on the" by rule id and code path; the one-emitter registry accounting is re-run for every SQL-adjacent rule.
2. Whatever the path, the fix is routing, not filtering: all table extraction — raw SQL, ORM, schema_usage population — flows through the Spec 17 R2 inversion (SQL-context-only, provenance-gated receivers). No dictionary band-aids.
3. SQL alias handling lands in the same pass: `FROM x AS t` never yields `t` as a table (triage item 6).
4. Fixtures: an `Array.map`/`toLowerCase` file → zero SQL findings via *every* SQL-adjacent rule id (asserted per rule, not per analyzer); an aliased query → base table only. The diagnosis sentence (regression vs. second emitter, and which) goes in the CHANGELOG.

## R5 — Conventions: naming populations and usage-pair floors (~200 findings)

1. **Naming partitions by export kind before computing a mode.** Populations: React components (JSX-returning / `.tsx` PascalCase entities), hooks (`use`-prefixed), constants (top-level literal-initialized), functions (the rest) — using entity metadata already in the index. A directory's convention is computed per population; `submit()` is never judged against a component population. Kinds with sub-`minCorpus` populations produce nothing.
2. **Usage-pair mining excludes built-in/stdlib callees** as antecedents and consequents (`slice`, `trim`, `map`, `push`, …): co-occurrence of universal methods is arithmetic, not convention. Antecedents must be project-defined symbols (resolvable in the function index). `pairConfidence` floor rises 0.9 → 0.95 and `minSupport` 20 → 30 (interim; sweepable).
3. Error-handling verdict from the triage — legitimate alternatives at suggestion severity — is recorded as working-as-intended; no change.

## R6 — Evidence

1. The triage committed verbatim with hash test; a resolutions doc cites items 1–7 → requirements.
2. Fixture-per-class as specified above; all absorbed as bench labels.
3. Before/after full-audit counts on the recall-shaped corpus classes per analyzer, with per-requirement attribution — expected: styles noise collapses by ~4,000, conventions by ~150, data-access JS-as-SQL to zero, while R1.4/R2.3/R3.2 positive fixtures prove the detectors still fire on their true cases.
4. Confirmation that every touched rule remains suggestion-tier and the hook path is byte-identical before/after on the hook fixtures.
5. Real-surface transcript (installed tarball, per the 3.4.1 lesson): a Tailwind project audits with zero undefined-class noise; `verify:close` green; tag `spec-22`.

## Out of scope

- Tier promotion for any new detector — that is the next recalibration pass, run under the amended two-corpus method, for which this spec's fixtures and the committed triage are the required inputs.
- The line=0 indexing root-cause and skill self-update (tracked post-release issues, separate work).
