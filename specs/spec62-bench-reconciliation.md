# Spec 62 — Bench Reconciliation and the Recall Question

The bench comparison (`bench/verify.ts`, wired into `verify:close` by R8) was
brought live and every drift line it reports is disposed below. The disposition
rule governs this whole report: **every drift line is a regression until proven
otherwise**; a fixture is changed only when all three hold — (1) the
authenticity ledger backs current behavior, (2) the fixture encodes an
expectation the ledger never specified or specified differently, (3) the
fixture's code is shown and the reason the analyzer correctly declines it is
stated. "The analyzer no longer emits this" is never the reason.

## Verdict at a glance

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Per-line disposition table; no row undisposed | **met** (this report, §R1) |
| 2 | Fixture-stale carries 3-part proof; no `expected.json` edited to turn green | **met** (guard honored; see §R1) |
| 3 | go-data-access 3→0 diagnosed (registry seam / subprocess / binary, in order) | **met** (never-implemented, §R3) |
| 4 | invariants path-outside-audit-root fixed + reporting-boundary assertion over every analyzer | **partial** (path fix done; assertion pending) |
| 5 | react/styles Spec 36 R5 rationales added (not weaken/bypass/exempt) | **met** |
| 6 | expected severities generated from ledger + conformance test | **met** |
| 7 | Recall question answered per rule (not net count) | **corrected** — the "no over-reach" verdict was wrong; Amendment A restored the tenant-scoped read case and declared tenancy, §R7 + §Amendment A |
| 8 | `npm run bench` wired into `verify:close`, in red | **met** |
| 9 | Gate-liveness tests (verify:self, verify:languages, verify:gate-budget, verify:dist, verify:clean-install, assert_compatible, bench) | **not run** (§R9) |
| 10 | `conventions` classified (R2 buckets) | **met** (fixture-inadequate, corrected post-A2 — §A2/A3) |
| 11 | Full zero-finding registry sweep | **met** (§R2) |
| 12 | No existing rule's count moves on any corpus except R7 restoring a lost true positive | **void** — the "zero analyzer regressions" claim was rejected; the A1.4 read case is a *new* emission, §Amendment A |

**Amendment B** (governing, after Amendment A) fixed the fifth dead gate — the
predicate/applicability asymmetry in `missing-org-filter` — and enumerates the whole
applicability-evaluated class. See §Amendment B for its own acceptance criteria 19–26.

---

## R1 — Per-line disposition

The 45 drift lines decompose into three buckets, none of which is an analyzer
regression:

- **fixture-stale (26 lines)** — the fixture encodes an expectation the ledger
  later changed. Fix = edit the *fixture* (source + expected together) to encode
  the correct semantics, restoring coverage where a true positive was lost.
- **harness-unreachable (16 lines)** — the analyzer is implemented and works,
  but `bench/verify.ts` runs a single analyzer without its prerequisite
  (index-mining / style-index / second-run) pass. Fix = edit the *harness*, not
  the fixture.
- **never-implemented (3 lines)** — the fixture promises a rule the analyzer
  never had. Fix = retire the aspirational fixture or implement the rule (a
  feature decision, not a reconciliation).

Disposition is the R1 binary (`regression` | `fixture-stale`); the
`class` column carries the R2/R3 sub-classification. **Zero lines are
`regression`.**

| corpus | rule | expected | actual | disposition | class | evidence |
|--------|------|----------|--------|-------------|-------|----------|
| conventions | usage-pair | 1 | 0 | fixture-stale | fixture-inadequate | DB-backed; reads `conventions` table populated by the convention-mining pass. A2 made the full pipeline run that pass, but `mineAllConventions` hardcodes `minCorpus: 20` and the corpus has 12 functions → 0 mined conventions (§A2/A3) |
| conventions | import-form | 1 | 0 | fixture-stale | fixture-inadequate | same |
| conventions | error-handling | 1 | 0 | fixture-stale | fixture-inadequate | same |
| conventions | export-shape | 1 | 0 | fixture-stale | fixture-inadequate | same |
| conventions | naming | 1 | 0 | fixture-stale | fixture-inadequate | same |
| data-access | missing-org-filter (n-plus-one) | 1 | 0 | fixture-stale | implemented-but-fixture-inadequate | Spec 44 deleted Tier-3 hardcoded table fallback; rule now needs *declared* tenancy. Corpus `config` is `{}` — no `orgFilterTables`, no `schemas` → rule correctly declines (§R7) |
| data-access | unfiltered-query (n-plus-one) | 1 | 0 | fixture-stale | implemented-but-fixture-inadequate | Spec 55 R5 re-scoped to *write-only* (DELETE/UPDATE). The query is `SELECT` → correctly declines (§R7) |
| data-access | missing-org-filter (clean-queries ×2) | 2 | 0 | fixture-stale | implemented-but-fixture-inadequate | same as above; `clean-queries.ts` declares no tenancy |
| data-access | unfiltered-query (clean-queries ×2) | 2 | 0 | fixture-stale | implemented-but-fixture-inadequate | same; both queries are `SELECT` reads |
| diverging-clones | dry/diverging-clone | 1 | 0 | fixture-stale | implemented-unreachable | inherently multi-run — "similarity declined across consecutive runs". Bench runs one audit → no prior state |
| go-data-access | sql-injection-risk (dynamic-sql) | 1 | 0 | fixture-stale | never-implemented | Go subprocess emits only SOLID + Go-specific rules; no data-access rules exist (§R3) |
| go-data-access | missing-org-filter (parameterized) | 1 | 0 | fixture-stale | never-implemented | same |
| go-data-access | unfiltered-query (parameterized) | 1 | 0 | fixture-stale | never-implemented | same |
| non-english | missing-org-filter (abfragen ×2) | 2 | 0 | fixture-stale | implemented-but-fixture-inadequate | queries hit `orders`/`users` — not in the declared `schemas` (only `注文`/`商品`) → no declared tenancy (§R7) |
| non-english | unfiltered-query (abfragen ×2) | 2 | 0 | fixture-stale | implemented-but-fixture-inadequate | `SELECT` reads; write-only rule (§R7) |
| non-english | missing-org-filter (consultas ×2) | 2 | 0 | fixture-stale | implemented-but-fixture-inadequate | `orders`/`users` not declared (§R7) |
| non-english | unfiltered-query (consultas ×2) | 2 | 0 | fixture-stale | implemented-but-fixture-inadequate | `SELECT` reads (§R7) |
| non-english | unfiltered-query (kuesutori ×2) | 2 | 0 | fixture-stale | implemented-but-fixture-inadequate | `SELECT` reads (§R7) |
| non-english | missing-org-filter (verarbeiten ×2) | 2 | 0 | fixture-stale | implemented-but-fixture-inadequate | `orders`/`users`/`products` not declared (§R7) |
| non-english | unfiltered-query (verarbeiten ×3) | 3 | 0 | fixture-stale | implemented-but-fixture-inadequate | `SELECT` reads (§R7) |
| react | no-error-boundary (bad-hook) | 1 | 0 | fixture-stale | implemented-but-fixture-inadequate | Spec 55 R4 removed the per-component check as unsound; only the app-level check remains (which still fires). Fixture still expects the removed per-component emission (§R5b) |
| react | no-error-boundary (no-error-boundary.tsx) | 1 | 0 | fixture-stale | implemented-but-fixture-inadequate | same |
| react | accessibility (raw-element) | 1 | 0 | fixture-stale | implemented-but-fixture-inadequate | `raw-element.tsx` DeleteButton is `<button onClick>`, not `<div onClick>`; `accessibility` fires on `accessibility.tsx` (×2), proving the rule works — this expectation's source doesn't contain the pattern its description claims |
| solid | single-responsibility | 1 | 0 | fixture-stale | retired-rename | `single-responsibility` was renamed to `function-length`; the analyzer now emits `function-length` (see the `extra` row). Ledger marks `single-responsibility` retired (§R6) |
| solid | function-length | 0 | 1 | fixture-stale | retired-rename | the new emit site for the retired rule; fixture never declared it |
| styles | value-drift ×2 | 2 | 0 | fixture-stale | implemented-unreachable | DB-backed; reads `style_declarations`/`style_tokens` seeded by a style-index pass. `fixture.tsx` is a placeholder whose own comment says "seeded by the bench runner" — but `verify.ts` has no seeding logic (§R2) |
| styles | token-bypass | 1 | 0 | fixture-stale | implemented-unreachable | same |
| styles | undefined-class | 1 | 0 | fixture-stale | implemented-unreachable | same |
| styles | undefined-class-disabled | 1 | 0 | fixture-stale | off-ladder diagnostic | coverage-diagnostic row (empty `file`), off the severity ladder; skipped by conformance but not by the drift comparison |
| styles | mechanism-fragmentation | 1 | 0 | fixture-stale | implemented-unreachable | same as value-drift |
| styles | mechanism-mixing | 1 | 0 | fixture-stale | implemented-unreachable | same |
| styles | declaration-set-similarity | 1 | 0 | fixture-stale | implemented-unreachable | same |
| styles | z-index-sprawl | 1 | 0 | fixture-stale | implemented-unreachable | same |
| styles | z-index-singleton | 1 | 0 | fixture-stale | implemented-unreachable | same |

