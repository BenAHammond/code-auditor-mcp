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

---

## Session 9 — Go `channels/concurrency` (signature+complexity proxy → same-goroutine deadlock) (spec-49 order #7 remainder, row 20)

The authenticity ledger marked `channels/concurrency` (row 20) crude: the predicate
was `if containsChannel(function.Signature) && function.Complexity > 3`, where
`containsChannel` was `strings.Contains(signature, "chan")` — a signature substring
plus a cyclomatic-complexity count — emitting "Complex function uses channels -
review for proper synchronization". The `gap` column: *"Potential deadlocks is
claimed but not computed — no analysis of send/recv blocking."*

Neither signal is a deadlock. A channel in the signature is not a deadlock; a
3-statement function can deadlock. The honest, provable signal is the
**same-goroutine deadlock**: a channel created unbuffered (`make(chan T)`, no
buffer) that is both sent to and received from (or operated on twice) in the same
function with no `go` statement in the body. An unbuffered send blocks until a
receiver is ready; if the counterpart lives in the same goroutine, the first
operation blocks before the second can run — guaranteed, independent of external
code.

### The fix

The signature-substring + complexity proxy is removed outright. The predicate is
replaced with `deadlockChannel(funcDecl)`:

- `isUnbufferedMakeChan(expr)` — `make(chan T)` (single-arg make of a channel
  type); `make(chan T, N)` (buffered) never qualifies because its send does not
  block.
- `deadlockChannel` walks the top-level statements of the function body, recording
  locally-created unbuffered channels and counting sends (`*ast.SendStmt`) and
  receives (`<-` `*ast.UnaryExpr`) on each. A channel with ≥2 blocking operations
  and **no** `*ast.GoStmt` anywhere in the body is a guaranteed deadlock.

The category is renamed `concurrency` → `channel-deadlock` (the goroutines analyzer
keeps `concurrency`; the channels analyzer now honestly names what it detects). The
"potential deadlock" overclaim is dropped — the message claims only the provable
same-goroutine deadlock.

### Tests (written before implementation, per the TDD loop)

`goChannelDeadlock.spec.ts` — 5 tests, all spawning the real Go binary:

- positive — an unbuffered send+receive with no `go` fires `channel-deadlock`
- near-miss — a safe channel function (chan signature + complexity > 3, but has a
  `go` goroutine) does **not** fire
- inverse near-miss — a simple deadlock the old proxy missed (no "chan" in
  signature, complexity 1) **fires**
- near-miss — a buffered `make(chan int, 1)` send+receive does **not** fire
- rename guard — the retired `concurrency` category no longer emits from the
  channels analyzer

3 red before implementation (positive / inverse / rename-guard — the old proxy both
missed simple deadlocks and fired on safe channel functions); 5 green after. Full Go
suite 18 passed (`goChannelDeadlock` 5, `goImportOrganization` 5,
`goSingleResponsibilitySplit` 5, `goDependencyInversionBlock` 3).

### Counts (before → after, per corpus)

The `channels` analyzer is Go-only and **not in the default Go analyzer set**
(`['solid', 'imports', 'errors']`), so it contributes nothing to the default corpus
counts; it runs only when `channels` is explicitly enabled. Measured with
`channels` explicitly enabled:

- gin `channels::concurrency` 0→**0** (`channels::channel-deadlock` — the old proxy
  fired 0 on gin, and the new detector also finds 0, as gin uses proper
  goroutine patterns and has no same-goroutine unbuffered deadlocks)
- recall / knex / primer-css / blitz / hhra-org n/a (TS, untouched) ·
  svelte-realworld not on disk

"before" was measured against the committed pre-change binary (`65a9d51`, verified
to still contain the `containsChannel` + `Complexity > 3` proxy), not reconstructed.

### Adjudication

Zero survivors — a count of 0 has nothing to re-examine. The old proxy's 0 on gin
is not because gin lacks channels, but because no gin function both mentions a
channel in its signature and has complexity > 3; the proxy's direction was wrong,
not just its threshold. The new detector's 0 is the honest answer: gin's channel
usage is either buffered or paired with a `go` statement, so no same-goroutine
unbuffered deadlock exists.

### Verdict

