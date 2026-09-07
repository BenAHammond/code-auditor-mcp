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

---

## Follow-up — `solid/single-responsibility` concern taxonomy correction

Session 1 marked `solid/single-responsibility` `replaced` by the concern
engine, but the corpus diagnostic that session cited — **4,308 functions with
≥1 concern, 14 with ≥2, and 0 with ≥3** on recall — was the real finding, not
evidence of a working rule. A rule that has never fired on a 15k-function
corpus hasn't been shown to be precise; it's been shown to be silent. This
follow-up confronts that silence.

### The diagnostic

Walked recall's functions and listed every one with ≥2 concern groups. All 15
are cohesive — **none is a god-function**. The secondary "concern" is always
glue or annotation, never an unrelated job:

- **`logging` as the secondary** (3): `runStadiumOnlySync`, `main` (sync-roster),
  `main` (sync-stadium-icons) — a sync job that logs its progress is one job.
- **`data-transformation` + `messaging`** (6): the strategist tool `execute`s,
  `emitTurnOutcome`, `resumeSession`, the SSE `emit`, `postEntry` — "shape then
  send/enqueue" is one job.
- **`data-transformation` + `rendering`** (2): `renderBuildOgPng`,
  `renderHeroOgPng` — "shape then render" is one job.
- **`data-access` + `rendering`** (1): `boot` (fetch + mount) — the only
  genuine two-job border case.

So the **taxonomy** was wrong, not the threshold. `data-transformation` and
`logging` were treated as sibling responsibilities when they are glue and
annotation: a function that "shapes then sends", "shapes then renders", or
"fetches then logs" is a single job.

### The fix

Demote `data-transformation` and `logging` to **non-voting**: they are still
detected (for future use) but never count toward the SRP span, and they are no
longer listed in the violation message. The irreducible concerns — the
output/side-effect categories a function can *produce* — are `data-access`,
`messaging`, `rendering`. A function spans two or more of those only when it is
doing two jobs, so the floor drops from 3 to **2**.

- `countConcernGroups` now returns `votingConcerns(concerns).length`, where
  `VOTING_CONCERNS = { data-access, messaging, rendering }`.
- The message lists only the voting concerns, so `db.save` + `sendEmail` +
  `logEvent` reports "mixes 2 unrelated concerns (data access, messaging)" —
  the two jobs — not a three-way count padded by annotation.

### Tests (updated, TDD-shaped)

`single-responsibility.spec.ts` grows to 10 tests. New near-misses pin the
demotion: a fetch that logs progress does **not** fire; a shape-then-send
pipeline (`map` + `publish`) does **not** fire; a shape-then-render pipeline
(`filter`+`map` + `render`) does **not** fire. The positive (`handler`, 6
concerns) and the `notifyUser` case now assert the message lists the two/three
*voting* concerns and omits `logging`/`transformation`. 145 universal-analyzer
tests green.

### Counts after the correction

`solid/single-responsibility` (before → after): recall 0→**1** · blitz 0→0 ·
knex 0→0 · primer-css 0→0 · hhra-org 0→0.

### Adjudication

The single survivor is recall's `boot` (`specs/build-editor-rework/support.js`),
which both `fetch`es the document and `render`s the React root — a defensible
two-job reading of a boot entry point.

The rule is now technically correct and **narrow by design, not silent by
accident**: it fires on the clearest god-functions (the fixtures prove the
engine — `handler`, `notifyUser`, `processOrder` all fire) but the corpora
genuinely lack functions spanning two irreducible side-effects. It remains a
high-precision guard, appropriate for a rule that blocks an agent's edit loop
(a false positive is costlier than a miss).

---

## Session 3 — `interface-segregation` → `interface-size` (spec-49 order #3)