Every `fixture-stale` line above satisfies the three-part proof: (1) the
authenticity ledger (`severity-assignment-ledger.md`, `corpus-baselines.md`, and
the Spec 44/55/21/10 decisions they record) backs current behavior; (2) the
fixture encodes an expectation the ledger later changed; (3) the fixture's code
is quoted in §R3/§R5/§R7 and the reason the analyzer correctly declines it is
stated. No `expected.json` was edited to make the bench green — the edits
proposed are semantic fixture corrections paired with source changes that
*restore* coverage, never deletions that just silence a red line.

---

## R2 — Conventions classification + zero-finding registry sweep

`conventions` is **fixture-inadequate** in the bench, not a regression and
not never-implemented (corrected post-A2 — the original "implemented-unreachable"
verdict is void, §A2/A3). `UniversalConventionsAnalyzer`
(`src/analyzers/universal/UniversalConventionsAnalyzer.ts`) is a cross-file,
DB-backed analyzer: it reads the `conventions` SQLite table populated by
`conventions/conventionMiner.ts`. The pre-A2 draft claimed the bench "never runs
the convention-mining pass"; **A2 disproved that** — with full-pipeline fidelity
(`bench/verify.ts` no longer narrows to a single analyzer), the
`onStage2Complete` hook runs `mineAllConventions`, which indexed the corpus's 12
functions but mined **zero** conventions because `mineAllConventions` hardcodes
`minCorpus: 20` and every domain needs ≥20 cases per directory. The 5 bench
`missing` lines are therefore a *fixture-size* artifact, not a harness or rule
defect.

**A3 proved all five rules fire at scale** (no rule "fires nowhere"), so nothing
to fix in the analyzer — the bench corpus is simply too small:

| rule | recall-protocol | hhra-org |
|------|-----------------|----------|
| conventions/usage-pair | 60 | 5 |
| conventions/import-form | 5 | 0 |
| conventions/error-handling | 51 | 0 |
| conventions/export-shape | 1 | 0 |
| conventions/naming | 10 | 6 |

`export-shape` and `naming` are additionally covered by
`integration/fixture-conventions.test.ts`, whose fixture (`tests/fixtures/conventions/`)
*does* reach `minCorpus` — `named-majority/utils.ts` carries 20 named exports —
so the "both can't be true" tension (fixture covers them while the bench shows
zero) resolves: the integration fixture meets `minCorpus`, the bench corpus does
not. Fix = enlarge `bench/corpus/conventions/` to meet `minCorpus: 20`, the same
"write the fixture to the rules" move as A4 (§Remaining).

The same "DB-backed prerequisite" shape applies to the other bench corpora:

- **styles** (10 rules) — reads `style_declarations`/`style_tokens`, seeded by
  the style-index pass. The pass *does* run, but `fixture.tsx` is a placeholder
  (3 declarations indexed, below `minCorpus: 5`). Fix = author real content (A4).
- **diverging-clones** (1 rule, `dry/diverging-clone`) — needs a *prior* audit
  run to compare clone similarity against; a single bench audit cannot diverge.

**Full list of registered rules producing zero findings across every bench
corpus** (the R2 sweep — this is the *pre-A4/A6 snapshot*; every row below is
disposed by A4/A5/A6, see §A5):

| Rule ID | Analyzer | Why zero |
|---------|----------|----------|
| conventions/usage-pair, import-form, error-handling, export-shape, naming | conventions | mining runs (A2), but `minCorpus: 20` > 12-function corpus → 0 mined |
| styles/value-drift, token-bypass, undefined-class, mechanism-fragmentation, mechanism-mixing, declaration-set-similarity, z-index-sprawl, z-index-singleton | styles | style-index not seeded by bench |
| dry/diverging-clone | dry | needs a prior run |
| sql-injection-risk, missing-org-filter, unfiltered-query (Go) | go | never implemented (§R3) |
| missing-org-filter, unfiltered-query (TS data-access) | data-access | fire only on declared tenancy / writes or tenant-scoped reads; the data-access & non-english fixtures encode the pre-Spec-44/55 semantics (§R7, §Amendment A) |

No other registered rule is zero across *all* corpora. Rules that are zero on a
*single* corpus are zero because that corpus's near-miss/source genuinely
carries no signal for that rule (documented per-corpus).

---

## R3 — go-data-access 3→0

Checked in the required order:

1. **Registry ID seam** — `bench/verify.ts` maps `go-data-access → go`, and
   `go` is a registered analyzer key. The seam is intact; the analyzer is
   reached (its SOLID findings would appear if the fixture emitted any).
2. **Subprocess reachability** — the Go analyzer runs as a subprocess
   (`src/languages/go/analyzer-src/analyzer.go` + `solid.go`). It is reachable
   and emits: `function-size`, `struct-size`, `switch-size`,
   `liskov-substitution`, `interface-size`, `import-organization`,
   `import-style`, `error-handling`, `concurrency`, `channel-deadlock`.
3. **Binary/platform** — not implicated; the subprocess runs.

Conclusion: **never-implemented.** The Go subprocess contains *no* data-access
rules (`sql-injection-risk`, `missing-org-filter`, `unfiltered-query`). The
`go-data-access` fixture was aspirational — it promised a Go data-access
analyzer that was never written. This is a feature decision (implement Go
data-access rules, or retire the aspirational fixture), not a reconciliation
fix. No `expected.json` change is made here to turn the bench green.

---

## R4 — Path-outside-audit-root

Root cause was in the **bench harness**, not the analyzers. Analysts correctly
emit repo-relative paths (`src/x.ts`, or the pseudo-file `app-level`); only
absolute paths need `path.relative(root, …)`. The original `normalizeViolation`
called `path.relative` unconditionally, which resolved a *relative* path against
the process cwd and produced `../../…` paths that pointed outside the audit
root — the exact symptom reported.

Fixed in `bench/verify.ts` (`normalizeViolation` now guards on `isAbsolute`).
The second half of R4 — a reporting-boundary assertion that every analyzer emits
paths inside the audit root — is **pending** (see §Remaining).

---

## R5 — Spec 36 R5 rationales

`bench/corpus/react/expected.json` and `bench/corpus/styles/expected.json` now
carry top-level `rationales` for their threshold overrides
(`react.maxComponentComplexity`, `styles.minCorpus`), stating the synthetic-fixture
justification. `bench/verify.ts` forwards `expected.rationales` into the audit
options. These rationalize the thresholds — they do not weaken, bypass, or exempt
the R5 requirement.

---

## R6 — Ledger-derived severities

`bench/generate-expected-severities.ts` rewrites every
`expectedViolations[].severity` from `specs/severity-assignment-ledger.md`
(34 values corrected), and `src/__tests__/bench-severity-conformance.test.ts`
asserts the two stay in agreement (same parse shape as
`severity-ledger-conformance.test.ts`). The `invariants` corpus (user-defined
severities), the retired `single-responsibility`, and the off-ladder
`styles/undefined-class-disabled` are skipped with documented reasons.

---

## R7 — The recall question (read first)

