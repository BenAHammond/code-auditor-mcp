# Spec 44 — Release 3.5.0 blocked on pre-existing `verify:self` drift

The 3.5.0 version bump is committed (`5e7cbe2` + `9ab2853`), the changelog is
written, and `verify:close` is green on every stage **except** `verify:self`.
The release was therefore **not** tagged or pushed to `main`: `verify:close
green` is a hard precondition for both, and it is not met.

## What is green

| stage | result |
|---|---|
| `test` (unit) | 82 files, 1182 passed, 66 skipped |
| `test:integration` | 10 files, 268 passed |
| `verify:gate-budget` | PASS (warm gate 155 ms < 300 ms) |
| `verify:dist` | PASS (tarball installs, 7 native binaries, all WASM grammars, Go subprocess pings) |
| `verify:self` | **FAIL — 30 scoped blocking violations** |

## The blocker — `verify:self` has drifted from zero

`verify:self` asserts zero `critical` + `warning` findings scoped to
`src/analyzers/` + `src/languages/` (production code, tests/fixtures excluded).
The Spec 33/35 milestone drove this to 0 ("How 461 became 0"); it has since
drifted back to **30**, all of which predate this branch.

Proof of pre-existence: 19 of the 30 sit in files that are **byte-identical**
between `origin/main` (v3.4.18) and `HEAD` — `git diff origin/main...HEAD`
shows no change to them. The same source text fed to the same analyzer produces
the same finding, so these findings existed at v3.4.18.

Remaining 30, by rule:

| rule | count | nature |
|---|---|---|
| `dry/duplicate` | 16 | 3–8-line duplicated blocks (8 in `provenance.ts` alone), flagged by the self-audit's aggressive `dry.minLineThreshold: 3` / `similarityThreshold: 0.75` |
| `solid/single-responsibility` | 8 | functions >50 lines (`flagSimilarBlockPairs` 99, `analyzeDependencyHealth` 76, …) or >4 params |
| `solid/dependency-inversion` | 3 | concrete instantiation in composition roots (warning severity, not the suggestion-level factory case) |
| `solid/class-size` | 1 | `LanguageOrchestrator` 16 methods (>15) |
| `parameter-documentation` | 1 | `countCrossLanguagePairs` missing `@param` |
| `return-documentation` | 1 | `countCrossLanguagePairs` missing `@returns` |

Files carrying the findings: `analyzers/provenance.ts` (8), `analyzers/
cross-language/DependencyGraphBuilder.ts` (2), `analyzers/cross-language/
SchemaValidator.ts` (2), `analyzers/crossDomain/CrossDomainAnalyzer.ts` (1),
`analyzers/universal/schema/jsonSchema.ts` (1), `analyzers/universal/
UniversalConventionsAnalyzer.ts` (1), `analyzers/universal/
UniversalDataAccessAnalyzer.ts` (2), `analyzers/universal/
UniversalStylesAnalyzer.ts` (4), `languages/go/GoAdapter.ts` (1),
`languages/LanguageOrchestrator.ts` (4), `languages/RuntimeManager.ts` (3),
`languages/typescript/TreeSitterTypeScriptAdapter.ts` (1).

## What this branch added — zero

The one net-new finding this branch introduced (`isGoValueType` missing
`@param`/`@returns`) is fixed in `9ab2853`; `verify:self` fell 32 → 30 as a
result. Every remaining finding is pre-existing.

## Why not just fix them now

Two of the 30 (`countCrossLanguagePairs` docs) are trivial. The other 28 are a
self-audit-to-zero remediation in their own right — deduplicating 16 blocks
across `provenance.ts` and friends, splitting oversized functions and the
`LanguageOrchestrator` class, and reworking three dependency-inversion sites —
a design-level refactor of core analysis code that is out of scope for the Spec
44 rule-authenticity remediation and risks regressing behavior that 1,450
passing tests would not all catch. That work belongs to a dedicated Spec 35/38
"self-audit to zero" pass, not a release step.

## Decision

Release 3.5.0 is **held, not shipped**: version bumped and changelogged, but
untagged and unpushed, because `verify:close` is red on a pre-existing gate.
Re-tagging/pushing is Ben's call (the same rule as publishing), and the honest
precondition is a green `verify:self` — either via the dedicated remediation or
Ben's explicit sign-off to release with a documented red gate.
