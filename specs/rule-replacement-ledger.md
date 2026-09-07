# Rule Replacement Ledger

Append-only. One entry per rule replaced, renamed, or blocked, in spec-49 order.
Never rewrite earlier entries — this file is the audit trail that the crude
backlog is actually being closed.

---

## Session 1 — the `single-responsibility` split (spec-49 order #1)

The authenticity ledger's row 25 marked `solid/single-responsibility` crude: a
line-count + parameter-count size proxy masquerading as a responsibility
reading ("largest rule in the tool, 987 on recall"). The concern engine
(`functionConcerns.ts`, #128) and the size-rule split (#131) landed before this
spec was written, so this session pins that work with the spec's TDD evidence
and closes the ledger row.

Three emitted rule IDs changed:

### `function-length`

- **rule**: `function-length`
- **was**: `if (lineCount > (maxLinesPerMethod || 50))` emitted under
  `solid/single-responsibility` — a line count standing in for responsibility
- **now**: the same line-count predicate, emitted under `function-length` — an
  honest name for a length reading. A 52-line function is "2 over a length
  threshold," not an SRP violation
- **tests**: positive (long function fires `function-length`); near-miss
  (cohesive 180-line handler fires `function-length`, *not*
  `single-responsibility`); inverse near-miss (30-line four-concern function
  fires `single-responsibility`, *not* `function-length`)
- **counts** (now; was emitted as the line-count half of `single-responsibility`
  at the same counts — same predicate, new ID):
  recall 902 · knex 60 · primer-css 3 · blitz 88 · hhra-org 381 ·
  gin n/a (Go corpus) · svelte-realworld not on disk
- **adjudication**: survivors are genuinely long functions — what the rule
  claims to measure. No false positives of the "responsibility" kind, because
  the rule no longer claims responsibility
- **verdict**: `renamed` (proxy kept under an honest name)

### `parameter-count`

- **rule**: `parameter-count`
- **was**: `if (func.parameters.length > (maxParametersPerMethod || 4))`
  emitted under `solid/single-responsibility` — a parameter count standing in
  for responsibility
- **now**: the same parameter-count predicate, emitted under `parameter-count`
- **tests**: positive (5-param function fires `parameter-count`); near-miss
  (4-param function does not); inverse near-miss (short function mixing
  concerns fires `single-responsibility`, not `parameter-count`)
- **counts** (now; was emitted as the param-count half of `single-responsibility`
  at the same counts): recall 89 · knex 6 · primer-css 0 · blitz 9 · hhra-org 2 ·
  gin n/a · svelte-realworld not on disk
- **adjudication**: survivors are genuinely many-parameter functions — what the
  rule claims to measure
- **verdict**: `renamed` (proxy kept under an honest name)

### `solid/single-responsibility`

- **rule**: `solid/single-responsibility`
- **was**: `if (params > 4) fire` + `if (lines > 50) fire` — size proxies
  standing in for cohesion (987 on recall)
- **now**: `detectFunctionConcerns` + `countConcernGroups >= 3` — a function
  fires only when it spans three or more *unrelated* concern categories
  (data-access, messaging, logging, rendering), with load-and-shape collapsing
  and nested-body isolation
- **tests**:
  - *positive* — `handler` (db + email + log + render + audit + notify) fires
  - *near-miss* — cohesive 180-line handler does **not** fire (its length fires
    `function-length` instead)
  - *inverse near-miss* — 30-line function doing four unrelated things **does**
    fire (the old size proxy would have missed it)
  - all 8 tests green (`single-responsibility.spec.ts`)
- **counts** (before → after, per corpus):
  recall 991→0 · knex 66→0 · primer-css 3→0 · blitz 97→0 · hhra-org 383→0 ·
  gin n/a (Go — `solid.go` crude SRP is ledger rows 9/10, a later session) ·
  svelte-realworld not on disk.
  "before" is the reconstructed size-proxy count (`function-length` +
  `parameter-count` = the two relabeled halves of the same predicates); the
  spec-44 headline was 987 on recall, the 4-finding delta is corpus drift
  between the spec-44 pin and now.
- **adjudication**: zero survivors — the count is 0 on every corpus, so there
  is nothing to sample. Verified genuine, not a dead engine: a walk of
  recall-protocol's 15,144 functions finds 4,308 with ≥1 concern, 14 with ≥2,
  and **0 with ≥3** (the firing threshold). The 991→0 drop is the proxy firing
  on long/param-heavy-but-cohesive functions that were never god-functions.
- **verdict**: `replaced` (concern engine computes the real signal)

---

## Session 2 — the `documentation` family (spec-49 order #2)

The authenticity ledger marked four documentation rules crude (rows for
`function-documentation`, `class-documentation`, `method-documentation`,
`file-documentation`). All four shared one proxy:

```ts
if (doc.length < minDescriptionLength /* default 10 */) fire;
```

Presence + character length, not substance. A `/** TODO: implement later */`
comment (23 chars) passed as "documented"; a `/** Sums. */` comment (8 chars)
failed despite describing the function. The ledger's `gap` column names the
real signal: *content* (a word-count / non-boilerplate heuristic for
function/class/method, a `@fileoverview`-style marker check for file).

### The replacement

`isSubstantiveDoc(doc)` — a comment is documentation iff, after stripping
comment delimiters and JSDoc tags, it contains at least one descriptive word
(≥2 chars, non-stopword) **and** does not lead with a placeholder marker
(`TODO`/`FIXME`/`XXX`/`TBD`/`WIP`/`STUB`/`PLACEHOLDER`, optional `@` sigil).
File headers additionally require a `@fileoverview`/`@file`/`@module`/
`@overview`/`@purpose` marker, so a bare license block no longer counts.

Four check sites changed from `doc.length < minDescriptionLength` to
`!isSubstantiveDoc(doc)`: `checkFileHeader`, `checkFunctionDocumentation`,
`analyzeClassDocumentation`, `checkClassMethodDocumentation`.
`minDescriptionLength` is left in the config interface but is now dead for
these four rules (kept for back-compat, removed from the predicate).

Two latent bugs surfaced and were fixed along the way:

- **`getFileDocumentation` never found a leading comment.** tree-sitter exposes
  a leading `/** */` as `program.children[0]` (type `comment`); passing it to
  `adapter.getDocumentation` (which searches *preceding* siblings) returned
  null, so `file-documentation` fired even on files with a real header whenever
  `fileHeaders` was enabled. Fixed to read the comment node's raw text directly.
- **The placeholder word-list was too aggressive.** The first cut matched
  `PLACEHOLDER`/`STUB` anywhere in the comment, so a descriptive doc like
  "…falls back to the placeholder card" was misread as a placeholder *comment*
  (3 false positives on recall: `applyAbilityPileRow`,
  `handleCommandPlaceholder`, `cdnIcon`/`getIndexedStrategyCount`). Fixed by
  anchoring the marker to the *start* of the comment; a regression test pins it.

### Tests (written before implementation, per the TDD loop)

`documentation-substance.spec.ts` — 13 tests, positive / near-miss / inverse
near-miss for each of the four rules:

- function-documentation: positive (undocumented exported fn fires), near-miss
  (`/** Sums. */` 8 chars does **not** fire — the old length proxy did),
  inverse near-miss (`/** TODO: implement later */` 23 chars **does** fire),
  regression near-miss (a descriptive doc *mentioning* "placeholder" does not)
- class-documentation / method-documentation: same three-way shape
- file-documentation (`fileHeaders: true`): positive (no leading comment),
  near-miss (`/** @fileoverview Core utilities. */` does not), inverse
  near-miss (`/** Copyright 2024 … */` license block **does** fire)

19 tests green across `documentation-substance.spec.ts` + the pre-existing
`UniversalDocumentationAnalyzer.spec.ts`.

### Counts (before → after, per corpus)

- **function-documentation**: recall 574→574 · knex 0→0 · primer-css 1→1 ·
  blitz 190→**191** · hhra-org 51→51 · gin n/a (Go corpus) · svelte-realworld
  not on disk
- **class-documentation**: recall 16 · knex 0 · primer-css 0 · blitz 34 ·
  hhra-org 39 (unchanged)
- **method-documentation**: recall 80 · knex 0 · primer-css 0 · blitz 161 ·
  hhra-org 69 (unchanged)
- **file-documentation**: 0 everywhere — defaults off (`fileHeaders: false`)

### Adjudication

One net survivor across all corpora: **blitz
`packages/blitz-auth/…/parse-url.ts` `parseUrl`** (`+1` function-documentation).
Its doc leads with `TODO: Can we remove this?` before describing the return
value, so the substance heuristic no longer counts it as documented. That is a
genuine reading — the leading signal is a TODO, not a confident description —
so the survivor stands rather than being tuned away.

The transient `+3` on recall during development (the `PLACEHOLDER`/`STUB`
word-list bug above) was a self-inflicted false positive, caught by the
measurement diff and removed; the committed state is `574→574` on recall.

The delta is small by design: `// TODO` line comments never populate `jsDoc`
(only `/** */` block comments do), so the placeholder effect is confined to
`/** TODO */` block comments, and the overwhelming majority of block doc
comments are genuinely descriptive.

### Verdicts

- `function-documentation` — `replaced` (substance heuristic)
- `class-documentation` — `replaced`
- `method-documentation` — `replaced`
- `file-documentation` — `replaced` (marker/content check)