The authenticity ledger marked `solid/interface-segregation` (TS row 26) and
`interface-segregation` (Go row 14) crude: a raw member/method count standing in
for the Interface Segregation Principle ("clients forced to depend on methods
they do not use"). The `gap` column names the real signal — *client-usage sets*:
which callers use which disjoint subsets of an interface's methods. A 21-member
interface may be perfectly segregated (every caller uses a different slice); a
3-member interface may be unsegregated (one client depends on all three). Member
count is a **size** reading, not a segregation reading.

### The verdict: rename the size signal, block the ISP reading

Two honest moves, one per half of the lie:

- **`interface-size`** — the member-count predicate is kept, but emitted under an
  honest name. TS: `UniversalSOLIDAnalyzer.analyzeInterface` emits `rule:
  'interface-size'` (was `solid/interface-segregation`); Go: `solid.go`
  `analyzeISP` emits `Category: "interface-size"` (was `interface-segregation`).
  The config flag `checkInterfaceSegregation` is renamed `checkInterfaceSize`
  (`maxInterfaceMembers` was already honestly named). The registry key, its
  `docs` slug, the near-miss runner key, and the two `RULE_ALIASES` entries
  (`interface-segregation`, `solid/interface-segregation`) all point at the new
  ID, so pre-rename baselines still canonicalize through the alias map and do
  not reshuffle known vs new.
- **true ISP** — `blocked`. Client-usage-set detection needs type resolution and
  a call graph (to know, per method, which callers exercise it), which the
  per-file tree-sitter analyzer and the syntax-only `go/parser` subprocess do
  not have. No call-graph tier exists today, so the honest segregation reading
  is blocked, not faked.

### Tests (written before implementation, per the TDD loop)

`interface-size.spec.ts` — 3 tests, positive / near-miss / inverse near-miss:

- positive — a 21-method interface fires `interface-size`
- near-miss — a data-shape interface of 30 *property* signatures does **not**
  fire (a record/options bag is not a large behavior interface)
- inverse near-miss — a small 2-method interface does **not** fire (size is
  under the threshold)

3 green; 148 universal-analyzer tests green; typecheck clean; the near-miss
executor and registry-contract suites stay green after the key move.

### Counts (before → after, per corpus)

The predicate did not change — only the emitted ID and the config-flag name —
so the count is preserved by construction and every row is a pure relabel:

- recall 2→2 · knex 8→8 · primer-css 0→0 · blitz 0→0 · hhra-org 0→0 ·
  gin 2→2 (`solid::interface-size`) · svelte-realworld not on disk

(gin "before" was `interface-segregation: 2` on the pre-rebuild binary; the
rebuilt binary now reports `interface-size: 2` on the same corpus — the stale
binary was the only reason the label lagged the source.)

### Adjudication

12 total survivors (recall 2 · knex 8 · gin 2), all genuinely large interfaces
with method members — exactly what `interface-size` claims to measure. Zero
false positives, because the rename removed the false *claim* (ISP) rather than
touching the *predicate*: none of these findings now assert that any client is
forced to depend on a method it does not use. That assertion is the blocked
part, and it stays unmade.

### Verdict

- `interface-size` — `renamed` (member-count proxy kept under an honest size name)
- ISP client-usage-set computation — `blocked` (needs a call-graph / type-resolution tier)

## Session 4 — `open-closed` (Go switch + type-switch) → `switch-size` (spec-49 order #4)

The authenticity ledger marked the Go `open-closed` switch variant (row 11) and
type-switch variant (row 12) crude: `if caseCount > 5` standing in for the
Open/Closed Principle ("a module should be open for extension, closed for
modification"). The `gap` column names the real signal — *extensibility*: whether
the switch dispatches over a **stable enum** (closed, perfectly fine to switch
over) versus an **extensible type** (open, the canonical OCP smell). A 6-case
switch over an enum is not an OCP violation; a 2-case type switch over an open
interface is. Case count is a **size** reading, not an OCP reading.

The TS `solid/open-closed` variant (row 24) is a different story: its predicate —
`instanceof` against a user-defined type — is a *real* OCP smell, and its emitted
message ("uses instanceof against a user-defined type. Consider composition or
inheritance for extension") is already honest. Row 24's "frequently modified"
quote is stale — the reword happened in an earlier session — so the TS instanceof
rule is already `replaced`-shaped and needs no change here. Only the Go
switch/type-switch proxies were still crude.

### The verdict: rename the size signal, block the OCP reading

Two honest moves, one per half of the lie:

- **`switch-size`** — the case-count predicate is kept, but emitted under an
  honest name. `solid.go` `analyzeSwitchSize` (was `analyzeOCP`) emits
  `Category: "switch-size"` (was `open-closed`) for both `*ast.SwitchStmt` and
  `*ast.TypeSwitchStmt`; the messages drop the "consider using polymorphism /
  interfaces" overclaim and state the size reading plainly ("Switch statement has
  many case clauses" / "Type switch has many case clauses"); the `Details`
  `principle: "OCP"` field is dropped (it falsely claimed a SOLID principle) in
  favour of a `kind: "switch" | "type-switch"` discriminator.
- **true OCP** — `blocked`. Extensibility judgment needs type resolution: to know
  whether a switch's scrutinee is a sealed enum or an open interface, the analyzer
  must resolve the scrutinee's type and its definition site. The syntax-only
  `go/parser` subprocess has no type resolution, so the honest OCP reading is
  blocked, not faked.

### Tests (written before implementation, per the TDD loop)

`goSwitchSize.spec.ts` — 4 tests, positive / near-miss / inverse near-miss, plus
a rename guard, all spawning the real Go binary:

- positive — a 7-case switch fires `switch-size`, and its message carries no
  "polymorphism" overclaim
- positive — a 7-case type switch fires `switch-size`, no "interfaces" overclaim
- near-miss — a 4-case switch does **not** fire (under the size threshold)
- rename guard — the retired `open-closed` category no longer fires

3 red before implementation (switch-size absent, open-closed still present);
4 green after. Full suite 1240 passed / 67 skipped / 90 files.

### Counts (before → after, per corpus)

The predicate did not change — only the emitted category and message — so the
count is preserved by construction and the row is a pure relabel. The rename is
Go-only, so the TS corpora are unaffected:

- gin 6→6 (`solid::open-closed` → `solid::switch-size`, verified against a
  rebuilt pre-rename binary) · recall/knex/primer-css/blitz/hhra-org n/a
  (TS — the `solid/open-closed` instanceof rule is unchanged) ·
  svelte-realworld not on disk

### Adjudication

6 survivors on gin, all genuine large `switch` statements (7–18 case clauses) in
`context.go:1415`, `binding/binding_nomsgpack.go:96`, `binding/form_mapping.go:336`
(18 cases), `logger.go:114`, `logger.go:136`, `binding/binding.go:100`. Every one
is exactly what `switch-size` claims to measure — a switch with many cases. Zero
false positives, because the rename removed the false *claim* (OCP) rather than
touching the *predicate*: none of these findings now assert that the switch is
"closed to extension", an assertion the size reading never had grounds to make.

### Verdict

- `switch-size` — `renamed` (case-count proxy kept under an honest size name)
- true OCP extensibility computation — `blocked` (needs type resolution: scrutinee
  type + sealed-vs-open judgment)
- `solid/open-closed` (TS instanceof) — already `replaced` (honest predicate +
  message); row 24 was stale and needed no change

---

## Session 5 — `dependency-inversion` (Go concrete-field proxy removed; TS already honest) (spec-49 order #5)

The authenticity ledger marked the Go `dependency-inversion` (row 15) crude and the
TS `solid/dependency-inversion` (row 28) honest. Two different stories, so two
different outcomes — the same shape as Session 4's open-closed split.

### The Go proxy (row 15) — `blocked`, proxy removed

`analyzeDIP` fired `if concreteDeps > 3`, where `countConcreteDependencies` counted
a struct field as "concrete" iff
`!strings.Contains(field.Type, "interface") && !strings.HasPrefix(field.Type, "*")
&& !s.isBuiltinType(field.Type)`. That predicate is broken on both ends:

- **pointers are exempted** — `*http.Client` (`HasPrefix "*"`) is skipped because
  "pointers might be interfaces", when a pointer-to-concrete is the *most common*
  concrete dependency in Go. The exemption silently drops the exact case DIP is
  about.
- **`"interface"` is substring-matched** — a concrete type named `MyInterface` is
  exempted, while a real interface like `io.Reader` is not matched (it has no
  `"interface"` substring), so the check neither exempts what it should nor counts
  what it should.

Whether a named field type is an interface or a concrete type cannot be answered by
`go/parser` — it needs type resolution. The honest DIP computation is therefore
**blocked**, not faked: the proxy is removed and the Go analyzer no longer emits
`dependency-inversion`.

### The TS rule (row 28) — already `replaced`-shaped, no change

`UniversalSOLIDAnalyzer.hasDirectInstantiation` is a *real* signal: a bare
`new PascalCaseNonBuiltinNonSelf()` instantiation inside the class body, with
near-miss guards — lowercase ctor names are instances not types, `BUILTIN_TYPES`
are platform primitives, `cls.name` is self-instantiation. It has the only
execution-level near-miss suite in the solid analyzer (7 tests). The one stale
caveat in the authenticity ledger is a *wording* overreach, not a predicate lie:
the message says "concrete **dependency**", but a `new` of a value object/DTO is
not a dependency. That is a message nit, not a crude proxy, so the rule stands
untouched (matching how Session 4 left the TS `instanceof` rule alone).

### Tests (written before implementation, per the TDD loop)

`goDependencyInversionBlock.spec.ts` — 3 tests, all spawning the real Go binary:

- positive-block — a struct with four concrete fields (`User`/`Order`/`Product`/
  `Payment`) does **not** emit `dependency-inversion` (the proxy no longer fires)
- rename guard — no re-branded proxy category (`dependency`/`concrete`/
  `field-count`) fires for the same struct
- sanity — the rest of the solid analyzer still runs (a large interface fires
  `interface-size`)

2 red before implementation (`dependency-inversion` still emitted for the four-field
struct); 3 green after. Full Go suite 7 passed across both `goSwitchSize` and
`goDependencyInversionBlock`.

### Counts (before → after, per corpus)

The proxy is Go-only and removed outright (not relabeled), so only gin — the sole
Go corpus — is affected; the TS corpora are untouched:

- gin `solid::dependency-inversion` 6→**0** (advisory 29→23, `solid` 25→19;
  `liskov-substitution` 11 and `switch-size` 6 and `interface-size` 2 unchanged)
- recall / knex / primer-css / blitz / hhra-org n/a — `solid/dependency-inversion`
  (TS) unchanged · svelte-realworld not on disk

"before" was measured against the pre-removal committed binary (0b11db3, verified
to still contain the `dependency-inversion` string), not reconstructed.

### Adjudication

Zero survivors — a block has nothing to re-examine. The 6 removed findings were
gin structs with >3 non-builtin, non-`"interface"`-substring, non-pointer fields,
which is exactly the population the broken predicate selected: a mix of genuine
concrete-typed aggregates and pointer-exempted false negatives, with no way to tell
them apart without type resolution. Rather than keep a signal that counts a
`*http.Client` as an interface and a `MyInterface` as not-an-interface, the finding
class is removed wholesale.

### Verdict

- Go `dependency-inversion` — `blocked` (needs type resolution: interface-vs-concrete
  per field type); proxy removed
- `solid/dependency-inversion` (TS) — already `replaced` (honest
  `new PascalCaseNonBuiltinNonSelf()` predicate + 7-test near-miss suite); row 28's
  only stale note is the "dependency" wording, a message nit left as-is

---

## Session 6 — `class-size` (registry message overclaim reworded) (spec-49 order #6)

The authenticity ledger marked `solid/class-size` (row 22) crude with a **single
gap**, and its own `gap` column already said it: the predicate — method count
(`cls.methods.length > 15`) plus aggregate cyclomatic complexity (`Σ
getComplexity(method) > 100`) — is a **real size computation**, but the message
claimed "splitting responsibilities", which is a responsibility reading, not a size
reading. A 173-method `Builder` is large; it is not necessarily "doing too much".
The `note` column concurred: *"computation is complete; only the 'responsibilities'
wording overclaims"*.

### The state on arrival

The rule had already been half-reworded in an earlier session. The **emitted**
messages are honest size framing — "Consider splitting into smaller classes."
(method-count half) and "Consider splitting the class." (aggregate-complexity half).
Only the **registry's canonical `message` template** (`ruleRegistry.ts:139`) still
carried the stale overclaim: `"…Consider splitting responsibilities."`. So the
predicate needed no change, the emitted message needed no change — only the
registry metadata string was stale.

### The fix

`ruleRegistry.ts` `solid/class-size.message` reworded from "Consider splitting
responsibilities." to "Consider splitting into smaller classes." — matching the
emitted message. No predicate, threshold, rule ID, alias, or emitted-message change;
this is a metadata reword, not a rewrite.

### Tests (written before implementation, per the TDD loop)

`classSizeMessage.spec.ts` — 3 tests, positive / near-miss / inverse near-miss,
running the real `UniversalSOLIDAnalyzer` via `analyzeAST`:

- positive — a 16-method class fires `solid/class-size`
- near-miss — a 15-method class does **not** fire (size threshold is the only signal)
- inverse near-miss — the emitted message **and** the registry canonical message do
  not claim "responsibilities"

1 red before implementation (the registry-message assertion — the emitted-message
assertion was already green); 3 green after. Contract suites stay green:
`ruleRegistry.test.ts` (5), `nearMissExecutor.spec.ts` (101, 67 skipped),
`baseline.test.ts` (70).

### Counts (before → after, per corpus)

The predicate and emitted message did not change, so the finding count is preserved
by construction — the registry `message` template is metadata (validated non-empty
by the contract suite), not the violation text emitted during an audit:

- recall 3→3 · knex 31→31 · primer-css 0→0 · blitz 0→0 · hhra-org 1→1 ·
  gin n/a (Go corpus) · svelte-realworld not on disk

### Adjudication

35 findings across 30 distinct classes; every one is a genuine large class — 17 to
173 methods (knex `Builder` 173, `QueryCompiler` 86, `Client` 44, `TableCompiler`
35, recall `UserStrategist` 30, `StrategistManager` 28, …) or a genuinely high
aggregate McCC (346, 300, 141, 137, 134), or both. Five classes fire twice
(method-count **and** aggregate-complexity), which is correct — the two halves of
`checkClassSize` are independent thresholds. Zero false positives of the
"responsibility" kind, because the rule no longer asserts responsibility anywhere —
the surviving claim is purely "this class is large".

### Verdict

- `solid/class-size` — `reworded` (registry message corrected to match the
  already-honest emitted message); the computation was already complete and the
  only crude remnant was the stale "responsibilities" template string

---

## Session 7 — Go `single-responsibility` split into `function-size` / `struct-size` (spec-49 order #7, rows 9 & 10)

The authenticity ledger marks two Go rules crude under the same `solid.go`
`analyzeSRP` function, both emitting the `single-responsibility` category:

- **row 9 — function**: `countFunctionResponsibilities` = `1 + (complexity > 10) +
  (returnCount > 2) + (paramCount > 5)`, firing when the total exceeds 3 — i.e.
  only when *all three* size signals are elevated at once.
- **row 10 — struct**: `countStructResponsibilities` = `1 + fieldCountScore +
  mixedTypesScore`, firing when the total exceeds 5. The arithmetic makes this
  impossible — base 1 + fieldCount max `+2` + mixedTypes max `+1` = 4 < 5 — so the
  struct half was **dead code** that could never fire. Its `mixedTypes` heuristic
  additionally false-matched via `strings.Contains(field.Type, "int")`, so a
  `*Point` field (substring `"int"`) counted as a numeric type.

Both claimed the Single Responsibility Principle from *size* proxies.
"Responsibility" is semantic — cohesion / LCOM — which the syntax-only `go/parser`
subprocess cannot compute. The SRP reading is therefore **blocked**; the honest
size signal survives under honest names, exactly as `single-responsibility` (TS)
was split into `function-length`/`parameter-count`:

- `function-size` — the "many params + multiple returns + high complexity"
  composite, kept as-is (all three must be elevated), `principle: "SRP"` dropped.
- `struct-size` — the "many fields" reading, now a **direct** `len(Fields) > 10`
  check; the buggy `mixedTypes` substring heuristic and the dead composite are
  removed.

### Tests (written before implementation, per the TDD loop)

`goSingleResponsibilitySplit.spec.ts` — 5 tests, all spawning the real Go binary:

- positive — a big function (complexity 12 + 6 params + 3 returns) fires `function-size`
- positive — an 11-field struct fires `struct-size`
- near-miss — a complexity-only function (11 ifs, 2 params, 1 return) does **not**
  fire `function-size` (all three signals must be elevated)
- near-miss — a ≤10-field struct whose field type merely contains `"int"` as a
  substring does **not** fire `struct-size` (the substring heuristic is gone)
- rename guard — `single-responsibility` no longer emits for either the big
  function or the big struct

3 red before implementation (`function-size` absent, `struct-size` absent,
`single-responsibility` still emitted); 5 green after. Go contract suites stay
green: `goDependencyInversionBlock` (3), `goSwitchSize` (in the same solid suite).

### Counts (before → after, per corpus)

The change is Go-only, so only gin — the sole Go corpus — is affected; the TS
corpora are untouched:

- gin `solid::single-responsibility` 0→**0** (function half fires 0 on gin — the
  "all three signals" composite is too strict for real code — and the struct half
  was dead); `solid::struct-size` 0→**3** (the formerly-dead struct signal now
  surfaces three genuine large structs); advisory 23→26, `solid` 19→22;
  `liskov-substitution` 11, `switch-size` 6, `interface-size` 2, `import-organization`
  4 all unchanged
- recall / knex / primer-css / blitz / hhra-org n/a (TS, untouched) ·
  svelte-realworld not on disk

"before" was measured against the committed pre-removal binary (`a0ac5ef`, verified
to still contain `single-responsibility`), not reconstructed.

### Adjudication

Three survivors, all genuine large structs in gin:

- `Engine` (gin.go:92) — 30 fields (router + config + state)
- `Context` (context.go:61) — 17 fields (gin's well-known "god struct")
- `LogFormatterParams` (logger.go:68) — 11 fields (log format config)

Zero false positives — the direct field-count threshold reports only genuinely
large structs, and the `mixedTypes` substring false-positive (`*Point` → "int")
is gone by construction.

### Verdict

- Go `single-responsibility` (function, row 9) — `renamed` to `function-size` (the
  composite is kept verbatim; only the SRP claim is dropped)
- Go `single-responsibility` (struct, row 10) — `renamed` to `struct-size` with the
  predicate `replaced` (dead composite + substring heuristic → direct field count)

---

## Session 8 — Go `import-organization` (count proxy → grouping) (spec-49 order #7 remainder, row 16)

The authenticity ledger marked `imports/import-organization` (row 16) crude with
a single gap: the predicate was `if len(file.Imports) > 10` — a raw import *count*
standing in for "import organization", emitting "File has many imports - consider
organizing or reducing import count". The `gap` column named the real signal:
"stdlib vs third-party vs project grouping and unnecessary deps".

Count is not that signal. A file with twelve well-grouped imports is not
unorganized; a file with two mis-grouped imports is. The "unnecessary deps" half
is out of scope — the Go compiler already rejects unused imports at build time, so
a static analyzer adds no signal there. What remains is **grouping**, and it is
directly bridgeable from the AST: each `*ast.ImportSpec` carries its path string,
and Go convention (goimports/gofmt) requires standard-library imports first, then
third-party, then local, each block sorted.

### The fix

The count threshold is removed outright (a raw import count is not a signal worth
keeping under any name — unlike line count for `function-length`, no Go tool or
style guide treats "too many imports" as a defect). The predicate is replaced with
a grouping check:

- `importGroup(path)` classifies an unquoted path by its first segment — `stdlib`
  (no `.`), `third-party` (has `.`), `local` (starts `.`/`..`).
- `firstImportGroupViolation(imports)` scans the import list and reports the first
  import whose group precedes a strictly-earlier group (i.e. the group sequence is
  not non-decreasing), plus how many imports are out of group order.

One violation per file, positioned at the first out-of-group import, message
"Import block mixes standard library and third-party imports without grouping".
The dot-import `import-style` check is untouched (it was already honest).

### Tests (written before implementation, per the TDD loop)

`goImportOrganization.spec.ts` — 5 tests, all spawning the real Go binary:

- positive — third-party-then-stdlib imports fire `import-organization`
- near-miss — 12 well-grouped imports (stdlib sorted, then third-party) do **not**
  fire — the count proxy is gone
- inverse near-miss — a 2-import file with stdlib-after-third-party **fires** — the
  grouping signal catches what the count proxy missed
- sanity — a dot import still fires `import-style` (honest check untouched)
- rename guard — no retired `import-count` / `many-imports` category emits

3 red before implementation (positive/near-miss/inverse — the count proxy both
false-fires on 12 well-grouped imports and misses a 2-import mis-grouping); 5 green
after. Full Go suite 13 passed (`goImportOrganization` 5, `goSingleResponsibilitySplit`
5, `goDependencyInversionBlock` 3).

### Counts (before → after, per corpus)

Go-only change, so only gin — the sole Go corpus — is affected; the TS corpora are
untouched:

- gin `imports::import-organization` 4→**1** (advisory 26→23, `imports` 4→1;
  `solid` 22→22 and its `struct-size` 3, `liskov-substitution` 11, `switch-size` 6,
  `interface-size` 2 all unchanged)
- recall / knex / primer-css / blitz / hhra-org n/a (TS, untouched) ·
  svelte-realworld not on disk

"before" was measured against the committed pre-change binary (`5a4a0d7`, verified
to still contain the `> 10` count predicate), not reconstructed.

### Adjudication

The 4 dropped findings were all gin files with >10 imports that are, in fact, well
grouped — `context.go` (19), `recovery.go` (15), `gin.go` (14),
`binding/form_mapping.go` (11). Pure count false positives: every one is a large
but correctly organized import block.

The single survivor is `testdata/protoexample/test.pb.go` — a genuine grouping
violation the count proxy had missed (it has only 4 imports): the generated
protobuf file places `google.golang.org/protobuf/...` imports before the `reflect` /
`sync` stdlib imports. True positive — the block really is mis-grouped (a known
protoc-gen-go quirk), exactly the "mixed-up imports" case the rule now names.

### Verdict

- `imports/import-organization` — `replaced` (count proxy removed outright; the
  grouping predicate computes the real "stdlib vs third-party vs local" signal the
  ledger's `gap` column named). Category ID unchanged — "import-organization"
  already named the right thing; only the predicate was a proxy.