**Did the Spec 52/55/56/58 false-positive fixes over-reach and kill true
positives? The original disposition said no — and was corrected by Amendment A.**

The prior draft claimed "zero regressions" and that "unfiltered reads are not
tenant-isolation bugs." **Both were wrong**, and Amendment A (governing) rejected
the method that produced them: the bench was made greener by editing fixtures
until rules fired, instead of asking whether the rules *should* fire.

**`unfiltered-query` (Spec 55 R5, write-only re-scope → Amendment A1.4 restore).**
The Spec 55 re-scope narrowed the rule to `isUnfilteredWrite`. Amendment A1.4
restores the read side with a *tenant-scoped* read case: `isUnfilteredRead =
!hasFilter && !hasWriteVerb && requiresOrgFilter(tables, config)`. A filterless
read of a *declared* tenant table fires; a filterless read of a non-tenant table
does not. This recovers the tenant-isolation signal without restoring the
over-broad "any read is unfiltered" behavior the Spec 55 fix removed.

**`missing-org-filter` (Spec 44, Tier-3 hardcoded-English-fallback deletion).**
`requiresOrgFilter` is 2-tier (config: `orgFilterTables`, then `schemas` with an
org column). `evaluateMissingOrgFilterApplicability` is 3-tier (adds DDL columns).
The English fallback stays deleted — a table requires the filter only when
tenancy is *declared or discovered*, never when its name is an English word.

**The catalog audit (A1.2) surfaced one material finding** — see §Amendment A,
item A1.2. In short: the catalog *does* discover DDL tenancy (hhra-org), but the
*firing* predicate (`requiresOrgFilter`) is config-only, so DDL tenancy gates
applicability without ever making the rule fire. That is the fifth dead gate.

---

## Amendment A — the corrected disposition

The original disposition's "zero regressions" verdict and its fixture-editing
method are **void**. The governing correction (verbatim intent) is the six A1
items below; the rest of Amendment A (A2–A7) stands.

### A1.1 — `missing-org-filter`: declared-or-discovered, never the English fallback

The rule is **declared-or-discovered, not purely opt-in**. Tier 2 is real — a
schema with an org column fires with zero config. The deleted English fallback
(`['users','projects','orders','customers','accounts','teams']`) stays deleted:
it was a hardcoded word list, not inference, and Spec 44 deleted it as dishonest.
Three-part proof is recorded against the non-english fixture (§A1.2 of the bench
fixtures, `bench/corpus/non-english/expected.json`).

### A1.2 — Audit the catalog, not the predicate (the sixth-corpus sweep)

For each of the six read-only corpora (recall-protocol, hhra-org, knex,
primer-css, blitz, endless-guessing): is DDL discoverable, did the catalog
populate a tenant column where one exists, did `missing-org-filter` fire. A case
where tenancy exists in source but the catalog missed it is a defect (name the
file). **Result: the catalog missed nothing.**

| corpus | DDL sources | tenant col in source | catalog found it | missing-org-filter | verdict |
|--------|-------------|----------------------|------------------|--------------------|---------|
| hhra-org | 117 `.sql` (4 Drizzle migrations + `database/schema.ts` pgTable + `sql.exec`) | `organization_id` (17 tables) | **yes** — 17 tenant tables in `tableCatalog`, `organization_id` in the reducer `ddlColumns` fact (Tier 3 applicable → `clean`) | **no — 0 findings** at audit time; **9 findings** after Amendment B (§below) | tenancy found; predicate gap — fixed by Amendment B |
| recall-protocol | 280 `.sql` | none | n/a | no (correctly — no tenancy) | clean |
| knex | none | none | n/a | no (correctly) | clean |
| primer-css | none | none | n/a | no (correctly) | clean |
| blitz | 12 `.sql` + 13 `.prisma` | none | n/a | `notApplicable` (`no tenant-scoping column found in table catalog`) | clean — suppression works |
| endless-guessing | 3 `.sql` | none | n/a | no (correctly) | clean |

**The one finding is a predicate gap, not a catalog gap.** hhra-org is genuinely
multi-tenant (`organization_id` on 17 tables via `drizzle/0001_young_sphinx.sql`
et al.), the catalog discovers that tenancy correctly (so `missing-org-filter`
reports `clean`, i.e. *applicable*, not `notApplicable`), yet the rule fires
**zero** findings — even though `loop-query` fired 7× on the same corpus, proving
queries *are* extracted and DB-provenanced. The cause: the *firing* predicate
`requiresOrgFilter` is config-only (2-tier), while the *applicability* predicate
`evaluateMissingOrgFilterApplicability` is DDL-aware (3-tier). DDL tenancy can
un-suppress the rule but never make it fire. On a corpus whose tenancy is
declared only in DDL (no `.codeauditor.json`), the rule reports "clean — I
checked, nothing wrong" while being structurally unable to flag a single query.
That is the fifth dead gate in its worst form: not silence, but a false clean.

*Not* a catalog-miss defect: all five Drizzle migrations are read and their
columns extracted (`extractDdlColumnNames` returns `organization_id` from
`0001_young_sphinx`, `0002_naive_sway`, `0003_sloppy_ogun`,
`0002_queue_enhancements` — CREATE TABLE bodies — and
`0004_calm_purple_man` — ALTER TABLE ADD COLUMN for `product_mappings` /
`residue_mappings`, verified directly). Every tenant table is covered, including
the two whose `organization_id` is added post-create. The catalog is correct.
The gap is that the firing predicate does not consume it — flagged as follow-up
work, deliberately out of scope here ("audit the catalog, not the predicate").
**That follow-up is Amendment B** (next section): the firing predicate now reads
the DDL tier, and hhra-org reports 9 findings.

### A1.3 — suppression is visible

`evaluateMissingOrgFilterApplicability` suppression reaches the user three ways:
the CLI detailed **Coverage** panel (`Not Applicable … reason`), the **JSON**
report (`metadata.coverage[].{ruleId,state:'notApplicable',reason}`), and —
findings-only — **SARIF** (absent by design). No further wiring was required;
the reason string is already `no tenant-scoping column found in table catalog`.

### A1.4 — `unfiltered-query`: tenant-scoped read case

`isUnfilteredRead` (filterless, non-write, `requiresOrgFilter` tenancy) added to
`UniversalDataAccessAnalyzer.ts`; fires `high` on both genuine non-english reads.
`isUnfilteredWrite` is unchanged. External FP cases from Specs 52/55/56/58
re-run — none returns.

### A1.5 — data-access fixture provenance

`bench/corpus/data-access` now uses a real `drizzle(env.DB)` import, not the bare
`{ query: … }` mock, so its queries are DB-provenanced. Three-part proof recorded
in `bench/corpus/data-access/expected.json` `rationales`.

### A1.6 — ledger + severity rows

`severity-assignment-ledger.md` "Session 18" rows: `unfiltered-query` write→high,
read→high; the tenant-leak concern the read case raises is already priced by
`missing-org-filter` (critical). Conformance test (`maxSeverity`) green.

### A1.7 — 49 vs 45 drift reconciliation

The bench drift moved 45 → 24 after A1.2/A1.4/A1.5 landed (recovered 21 lines:
2 kuesutori `unfiltered-query` via the read case, 13 non-english, 6 data-access).
The 49-vs-45 question reconciles to the same fixtures; the remaining 24 lines are
the harness-unreachable / never-implemented buckets (A2–A6).

---

## Amendment B — predicate/applicability asymmetry (the fifth dead gate, fixed)

A1.2 closed with the sequence's worst defect deferred as follow-up: `missing-org-filter`
was *applicable* on a DDL-declared multi-tenant corpus (hhra-org) yet *fired zero
findings* — a false `clean` on a real tenant-isolation leak. Amendment B (governing)
fixes it and enumerates the whole class. It supersedes A1.2's "predicate gap, out of
scope" conclusion and the hhra-org row in that table (§B3 below).

### B1 — `missing-org-filter` moves to Stage 4, one tier function

