# Spec 21 — Language-Neutral Detection

**Ships as:** no version work — specs never touch version fields (tag `spec-21`)
**Sequencing:** after Spec 20, before Spec 11. Revised forward order: 20 → 21 → 11 → 10 → 12 → 13 → 14 → 15.
**Why before 11:** Spec 11 certifies precision/recall on bench corpora that are English-identifier projects. If detection depends on English name lists, 11 would publish numbers that silently don't hold for non-English codebases. Detection goes language-neutral first; 11 then measures the neutral mechanism.

## Context

Several detection heuristics gate on developer-chosen identifier names drawn from English word lists: `dbReceiverNames` (`db`, `database`, `pool`, …), the validator name heuristic (`validate*`, `assert*`, `parse*Schema`), and path/exempt defaults. A codebase naming its handle `banco`, `datenbank`, or `データベース` (all legal JS/TS) matches nothing — the schema and data-access analyzers go silently dead for that project, with no signal that detection failed. This is a false-negative class invisible by construction, the GoAdapter failure shape. Fixed keywords are NOT the problem and are not translated: SQL grammar (`FROM`, `INSERT INTO`) and library API surfaces (`.prepare()`, `.exec()`, `.batch()`) are language-invariant by spec.

## R1 — Provenance-based DB receiver detection (primary mechanism)

A receiver is a DB receiver because of where its value came from, never because of what it is named. The shared DB-call detection module (Spec 19 R2.1) gains a provenance resolver; an identifier is DB-provenanced iff any of:

1. **Package provenance:** it holds a value imported from a known DB package, or returned by a call to such an import. Shipped package list (data, configurable, extensible): `better-sqlite3`, `drizzle-orm` (+ dialect subpaths), `@prisma/client`, `pg`, `mysql2`, `postgres`, `kysely`, `knex`, `mongodb`, `mongoose`, `@libsql/client`, `@planetscale/database`, `@neondatabase/serverless`, `@vercel/postgres`, `bun:sqlite`, `node:sqlite`. Package names are the one universal vocabulary — identical in every human language.
2. **Binding provenance:** assigned from `env.<name>` where `<name>` matches `dbBindingNames`, or from a member/call chain rooted at a DB-provenanced value (`db.prepare(...)` → the statement is provenanced; `drizzle(env.DB)` → the instance is).
3. **Type provenance (TS):** declared or annotated with a known DB type (`D1Database`, `D1PreparedStatement`, `Database`, `Pool`, `PrismaClient`, `Kysely<…>`, configurable list) — textual annotation match, no type checker required.
4. Provenance propagates through const/let assignment, destructuring, default parameters, and class-field initialization within a file; cross-file: an export whose initializer is provenanced carries provenance to its import sites (the function index's dependency data supports this).

## R2 — Per-project usage inference (secondary mechanism)

1. During full sync, any identifier established as DB-provenanced under R1 seeds inference: other identifiers in the project that (a) receive values from the same provenance chains or (b) are call receivers of the exact fixed API-method set (`dbCallMethods`, exact match) AND flow into/from provenanced values, join the project's inferred receiver set, stored in SQLite and refreshed on sync.
2. Inference is conjunctive by design — a variable named anything joins only via provenance-linked evidence, never via name and never via method-name alone (`cache.first()` on a Map stays out; `banco.prepare(...)` where `banco = drizzle(env.DB)` is in via R1 anyway).
3. `code-audit config detection` prints the resolved receiver set with the evidence per entry (which rule admitted it) — the inspectability surface; silent detection sets are how this bug class hid.

## R3 — Name lists demoted to fallback

`dbReceiverNames` and `dbBindingNames` remain as configurable fallbacks, documented as the escape hatch for codebases whose provenance is invisible (dynamic requires, injected globals). The shipped default list is unchanged (no translation expansion — names only gate conjunctively with exact API-method match, and the docs state plainly that provenance is the primary mechanism and config is the fix if detection misses).

## R4 — Validator provenance

1. The Spec 15 validator set design is amended ahead of implementation: primary mechanism is package provenance — imports from `zod`, `joi`, `ajv`, `valibot`, `yup`, `superstruct`, `arktype`, `@sinclair/typebox`, `class-validator` (configurable list) mark the importing symbols and their call results as validators.
2. The `validate*`/`assert*` name heuristic demotes to fallback with the same conjunctive posture; user `validators` config unchanged as the override of record.

## R5 — Unicode identifier correctness

1. Extraction, the naming analyzer, exempt/profile glob matching, and search tokenization handle full Unicode identifiers (`база`, `データベース`, mixed-script camelCase) without crash, mis-span, or silent skip.
2. The naming rule kind and (forward requirement on Spec 12's naming-convention mining) casing detection treat non-Latin identifiers as **unclassifiable, therefore never violations** — a casing convention regex must not flag what it cannot parse.
3. The camelCase/snake_case FTS tokenizer (Spec 03) passes non-Latin identifiers through intact rather than dropping them.

## R6 — Fixtures and the Spec 11 corpus mandate

1. Fixtures: `banco = drizzle(env.DB)` with a loop-query inside — fires (provenance, zero name-list hits); `датаБаза.prepare()` chain — fires; a Map named `database` with `.first()` calls — silent (name without provenance); validator via zod import under a Portuguese function name — recognized; naming analyzer over a Cyrillic-identifier file — zero casing violations, zero crashes; `config detection` output showing per-entry evidence.
2. **Spec 11 amendment (binding on 11's implementation):** the bench corpus gains a non-English-identifier fixture project (mixed Portuguese/German/Japanese identifiers, DB access via provenance only), and 11's per-rule precision/recall is reported on it alongside the English corpora. A detection gap between the two is a release-blocking finding, not a footnote.

## Acceptance evidence

1. Full suite green including all R6.1 fixtures; `verify:close` green.
2. Transcript: a fixture project with zero English DB names — full audit detects its schema usage and loop queries; `config detection` shows the inferred set with evidence.
3. Regression guard: the English-named corpora produce identical findings before/after (provenance must be additive — a before/after diff on the committed baselines shows zero delta).
4. GROUND-TRUTH.md and the docs updated: detection mechanism documented as provenance-primary, names-fallback.
5. Tag `spec-21` on `app/` main; continue immediately to Spec 11.

## Out of scope — stated limits, not deferrals

- **Finding-message i18n:** output stays English. The agent-loop consumer is an LLM that reads English regardless of the developer's language; human-facing message translation is a real but separate product decision Ben makes if ever.
- **Keyword translation lists:** rejected as a mechanism, not deferred — an unwinnable chase that imports domain-word false positives (`banco` = "bank"). Provenance replaces it.
- **Dynamic/reflective provenance** (computed property access, `eval`-constructed handles): out of reach of static provenance; the R3 fallback config is the documented answer.
