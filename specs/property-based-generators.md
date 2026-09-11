# Property-Based Generators — Spec 53 R3

Status: **implemented** (`fast-check` 4.10.0; spec at
`src/__tests__/property-based-generators.spec.ts`, 6 tests). The blocking
dependency (R1's Stryker run holding the vitest worker pool) cleared, so the
install and the property specs landed after R1 exited.

Goal: generate source constructs whose rule outcome is *knowable in advance*,
then assert the analyzer's answer equals the oracle across the whole generated
space — including every "wrapping context" a construct can legally sit in. A
mismatch is a real bug; fast-check shrinks it to a minimal fixture we keep.

---

## 1. The five constructs and their oracles

| construct | rule | oracle (knowable answer) | threshold |
| --- | --- | --- | --- |
| parameter-count | `parameter-count` | function with `N` params fires iff `N > maxParametersPerMethod` | 4 (fires at 5) |
| class-size | `solid/class-size` | class with `M` methods fires iff `M > classMethodsThreshold` | 15 (fires at 16) |
| loop-query | `loop-query` | a DB query call inside a `for`/`while`/`for-in`/`for-of` body fires; the same call outside a loop does not | — |
| undefined-class | `styles/undefined-class` | a markup class name with no CSS definition fires; a defined class does not | — |
| upsert-write | `cross-domain/written-never-read` (via write-verb classification) | `INSERT … ON CONFLICT … DO UPDATE` / `INSERT … ON DUPLICATE KEY UPDATE` / `REPLACE INTO` count as a write; a bare `INSERT` into a temp/scratch table is still a write | — |

The oracles are *properties*, not exact counts: a generator asserts "0 findings"
for the non-firing side and "≥1 finding" for the firing side. Exact counts are
what the corpus baselines (`specs/corpus-baselines.md`) are for.

### Oracle validation status (probed against `dist/` on 2026-09-11)

| construct | probe result | construct shape that actually works |
| --- | --- | --- |
| parameter-count | ✅ confirmed | single file, `function f(a,…)` or `const f = (a,…) => {}` — both fire at 5 params |
| solid/class-size | ✅ confirmed | single file, `class C { m1(){} … }` — fires at 16 methods |
| loop-query | ✅ confirmed | single file, `db.query(...)` inside `for…of` |
| styles/undefined-class | ✅ confirmed (multi-file) | needs a `.css` defining `.card` **and** a `.tsx` with `className="missing"` |
| upsert-write | ⚠️ reframed | see below — no single-file rule exposes "is-this-a-write" |

`undefined-class` is cross-file: the class catalog comes from a real `.css` file
(not a string constant), and the usage from a `.tsx`/`.jsx` `className="…"` /
`class="…"` attribute. A single-file probe with `const css = '…'` yields 0 for
both sides; the two-file probe yields 1 vs 0. The property generator must emit
both files.

`upsert-write` has no single-file rule that surfaces "this SQL is a write":
`unfiltered-query` is read-only (pure writes are explicitly out of scope), and
the write-verb classification (`hasWriteVerb` in `UniversalDataAccessAnalyzer`,
`sqlTablePatterns` in `schema/codeAnalysis`) feeds only the cross-domain rules
(`written-never-read`, `multi-table-write`) which require a full-corpus
schema_usage pass. Two honest options: (a) a unit-level property over the
write-verb classifier (`\bINSERT\b`/`\bDELETE\b`/`\bUPDATE\b`/`\bREPLACE\s+INTO\b`
→ write, `SELECT` → read), or (b) an end-to-end `multi-table-write` property that
requires shipping a migration + transaction fixture pair. (a) is the R3 target;
(b) is corpus-baseline territory.

---

## 2. The wrapping matrix

Every generated construct is crossed with a matrix of wrapping contexts. The
oracle must hold in each cell, or the delta is a finding:

| # | wrapping context | what it tests |
| --- | --- | --- |
| W1 | top-level | the bare construct |
| W2 | inside a named `function` | scope/hoisting sensitivity |
| W3 | inside a `const f = () => {}` | declaration-vs-expression symmetry (the R2 weak spot) |
| W4 | inside a class `method_definition` | method-vs-function handling |
| W5 | inside an IIFE `(() => { … })()` | anonymous/expression context |
| W6 | inside `await Promise.all([…])` | call-site context |
| W7 | inside `try { … } catch {}` | block nesting |
| W8 | inside an `if` / `else` branch | conditional nesting |
| W9 | re-indented + comment-decorated | formatting/comment insensitivity |

The matrix is per-construct (some cells are inapplicable, e.g. `undefined-class`
needs the CSS + markup pair, so W1–W9 apply to the *markup* side). "Inapplicable"
cells are recorded, not silently dropped.

**Validity constraints** (found by probing — a naive wrap can silently produce
invalid code and a bogus "violation"):

- Constructs are generated **without** `export` — visibility is a separate axis
  from context-invariance, and `export` is only legal at top level.
- `Promise.all([…])` (W6) is **expression-only**: a declaration (`class C {}`,
  `function f() {}`) or a statement (`for (…) {…}`) is not an array element.
  Wrapping either in `Promise.all([…])` yields invalid code whose "finding
  disappears" result is tree-sitter error recovery, not an invariance fact.
  W6 is therefore inapplicable to `parameter-count`, `class-size`, and
  `loop-query`; it applies to expression-shaped constructs only.
- Block wraps (W2–W5, W7–W8) are valid for declarations, statements, and
  expressions alike.

**Probe result (2026-09-11, `scripts/r3-wrapping-probe.mjs`)**: `parameter-count`,
`solid/class-size`, and `loop-query` each fire under every applicable wrap
(all 1s, no drop). No invariance violation found.

---

## 3. Generators

Each generator is a fast-check arbitrary producing a full, parseable source
string plus its oracle expectation:

- **parameter-count**: `fc.integer({min:0, max:12})` params × `fc.array(paramName)`
  → `function f(a, b, …) {}`. Oracle = `N > 4`. Cross W1–W9.
- **class-size**: `fc.integer({min:0, max:24})` methods → `class C { m1(){} … }`.
  Oracle = `M > 15`. Cross W1–W9.
- **loop-query**: `fc.constantFrom('for','for-of','for-in','while')` loop body
  containing a fixed `db.query(...)` / `.first()` call. Oracle = fires. The
  *negative* control (same call, no loop) is generated separately. Cross W1–W9.
- **undefined-class**: a fixed CSS string (`.card {}`) × markup using either the
  defined class or an undefined one. Oracle = fires iff undefined. Cross W1–W9 on
  the markup; CSS side fixed.
- **upsert-write**: `fc.constantFrom('ON CONFLICT DO UPDATE','ON DUPLICATE KEY UPDATE','REPLACE INTO','INSERT INTO')`
  → a SQL template/string. Oracle = write iff the upsert/replace form. Cross W2–W9.

Each generator shrinks through the *oracle mismatch*, not the raw input — so a
failure shrinks to the minimal construct that still trips the rule.

---

## 4. Shrink-to-fixture workflow

1. `fc.assert(property, { numRuns: 200, seed })` in a vitest spec under
   `src/__tests__/` (not a plain unit test — the property must run the *real*
   audit dispatch, same as R2's `run.mjs` does against `dist/`).
2. On failure, fast-check reports the counterexample. The spec writes the
   *shrunk* minimal source to `src/__tests__/fixtures/spec-53/r3-<construct>-<seed>.ts`
   and registers a plain regression `it()` over that fixture (so the bug is
   pinned even after the property is refactored).
3. The bug is then fixed in the analyzer/extractor (never in the oracle or the
   generator — narrowing the generator to dodge a failing case is a Scope
   violation, same rule as R1).

---

## 5. Acceptance

- `npm run test` green with the five property specs + the pinned fixtures.
- Every surviving oracle mismatch is either fixed in the analyzer, or — if it is
  a *false* oracle (the "knowable answer" was wrong) — the oracle is corrected
  with a written justification. Unresolved mismatches are reported, not hidden.
- Baselines unchanged except where a fixed bug moved them (with attribution).

## 6. Implementation notes

- Installed `fast-check@4.10.0` (`pnpm add -D fast-check`).
- Spec lives at `src/__tests__/property-based-generators.spec.ts`. The five
  constructs run at the `analyzeAST` layer (real analyzers, milliseconds per
  case) except `undefined-class`, which is cross-file and runs the full
  `runAuditDispatch` with a `.css` + `.tsx` pair — the end-to-end oracles were
  already validated by `scripts/r3-oracle-probe.mjs` / `r3-wrapping-probe.mjs`.
- `upsert-write` is the unit property over the write-verb classifier, which
  required exporting `hasWriteVerb` from `UniversalDataAccessAnalyzer.ts` (a
  one-word `export` change; no behavior change).
- The property specs assert the *oracle*, and fast-check shrinks any mismatch to
  a minimal counterexample. Pinned threshold-boundary regressions (5 params, 16
  methods) are covered by the generated sweep itself, which hits those exact
  integer values.