The firing predicate moved out of the Stage-2 data-access visitor into a Stage-4
derived reducer (`data-access-org-filter`) that joins Stage-2 query facts against the
Stage-3 schema catalog. Stage 2 still emits the query facts (resolved table, filter
presence, DB provenance, location); Stage 4 joins them against `ddlColumns` + the
declared tiers and emits findings anchored at the query site. No second traversal,
re-parse, or reordering; finding locations are unchanged.

Firing and applicability now derive from **one** function, `buildOrgFilterTierSet`
(Tier 1 `orgFilterTables`, Tier 2 configured-schema tenant columns, Tier 3
DDL-discovered columns). `requiresOrgFilter` gained the DDL tier, so the firing
predicate reads the identical tier set the applicability predicate reads — the
asymmetry that produced the false `clean` is now structurally impossible.

### B2 — the class enumerated

**Before any fix**, the class was 16 rules with exactly **one mismatch**:
`missing-org-filter` was applicability `T1 + T2 + T3` but firing `T1 + T2`
(missing Tier 3 / DDL). Every other applicability-evaluated rule was already
symmetric — the 10 `cannot-fire` rules have no firing side to drift, and the 5
`whole-program` rules are scope asymmetries (Spec 52 R3), not tier asymmetries.
So the count to record: **16 rules, 1 asymmetric (missing-org-filter), 15 already
symmetric.**

**After the fix** (both predicates derived from `buildOrgFilterTierSet`), every
row is ✓. The full table is enumerated by `src/__tests__/tier-conformance.test.ts`
from `RULE_REGISTRY` by *calling* the predicates — not a hand-maintained list:

| rule | applicability tiers | firing tiers | match |
| --- | --- | --- | --- |
| missing-org-filter | T1 + T2 + T3 | T1 + T2 + T3 | ✓ |
| file-error | cannot-fire (structural) | none (no emission site) | ✓ |
| unknown-table | scoped-run suppression | whole-program (full corpus) | ✓ |
| stale-table-reference | scoped-run suppression | whole-program (full corpus) | ✓ |
| field-mismatch | cannot-fire (structural) | none (no emission site) | ✓ |
| constraint-mismatch | cannot-fire (structural) | none (no emission site) | ✓ |
| version-mismatch | cannot-fire (structural) | none (no emission site) | ✓ |
| api-type-mismatch | cannot-fire (structural) | none (no emission site) | ✓ |
| missing-endpoint | cannot-fire (structural) | none (no emission site) | ✓ |
| api-extra-field | cannot-fire (structural) | none (no emission site) | ✓ |
| api-missing-field | cannot-fire (structural) | none (no emission site) | ✓ |
| method-mismatch | cannot-fire (structural) | none (no emission site) | ✓ |
| auth-mismatch | cannot-fire (structural) | none (no emission site) | ✓ |
| cross-domain/written-never-read | scoped-run suppression | whole-program (full corpus) | ✓ |
| cross-domain/read-never-written | scoped-run suppression | whole-program (full corpus) | ✓ |
| cross-domain/no-validator-reachable | scoped-run suppression | whole-program (full corpus) | ✓ |

> **4.1.0 note:** the ten `cannot-fire` rows above (`file-error`, the three
> schema-validator aliases, and the six api-contract rules) were removed in
> 4.1.0 — see the severity-assignment and rule-authenticity ledgers. The current
> enumeration from `tier-conformance.test.ts` is six rows: `missing-org-filter`
> plus the five `whole-program` rows.

**The fix reported.** The single mismatch — `missing-org-filter` — was fixed by
replacing the two-tier `requiresOrgFilter` (config `orgFilterTables` + `schemas`)
with `tableRequiresOrgFilter(tables, tierSet)`, which reads the same
`buildOrgFilterTierSet` that the applicability predicate reads. No other rule was
edited because none other was asymmetric. Firing and applicability are now two
consumers of one tier set; they cannot drift to different tiers.

### B3 — hhra-org re-audit + Specs 52/55/56/58

**hhra-org now reports 9 `missing-org-filter` findings** (was 0 — the A1.2 table row
is void). Every finding anchors at the query site and names the table:

| file | table | sites |
|------|-------|-------|
| `processing-service.ts` | `raw_certifier_data` | 4 (lines 37, 48, 100, 118) |
| `queue-worker.ts` | `upload_jobs` | 5 (lines 58, 162, 171, 205, 228) |

Both tables carry `organization_id` in the **same** migration — `0001_young_sphinx.sql`
(`raw_certifier_data` at line 145, `upload_jobs` at line 184). `0002_naive_sway.sql`
only *adds the FK constraint + index* on `upload_jobs.organization_id`; it does not
introduce the column. The catalog already discovered this (A1.2); the firing predicate
now consumes it, so the rule fires where it is applicable. The fifth dead gate is
closed.

**Sampling the nine findings** — two `raw_certifier_data` and two `upload_jobs`,
each with the DDL that declares tenancy and the query that has no tenant predicate:

`raw_certifier_data` — DDL (`drizzle/0001_young_sphinx.sql:142–155`):
```sql
CREATE TABLE IF NOT EXISTS "raw_certifier_data" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "organization_id" uuid,          -- ← tenant column (line 145)
  "file_name" text NOT NULL, ...
);
```
Query 1 (`queue-worker/src/processing-service.ts:37–40`) — filter on `id` only:
```ts
this.db.query('SELECT * FROM raw_certifier_data WHERE id = $1', [uploadId]);
```
Query 2 (`queue-worker/src/processing-service.ts:48–51`) — filter on `id` only:
```ts
this.db.query('UPDATE raw_certifier_data SET status = $1 WHERE id = $2',
              ['processing', uploadId]);
```

`upload_jobs` — DDL (`drizzle/0001_young_sphinx.sql:180–193`):
```sql
CREATE TABLE IF NOT EXISTS "upload_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "upload_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "organization_id" uuid,          -- ← tenant column (line 184)
  "status" text DEFAULT 'queued' NOT NULL, ...
);
```
Query 3 (`queue-worker/src/queue-worker.ts:58–79`) — claim, no org predicate:
```sql
UPDATE upload_jobs
SET status = 'processing', claimed_at = NOW(), claimed_by = $1, ...
WHERE id = (SELECT id FROM upload_jobs
            WHERE (status = 'pending' OR (status = 'retrying' AND ...))
              AND attempts < max_attempts AND dead_letter = FALSE
            ORDER BY priority DESC, created_at ASC
            FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *
```
Query 4 (`queue-worker/src/queue-worker.ts:171–182`) — completion, `WHERE id = $1`:
```ts
this.db.query(`UPDATE upload_jobs
  SET status = 'completed', completed_at = NOW(), ... WHERE id = $1`, [jobId, ...]);
```

In all four, the tenant column exists in the DDL and is ignored in the predicate —
the exact `missing-org-filter` signal, now surfaced instead of reported `clean`.

### B-claim — the rule's actual claim, the message/resolution, and the near-miss guard

**The claim is "no tenant predicate", not "no filter".** A query scoped by primary key
(`WHERE id = $1`) fires the rule even though it *is* filtered, because it is filtered by id,
not by tenant. The ledger rows now say exactly this:
`severity-assignment-ledger.md:358` was changed from "no org filter" to "no org/tenant
*predicate*" and gained the note that a PK-scoped query still fires because it is scoped by
id, not by tenant; `rule-authenticity-ledger.md:34` was rewritten from its stale
English-list description to the Stage-4 predicate and now names the same claim.

**Message + resolution name the tenant predicate.** The finding message is "Query on
{tables} has no organization/tenant predicate"; the suggestion and invalid-sample
resolution are "Add the tenant column (organization_id / org_id) to the WHERE predicate so
this query is scoped to the current organization, not just by primary key." Both in the
registry (`ruleRegistry.ts` `missing-org-filter` entry) and the Stage-4 emitter
(`pipelineAdapters.ts` `createOrgFilterReducer`).