- `channels/concurrency` — `replaced` with `channel-deadlock`: the provable
  same-goroutine unbuffered-deadlock signal replaces the signature-substring +
  complexity proxy. The broader cross-goroutine deadlock detection (channel
  escape, blocking across spawned goroutines) remains `blocked` — it needs
  inter-procedural escape/dataflow analysis the syntax-only `go/parser` subprocess
  lacks.

---

## Session 10 — `solid/open-closed` (registry message overclaim reworded) (spec-49 order #7 remainder, row 24)

The authenticity ledger marked `solid/open-closed` (row 24) crude with a **single
gap**, and its own `gap` column already said it: the predicate — `instanceof`
against a *user-defined* (non-builtin) type — is a **real type-checking smell**
(dispatch on concrete types instead of polymorphism), but the message claimed
"frequently modified", which is a *modification-frequency* reading, not a
type-checking reading. Nothing in the tool measures modification frequency (that
needs version history), so the claim was fabricated. The `note` column concurred:
*"instanceof detection is real; 'frequently modified' needs version history, not
present"*.

### The state on arrival

The rule had already been half-reworded in an earlier session. The **emitted**
message is honest type-checking framing — "Class "{name}" uses instanceof against a
user-defined type. Consider composition or inheritance for extension." Only the
**registry's canonical `message` template** (`ruleRegistry.ts:176`) still carried
the stale overclaim `"Class "{name}" violates the Open/Closed Principle."`. The
**invalid** sample (`ruleRegistry.ts:184`) also misdescribed the rule: it showed
duck-typing (`shape.type === "circle"`), which the predicate does *not* detect, when
the rule actually fires on `instanceof`. So the predicate needed no change, the
emitted message needed no change — only the registry metadata string and the sample
were stale.

### The fix

- `ruleRegistry.ts` `solid/open-closed.message` reworded from `"Class "{name}"
  violates the Open/Closed Principle."` to `"Class "{name}" uses instanceof against
  a user-defined type."` — matching the emitted message.
- `ruleRegistry.ts` `solid/open-closed.samples.invalid[0]` corrected from the
  duck-typing snippet (`shape.type === "circle"`) to a class whose method
  type-checks `instanceof` against a user-defined type — so the sample describes the
  rule it documents.

No predicate, threshold, rule ID, alias, or emitted-message change; this is a
metadata reword, not a rewrite.

### Tests (written before implementation, per the TDD loop)

`openClosedMessage.spec.ts` — 3 tests, positive / near-miss / inverse near-miss,
running the real `UniversalSOLIDAnalyzer` via `analyzeAST`:

- positive — a class method `instanceof` a user-defined type fires `solid/open-closed`
- near-miss — a class method `instanceof` a builtin (`Error`) does **not** fire
  (builtin types are legitimate runtime concerns, not OCP extension points)
- inverse near-miss — the emitted message **and** the registry canonical message do
  not claim "frequently modified" or "violates the Open/Closed Principle", and do
  match /instanceof/

1 red before implementation (the registry-message assertion — the emitted-message
assertion was already green); 3 green after. Contract suites stay green:
`ruleRegistry.test.ts` (5), `baseline.test.ts` (70).

### Counts (before → after, per corpus)

The predicate and emitted message did not change, so the finding count is preserved
by construction — the registry `message` template is metadata (validated non-empty by
the contract suite), not the violation text emitted during an audit:

- recall 0→0 · knex 12→12 · primer-css 0→0 · blitz 2→2 · hhra-org 0→0 ·
  gin n/a (Go corpus) · svelte-realworld 0→0

### Adjudication

14 findings, all genuine `instanceof`-against-a-user-defined-type cases: knex's
dialect classes (`Client`, `Client_Oracle`, `Client_Oracledb`, `Client_SQLite3`,
`QueryCompiler_MSSQL`, `ColumnCompiler_Oracle`, `Oracledb_Compiler`, `Runner`,
`Transaction`, `Migrator`, `Builder`, `QueryCompiler`) and blitz's `SessionContextClass`
and `Field`. Each is a concrete type being matched against its base/peer class —
exactly the dispatch-on-concrete-type smell the rule claims. Zero false positives of
the "frequently modified" or blanket-OCP kind, because the rule no longer asserts
either anywhere — the surviving claim is purely "this class type-checks against a
concrete user-defined type".

### Verdict