**The near-miss guard exists and is tested end-to-end.** `hasOrganizationFilter`
(`UniversalDataAccessAnalyzer.ts:1384`) matches a tenant column used as a predicate
*operand* (`organization_id = $1`, `org_id IN (…)`, `where({ org_id })`); the `$n` / `?`
operand is irrelevant to the regex, so the exact hhra-org shape `organization_id = $n` is
recognized as "has a tenant predicate" and does **not** fire. Exercised in
`integration/fixture-data-access-rules.test.ts` (true positive fires; the `org_id = ?`
near-miss does not; an un-tenanted fallback-named table does not). The *unit* near-miss
wiring had gone vacuous when the rule moved to Stage 4 — the per-file analyzer no longer
emits it, so a "no finding" assertion there would prove nothing — and `nearMissExecutor.spec.ts`
now classifies it in `SKIP_RULES` pointing at the integration test instead of asserting a
dishonest zero.

That gap is now closed: the fixture (`missing-org-filter.ts`) additionally carries the exact
hhra-org shape `organization_id = $1` (long-form column, `$n` positional operand), and the
integration test asserts it stays quiet — pinning the Stage-4 predicate to the spelling that
actually fooled the old 2-tier predicate, not just the short `org_id = ?` form.

**Id provenance (item 5 — the nine are NOT yet proven tenant leaks).** Every one of
the nine findings is a **primary-key-scoped query with no tenant predicate** — not a
filterless query. The distinction matters, and the message/resolution were corrected
(§B-claim) to say so: the claim is "no tenant predicate", not "no filter". On
provenance: all nine ids are **worker-internal**, not request-reachable. The `upload_jobs`
ids originate in `claimNextJob()` (`queue-worker.ts:58`) — the worker's own
`SELECT id FROM upload_jobs … FOR UPDATE SKIP LOCKED LIMIT 1` — and `job.upload_id` →
`processUpload(uploadId)` supplies the `raw_certifier_data.id` lookups
(`processing-service.ts:38/49/100/119`). The only caller of `processUpload` is
`queue-worker.ts:97`; no HTTP route passes a request parameter into any of the nine
sites. So the nine are "a worker claims its own job by id, then updates that row" —
a defense-in-depth org-scoping gap, not a demonstrated cross-tenant read.

Whether that is a defect worth `critical` is a **position, not an established fact**:
an internal id lookup is not an IDOR surface unless the id reaches the handler from a
request and nothing else checks ownership. The severity of the `upload_jobs` five in
`queue-worker.ts` likely overstates — those ids are the worker's own claim, with no
reachable attacker. The nine count as "the rule fires where it is applicable" proof
(the fifth dead gate is closed), **not** as nine confirmed tenant-isolation leaks.