- `solid/open-closed` — `reworded` (registry message and invalid sample corrected to
  match the already-honest emitted message and predicate); the computation was
  already complete and the only crude remnant was the stale "frequently modified" /
  "Open/Closed Principle" template string and a mismatched sample.

---

## Session 11 — `solid/liskov-substitution` (already replaced in spec-44; verified) (spec-49 order #7 remainder, row 27)

The authenticity ledger marked `solid/liskov-substitution` (row 27) crude with one
gap: the old proxy — for each non-constructor method, if `cls.extends`, walk the
method node for a `throw_statement` and fire — computed only "contains a throw
statement", never "violates the parent class contract". A subclass method that
throws is not a Liskov violation when the parent method throws the same way, nor
when it is a *new* method (not an override), nor when the parent is unresolvable
(imported, cross-file). The message claimed "Ensure this doesn't violate parent
class contract" without ever comparing against the parent.

### The state on arrival

The rule was **already replaced in spec-44**, not in this sweep. Commit `a60f655`
("build the honest predicates") rewrote `checkLiskovSubstitution` and added a
six-test suite (`src/analyzers/universal/liskov-substitution.spec.ts`); commit
`fdd8c81` reworded the message to claim only what is computed. The honest predicate:

1. resolve the parent class **within-file** (`adapter.extractClasses(ast).find(c =>
   c.name === cls.extends)`); if it cannot be found — imported/cross-file parent —
   the contract is unknowable and the rule does **not** fire (claim less rather than
   accuse blindly);
2. require a **real override** — a same-named parent method, not a new method;
3. fire only when `childThrows && !parentThrows`.

The emitted message and the registry's canonical template both read "…throws where
the parent does not", and the samples are correct (`Ostrich extends Bird` with a
throwing `fly()` as invalid; `Sparrow extends Bird` with a non-throwing `fly()` as
the near-miss valid).

### The fix

None required in this session. The predicate, message, and samples were already
honest. This session's contribution is **verification + measurement + ledger
record**: the six-test spec-44 suite was re-run green, and the honest rule's count
was measured across the TS corpora. The remaining `gap` — cross-file parent
resolution — is `blocked` (needs a type resolver, which the syntax-only tree-sitter
adapter lacks), and the honest rule already handles it by declining to fire.

### Tests (spec-44, re-verified this session)

`src/analyzers/universal/liskov-substitution.spec.ts` — 6 tests, running the real
`UniversalSOLIDAnalyzer` via `analyzeAST`:

- true positive — an override that throws where the parent does not (`Ostrich.fly`)
- near-miss — an override that does not throw (`Sparrow.fly`)
- contract preserved — child throws but the parent also throws
- unresolvable parent — `extends Bird` with `Bird` not in the file
- non-override — a *new* `swim()` method throws
- no parent — a throwing method on a class with no `extends`

6 green. No new tests were written this session — writing a duplicate subset of the
spec-44 suite would add nothing (the Session 5 precedent: TS `dependency-inversion`
was recorded `already replaced` with its existing near-miss suite, no new tests).

### Counts (before → after, per corpus)

The proxy was removed in spec-44, before this sweep's baseline. The honest predicate
fires only on a within-file override that throws where the parent does not — a
genuinely rare shape, because parents are usually imported cross-file:

- recall 0→0 · knex 0→0 · primer-css 0→0 · blitz 0→0 · hhra-org 0→0 ·
  gin n/a (Go corpus — the Go `liskov-substitution` is a separate dishonest rule,
  row 13, already fixed) · svelte-realworld 0→0

A count of zero is the honest answer, not a regression: the old proxy's non-zero
readings were false positives (any subclass method that threw), and the honest
signal is rare.

### Adjudication

Zero survivors — a count of 0 has nothing to re-examine. The rule now claims a
specific, provable thing (a within-file override that throws where the parent does
not) and is silent everywhere it cannot prove it.

### Verdict

- `solid/liskov-substitution` — `replaced` (already replaced in spec-44, commits
  `a60f655` + `fdd8c81`: within-file parent resolution + real-override requirement +
  throws comparison, with a 6-test suite). The cross-file-parent half is `blocked` —
  it needs type resolution the syntax-only adapter lacks — and the honest rule
  already declines to fire there.

---

## Session 12 — `complex-query` (table-count proxy → subquery-or-many-tables) (spec-49 order #7 remainder, row 31)

The authenticity ledger marked `complex-query` (row 31) crude with one gap:
"Complex query = count of regex-extracted table names; `hasSubquery`/`hasJoins` are
computed but not wired into the `high` gate." The rule fired only on
`tables.length > joinedTableCount` (default 4), so a genuinely complex query built
around a subquery — `WHERE id IN (SELECT …)`, `NOT EXISTS (SELECT …)`, a scalar
subquery in the SELECT list — was invisible whenever it touched few tables.

Two defects stacked. First, `hasSubquery` was computed from `sourceCode` (the
*whole file*): a file with two unrelated simple queries read as "has a subquery",
so wiring it in as-is would have flagged both simple queries. Second, even that
(broken) `hasSubquery` was dead — only `performanceRisk === 'high'`
(`tables.length > joinedTableCount`) drove the violation.

### The fix

- **Query-scoped subquery detection.** `DatabaseCall` gained a `queryText` field
  (the candidate node's own text, comments stripped). `hasNestedSelect(queryText)`
  returns true when the query text has ≥2 `SELECT` keywords — a nested SELECT.
  This replaces the file-scoped `sourceCode.includes('SELECT')` heuristic.
- **Wire it into the gate.** `performanceRisk === 'high'` is now
  `hasSubquery || tables.length > joinedTableCount`, not just the table count.
- **Honest message.** The violation names the reason: "contains a subquery" /
  "references N tables" / both. The registry message and samples were updated to
  match (the subquery case added as an invalid sample).
- The now-unused `sourceCode` parameter was dropped from `analyzeQuery`.

### Tests (written before implementation, per the TDD loop)

`complexQuery.spec.ts` — 4 tests, running the real `UniversalDataAccessAnalyzer`:

- positive — a 6-table join fires (tables > 4)
- inverse near-miss — a subquery with only two tables fires (the case the old
  table-count proxy missed: 2 ≤ 4)
- near-miss — a simple single-table `COUNT(*)` query does not fire
- file-scope guard — two unrelated simple queries in one file do not fire (proves
  subquery detection is query-scoped, not file-scoped)

1 red before implementation (the subquery inverse near-miss); 4 green after.
Contract suites stay green: `nearMissGuards` (9), `ruleRegistry` (5),
`nearMissExecutor` (101, 67 skipped), `baseline` (70), and the data-access
integration suite (44).

### Counts (before → after, per corpus)

- recall **1→67** · knex 0→0 · primer-css 0→0 · blitz 0→0 · hhra-org 0→0 ·
  gin n/a (Go corpus) · svelte-realworld 0→0

The recall delta is the entire point of the fix: the old proxy fired on exactly 1
finding (a >4-table join); the honest signal surfaces 66 subquery findings the
proxy was blind to. Every one of the 66 is a genuine subquery (`NOT IN (SELECT …)`,
`NOT EXISTS (SELECT …)`, scalar `(SELECT COUNT(*) …) AS x` in the SELECT list).

### Adjudication

Sampled 12 of the 66 new recall findings (backfill-strategy-heroes, dedup-strategies,
builds, nickname, weighting, edit/generate-duo-article, cleanup-impossible-builds,
edit-build-article): all true — each carries a real subquery. No false positives of
the "SELECT appears twice for another reason" kind surfaced. The one residual
imprecision is that a `UNION` (two SELECTs, not a subquery) would also read as
"contains a subquery"; none appeared in the corpus, and a UNION is itself a
legitimate complexity signal, so the wording overreach is immaterial.

### Verdict

- `complex-query` — `replaced`: the "count of tables" proxy is replaced by the
  honest "subquery or many-tables" signal, with subquery detection scoped to the
  query's own text. The table-count half survives under its own honest reading
  (a >4-table join *is* complex), now alongside the subquery half it was missing.

---

## Session 13 — `unfiltered-query` (WHERE/HAVING/LIMIT/ON substring proxy → row-limiting clause) (spec-49 order #7 remainder, row 32)

The authenticity ledger marked `unfiltered-query` (row 32) crude with one gap:
"Unfiltered = absence of WHERE/HAVING/LIMIT/ON keyword substrings; `WHERE 1=1`
or `JOIN … ON` with no row-limiting WHERE counts as filtered." Two proxy defects:

1. **`ON` is not a filter.** A `JOIN … ON` predicate scopes *how* rows match, not
   *which* rows come back. `SELECT * FROM a JOIN b ON a.id = b.id` returns every
   joined row — an unbounded read — yet the `\bON\b` substring read it as
   "filtered".
2. **`WHERE 1=1` is not a filter.** The tautology is the placeholder prepended so
   a caller can append `AND x = ?`; by itself it limits nothing, yet `\bWHERE\b`
   read it as "filtered".

### The fix

- **Drop `\bON\b`** from `hasQueryFilter`. A filter is now a row-limiting clause
  only: a WHERE carrying a real predicate, a HAVING, or a LIMIT.
- **Tautology-aware WHERE.** `whereClauseIsTautology(text)` extracts the WHERE
  body (up to the next clause keyword, with the SQL-string terminator + call-arg
  closer stripped) and returns true only for a bare `1=1` / `1 = 1` / `TRUE`
  (optionally repeated under `AND`). `WHERE 1=1 AND active = ?` is not a
  tautology. `WHERE 1=1 … LIMIT ?` stays filtered — the LIMIT is the real
  row-limiting clause.

### Tests (written before implementation, per the TDD loop)

`unfilteredQuery.spec.ts` — 5 tests, running the real `UniversalDataAccessAnalyzer`:

- positive — a bare `SELECT * FROM users` fires
- near-miss — `SELECT * FROM users WHERE active = ?` does not fire
- inverse near-miss (ON) — `SELECT * FROM users u JOIN orders o ON u.id = o.user_id`
  fires (the old proxy called it filtered)
- inverse near-miss (tautology) — `SELECT * FROM users WHERE 1=1` fires
- guard — `SELECT * FROM users WHERE 1=1 AND active = ?` does not fire

2 red before implementation (both inverse near-misses); 5 green after. Contract
suites stay green: full unit suite (98 files, 1273 passed, 67 skipped),
`nearMissGuards` (9), `ruleRegistry` (5), data-access integration (44).

### Counts (before → after, per corpus)

- recall **32→32** · knex **14→15** · primer-css 0→0 · blitz **30→30** ·
  hhra-org 0→0 · gin n/a (Go corpus) · svelte-realworld 0→0

The delta is one finding, on knex. The monotonic predicate (removing filters can
only *add* unfiltered readings, never remove one) means 32→32 and 30→30 are
identical sets, not a swap.

### Adjudication

- **The +1 (knex)** — `test/tape/raw.js:72`:
  `raw('select * from "table" join "chair" on :tableCol: = :chairCol:', …)`.
  A `JOIN … ON` with no WHERE/HAVING/LIMIT. Genuine unbounded read. TRUE.
- **recall survivors (32)** — sampled `get-static-paths.ts:109`
  (`db.prepare("SELECT slug, sub_role_name FROM heroes").all()`),
  `backfill-patch-eras.ts:114`
  (`d1Query(… SELECT era_id, start_date FROM patch_eras ORDER BY start_date)`),
  `hero-data-agent.ts:219` (a `storage.sql` builder read), and `data.ts:470`:
  all bare SELECTs / builder reads with no limiting clause. TRUE.
- **blitz survivors (30)** — same shape as recall: plain unfiltered reads.
- **The tautology fix produced zero delta, correctly.** Every `WHERE 1=1` in the
  corpora is followed by a real clause that *does* bound the result —
  `stadium-builds.ts:489` (`WHERE 1 = 1 … LIMIT ?`), `hhra-org/compliance.ts:199`
  (`WHERE 1=1 … LIMIT $N OFFSET …`), `foodPesticideList.ts:120`
  (`WHERE 1=1${additionalWhere} … LIMIT …`). Each stays filtered because the
  LIMIT is the row-limiting clause; the honest predicate does not un-filter them.

### Verdict

- `unfiltered-query` — `replaced`: the "absence of WHERE/HAVING/LIMIT/ON
  substrings" proxy is replaced by "absence of a row-limiting WHERE/HAVING/LIMIT
  clause", where `ON` and a bare `WHERE 1=1` no longer masquerade as a filter.

---

## Session 14 — `conventions/error-handling` (first-match regex over body text → structural AST shape) (spec-49 order #7 remainder, row 38)

The authenticity ledger marked `conventions/error-handling` (row 38) crude with
one gap: the error-handling *shape* of a function is classified by a **first-match
regex over raw body text**, which (a) collapses a body that mixes two shapes down
to whichever the regex saw first, and (b) misclassifies text — a string or comment
containing `try {` reads as a try/catch, `if (errorMessage)` reads as `if-err`, and
`.success` reads as `go-style`. The proxy was:

```ts
\btry\s*\{        → 'try-catch'
\.catch\s*\(      → 'promise-catch'
\bif\s*\(\s*err   → 'if-err'
\b\.success\b     → 'go-style'
```

### The fix

`detectErrorHandlingShape` now walks the function body's tree-sitter AST and
classifies the shape from real nodes:

- `try-catch`     — a `catch_clause` (a real try/catch, not `try`/`finally`)
- `promise-catch` — a `.catch(...)` call (`call_expression` whose callee is a
  `member_expression` with property `catch`)
- `if-err`        — an `if` whose condition is a bare error-presence check
  (`if (err)`, `if (!err)`, `if (err != null)`), not type narrowing
  (`err instanceof Error`) or member access (`err.message`)

The `go-style` shape is **dropped entirely** — `.success` is a result boolean
(Zod `safeParse().success`, a `{ success: boolean }` API field), not error
handling. A body exhibiting more than one distinct shape is ambiguous and
returns null (never collapsed). A body with no error handling returns null.
`MINER_VERSION` bumped 1 → 2 so the re-mine runs against the new predicate.

### Tests (written before implementation, per the TDD loop)

`errorHandlingShape.spec.ts` — 9 tests against the real `detectErrorHandlingShape`
(the stored `{...}` body text parsed by the TS parser):

- positive — `try {} catch {}` → `try-catch`; `.catch()` → `promise-catch`;
  `if (err)` → `if-err`
- near-miss — a string literal `"try {"` → null; `if (errorMessage)` → null
- inverse near-miss — a mixed try/catch + `.catch()` body → null (not collapsed
  to its first shape); `if (err instanceof Error)` → null (type narrowing);
  `r.success` (Zod result) → null

The inverse near-misses (`if (err instanceof Error)`, `r.success`, and the
multi-shape body) failed against the first AST iteration and drove its
refinement — the first iteration still classified `.success` as `go-style` and
any `err` identifier in the condition as `if-err`, both of which the adjudication
step below caught as residual false positives.

### Counts (before → after, per corpus)

- recall **49→51** · knex 0→0 · primer-css 0→0 · blitz 0→0 ·
  hhra-org 0→0 · gin 0→0 · svelte-realworld 0→0

The +2 on recall is the net of two opposing corrections. Dropping `go-style`
removes ~18 `.success`-as-error-handling false positives and the broad `if-err`
scan removes ~2 `instanceof` false positives; those removals are offset by the
multi-shape collapse fix, which now correctly surfaces ~10 bodies that mix a real
`.catch()` with a `.success` field (previously excluded as "ambiguous"). Every
delta is attributed to a named cause.

### Adjudication

- **All 51 recall survivors are `promise-catch`** — a `.catch(...)` call in a
  directory whose dominant shape is `try-catch`. Sampled:
  `_find-source.ts:213` (`await r.json().catch(() => ({ error: r.status }))`),
  `og-build-png.ts:36` (`initWasm(fetch(url)).catch((error) => { … })`),
  `og-hero-png.ts:58`, `fan-creations.ts:22` — each is a genuine `.catch()` on a
  promise. TRUE, all of them.
- **`go-style` — gone.** `.success` no longer registers as error handling, so
  the Zod/API-result false positives that dominated the old output are removed.
- **`if-err instanceof` — gone.** `if (err instanceof Error)` is type narrowing,
  not a presence check, and no longer registers.

### Verdict

- `conventions/error-handling` — `replaced`: the first-match regex over raw body
  text is replaced by a structural AST walk that classifies `try-catch`,
  `promise-catch`, and `if-err` from real nodes, drops the bogus `go-style`
  shape, and leaves multi-shape bodies unclassified rather than collapsing them.

## Session 15 — `styles/off-scale` (hardcoded [2,4,8,16] step proxy → Tailwind scale membership) (spec-49 order #7 remainder, row 43)

### The state on arrival

`detectOffScaleValues` parsed scale-family values to px, inferred a uniform
"step" from a hardcoded `[2, 4, 8, 16]` candidate set, and flagged any value
whose remainder against that step was more than 1px away from both 0 and the
step. Three defects:

1. **Overclaim** — the registry message was `'Value "{value}" is off the
   project\'s design scale.'`, but the predicate was a step guess, not a real
   scale. The actual emitted message at least said "inferred {step}px scale
   step", but "project's design scale" still named a thing that was never read.
2. **Cannot-fire** — because every multiple of 4/8/16 is also a multiple of 2,
   `inferScaleStep` always resolved to step 2 (or null), and step 2's 1px
   tolerance (`|remainder| > 1`) swallowed every possible remainder. The rule
   emitted **0 findings on every corpus**.
3. **Dead code** — `TAILWIND_SPACING_PX` / `TAILWIND_SCALE_VALUES` were defined
   but never referenced; the scale the rule needed was sitting there unused.

### The fix

The step proxy is gone. The predicate is now **exact membership in the
property's Tailwind design scale**, fed by the previously dead constant:

- `TAILWIND_SPACING_VALUES` (margin/padding/gap) — the named default spacing
  steps, completed with the `1.5`/`2.5`/`3.5` steps (6/10/14px) the old table
  omitted.
- `TAILWIND_FONT_SIZE_PX` (font-size) — the named `text-xs`…`text-9xl` steps
  (12/14/16/18/20/24/30/36/48/60/72/96/128). Font-size is judged against its
  **own** scale, not the spacing scale: `14px` is `text-sm` but not a spacing
  step, and `28px` is a spacing step but not a font size. The old proxy judged
  both against one inferred step, which is the category error the split removes.

The message now says exactly what it measures: `is not on the Tailwind
{spacing|font-size} scale`, with the nearest scale values on either side. The
registry message is `'Value "{value}" is off the Tailwind spacing scale.'`.

### Tests (written before implementation, per the TDD loop)

`UniversalStylesAnalyzer.spec.ts` — 5 tests, replacing the two proxy-era tests
(one of which asserted the proxy's null-step no-op):

- positive — `margin-top: 13px` (off the spacing scale) fires
- near-miss — `8/12/20/24/28/16px` (on-scale values the old step proxy would
  have mis-flagged at step 8) do not fire
- inverse near-miss — `margin-top: 100px` (a multiple of 4 the old step-4 proxy
  passed, but not a spacing step) fires
- near-miss (font-size) — `font-size: 14/16/18/20/30/24px` (all named font
  sizes; `30px` is `text-3xl` but not a spacing step) do not fire
- inverse near-miss (font-size) — `font-size: 28px` (a spacing step but not a
  named font size) fires

The positive and inverse near-miss tests failed against the old implementation
(0 findings — the proxy never fired), posting the pre-change failure; the two
font-size scale-separation tests also failed against any single-scale check.

### Counts (before → after, per corpus)

- recall **0→735** · knex 0→0 · primer-css **0→101** · blitz **0→50** ·
  hhra-org 0→0 · gin 0→0 · svelte-realworld **0→45**

Every "before" count is 0 because the proxy could not fire at all (step always
2 or null). The "after" deltas are entirely new findings from the real
predicate. hhra-org/gin stay 0 because they hold no scale-family declarations;
knex stays 0 for the same reason. The four positive deltas are real arbitrary
values in real CSS.

### Adjudication

Sampled from recall (735, the largest): dominated by hand-tuned pixel values in
a Tailwind v4 project — `margin-top: 3/7/9/11/22/18/30px`,
`font-size: 11/9/13/13.5/15px`, `row-gap: 7px`. Every sampled value is a
genuine off-scale magic number (TRUE). `30px` on a margin is off the spacing
scale (28 or 32, no 30); `30px` as a font size is `text-3xl` and correctly not
flagged — the scale split is what keeps those from colliding.

- **No false positives** — no on-scale value was flagged. The nearest value I
  could find on the boundary (`0.5em`, `0.2rem`) converts to a fractional px
  that is off either scale, so it is correctly flagged.
- **true-but-useless tail** — negative pixel nudges (`margin: -1px`, `-15px`)
  and non-Tailwind corpora (Primer's `15px`/`13px`, svelte-realworld's conduit
  theme) are technically off the Tailwind scale but not token-bypass defects in
  a project that never used Tailwind. They are a small fraction of the tail,
  and the message names the Tailwind scale so the reader can dismiss them.

### Verdict

- `styles/off-scale` — `replaced`: the hardcoded `[2,4,8,16]` step proxy
  (which overclaimed "project's design scale" and, in practice, never fired) is
  replaced by exact membership in the property's Tailwind design scale, with the
  spacing and font-size scales separated so each property is judged against the
  scale it actually uses.

## Session 16 — `styles/token-bypass` (key-normalization asymmetry → symmetric normalized match) (spec-49 order #7 remainder, row 46)

### The state on arrival

Row 46 marked `styles/token-bypass` crude with two gaps: (1) the
`valueType !== 'color'` gate that let only colour tokens fire, silently
skipping length/spacing/other token bypasses; and (2) a key-normalization
asymmetry — `buildTokenValueMap` keyed the map by the token's *raw* value while
`matchBypassToken` looked up the declaration's *normalized* spelling. Two
commits from the Spec-44 sweep had already closed gap (1) (`d4d2f12` removed the
colour gate) and fixed a separate built-in-defaults false-positive
(`b2e4ec6`). Gap (2) — the asymmetric key — was still open on arrival.

### The fix

`buildTokenValueMap` now keys the map by `normalizeForTokenMatch(t.value)` — the
same lowercasing/`#rgb`→`#rrggbb` expansion the lookup applies to the
declaration. A shorthand or case-differing token value (`#fff`, `#FFFFFF`) now
matches a raw declaration of the same colour (`#ffffff`), in both directions.
The comment names the ledger gap it closes.

### Tests (written before implementation, per the TDD loop)

Three tests added to the Token Bypass block:

- inverse near-miss — a shorthand-hex token (`#fff`) matches an expanded raw
  value (`#ffffff`); failed pre-change (map key `#fff` vs lookup `#ffffff`).
- inverse near-miss — a case-differing token (`#FFFFFF`) matches a lowercase
  raw value (`#ffffff`); failed pre-change (map key `#FFFFFF` vs lookup
  `#ffffff`).
- near-miss — `#1e2329` does NOT match token `#1e2328` (exact-match only, no
  fuzzy hex); passed pre-change, kept to lock in the boundary.

The two inverse near-misses posted the pre-change failure (0 findings where 1
was expected).

### Counts (before → after, per corpus)

- recall **423→456** · knex 0→0 · primer-css 0→0 · blitz 16→16 ·
  hhra-org 0→0 · gin 0→0 · svelte-realworld **1→5**

The +33 on recall and +4 on svelte-realworld are shorthand/case false negatives
now caught. blitz's 16 are unaffected (already normalised spellings). The rest
stay 0.

### Adjudication

Sampled recall (456). Findings split into two classes by the *role* of the
matched token:

- **TRUE** — raw literal matching a *generic* token: `border-*-width: 8px`
  matching `--space-2: 8px`, `color: …` matching `--color-rewrite-white` /
  `--bg-secondary`, `background: …` matching `--surface-card`. The token is the
  canonical spelling of that value; the raw literal is a genuine bypass.
- **true-but-useless** — raw literal matching a *specific* token by value
  coincidence: `border-radius: 4px` / `flex: 4px` matching `--girder-width:
  4px` (a girder element's width), `max-width` matching `--content-max`,
  `clip-path` matching `--clip-sm`. The value equals the token's value but the
  token is not the right one for the property; the "use this token" suggestion
  is wrong. The `--girder-width` family alone is ~113 of 456.

No on-scale or genuinely-different values are flagged (exact match holds). The
true-but-useless tail is inherent to value-only matching, surfaced — not caused
— by the colour-gate removal: small length values (4px/8px) coincide with
specific tokens far more often than colours do. Eliminating it would require
token-*role* analysis (distinguish a generic `--space-2` from a specific
`--girder-width`), which is beyond this rule's ledger gap.

### Verdict

- `styles/token-bypass` — `replaced`: both ledger gaps are closed — the
  colour-only gate (removed in `d4d2f12`) and the key-normalization asymmetry
  (this session). The rule now honestly measures "a raw value whose normalised
  spelling equals a project-defined token's value, type-agnostic and
  case/shorthand-symmetric". The residual value-coincidence tail is reported as
  true-but-useless above, not left unstated.