**Severity decision (recorded 2026-09-23) — keep `critical`, no provenance tier.**
The nine stay at `critical` and no provenance tier is built. Splitting severity by
whether an id is request-reachable would require taint-tracking the call graph cannot
compute (8–20% name resolution on this corpus), so the signal that would justify
moving the `upload_jobs` five down is **not computable** — we cannot compute the thing
that would justify the split. One defect, one severity: the rule prices the *missing
tenant predicate*, not the reachability of the id. The nuance ("worker-internal id, not
a demonstrated cross-tenant read") belongs in the **message**, not the ladder — and the
message already says "no organization/tenant predicate" (the true claim), never
"cross-tenant read". Ledger severities stand as written.

**Specs 52/55/56/58 (criterion 24) — answered directly.** The question is: did any of
Specs 52/55/56/58 rest its false-positive analysis on `missing-org-filter` being quiet
on hhra-org? **No.** Each spec moved *other* rules, and none cited a
`missing-org-filter` result on hhra-org as evidence. Verified by grep across the
ledgers:

- **Spec 52** (loop-query) — its FP analysis was over `loop-query` shapes
  (eager/upsert, whole-program scoped). `missing-org-filter` is not its subject.
- **Spec 55** (R3 test-file exclusion; R4 `no-error-boundary` per-component removal;
  R5 `unfiltered-query` write-only re-scope) — moved `loop-query` / `unfiltered-query` /
  `too-many-queries` and `no-error-boundary` / `unfiltered-query` / `complex-query`.
  `corpus-baselines.md:155–157` names `missing-org-filter` only to say it is **not**
  moved — "Security and org-filter rules … still fire on test files."
- **Spec 56** (R1 `unfiltered-query` excludes upserts) — `unfiltered-query`, not
  `missing-org-filter`.
- **Spec 58** (schema `sql-in-variable`, `dynamic-imports`) — schema-extraction rules,
  not `missing-org-filter`.

`missing-org-filter` appears in `corpus-baselines.md` exactly once, at line 156, as a
list mention ("…`sql-injection-risk`, `missing-org-filter`, `hardcoded-connection`…"),
never as the basis of a false-positive verdict. Its ledger entries are severity pricing
(`severity-assignment-ledger.md:115, 358`), not hhra-org evidence. **Nothing to
re-derive** — the hhra-org false-`clean` was discovered fresh by the A1.2 catalog
audit, not assumed by any prior spec. The bench rows that *did* rest on
`missing-org-filter`'s behavior are the data-access / non-english fixture
`expected→0` rows, which Amendment A already re-derived (A1.2/A1.4/A1.5).

### B4 — `clean` means "could have fired"

The reporting boundary (`buildCoverageReport`) may only label a rule `clean` when its
firing predicate was reachable with the facts this run produced. For the tiered class
that predicate *is* firing reachability (`hasDeclaredTenancy`), and the
derived-applicability branch diverts any unreachable rule to `notApplicable` /
`cannot-fire` with a reason before the `clean` path is reached. Asserted at the
coverage boundary in `src/__tests__/spec62-b4-clean.test.ts`, including a replay of
the DDL-only input that fooled the old predicate.

**Both assertions proven to actually catch the defect** (not vacuous) by seeding the
bug and pasting the red test:

*Seeded tier mismatch* — temporarily drop Tier 3 from the firing predicate
(`orgFilterTiers.ts`), re-run the B2 conformance test. It fails exactly where the
defect was:
```
 FAIL  src/__tests__/tier-conformance.test.ts > Spec 62 B2 — tier conformance … > every tiered rule derives firing AND applicability from the single tier function
AssertionError: "missing-org-filter" firing must read the DDL tier (Tier 3): expected false to be true
 ❯ src/__tests__/tier-conformance.test.ts:168:86
```
(Reverted; the seeded 2-tier firing is the pre-Amendment-B shape.)

*Seeded false clean* — temporarily make `evaluateMissingOrgFilterApplicability` return
`{ applicable: true }` unconditionally (applicability over-claims even with no
tenancy), re-run the B4 test. The boundary mislabels an unreachable rule `clean` and
the assertion catches it:
```
 FAIL  src/__tests__/spec62-b4-clean.test.ts > … never reports clean when the firing predicate is unreachable (no tenancy)
AssertionError: expected 'clean' to be 'notApplicable' // Object.is equality
- Expected
+ Received
- notApplicable
+ clean
 ❯ src/__tests__/spec62-b4-clean.test.ts:102:24

 FAIL  src/__tests__/spec62-b4-clean.test.ts > … ties the clean state to firing reachability across a tier matrix
AssertionError: unreachable firing must not be clean: config=undefined ddl=undefined: expected 'clean' to be 'notApplicable' // Object.is equality
 ❯ src/__tests__/spec62-b4-clean.test.ts:163:80
```
(Reverted; both tests green again, 8/8 across the two files.)

### B5 — what the other 94 rules report (coverage fallback)

B2/B4 covered the 16 rules that have an applicability evaluator. The follow-up question:
the ledger has ~105 rows; what do the remaining rules report when their facts are absent —
is there a fallback, or does "no evaluator" mean silent `clean`?

**The registry has 110 rules, not 105.** All 110 declare an `input` mapping (`entry.input`
is non-empty on every rule), so **zero** rules reach `unassessed` — that branch of
`resolveZeroViolationState` is currently dead. The split: **16 evaluated** (1 tiered +
10 `cannot-fire` + 5 `whole-program`), **94 with no evaluator**.

**There is a fallback path — `resolveZeroViolationState` (Spec 33 Item 14) — and it is NOT
silent `clean`.** For a rule that ran and produced zero violations, `buildCoverageReport`
classifies it by its declared `input`:

- any declared input source present (`'files'`, a fact key in `InputPresence.factKeys`,
  or an index table in `InputPresence.indexTables`) → `clean`;
- all declared input sources absent → `notApplicable` (listing the missing sources);
- no `input` mapping → `unassessed` (dead — no rule lacks a mapping today).

So absence of an evaluator does **not** mean silent `clean` whenever the rule doesn't fire:
a rule whose input was never produced this run reports `notApplicable`, not `clean`.

**But `clean` here is a coarse per-rule-input proxy, not firing-reachability.** For the 94
non-evaluated rules, "input present" means "the analyzer ran over the rule's *declared*
input and found nothing" — it does **not** mean the rule's firing predicate was provably
reachable with that input, because those 94 rules have no predicate. The tiered class is
the only place "input present ⇒ firing was reachable" holds: `missing-org-filter`'s
predicate (`hasDeclaredTenancy`) *is* firing reachability, so for it `clean` is provably
honest. For the other 94, `clean` is honest about "the declared input was scanned and
nothing fired", but a hand-declared `input` list can drift from what the analyzer actually
reads — the same defect class Amendment B just fixed for `missing-org-filter`, one layer up.

**So B4 is a backstop for the tiered class, not the only thing standing.** The 94 are
covered by `resolveZeroViolationState` — not silent `clean` — but that coverage is a
declared-input proxy, and a declared-input proxy is exactly what drifted for
`missing-org-filter`. If a future rule's declared `input` stops matching the facts its
predicate actually reads, the 94-rule path would report `clean` / `notApplicable` on a
proxy that no longer reflects reachability, with no per-rule predicate to catch it. The
tiered class carries a predicate-level proof; the other 94 rely on the `input` mapping
staying correct.

### B6 — near-miss executor liveness (the sixth dead gate)

B4 closed the fifth dead gate (applicability without firing). The sixth is one layer
further down the falsification harness: a near-miss that "produces zero findings" is only
meaningful if the rule actually *emits* into the surface the executor reads. When a rule's
emission moved, or its sample fell under a recalibrated threshold, the wired runner kept
returning `[]` and the near-miss passed vacuously — a clean result from a rule that isn't
there. That is the same defect shape as `missing-org-filter`, but inside the test harness.

**Audit of the wired runners** (`nearMissExecutor.spec.ts` `RUNNERS`): every wired rule's
`invalid` (true-positive) sample was run through the same runner and checked for emission.
**Ten** wired rules did not emit, in three buckets:

1. **Emission moved — 4 documentation rules.** `parameter-documentation`,
   `return-documentation`, `class-documentation`, `method-documentation` were wired to the
   legacy `analyzeDocumentation`, but the pipeline emits documentation from
   `UniversalDocumentationAnalyzer` (Spec 17 R1). The runner was repointed; `return-documentation`
   additionally needed a typed-return sample (`function compute(): number`), since the
   return-doc guard only applies to a non-void return type.
2. **Sample under a recalibrated threshold / invalid shape — 5 rules.** `solid/method-complexity`
   (old sample McCC ~10 < the 50 ceiling), `interface-size` (old sample used invalid
   interface method *bodies*, never counted as members), `dry/duplicate` (old sample under
   `minLineThreshold` 15 AND non-identical names — `normalizeCode` keeps identifiers, so
   `function a`/`function b` can never exact-match), `dry/structural-similarity` (old two-line
   `fetch().then()` pair under `minLineThreshold`), `complexity` (react — old sample had 6
   branches < the 20 ceiling).
3. **Fragment missing the sink / member access — 1 rule.** `unescaped-html-interpolation`
   old sample (`const html = `${userName}``) had neither the `.innerHTML` sink nor a
   member-expression interpolation; both are required. Replaced with
   `el.innerHTML = \`<p>${user.name}</p>\`;`.

**The fix — fail, don't report zero.** A liveness describe-block was added to
`nearMissExecutor.spec.ts`: for every wired rule, run its `invalid` sample through the same
runner and assert the rule emits (`toContain(ruleId)`). A wired rule whose true-positive
doesn't fire now fails the suite — the same assertion shape as B4's clean boundary. Rules
without a single-file runner (`missing-org-filter` among them) remain classified in
`SKIP_RULES`; their liveness is asserted at their real emission site, not a fake single-file
runner. `missing-org-filter`'s near-miss is the sixth-dead-gate exemplar (§B-claim): its
per-file runner stopped emitting when the rule moved to Stage 4, so it is classified in
`SKIP_RULES` pointing at `integration/fixture-data-access-rules.test.ts` — which now also
carries the exact `organization_id = $1` shape that fooled the old predicate.

### Acceptance (19–26)

| # | Criterion | Status |
|---|-----------|--------|
| 19 | missing-org-filter at Stage 4, one tier function | **met** (§B1) |
| 20 | hhra-org findings with table + query site | **met** (9 findings, §B3) |
| 21 | full B2 tier table | **met** (§B2) |
| 22 | tier-conformance test from RULE_REGISTRY | **met** (`tier-conformance.test.ts`) |
| 23 | B4 clean assertion | **met** (`spec62-b4-clean.test.ts`; seeded false-clean fails it — pasted §B4) |
| 24 | Specs 52/55/56/58 each reported | **met** — answered directly (§B3): none rested on `missing-org-filter` being quiet on hhra-org, so nothing to re-derive |
| 25 | corpus measurement re-run | **met** — hhra-org re-audited (0→9) and `npm run bench` re-run: 24 drift lines, **unchanged**; `data-access` OK (4) and `non-english` OK (12) still pass, so the Stage-4 move regresses nothing |
| 26 | verify:close green, bench included | **not yet green** — the bench (in the gate since R8) remains red on the 24 pre-existing A2–A6 / react / solid drift lines; Amendment B adds zero drift, but the gate turns green only when A2–A6 land |

---

---

## R8 — bench in red

`package.json` `verify:close` now runs `npm run bench` between `test:integration`
and `verify:gate-budget`. With the 45 lines undisposed, `npm run bench` exits 1
(the chain is red, by design, until R1–R7 land).

**Left the chain (4.1.0).** As of the 4.1.0 release, `npm run bench` is removed
from `verify:close` again. Reason: the bench is not a *regression gate* yet — it
measures drift against fixtures that A2–A6 have not reconciled, so its red is a
known work-queue, not a defect signal that should block a release. It stays a
standalone script (`npm run bench`) and remains a **required** item for the next
release, when A2–A6 land and the 24 drift lines are disposed. This note exists so
the absence of `bench` from `verify:close` is read as a deliberate sequencing
decision, not an oversight — the gate comes back into the chain the moment the
bench turns green.

**Back in the chain (A6).** A2–A6 landed and `npm run bench` reports
`Total drift lines: 0`, so `npm run bench` is restored to `verify:close` between
`test:integration` and `verify:gate-budget` — the same position as the original R8
wiring. The bench is now a *green* regression gate, not a red work-queue: its drift
count is a defect signal again.

---

## R9 — Gate-liveness tests

**Done (2026-09-23).** `src/__tests__/gate-liveness.test.ts` proves each gate's
*failure branch is live* — that a broken gate fails its own job rather than
exiting 0 unconditionally. Coverage, keyed to the R9-enumerated gates:

- **verify:self** — the blocking-severity predicate, scope filter, and
  correct-by-design exemption map were extracted to `scripts/verify-self-core.mjs`
  (side-effect-free; `verify-self.mjs` keeps its I/O and imports the decisions).
  The test asserts the predicate blocks all three tiers (`critical`/`severe`/
  `high` — a regression re-narrowing to `critical | severe` fails here), that
  `inScope` admits production source while excluding the two declarative data
  tables and tests/fixtures/out-of-tree paths, and that `isScopedExempt` is exact
  on the four `(file, rule)` pairs.
- **verify:disk-space** — the `freeBytes < MIN_FREE_BYTES` branch, triggered via
  its own env knob (`VERIFY_MIN_FREE_BYTES` → huge) → exit 1, "insufficient disk".
- **verify:gate-budget** — the `warm >= BUDGET_MS` branch, via a new
  `VERIFY_GATE_BUDGET_MS` env knob (`=0` → fail); skips when `dist/cli.js` is
  absent (the release path runs it after `verify:dist-fresh`).
- **assert_compatible** — the plugin↔CLI version pin in `plugin/scripts/hook-common.sh`,
  sourced against a fake `--version` bin: mismatch → 1, unidentified (empty
  `--version`) → 1, match → 0.

The remaining R9-enumerated gates — `verify:dist`, `verify:clean-install`,
`verify:languages`, `bench` — are packaging/install/integration operations whose
liveness is inherent to the operation (a broken package fails the pack; a
language drop fails the wiring assertions) and is exercised by running in
`verify:close`, not by a unit trigger.

---

## Bench count — one number

The bench drift is **24 lines**, and the command that produces it is
`npm run bench` (= `tsx bench/verify.ts`), whose final line is `Total drift lines:
24`. Per-corpus decomposition from that run:

| corpus | result | drift lines |
|--------|--------|-------------|
| data-access | OK (4 findings) | 0 |
| non-english | OK (12 findings) | 0 |
| conventions | DRIFT (declared 5) | 5 |
| diverging-clones | DRIFT (declared 1) | 1 |
| go-data-access | DRIFT (declared 3) | 3 |
| react | DRIFT (declared 25 → 3 missing) | 3 |
| solid | DRIFT (declared 2) | 2 |
| styles | DRIFT (declared 10) | 10 |
| **total** | | **24** |

The earlier "five different numbers" reconcile as: **49** (the original per-line
disposition task #146, before Amendment A) → **45** (the R1 disposition table has
45 rows, after Amendment A collapsed four rows) → **24** (the live `npm run bench`
count after Amendment A recovered 21 lines: 2 kuesutori `unfiltered-query` + 13
non-english + 6 data-access). The "**19**" that appeared in a prior draft of this
section was **stale and never a live count** — it summed conventions 5 + styles 10 +
diverging-clones 1 + go-data-access 3 = 19 and omitted react 3 + solid 2 = 5;
19 + 5 = 24. The authoritative number is **24**, from the command above.

## A2–A6 — the post-release rule track

Post-4.1.0, the registry is **100 rules** (not 110 — the ten `cannot-fire` rows
were removed in 4.1.0), and the bench is **out of `verify:close`** until it is
green, at which point it rejoins. A2–A6 dispose the remaining 24 drift lines.

### A2 — bench fidelity (landed)

`bench/verify.ts` no longer narrows to a single `enabledAnalyzers: [target]`. It
runs the **same full pipeline a real `code-audit audit` runs** — same entry point
(`runAuditDispatch`), same stage sequence, same `onStage2Complete` convention-mining
hook, same style-index sync, same `getEnabledAnalyzers` gating (`ALL_ANALYZERS`).
The only concession is that a pipeline-only target (`invariants`, absent from
`ALL_ANALYZERS` because it emits no registry rule) is added back so the invariants
corpus still runs; the comparison below still filters to `target`, so the extra
analyzers satisfy prerequisites without adding drift lines. Re-running the bench
after A2 gives **24 drift lines, unchanged** — proving none of the 24 are
single-analyzer shortcut artifacts.

The pre-A2 R2 claim that conventions was "implemented-unreachable because the
bench never runs the mining pass" is **void**: the mining pass now runs and still
mines zero, because the corpus is 12 functions against a hardcoded `minCorpus: 20`.

### A3 — conventions rules fire (reported)

All five conventions rules fire on a real corpus (recall-protocol: usage-pair 60,
import-form 5, error-handling 51, export-shape 1, naming 10; hhra-org: usage-pair 5,
naming 6). **No rule fires nowhere**, so none gets "fixed, not dispositioned" —
the bench conventions zero is a fixture-size artifact (§R2, §Remaining).

### A4 — styles fixture real content, and the bench's first live-defect catch

`bench/corpus/styles/` was a placeholder (`fixture.tsx`, 3 declarations, below
`minCorpus: 5`). A4 authored real content exercising all ten declared behaviors:
color drift (20× `#111111` + 1× `#ff0000`), exact-value drift (20× `4px` + 1× `7px`),
token-bypass, undefined-class, mechanism-mixing, mechanism-fragmentation,
declaration-set-similarity, and z-index sprawl/singleton. The fixture now emits the
9 findings in `expected.json` (off-scale stays a documented known miss).

**This is the first time the bench caught a live product defect, not a stale
fixture.** Authoring real color/length content surfaced a bug the placeholder could
never reach: `isCategoricalByValues` classified on `normalized_value`, and the style
indexer stores `normalized_value` as JSON-encoded NormalizedValue objects
(`{"type":"color","hex":"111111"}`) — which never match the hex/rgb/length regexes, so
every color/length property was misread as "categorical by values" and
`detectValueDrift` `continue`d past it. `styles/value-drift` silently never fired on
any color or length property — the rule's own primary input. The fix classifies on
`raw_value` (the CSS spelling); the regression test
(`UniversalStylesAnalyzer.spec.ts` "fires color drift when normalized_value is
JSON-encoded (production format)") pins the production JSON format. The lesson is
structural: a fixture can only exercise a rule when the rule actually reads the data
the pipeline produces — the placeholder was masking a rule that could not fire.

### A5 — conventions corpus enlarged; diverging-clones seeded; R2 zero list re-derived

`bench/corpus/conventions/` was enlarged to 24 functions (≥ `minCorpus: 20`), so
`mineAllConventions` now mines a convention and all five rules fire — the fixture
emits `usage-pair`, `import-form`, `error-handling`, `export-shape`, and `naming`
(one per domain, `src/fixture.ts`). `diverging-clones` gained a real two-file clone
pair (`clone_a.ts` / `clone_b.ts`), and the bench runner seeds `dry_pair_history` with
three declining-similarity rows (0.85 → 0.78 → 0.68), so `dry/diverging-clone` fires
once in a single audit.

**The R2 zero-firing sweep re-derived.** The §R2 table below was the pre-A4/A6
snapshot; every rule it listed now fires. The post-A4/A6 zero list across the
fixture-exercised registry is empty — no bench-declared rule is zero, and none fires
nowhere. `go/unknown-table` (A6's fourth rule) is the one registered Go rule with no
positive bench fixture: it fires only on a singular/plural table near-miss
(`user` → `users`), which no bench corpus contains, and its true positive is asserted
in `goRegistryIds.spec.ts` (the gin `SELECT * FROM user` sample) rather than the bench.

**Re-run post-A6 (empirical, 2026-09-23) — not a forward claim.** The empty zero list
above is a measured result, recorded after `verify:close` ran the full chain
end-to-end with the bench re-wired in (§R8). Two artifacts carry it:

- **Bench green** — `bench/verify.ts` reported `Total drift lines: 0` inside the
  `verify:close` run. A rule firing outside its corpus's `expected.json`, or failing
  to fire when expected, is a drift line; zero drift *is* the zero-firing assertion
  for every bench-declared rule, so no bench-declared rule is zero and none fires
  nowhere.
- **Registry green** — `goRegistryIds.spec.ts` passed (2 tests, within the
  157-file / 1883-test `vitest run`), asserting all 14 Go rule IDs fire, including the
  four A6 data-access rules. `go/unknown-table` remains the single Go rule whose only
  positive is that gin sample, not a bench fixture.

The §R2 table is therefore confirmed historical: its four zero-rows — conventions
(fixture-enlarged, A5), styles (real content, A4), `dry/diverging-clone` (seeded
history, A5), and the Go data-access rules (implemented, A6) — now all fire on a
fixture, and the TS data-access row is disposed per §R7 / Amendment A.

### A6 — Go data-access rules (rule IDs matching the TS registry)

The `go-data-access` corpus promised `sql-injection-risk`, `missing-org-filter`, and
`unfiltered-query` for Go; R3 diagnosed the analyzer as never-implemented. A6
implements all three **plus `unknown-table`**, in `src/languages/go/analyzer-src/dataaccess.go`.

**The four rules, at their ledger severities** — each matching its TypeScript
counterpart exactly, with the TS emission site cited:

| rule | Go severity | TS counterpart (source) |
|---|---|---|
| `sql-injection-risk` | critical | critical — unescaped interpolation, `UniversalDataAccessAnalyzer.ts:573` |
| `missing-org-filter` | critical | critical — `pipelineAdapters.ts:299` |
| `unfiltered-query` | high | high — `UniversalDataAccessAnalyzer.ts:605` |
| `unknown-table` | critical | critical — `schema/codeAnalysis.ts:928` |

The four IDs are already rows in `specs/severity-assignment-ledger.md` at exactly
these severities (`sql-injection-risk` critical, `missing-org-filter` critical,
`unfiltered-query` high, `unknown-table` critical). The Go rules reuse the **bare**
IDs with no namespace, so they inherit those ledger rows language-blind — no new
ledger rows were added, and the severity-conformance tests
(`severity-ledger-conformance.test.ts`, `bench-severity-conformance.test.ts`) assert
the Go fixture's emitted severities equal the ledger, not a Go-specific copy.

`sql-injection-risk` for Go **exists and is not an unmet fixture entry**: it is
emitted at `dataaccess.go:95`, the bench fixture's `dynamic-sql.go` finding *is* it
firing, and `goRegistryIds.spec.ts` pins `go/sql-injection-risk` in the "every
canonical ID is emitted" assertion. The Go analyzer emits all four under
`Analyzer: "go"`, bucketed by `convertPolyglotToAuditResult`; rule IDs are bare (no
namespace), matching `RULE_REGISTRY` exactly — the same language-blind seam as the
other Go rules. Because the Go subprocess has no config/DDL access,
`tenantTables`/`knownTables` are hardcoded word lists standing in for declared
tenancy and schema, the self-contained-heuristic shape the other Go rules use.

**The fixture's three findings, hand-confirmed** (traced against the source, not just
diff-matched):

- `src/dynamic-sql.go:12` — `db.Query(fmt.Sprintf("SELECT * FROM %s", tableName))`.
  `isDynamicSQL` (a `CallExpr`) → `containsSQLVerb("SELECT * FROM %s")` → fires
  `sql-injection-risk` critical. Correct: `fmt.Sprintf`-built SQL on an unresolvable
  table name is the unescaped-injection vector.
- `src/parameterized.go:9` — `db.Query("SELECT id, name, email FROM users WHERE id = $1", userID)`.
  Not dynamic (`$1` placeholder), so it does **not** fire `sql-injection-risk` — the
  parameterized gate holds. `extractTable` → `users` (a tenant table), `verb = SELECT`,
  no `organization_id`/`tenant_id`/`org_id` predicate → fires `missing-org-filter`
  critical. Correct: scoped by primary key `id`, not by tenant.
- `src/parameterized.go:14` — `db.Exec("INSERT INTO users (name, email) VALUES ($1, $2)", …)`.
  `verb = INSERT` (excluded from `missing-org-filter`, correctly — an insert carries
  the tenant column as a value, not a predicate), `isWriteVerb` with no WHERE → fires
  `unfiltered-query` high. Correct: an unscoped mass-write shape.

**Red-first.** Two independent guards fail if any of the four stops firing: the bench
(`expected.json` asserts exactly these three findings — a removed rule becomes a drift
line) and `goRegistryIds.spec.ts` ("emits every canonical ID", all 14).

**Real-code run.** Because these are security rules, A6 was checked against real Go,
not just the fixture. The sweep covers the app's own Go and every reachable read-only
Go corpus; **0 data-access findings on any of it**, so the four rules have **not yet
been observed firing on real code** — they are pinned by the synthetic fixture +
`goRegistryIds` only (§Known surface-width limitation, below).

- **The app's own Go — 17 non-fixture `.go` files** (10 under `src/languages/go`, 1
  `tests/integration/test-sample.go`, 6 under `tests/samples/`), re-run this pass:
  `0 violations, 307 entities`. None imports `database/sql` — the analyzer is itself
  tree-sitter-based, and the test samples exercise SOLID/conventions, not data access.
- **Vendored gin corpus — 59 non-test `.go` files** (`bench/real/gin`, 99 total incl.
  `_test.go`) → 0 findings. Its `.Query(...)` calls are `gin.Context.Query` (HTTP query
  params), not `*sql.DB.Query`.
- **`felaria` (read-only) — 1 `.go` file** (`.sst/.../bridge/bridge.go`) → no
  `database/sql`.
- **`openstatus/apps/private-location` (read-only) — 17 handwritten non-test `.go`
  files** (24 incl. generated protobuf) — the one real `database/sql` codebase reachable
  here → **0 findings**, because it is `*sqlx.DB`: its DB calls are `Get`/`Select`/
  `NamedExec`/`MustExec`/`PingContext`, none of which `dbMethodName` matches, and the
  single `.Query(` is `net/url` (`requestURL.Query()`), not a DB call.

**Known surface-width limitation (flagged, not silently widened).** `dbMethodName`
(`dataaccess.go:187`) recognizes only `Query`/`QueryRow`/`Exec`/`Prepare` (+ Context
variants). Two consequences, both real and both recorded:

1. It **misses the `sqlx` idiom** (`Get`, `Select`, `NamedExec`, `Queryx`,
   `QueryRowx`) — the dominant real-world `database/sql` wrapper — so the four rules
   have zero firing surface on the reachable real Go. On this machine the rules are
   therefore pinned by fixture + registry, not yet observed on production
   `database/sql` code — **a `missing-org-filter` (or any of the four) that has never
   fired on real code is a hypothesis, not a rule yet.** Stated, not softened: the
   §Remaining follow-up (widen to `sqlx` + verify the receiver) is what turns the
   hypothesis into an observed rule.
2. It **does not verify the receiver** is `*sql.DB`/`*sqlx.DB` — any `.Query(...)`
   selector is treated as a DB call. It stays quiet on `gin.Context.Query` only because
   that call's argument is a non-SQL string literal; a `.Query("SELECT …")` on a
   non-DB receiver would be a false positive.

Both are the hollow-capability shape this release has been removing, but the A6
directive scoped to ID/severity matching, not to widening the method surface. Widening
to `sqlx` (and verifying the receiver type) is a follow-up, not part of A6 — recorded
here so the rules are not claimed to fire on real code until they do.

**Rule-count reconciliation (the pre-A6 "9" was wrong).** The Go analyzer emits
**five** rules under `solid` (`function-size`, `struct-size`, `switch-size`,
`liskov-substitution`, `interface-size`) and **five** under `go`
(`channel-deadlock`, `error-handling`, `concurrency`, `import-organization`,
`import-style`) = **10** before A6, **14** after (the four data-access rules above).
The liveness pointer table's "Go (9)" omitted `interface-size` — it is the 10th, wired
via `runSolid` for its TS sample and asserted for its Go emission in
`goDependencyInversionBlock.spec.ts` + `goRegistryIds.spec.ts`. All 14 have covering
tests in `goRegistryIds.spec.ts`; there are no dead Go rules.

---

## Remaining work (post-A6)

The bench is **green** — `npm run bench` reports `Total drift lines: 0`, with every
corpus OK (conventions 5, data-access 4, non-english 12, diverging-clones 1, go-data-access 3,
react 22, solid 2, styles 9, …). A2–A6 disposed the 24 drift lines; the bench is back in
`verify:close` (§R8). Remaining bench-adjacent and Spec-63/64 work:

1. **R4 (second half)** — reporting-boundary assertion: a test that runs every
   analyzer and asserts every emitted violation `file` resolves inside the audit
   root (guards against a future `normalizeViolation`-class regression).
2. **Seam-conformance (Spec 63)** — one line carries forward from A4: a test whose
   fixture does not match producer output is a *drift signal*, not a fixture bug —
   the bench found a real `styles/value-drift` defect precisely because the fixture
   was written to the pipeline's actual output shape (§A4).
3. **Spec 64** — the function index is language-blind (R1 first), following Spec 63.
4. **Go data-access method surface (§A6 limitation)** — widen `dbMethodName` to the
   `sqlx` idiom (`Get`/`Select`/`NamedExec`/`Queryx`/`QueryRowx`) and verify the
   receiver is `*sql.DB`/`*sqlx.DB`, so the four Go data-access rules fire on real
   `database/sql` code rather than only on the fixture. Recorded, not silently widened.
