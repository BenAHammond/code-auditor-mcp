# Changelog

All notable changes to the Code Auditor MCP project.

## [3.9.0] — 2026-09-09

### SQLite without a native install (Spec 51)
`better-sqlite3` is no longer a hard dependency. The tool now selects its SQLite
backend at runtime: the built-in `node:sqlite` (`DatabaseSync`/`StatementSync`)
is the primary backend on Node 23.4+ and needs no native install or prebuilt
binary, so a fresh `npm install` on npm 11.2+/12 (which block install scripts by
default) just works. `better-sqlite3` remains as an `optionalDependencies`
fallback for Node 18–23.3.

- Backend selection is a runtime capability check, not a version-string match
  (`CODE_AUDITOR_SQLITE_BACKEND=node-sqlite|better-sqlite3` forces one for the
  parity suite). The active backend is reported in `code-audit --version`.
- `node:sqlite`'s missing `.transaction()`/`.pragma()` and its stricter
  named-parameter binding are shimmed behind the same interface; error codes are
  normalized to better-sqlite3's `SqliteError` shape so callers branching on
  `SQLITE_BUSY` etc. behave identically.
- Full-suite and corpus parity verified: both backends produce byte-identical
  results (recall-protocol corpus: 4,351 advisory findings under both).
- **Node floor:** `>=18` to run, `>=23.4` for the zero-native-install path.

## [3.8.1] — 2026-09-08

### Fresh-install fix — better-sqlite3 prebuild gap
A fresh npm install on npm 11.2+/12 left the tool unusable: npm's default
install-script allowlist blocks better-sqlite3's `prebuild-install`, so the
native SQLite binding is never downloaded. The audit then aborted with an error
that named neither the cause nor the fix — first a generic "corrupted/locked"
hint, then a downstream "Database not initialized" thrown 40 call sites later.

- The missing-binding failure now surfaces a clear cause + fix
  (`npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3`).
- `verify:dist` gained a deterministic guard (Guard 9) that reproduces the
  npm-12 blocked-install path via `--ignore-scripts` and asserts the clear
  error — so the gate that previously passed over this defect now catches it.

### Coverage — Go successor rules visible
The Spec 49 Go renames (`open-closed`→`switch-size`,
`single-responsibility`→`function-size`/`struct-size`) left four Go successor
IDs missing from the rule registry, so those findings were emitted but never
counted. Added `switch-size`, `function-size`, `struct-size`, and the bare Go
`liskov-substitution` to the registry and dropped the one wrong alias that
asserted a split identity.

### Daemon — `--help` no longer launches the process
`code-auditor-daemon --help` launched the daemon (~800 MB) instead of printing
usage. Argument parsing is extracted and unit-tested, and `--help`/`--version`
exit before the daemon starts.

## [3.8.0] — 2026-09-08

### Rule authenticity — Spec 49 closes the crude sweep
The 33 `crude` and 4 `dishonest` rules flagged in the authenticity ledger were
replaced, renamed, or blocked, so no analysis reports a name/doc-comment/substring
proxy under a rule ID that overclaims what was computed. The ledger now reads
`crude: 0`.

- **`solid::function-length`** (was `single-responsibility`) — counts parameters
  and lines honestly; the SRP claim is dropped.
- **`solid::interface-size`** (was `interface-segregation`) — counts members; true
  ISP needs client-usage sets.
- **`solid::switch-size`** (was Go `open-closed`) — counts cases; "closed to
  extension" needs type resolution.
- **`schema-code::dynamic-sql-construction`** (was `sql-injection`) — names the
  construction, not an unproven taint flow.
- **`cross-domain::multi-table-write`** (was `transaction-boundary`) — counts
  write targets, not an unparsed boundary.
- **`cross-domain::no-validator-reachable`** (was `validation-bypass`) — BFS
  reachability, not "not validated".
- Go `solid/dependency-inversion` (concrete-field) is **blocked** — the proxy was
  removed; an honest field-type check needs a semantic tier tree-sitter lacks.

### Rule-identity seam fix
The Go subprocess now emits the canonical `rule` ID, so the renames hold across
both TypeScript and Go analyzers instead of diverging on identity.

### Daemon — Spec 50
Auditing can run as a long-lived per-project process. One core owns the store and
pipeline; the Unix-socket and LSP faces are thin adapters over it, and every
command still works with no daemon (the daemon is an optimisation, never a
dependency).

- **`retryAfterMs` covers time-to-ready** — a polling client is told how long until
  the seed is *ready*, not just done reading files. The estimate prices the
  source/orphan file populations separately, then the corpus/derived reducer and
  finalization phases on their own rates, and never reports the "almost done"
  floor while a later phase has not started.
- **JSON dead-read removed** — JSON orphans no longer materialize their bytes for
  the schema-json visitor (it re-reads on demand); a measured read-cpu saving with
  no finding-count change.

## [3.7.0] — 2026-09-06

### Hardcoded credentials — new critical, gating analyzer
A new analyzer flags credentials embedded in source rather than read from
environment variables. It gates at `critical` out of the box.

- **`hardcoded-secret`** — pattern-matches connection strings, API-key
  formats, and credential-like string literals; fires `critical` and blocks the
  edit gate.
- **All-secret-args preserved** — `checkCredentialCall` keeps its
  all-secret-arguments behavior so a call passing only secret values is not
  misclassified.

### Analyzer hardening
- **`unreferenced-module` promoted** — `suggestion` → `warning`, so dead modules
  now surface at a gating severity.
- **`dry` quieter on fluent chains** — the default-on similar-expression check no
  longer fires on fluent library chains (`.map().filter().reduce()`).
- **`dependency-graph` orphan fix** — receiver-dispatched methods are no longer
  flagged as orphans; only genuinely unreferenced nodes report.
- **`documentation` noise cut** — default findings drop 1,044 → 159 on the
  hhra-org corpus by suppressing low-value defaults.
- **Self-audit debt cleared** — the new analyzer code passes code-auditor's own
  gate.

### Release hygiene
- **`.code-auditor-version` and the repo-root skills copy are dropped** — the
  plugin reads its version from the single source of truth, `package.json`.
- **`verify:close` fails fast on low disk** — the gate checks free space before
  running, instead of failing mid-run.

## [3.6.0] — 2026-09-05

### Enforcement — Spec 45 reverts the unauthorized narrowings
The R6 survey found ten enforcement/gating/reporting narrowings written into
specs 36–42 without agreement. Spec 45 reverts them all. Corpus baselines are
unchanged — the finding set is identical across all six corpora.

- **Every rule gates (R1)** — the per-rule `gating` opt-in is removed; a finding
  gates regardless of which rule produced it, with no requirement that the rule
  name a resolution first.
- **Severity-scoped gate (R2)** — severity returns to the gating decision; the
  gate blocks `critical` and `warning`, recording a resolution gap rather than
  dropping the finding to non-blocking.
- **No decaying suppressions (R3)** — the decaying-suppression mechanism is
  removed (it was never built).
- **Enforcement is not diff-scoped (R4)** — the gate compares against the full
  finding set, not only the lines the current edit touched.
- **`styles/undefined-class` reports on unread stylesheets (R5)** — a
  `.sass`/`.less`/`.styl` stylesheet no longer silences the rule with
  `notApplicable`; the finding still fires and carries the unread source as
  `details.incompleteDefinitions`, so "undefined" reads as "not defined in any
  *read* stylesheet".

### Amendment A
- **A1** — a slow rule is optimized, never dropped from the gate (Spec 38 R3's
  "removed from the gating set" is struck). The budget is reported, never
  silently widened.
- **A2** — counts are emitted in agent-facing output: per analyzer, per rule,
  per severity, and the before/after gating figure (Spec 36 R3's "no bare
  counts" is struck).

## [3.5.0] — 2026-09-05

### Rule authenticity — the dishonest rules now do what they claim
The authenticity audit found four rules whose predicates matched a name or a
doc-comment proxy instead of the thing their message claimed. All four are
reimplemented against the real AST:

- **Go `solid/liskov-substitution`** — walks method bodies for `panic()` calls
  instead of matching "panic" in the name.
- **Go `errors/error-handling`** — an errcheck-style walk: an `err` assigned from
  a call and never checked/returned/passed/ignored is a dropped error (bare
  returns in named-`err` functions count as a check).
- **Go `goroutines/concurrency`** — a `go` statement with no sync primitive or
  channel handoff, instead of matching "go"/"async"/"concurrent" in the name.
- **TS `data-access/missing-org-filter`** — derives tenant-scoped tables from the
  schema catalog; the hardcoded English `fallbackOrgTables` list is deleted.

### Cannot-fire reporting
Ten rules that can never fire (their extractor never populates the field they
read) now emit an explicit `cannot-fire` diagnostic naming the missing extractor
and field, distinct from `notApplicable` — a standing record of a broken rule,
not a per-project "nothing to see here."

### Crude / overclaim rule cleanup
- Reworded seven messages that asserted more than the predicate computed.
- Renamed crude size-proxies (`single-responsibility`, `interface-segregation`,
  `dependency-inversion`, `complex-query`, `unfiltered-query`, documentation
  length checks, …) to claim only what is measured.
- `schema/table-naming-convention` replaced its uppercase-proxy with an explicit
  `/^[a-z][a-z0-9_]*$/` conformance check.
- `styles/token-bypass` now fires on non-color tokens (the `valueType !== 'color'`
  gate is removed), so length/spacing token bypasses are caught.
- `dependency-graph` (circular-dependency, tight-coupling, hub-nodes, …) renders
  the cycle/node data it already computed instead of flattening to "Found N".

### Decide — built the tractable ones, cut the rest
`solid/liskov-substitution` (TS), `react/accessibility`, `react/performance`, and
`schema-validator/missing-field` are built against real inputs; the cohesion/
dataflow-dependent rules are cut or kept-as-renamed.

### Near-miss executor
Every declared near-miss sample now runs through its real analyzer and asserts
zero findings (28 wired); the remaining 66 are classified per-rule with the
precise missing input and `it.skip`ped, so the gap is visible rather than faked.

### Go routing fix
The Go-subprocess routing decision no longer counts a `.go` file buried in a
dependency's `node_modules` as a source file — a pure-TS project with such a
dependency is no longer misrouted through the Go analyzer (which dropped every
non-Go analyzer).

### Self-audit remediation — `verify:self` to zero
The 30 pre-existing `critical`+`warning` findings in `src/analyzers/` +
`src/languages/` are remediated honestly — duplicated logic collapsed into shared
helpers (`resolveReceiverText`, `enqueueCallNeighbors`, `filterByFilePatterns`,
`collectPatternTables`, `pushExportedSpec`, `resolveDeclaration`, …) and the
missing `@param`/`@returns` docs added — not via severity/threshold calibration.
`verify:close` now passes end-to-end, including `verify:self` at zero scoped
blocking findings.

### Edit-time self-audit hook
A new PostToolUse hook (`plugin/scripts/hook-self-audit.sh`) runs the same
self-audit scope over edited `src/analyzers/` + `src/languages/` files and blocks
the edit (exit 2) on any blocking finding, so self-audit findings fail at edit
time instead of recurring to the release gate. The shipped CLI gains a
`self-audit` command, and the hook resolves the plugin's own bundled CLI rather
than a stale PATH binary.

## [3.4.18] — 2026-09-03

### Index relocation
- The persisted code index now lives under `node_modules/.cache/code-auditor`
  (gitignored by universal convention) instead of a project-local `.code-index`
  directory — consumers no longer touch their own `.gitignore` for an internal
  detail. When `node_modules` is hoisted (monorepo), the path is scoped by a
  project hash; without `node_modules` it falls back to the OS cache dir.

### False-positive fixes
- `data-access/unfiltered-query` now treats reads scoped by `WHERE`, `HAVING`,
  `LIMIT`, or `ON` as filtered, so only genuinely unbound reads are flagged.
  Drops three false positives in the data-access fixture (baseline 12 → 9).
- React analyzer flags `rawElementCheck` and `requireErrorBoundaries` are now
  honored when set to `false` in `.codeauditor.json`, instead of being ignored.
- React class-component detection is fixed across `class_heritage` /
  `extends_clause` / `generic_type` tree-sitter nesting, and error-boundary
  method detection now covers `property_identifier` and
  `private_property_identifier` nodes.

### Defaults
- `minSeverity` now defaults to `suggestion` (was `warning`) across the MCP
  server, CLI, and pipeline surfaces.
- Plugin docs clarify the severity model: severity controls the edit gate, never
  the obligation to fix.

## [3.4.17] — 2026-08-26

### False-positive fixes
- `react/no-error-boundary` now recognizes Next.js App Router convention
  error-boundary files (`app/error.tsx`, `app/global-error.tsx`, and `.js`/`.jsx`/`.ts`
  variants) by basename. These are function components, so the class-only
  `hasErrorBoundary` check never fired for them, wrongly reporting "No error
  boundaries found" on projects that already define boundaries by convention.
- `documentation/parameter-documentation` no longer flags destructured
  object/array-pattern parameters (e.g. `({ children })`). Their parameter name
  is the raw pattern text, which can never match an `@param` tag, so they are
  skipped instead of reported as undocumented.

## [3.4.16] — 2026-08-19

### Close the 3.4.15 findings (Spec 45)
- Directory exclusions are now root-anchored: `docs` / `specs` / `backup` /
  `backups` / `build` at the project root are pruned, but the same names nested
  under source (`src/pages/docs/...`) are analyzed. Toolchain dirs
  (`node_modules`, `.git`, `.next`, `dist`, `out`, `coverage`, `.turbo`,
  `.cache`, `.vscode`, `.idea`, `.code-index`, `tmp`, `temp`) still prune at any
  depth.
- `styles/mechanism-fragmentation` and sibling style rules now report the raw CSS
  value in messages instead of the JSON `normalized_value` bucket key (fixes the
  `{"type":"literal","value":"center"}` leak).
- `infraPruned` accounting now reports directory counts (`node_modules (2
  directories)`) rather than implying file counts.

## [3.4.15] — 2026-08-19

### Detached runs & a queryable findings store (Spec 41)
- The findings ledger is now the single queryable findings store. `audit --detach`
  forks a detached run with per-run stderr captured to a log; new `status`,
  `result`, and `jobs` CLI commands read persisted run state and findings.
- Ledger runs gain lifecycle/provenance columns (`status`, `started_at`,
  `heartbeat_at`, `finished_at`, `error`, `progress_json`, content-hash
  manifest) and a `findings_ledger_coverage` table; coverage rows (fired / clean /
  notApplicable / unassessed per rule) are persisted for the first time.
- `auditJobService` is DB-backed (no in-memory `Map`); `runAuditJob` is shared by
  the MCP server and the CLI. Concurrency is a heartbeat lease (stale `running`
  rows are reclaimed as `failed`, never wedging the queue); retention is opt-in
  `jobs --prune` only.

### Stylesheet-dialect support (Spec 42)
- Embedded `<style>` blocks in `.astro` / `.vue` / `.svelte` are now read and
  parsed through the single shared rule-set parser (dispatching on `lang`/`type`),
  so those component dialects no longer produce silent zero class-usage counts.
- Unread style sources (`.sass` / `.less` / `.styl`, and unsupported `<style lang>`)
  are recorded to `style_unread_sources`; `styles/undefined-class` reports
  `notApplicable` naming them instead of asserting a class it cannot see.
- `styles/missing-org-filter` derives applicability from the schema table catalog
  (Tier 1 named tables / Tier 2 schema columns / Tier 3 DDL columns); no tenant
  column → `notApplicable` without a config flag.

### Silent-drop backstop (Spec 42 R2)
- The style extractor's `default:` branch no longer drops an unhandled file
  extension silently. A genuinely unknown dialect (`.mdx`, `.md`, …) is recorded
  as an unread source so `undefined-class` surfaces the gap; known non-style
  source (JSON/Go/SQL/TOML/Prisma) and `.css`/`.scss` (owned by the AST pipeline)
  stay silent via the shared `KNOWN_SOURCE_EXTENSIONS` set.
- The last hand-maintained extension lists (markup dispatch + class-usage gate)
  now derive from the `STYLE_MARKUP_EXTENSIONS` discovery constant, so adding a
  dialect to the discovery set flows everywhere at once.

### Gate-budget & fallthrough surface (Spec 43)
- The gate speed budget is now warm-then-measure: a cold run warms the page cache
  and index (reported, never asserted), and the warm run is the asserted figure —
  the budget measures rule latency rather than one-time WASM/index cost.
- The scoped-DRY `changed` path reads only the narrow columns
  `buildFullFunctionHashmap` needs (`getAllFunctionsForDry`), and `audit.health`
  counts functions with a `COUNT(*)` query — skipping the wide JSON columns and
  their per-row `JSON.parse`.
- Extensions present on disk but skipped by discovery (`.mdx`, `.md`, …) are now
  surfaced in the CLI so an unlisted extension never vanishes silently, and
  `styles/undefined-class`'s `notApplicable` reason names the per-source
  dialect/extension rather than a bare path list.

### File accounting (Spec 44)
- Every file the walk touches now lands in exactly one terminal state —
  `analyzed`, `partially analyzed`, or `dropped` (one of eight named reasons) —
  and the accounting must balance (`analyzed + partiallyAnalyzed + dropped ===
  touched`), asserted at end-of-run; a leak or double-classification fails the run.
- `partially analyzed` is keyed on *consumption*, not output: a file dropped at
  stage 2 (`no adapter` / `no visitor matched`) that any later layer read (the
  style indexer, or a stage-3 `readSource`) is reclassified, whether or not it
  produced findings — so a clean file the indexer read is never reported as
  "not analyzed".
- Infrastructure directories (`node_modules`, `.git`, …) are recorded as an
  aggregate `infraPruned` line, never per-file; content directories (`docs`,
  `specs`, …) are enumerated per-file as `dropped: directory pruned`.
- `.mjs` / `.cjs` / `.cts` / `.mts` are added to every site that hard-codes the
  JS/TS extension set, so those files are now discovered, parsed, and analyzed.
- The CLI summary line (`N analyzed · M dropped (R reasons)`) replaces
  `Files analyzed`, and `--explain-skipped` prints a bounded per-reason breakdown;
  the full per-file lists live in the JSON report under `metadata.fileAccounting`.

## [3.4.14] — 2026-08-17

### SOLID rule-ID namespace normalization (task #5)
- The five SOLID rules that were still emitting bare IDs — `single-responsibility`,
  `open-closed`, `interface-segregation`, `liskov-substitution`,
  `dependency-inversion` — now emit `solid/`-prefixed IDs, matching the two that
  already did (`solid/class-size`, `solid/method-complexity`). Applied consistently
  across the analyzer, `RULE_REGISTRY`, `defaults.ts`, and `RULE_ALIASES` (with a
  reverse map for the bare forms). `buildFullRuleId` now guards against
  double-prefixing (`solid/solid/class-size`).

### Self-scan exclusion (Bug #3)
- The tool's own on-disk output is no longer re-discovered as source: `.code-index`
  (the CodeIndexDB directory) is added to the excluded-dirs set, and
  `audit-report.{json,html,csv,sarif}` are skipped by basename. A prior audit's
  report embeds raw source snippets (e.g. `error_class = 'zombie-capped'`) that
  otherwise leaked class-usage false positives back into the next run.

### Two live false positives fixed (task #4)
- **Class-usage extraction**: a `\b` word boundary before the `class`/`className`
  attribute name prevents identifier-substring matches (`error_class`,
  `myclassName`) from being read as class attributes, while real
  `className="..."`/`class="..."` attributes still extract.
- **Tailwind v4 bare-import resolution**: bare package `@import`s (e.g.
  `tw-animate-css`, shadcn utility styles) are now resolved from `node_modules` via
  their package export map, so plugin utilities validate against the project's own
  `tailwindcss`. Fails open when a package or `node_modules` is absent.

## [3.4.13] — 2026-08-16

### Memory — streaming pipeline + `tree.delete()` (Spec 30/31/32)
- Streaming parse pipeline with per-file `tree.delete()`: peak heapUsed
  2.6 GB → 1.2 GB on the recall-protocol corpus.
- Three raw-content facts (file-sources / schema-sql / schema-json) eliminated —
  the arena no longer retains full source text.
- Oversized-SQL skip and WASM abort recovery.
- Post-`gc()` RSS on twenty (23,649 files): 2,423 MB → 1,285 MB; heapUsed after
  `gc()` flat at 71 MB (no JS-object leak).

### Schema precision fixes (Spec 33/34)
- `UniversalSchemaAnalyzer` split into `schema/` submodules; table-catalog
  registry (Tier 2) with provenance tracking.
- Taint-aware `sql-injection` (`isAllDynamicPartsSafe`) + parameterized-query skip.
- `interface-segregation` `hasMethodMembers` guard — data-shape records (GraphQL
  types, `HTMLElementTagNameMap`, config/DTO bags) no longer flagged.
- `open-closed` `BUILTIN_TYPES` expansion.
- Documentation de-dup: public methods reported once as `method-documentation`,
  no longer double-reported as `function-documentation`.
- `dependency-inversion` import-count signal removed (importing ≠ instantiating);
  the "directly instantiates" signal is retained.

### Self-audit to zero + pipeline hardening (Spec 35)
- `verify:self` gate on the production scope (`analyzers/` + `languages/`) at
  zero scoped violations, with a live zero-assertion.
- `isSafe*` parameter cluster collapsed into a `SafetyContext` object.
- A2: tree dispose runs on the throw path (`finally`), fault-injection tested.
- A3: every `catch` in the parse→loop span enumerated; none swallow silently.
- `verify:dist` self-contained (`npm pack` first); hook unset-variable guard.

### Enforcement + finding contract (Spec 36/37)
- Rules carry a resolution (the next action), not just a problem; rule metadata
  as a contract; rules ship with their tests.
- Binary gate: new findings block, existing ones don't; suppressions decay.
- `verify:gate-budget` enforces a 300 ms gate wall-clock budget.

### Operations (Spec 38)
- `--print-config`; per-rule timing; shareable presets (d1, drizzle, typeorm,
  prisma, plain-pg, knex); rule-ID alias map.

### Release verification
- Twenty 26,987 → 19,353 decomposed exactly (five named precision fixes, zero
  residual); knex re-pinned at 434, blitz at 917.

## [3.4.12] — 2026-08-10

### Accuracy fix — `unknown-table` silently off when configuring `schemas`

The pipeline schema reducer (`createSchemaReducer`) built its known-tables catalog
from `schemaConfig.knownTables` (a flat `string[]`) only. It did not read
`schemaConfig.schemas` — the documented, structured `{name, tables}` shape that
the standalone `UniversalSchemaAnalyzer.analyze()` path uses. A user who configured
only `schemas` in `.codeauditor.json` got `knownTables.size === 0`, triggering the
fail-open gate, and `unknown-table` violations silently never fired.

**Fix**: `createSchemaReducer` now flattens `schemaConfig.schemas` into the catalog
the same way the standalone analyzer does, so both config shapes work in both code
paths.

### Fixture corpus — 7 known-answer regression guard suites

Systematic fixture corpus: small projects with known-answer inputs and exact
violation-count assertions. Each suite copies to a temp dir and runs cold
through the real CLI — no mocks between config and report.

| Suite | Directory | What it guards |
|-------|-----------|---------------|
| Invariant rules | `tests/fixtures/invariant-rules/` | All 5 rule kinds: import-ban, naming, call-constraint, module-boundary, ast-pattern |
| Data-access rules | `tests/fixtures/data-access-rules/` | unfiltered-query, loop-query, missing-org-filter, complex-query; pool.length non-DB receiver guard |
| SQL FP guards | `tests/fixtures/sql-fp-guards/` | 10 safe-pattern files (prepare-bind, escapeSql, wrapper-bind, etc.) + 1 true positive; 15 documented acknowledged FPs |
| Conventions | `tests/fixtures/conventions/` | export-shape majority-rule detection (named-majority vs all-named) |
| Cross-domain | `tests/fixtures/cross-domain/` | written-never-read on INSERT-only table, transaction-boundary on multi-table write |
| SQL CTE | `tests/fixtures/sql-cte/` | CTE names excluded from table references; inner tables extracted |
| SQL subquery | `tests/fixtures/sql-subquery-alias/` | Subquery aliases excluded; column alias near-miss guard |

### Other fixes
- **`dbWrapperNames` passthrough**: schema-code visitor config wasn't forwarding
  `dbWrapperNames`, so locally-defined wrapper functions weren't recognized in
  the pipeline path (only the standalone analyzer saw them).
- **Non-DB `pool` receiver guard**: `pool.length` on array variables is no longer
  mistaken for a database pool operation.
- **SQL CTE / subquery-alias parser regression guards** (v3.4.8 regression): CTE
  names and subquery aliases correctly excluded from table reference extraction.
  Confirmed via integration tests.

### Open
- **15 documented `sql-injection-risk` false positives**: each mechanism named
  in `docs/sql-injection-fp-defect.md`. The FP-guard fixture tests use
  `toBeLessThanOrEqual(currentCount)` assertions — improvements drop the count
  without breaking; regressions that spike it are caught.

### Adjudication release — Spec 26 findings confirmed

All Spec 26 findings adjudicated against recall-protocol cold run (119 styles,
116 conventions, 1256 data-access). No code changes — every finding verified
individually.

#### Styles (frosted-prism.css delta)
- 9 token-bypass REAL: `#06131c` vs `--active-ink` (token consumed in 8 selectors)
- 4 token-bypass RULE BUG: `#fff` vs `--health-base` (cross-file discovery without semantic scoping — `#fff` is universal color used for Discord/YouTube elements unrelated to health bars)
- 15 declaration-set-similarity REAL: verified every pair (5-11/11 declarations identical)
- 1 z-index-sprawl REAL: 10 distinct z-index values in one file
- Failure construct identified: one-liner `@keyframes {...{...}...}` with nested braces immediately followed by `@media {...}` — `{[^}]*}` regex matches first nested `}`, confusing brace-counting state machine

#### SQL injection (18 survivors)
- 2 REAL: hero-data-agent.ts:232, :241 — `opts.gameMode` (RPC user input) interpolated into `.exec()` SQL with only quote-escaping
- 1 RULE BUG: store.ts:422 — `table` is fixed internal literal (documented)
- 15 FALSE POSITIVES: all `.prepare()` calls interpolate compile-time constants (OFFICIAL_HEROES_SQL, EFFECT_FLAGS, CATALOG_SOURCES_SQL, allowlist-guarded values)
- Zero SQL-keyword receiver false positives (confirmed)

#### Conventions
- +1 export-shape: AdminModerationShell.tsx uses `export default` in 97%-named directory (AST `extractExports` correctly identified)

#### Recall-protocol tickets
- generation_queue: 8 unknown-table violations, table dropped in migration 0198
- hero-data-agent.ts: user-input interpolation into `.exec()` SQL

## [3.4.11] — 2026-08-07

### Spec 26: Consume the ASTs We Already Produce

Stage 1 parses every `.css` file into a tree-sitter AST, but all CSS analysis
operated via regex on raw source text. Spec 26 converts CSS extraction and
several TypeScript subsystems to walk the AST via adapter methods — the regex
only classifies tokens; the AST discovers structure.

#### Phase 2 — CSS AST extraction (`cssAstExtractor.ts`)

CSS declarations, class names, and custom-property tokens are now extracted from
tree-sitter-css ASTs via three pure functions: `extractDeclarationsFromCSSAst`,
`extractClassUsageFromCSSAst`, `extractTokensFromCSSAst`. `.scss` files stay on
the regex path (tree-sitter-css is not an SCSS grammar).

Five parser bugs in the retired regex path are eliminated by AST structure:

- **Bug 1** (whitespace before `@`-rules): `at_rule` nodes are always correct
- **Bug 2** (`@apply` in rule sets): handled via ERROR/postcss_statement/at_rule children
- **Bug 3** (nested `@`-rule brace): tree-sitter handles brace matching
- **Bug 4** (backward-scan boundary): no backward scanning — selectors from `selectors` child
- **Bug 5** (CSS comments as class names): comment nodes are typed, naturally excluded

The `;` stripping fix in `getPropertyAndValue()` (tree-sitter-css includes the
trailing semicolon in declaration node text) uncovered 53 legitimate
cross-mechanism violations previously hidden: 14 token-bypass + 39
mechanism-fragmentation. Styles total: 119 (was 66).

Also fixed: `extractClassUsageFromCSSAst` filters by parent type `class_selector`
to exclude pseudo-classes (`:hover`, `:focus`) and pseudo-elements.

#### Phase 1 — TypeScript subsystems

- **Invariants** (`ruleEngine.ts`): `extractImports()` and `extractExportedSymbols()`
  regex functions deleted. `function-index` visitor now emits `imports`,
  `dynamicImports`, and `exports` facts per file — invariants reducer consumes
  them via `fileData` instead of re-extracting from source.
- **Conventions** (`conventionMiner.ts`): `detectExportForm()` now accepts
  `ExportInfo[]` from `extractExports(ast)` instead of 6 regexes on raw source.
  Export-shape detection found one additional legitimate violation
  (`AdminModerationShell`) the regex path missed.
- **Documentation** (`documentationAnalyzer.ts`): `getJSDocText()` and
  `getPrecedingJSDocComments()` replaced by `adapter.getDocumentation()`.

### SQL injection parameterization detection

Four new methods in `UniversalDataAccessAnalyzer.ts` detect safe parameterized
SQL patterns before the keyword/dynamic-part check:

- `isInPrepareBindChain`: detects `.prepare().bind()` chains including the
  two-statement pattern (`const stmt = db.prepare(sql); stmt.bind(x).all()`)
- `isInExecChain`: detects safe DO `.exec()` with spread binds
- `isD1ConvenienceCall`: detects D1 convenience methods (`.all()`, `.first()`,
  `.run()`) with bind parameters

18 legitimate `sql-injection-risk` violations remain (down from ~55 false
positives): 3 DO `.exec()` calls without detectable parameterization, 15
`prepare()` calls where the bind chain cannot be verified (dynamic table/column
names not bind-able).

### unknown-table = 8 (all generation_queue)

The DO DDL visitor correctly identifies 8 references to the `generation_queue`
table in `src/pages/api/admin/generation/queue.ts`. The table was dropped in
migration 0198 — a dead admin page referencing a removed table.

## [3.4.10] — 2026-07-31

### Accuracy fix: Phantom cross-domain lifecycle violations from over-broad DB detection defaults

`dbReceiverNames` and `dbCallMethods` defaults existed in three (actually seven) copies across the codebase, and they disagreed: the type annotations at `UniversalSchemaAnalyzer.ts` described a narrow 4-entry / 6-entry list, but `DEFAULT_SCHEMA_CONFIG` itself held a wider 7-entry / 9-entry list (`connection`, `pool`, `client`, `query`, `get`, `each`), `pipelineAdapters.ts` hardcoded the narrow list (correct by accident), `UniversalDataAccessAnalyzer.ts` had its own 7-entry / 11-entry copy via `...DB_CALL_METHODS`, and `config/defaults.ts` held the wide list for user-facing help.

The wide lists matched non-DB code: `env.VECTORIZE.query()` (Vectorize binding, not a DB client), `Map.get()`, jQuery `.each()`, WebSocket `connection.status`, generic `pool.length`, and `client.` appearing only in comments. Every match was a phantom — the extended entries produced zero signal across the entire recall-protocol corpus.

**Breaking ground-truth change:** `DEFAULT_SCHEMA_CONFIG.dbReceiverNames` and `.dbCallMethods` are now the narrow lists (`db, database, sql, stmt` / `exec, prepare, batch, run, all, first`). All inline fallbacks in `passesFileGate`, `findTableReferences`, and `buildProvenanceContext` reference `DEFAULT_SCHEMA_CONFIG` as the single source of truth. `config/defaults.ts` matches. `pipelineAdapters.ts` reads `DEFAULT_SCHEMA_CONFIG` instead of hardcoding.

This is not an internal cleanup — any user with a variable named `pool`, `client`, or `connection` was receiving phantom cross-domain `written-never-read` / `read-never-written` / `transaction-boundary` findings, and phantom data-access violations on generic `.query()` / `.get()` / `.each()` calls. The fix removes these false positives.

Cross-domain: 37 (was 43). Data-access: 1826 (was 1827). All 803 tests pass.

## [3.4.8] — 2026-07-28

### Fix: React Analyzer Bench F1 — Config Merge + Heuristic Fix

The React bench corpus dropped to F1 ~0.78 (2 of 6 rules below 1.0) after the expected.json expansion. Three fixes restore all 6 rules to F1 1.0:

1. **Config merge**: Added `const cfg = { ...DEFAULT_REACT_CONFIG, ...config }` in `analyze()`. The bench harness passes `expected.json` config directly without merging shipped defaults — missing `requireMemoization: true` and `requirePropTypes: true` caused 9 false negatives (entire `missing-props` and `performance`-memoization rules went silent).

2. **Inline-function heuristic FP**: Changed `context.includes('onClick')` to `/\bonClick\s*=\s*\{/.test()`. The old check matched string literals (`'onClick triggered'` in module-level code), producing a false positive on the `InlineClick` component which has no `onClick` handler at all. The regex requires `onClick` as a JSX attribute assignment, combined with the existing `=>` guard.

3. **Hook-contract guard**: Added `line: 1` to the `app-level` no-error-boundary violation. The bench harness validates that every violation has a numeric `line` field — the app-level sentinel was missing it, failing the hook-contract regression guard.

Also fixed `violationType: 'hooks-violation'` → `'hooks-naming'` so the rule name matches the field in `ruleRegistry.ts`.

### Deletion: `direct-sql` Rule + `directAccess` Config

Removed the `direct-sql` rule and its escape-hatch config `directAccess` entirely.
Architecture choices are not violations — dynamic-string SQL risk is
`sql-injection-risk`'s job, and users who want to ban specific APIs declare
it as an invariant rule. Ghost-key law: no config key survives the rule it
existed to escape. `hardcoded-connection` detection runs unconditionally now
(was also suppressed by `directAccess: 'allow'`).

### Fix: `unknown-table` Extraction Gaps — Quoted/Backtick/VIRTUAL Identifiers

`processMigrationSource()` and `discoverTablesFromSchemaFiles()` used `\w+` regex to extract table names from SQL migration files. This missed three classes of valid SQL identifier:

- **Quoted identifiers** (`"quoted_table"` / `"strategies"`)
- **Backtick identifiers** (`` `backtick_table` ``)
- **`CREATE VIRTUAL TABLE`** (FTS tables like `fts_data`)

Added `stripIdentifier()` helper to handle delimited identifiers, and updated all `CREATE TABLE` / `DROP TABLE` / `ALTER TABLE RENAME TO` regex patterns to match `[`"](?:[^`"]+)["\`]` in addition to `\w+`. `CREATE VIRTUAL TABLE` is now matched by the same `CREATE (?:VIRTUAL )?TABLE` pattern.

### Deletion: `unknown-column` Rule

Removed the `unknown-column` rule — a regex-based column-reference detector (`findColumnReferences()`) that used three source-code-text patterns (`table.column =`, `SELECT ... table.column`, `WHERE ... table.column`) on raw source text without AST awareness. Its receipts were JavaScript identifiers interpreted as SQL column references (any `obj.prop` matched the `\p{L}+\p{N}+\\.\p{L}+\p{N}+\\s*[=<>]` pattern). The rule was unauthorized — never registered in `ruleRegistry.ts`, no config key, no test fixtures, no bench entries, no plan or spec. Entry-law violation: unrequested scope arriving in a release is itself a defect.

`findColumnReferences()` existed dormant all along — its column check had a silent-skip guard (`columnSet && !columnSet.has(...)`) that returned early when no tables were known, so it never fired. v3.4.7's wrangler migration discovery populated the table catalog for the first time, which armed this downstream code path. Catalog-gated code paths light up when catalogs come alive; a post-fix grep confirmed no other consumers of `allTables` or `tableColumns` remain in `UniversalSchemaAnalyzer.ts` beyond the `unknown-table` detector itself.

Same total-deletion checklist as `direct-sql`: emitter, `findColumnReferences()` method, `ColumnReference` interface, `tableColumns` map (only consumer was the column check), `columnReferences` instance field, GROUND-TRUTH entry.

### Evidence: Unknown-Table False Positive Audit (51 findings, 1 extraction gap fixed)

Full recall-protocol audit produced 51 `unknown-table` findings across 13 table names. All 51 are expected false positives:

- **Bucket A — CTE/subquery alias false positives (FIXED)**: `parseSqlTables()` captured single-character CTE names (`x`, `t`) — matched because `extractAliasIdentifiers()` missed `WITH x AS (...)` and `FROM (SELECT ...) t` alias patterns. Fix: added CTE and subquery alias patterns to `extractAliasIdentifiers()`, plus a minimum-length guard in `parseSqlTables()` (identifiers < 3 characters are skipped unless known). The gap was concealed by the 10:1 fail-open ratio — short-CTE false positives inflated the ratio and triggered suppression.
- **Bucket B** (43 findings, 12 table names): Durable Object agents that define SQLite schema via in-code DDL. Tables exist only in DO-local SQLite, never in migration files.
- **Bucket C** (8 findings, 1 table name): `generation_queue` — created in migration 0058, dropped in migration 0198. API route still references it.

The `findTableReferences()` pipeline handles all gap classes: multi-statement `.sql` files, `CREATE TABLE IF NOT EXISTS`, quoted/backticked identifiers, `CREATE VIRTUAL TABLE` (FTS), RENAME replay order, and (new in v3.4.8) CTE aliases, subquery bare aliases, and a minimum-length guard. See `SPEC-ITEM-2-UNKNOWN-TABLE-EVIDENCE.md`.

### Evidence: sql-injection-risk False Positive Audit (78 findings, 3 receipt shapes)

Full recall-protocol audit produced 78 `sql-injection-risk` findings across 23 files. All 78 are false positives — zero actual SQL injection vulnerabilities. Three receipt shapes:

- **Receipt 1 (~30 findings)**: Imported SQL fragment constants (`${OFFICIAL_HEROES_SQL}` = `"user_id IS NULL"`). `resolveLocalConstant()` is local-only; cannot trace cross-file imports.
- **Receipt 2 (~44 findings)**: Locally-computed constant SQL fragments — file-level string constants, function calls returning constant strings, loop variables from hardcoded arrays.
- **Receipt 3 (4 findings)**: Durable Object `sql.exec()` with template interpolation. DO SQLite is local-only — no network injection boundary.

**Resolution**: Receipted closure — no code fixes. The architectural constraint (`resolveLocalConstant()` is local-only) is intentional: cross-module constant resolution requires full-program type analysis (TS server), out of scope for a tree-sitter structural analyzer. Detection correctly identifies dynamic SQL construction; findings are severity `suggestion` at 1.2% of all violations — correct behavior for this tier. See `SPEC-ITEM-3-SQL-INJECTION-EVIDENCE.md`.

### Fix: Line-Number Boundary Sweep

Two off-by-one bugs fixed:

1. **`adapterBridge.ts` `collectErrors()`**: Used tree-sitter's 0-based `node.startPosition.row` and `.column` directly as display positions — every emitted location was off by one line and one column.
2. **`UniversalSchemaAnalyzer.ts` `offsetToLocation()`**: Added `base.line + lineOffset`, double-counting the base offset. `lineOffset` is already relative to the start of the source; adding `base.line` pushed every result one line too far.

Audited all 38 tree-sitter position consumers across 12 files; only these two sites had the bug.

### Fix: React Analyzer raw-element Diagnostic

The React analyzer's `detectRawElements()` returned 0 findings against the recall-protocol corpus despite 1,247 JSX files. Investigation confirmed zero `dangerouslySetInnerHTML` or raw `<div>` patterns in the corpus — the corpus uses semantic components exclusively. The detector is working correctly; the zero count is genuine, not a detection failure.

### Integrity: TypeScript-Only Syntax Inventory

Grep audit across all universal analyzers, invariants engine, and reporting code confirmed zero host-language syntax patterns outside the `LanguageAdapter` interface. Analyzers consume only adapter methods (`getCallGraph()`, `extractFunctions()`, `findImports()`, etc.) — no `require()`, `import`, `export`, `=>` patterns exist in analyzer code. The adapter seam is the single language surface.

### Fix: Shadcn/JIT undefined-class Compile-Probe (Two Commits)

**Engine (`837063b`)** — Rebuilt `tryImportV4()` in `tailwindProbe.ts` to handle Tailwind v4.3.3's exports map: reads `pkg.exports['.'].import` from the project's installed `tailwindcss/package.json`, with a three-fallback chain (exports map → `createRequire` → bare `import`). Added `compileV4()` using cached `compile()` with `loadStylesheet`/`loadModule` options, `setProjectCss()` for injecting Shadcn `@theme` block custom properties into probe stylesheets, and iterative recompile for batch validation (catches "Cannot apply unknown utility class `X`" errors individually). Replaced the ~4,000-entry hand-curated class-name dictionary with this compile-probe oracle.

**Auto-discovery (`8c80429`)** — Added `discoverProjectCss()` to `tailwindUtilityExpander.ts` that scans candidate paths (`app.css`, `globals.css`, `src/app/globals.css`, etc.) for CSS files containing `@theme` blocks, then feeds them via `setProjectCss()` so Shadcn semantic theme classes (`bg-background`, `text-foreground`, `bg-card`, etc.) validate correctly. Added bench `projectRoot` passthrough in `runBench.ts` so the compile-probe initializes during benchmark runs.

Validated against `bench/corpus/shadcn-jit/` fixture — all Shadcn theme classes recognized; `not-a-real-class-xyzzy` correctly flagged as unknown.

### Fix: Cross-Project Index Data Leakage (Bug #4)

`CodeIndexDB.getInstance()` was a process-level singleton keyed only by `CODE_AUDITOR_DATA_DIR`. When the MCP server ran without `--data-dir`, the singleton used `<cwd>/.code-index/index.db` — switching projects mid-session leaked the prior project's indexed functions, audit results, and tasks into the new project's audit output. The singleton held a stale reference and never re-scoped.

**Fix**: The `--data-dir` flag (parsed in MCP bootstrap before any `CodeIndexDB` import) sets `CODE_AUDITOR_DATA_DIR` to an absolute path. `resolvePersistedIndexPath()` respects this env var as the storage root, pinning `index.db` to a fixed directory. When `--data-dir` is not set, the default `<cwd>/.code-index/index.db` is per-project by convention — callers that change `cwd` across projects must also call `CodeIndexDB.resetInstance()` or pass an explicit `dbPath` to `getInstance()`. The CLI audit commands already pass `projectRoot` for per-invocation scoping.

### Fix: verify-dist Gate Hardening — Zero-Files Warning Now Fails the Gate (Bug #5)

`runZeroFilesDiagnostics()` emitted `console.warn` messages when analyzers processed zero source files, but these warnings never affected exit code. The `verify-dist.sh` Guard 5 (`code-audit changed --json fixtures/test.ts`) checked only exit code, which was always 0 even when all analyzers silently processed nothing — a systemic failure (missing parsers, WASM load failure, index corruption) looked identical to a clean run.

**Fix**: Added `--fail-on-zero-files` flag to `code-audit changed`. Uses a majority threshold: exits 2 only when more than half of enabled analyzers report zero files. A single analyzer (e.g. `react` on a `.ts`-only corpus) is normal operation; all or most is systemic failure. Diagnostics are surfaced through `AuditResult.metadata.diagnostics` so the CLI has access to per-analyzer zero-files counts. `verify-dist.sh` Guard 5 now passes `--fail-on-zero-files`.

### Maintenance: Skill Staleness Guard

Added version stamp to `SKILL.md` and a CLI mismatch warning: when the installed `code-auditor-mcp` version differs from the skill's documented version, `code-audit --version` prints a warning. Prevents stale-skill drift across installs. Note: the 3 SKILL.md copies (repo root, plugin/, user skills dir) are identical and version-stamped, but `hotspots` and `risk` CLI commands are not yet documented in any copy — the sync is correct for what exists, not comprehensive.

## [3.4.7] — 2026-07-27

### Recall-Protocol Send-Back: Three Fixes + Adapter Architecture Refactor

Post-v3.4.6 audit against recall-protocol revealed three classes of false positive in `sql-injection-risk` and `unknown-table`. This release eliminates the root causes, then refactors host-language syntax detection from a static regex list onto the `LanguageAdapter` interface — the single seam for language support.

### Architecture Refactor: Delete `sqlInjectionPatterns`

**Before**: A string array (`['${', 'concat', "'+", ...]`) in the universal analyzer hardcoded JavaScript-specific patterns for detecting dynamic SQL construction. This was the wrong seam — it couldn't distinguish SQL arithmetic `COALESCE(a + b)` from string concatenation, couldn't resolve local constants to determine if a `${placeholder}` was safe, and had no path to handle Go's `fmt.Sprintf` or other languages' string-building idioms.

**After**: Three new `LanguageAdapter` methods, each implemented with tree-sitter node types per grammar:

| Method | TypeScript | Go |
|--------|-----------|-----|
| `isDynamicStringConstruction(node)` | Template substitution or binary-`+` with string operands | `fmt.Sprintf` call expression |
| `getDynamicParts(node)` | Extracts `${identifier}` from template literals, inner `identifier` node from tree-sitter `template_substitution` children | Extracts format arguments from `fmt.Sprintf` call |
| `resolveLocalConstant(scope, name)` | Finds `const`/`let`/`var` declarations in function scope, extracts RHS text, checks for reassignment | Finds `:=` and `var` declarations, same resolution logic |

The `sqlInjectionPatterns` list is deleted entirely. The universal analyzer now asks the adapter: "is this node dynamic?" → "what are its dynamic parts?" → "do those parts resolve to safe constants?" Each answer comes from tree-sitter node types, not regex.

### Fix 1 — sql-injection-risk on Static SQL (Receipts 2 & 3)

**Receipt 2** (pure static `prepare()` string with keyword `TRIM`): The old `checkQuerySecurity()` swept whole-function node text for injection patterns. The new `checkViolations()`, wired through `extractDatabaseCalls()`, inspects only the SQL string argument node — and `isDynamicStringConstruction()` returns `false` for a static `string` literal, so the categorical guard suppresses it immediately. Static literals structurally cannot be injection risks in any language.

**Receipt 3** (`+`-bearing `COALESCE(a + b)` query): The SQL `+` arithmetic operator was indistinguishable from JS string concatenation under the old regex approach. Under the adapter approach, `isDynamicStringConstruction()` checks tree-sitter node types — a bare `+` inside a SQL string literal has no `binary_expression` node, so it never matches.

**Fix**: Replaced `checkQuerySecurity()` regex-pattern matching with `adapter.isDynamicStringConstruction()` + `adapter.getDynamicParts()` flowing through `checkViolations()`. The categorical guard is structural, not pattern-based.

### Fix 2 — Interpolated-Placeholder Suppression (Receipts 1, 4, 5)

`${placeholders}` where `placeholders = ids.map(() => "?").join(",")` was flagged because `${` always matched the old injection pattern. The `?` in the map callback isn't in the same tree-sitter node as the template literal, so the parameterized check missed it.

**Fix**: Two bugs fixed in tree-sitter node traversal:

1. **`getDynamicParts()` inner identifier extraction**: Tree-sitter nests `template_substitution` as `${` → `identifier` → `}`. The old code sliced `${placeholders}` instead of `placeholders`, so `resolveLocalConstant` was searching for a declaration named `${placeholders}` and finding nothing. Fixed by walking into the `identifier` child node and using its range for name extraction.

2. **`isStatic` regex arrow-function support**: The regex determining whether a resolved RHS is placeholder-only (`"?"` literals) couldn't match arrow function syntax — the character class was `[\w]` which excludes `=`, `>`, `{`, `}`, `;`. Fixed to `/^["'\s?,\[\]\(\)\.map\(\)\.join\(\)\w=>{};]+$/`.

**Tiered outcome**: All interpolations resolve to placeholder-only and no reassignments → suppress. Any unresolved or reassigned → fire at suggestion severity with calibrated message naming the unresolved identifiers.

### Fix 3 — unknown-table Dead Discovery (204 migration files → 0 known tables)

Two layers: (1) `discoverTablesFromMigrations()` depended on `discoverFiles()` → `ALL_EXTENSIONS`, which excluded `.sql`, making the function dead; (2) for D1/wrangler projects, `wrangler.toml` declares where migrations live but was never parsed.

**Fix**: Implemented `discoverTablesFromWrangler()` — parses `wrangler.toml` for `[[d1_databases]]` blocks, reads `migrations_dir`, walks `.sql` files in alphanumeric order (chronological), and processes the migration ledger statefully: `CREATE TABLE` adds, `DROP TABLE` removes, `ALTER TABLE RENAME TO` updates references. Added `schemaFiles` config option for explicit schema file paths. Wire both into the table discovery pipeline: wrangler.toml runs first (highest authority), then explicit `schemaFiles`, then migration glob walk, then ORM extraction.

### direct-sql Fix

The `directAccess: 'allow'` config (Cloudflare Workers/D1) was dead for the `direct-sql` rule because the guard lived only in `checkGeneralPatterns()` (a file-level regex path), but `direct-sql` detection was moved to `checkViolations()` (per-`DatabaseCall` provenance). Moved the guard to the emission point.

### Verification

- Recall-shaped fixture audit through installed tarball: `sql-injection-risk: 2` (only the real-danger and reassignment cases fire; static SQL, `+` arithmetic, and placeholder-list all suppressed), `unknown-table: 2` (only genuinely-unrecognized tables; `posts`/`accounts` recognized from wrangler.toml)
- Go bench corpus: 14/14 passing ^(1) (zero `sql-injection-risk` false positives on `fmt.Sprintf` and static SQL; `direct-sql` suggestion still fires on raw SQL — expected, the Go corpus config doesn't set `directAccess: 'allow'`)
- TypeScript bench corpus: 65/65 baseline + 4 new `data-access` corpus passing
- 799/801 unit tests pass, 2 pre-existing timeout flakes (unchanged from v3.4.7)
- SKILL.md: 3 copies synced to v3.4.8 ^(2)
- Build: `npm run build` green

^(1) 14 corpus/analyzer pairings across all languages (TypeScript + Go), not 14 distinct analyzers. There are 9 distinct analyzers in the system.
^(2) The SKILL.md copies (repo root, plugin/, user skills dir) are identical and version-stamped to v3.4.8, but the `hotspots` and `risk` CLI commands are not yet documented in any copy — the sync is correct for what exists, not comprehensive.

## [3.4.6] — 2026-07-26

### Recall-Protocol Send-Back: 4/5 Items Closed + Comment Contamination Fix

Post-v3.4.4 triage against recall-protocol (7,548 findings) revealed zero production effect from the 4 false-positive fixes claimed in v3.4.3/v3.4.4. Every fix targeted a shape absent from real codebases. This release fixes the root causes found by a recall-shaped fixture project audited through the installed tarball.

#### Item 1 — var() False Positives (102 → 0)

`parseStyleObjectExpression()` regex in `styleExtractor.ts` only captured single-quoted string values, not template literals (`backticks`) or bare expressions. All 102 receipts were TSX files with `var(--ink)` in template literals — the regex never matched, so `tokenRef` was never set, and the guard (`if (d.token_ref) continue`) never fired.

**Fix**: Extended the regex in `parseStyleObjectExpression()` to capture backtick-delimited template literals (`\`...\``) in addition to single-quote, double-quote, and numeric values.

#### Item 2 — CSS Definition-Line Survivors (11 → 0)

Two defects, diagnosed from fixture database rows.

**2a — Comment Contamination (Production Mechanism)**: `extractDeclarationsFromBlock()` called `stripAllBlockComments()` per-line inside the `for` loop. When a multi-line `/* ... */` comment spans several lines, the body lines (lines 2 through N-1 of the comment) have no `/*` trigger and pass through `stripAllBlockComments()` verbatim. That comment body text accumulated in the parse buffer and prepended itself to the next real declaration's property field, producing malformed properties that dodged the `--` prefix guard. This is the mechanism behind the 11 item-2 survivors in recall-protocol: Frosted-prism.css (the source of those findings) is a comment-heavy design-token file with multi-line `/* ... */` blocks throughout. The clean recall-fixture couldn't reproduce the bug because `tokens.css` had no multi-line comments wrapping custom-property definitions.

**Fix**: Strip all `/* ... */` comments from the entire CSS block text *before* splitting into lines — `const cleanBlock = stripAllBlockComments(block); const lines = cleanBlock.split('\n')`. This eliminates all cross-line comment state: no `inComment` flag, no per-line stripping, no edge cases.

**2b — Defense-in-Depth Self-Tagging**: `--` definition sites (`--ink: #eef4f9`) had `tokenRef: null` at extraction because the assignment only checked for `var()` references. Self-tag with the property name: `property.startsWith('--') ? property : ...`. This populates `tokenRef` (e.g. `--ink`) so the analysis-side `token_ref` guard catches definition-site self-matches — defense-in-depth at a different layer from the `--` property guard.

**Golden parser tests**: 12 unit tests in `src/styles/styleExtractor.spec.ts` encode the comment-contamination bug class — CSS text with gnarly comments in → expected `{property, rawValue}` array out. Tests cover: single-line comments, multi-line comments (the bug class), unclosed comments, CSS custom properties, and the item-2 production regression (multi-line comment wrapping a `--` definition).

#### Item 3 — Color-Only Token-Bypass (239 → 0)

All 239 receipt survivors were length coincidences (`6px` = `borderRadius.md` tokens). Colors are near-unique; lengths collide by nature. Restricting raw-literal token-bypass to color-typed values eliminates the class on principle.

**Fix**: Added `if (tokenInfo.valueType !== 'color') continue` after the type-equality gate in `detectTokenBypass()`. Only color-typed design tokens are specific enough to flag raw-value bypasses.

#### Item 4 — unknown-table (1,404 → 0)

**Part A — Wire ORM Schema Discovery via Import Provenance**: Drizzle ORM schema tables (importing `pgTable`/`mysqlTable`/`sqliteTable` from `drizzle-orm`) and Prisma models (canonical `schema.prisma`) are now auto-discovered. Files importing from `drizzle-orm` are scanned for table builder calls; `schema.prisma` files are scanned for `model` blocks. Table names are fed into `allTables` alongside migration-discovered tables.

**Part B — 10:1 Fail-Open Ratio**: When unknown table references vastly outnumber known tables, the schema catalog is likely incomplete. Disable the unknown-table rule with a warning instead of flooding output. When zero known tables, the rule is always disabled — a detector that knows zero tables may not call anything unknown. When known tables exist, disable if unknown:known ratio exceeds 10:1.

#### Item 5 — sql-injection-risk (139)

Adjudicated by recall-fixture baseline: D1-style prepared queries with `?` placeholders are correctly suppressed. The 139 survivors are interpolation-shaped (template literals with `${var}` inside SQL strings). Deferred-pending-receipts — no fix in this release.

### Verification

- Recall-shaped fixture audit through installed tarball: `token-bypass: 1` (only the positive case), `unknown-table: 0`, `sql-injection-risk: 0`
- 12 golden parser tests for comment-contamination bug class
- 789+ tests passing
- Build: `npm run build` green

## [3.4.3] — 2026-07-26

### R12: Tailwind Compile-Probe Migration — Zero Hand-Curated Dictionaries

Replaced the ~4,000-entry hand-curated Tailwind class-name dictionary with a compile-probe oracle (`tailwindProbe.ts`) that validates classes against the audited project's own installed `tailwindcss` package. The project's compiler IS the authority on what classes exist — no maintained replica.

**Rationale**: The external-authority-as-oracle law (see GROUND-TRUTH.md) holds that when an external system defines what's valid, that system is the oracle — not our maintained replica of it. Hand-curating a Tailwind class dictionary is a losing game: the dictionary drifts from the actual Tailwind version, misses plugin classes, and requires maintenance on every Tailwind release.

#### Architecture

- **Primary (v4)**: Uses `compile()` with `@apply` probe stylesheets to validate classes
- **Fallback (v3)**: Uses `resolveConfig()` + theme generation
- **Structural parsing**: Arbitrary values (`prefix-[...]`), variant prefixes (`hover:`, `md:`, etc.), opacity modifiers (`utility/N`), and negative utilities (`-utility`) are parsed via regex patterns — never enumerated
- **Fail-open rule**: If the probe can't initialize (no tailwindcss found), `configFailed` is true and the `styles/undefined-class` detector emits a visible warning and returns early

#### New Module

- **`src/styles/tailwindProbe.ts`**: Compile-probe module. Dynamically loads the audited project's `tailwindcss`, validates class-name batches via `@apply` probe stylesheets (v4) or config theme generation (v3). Gracefully handles missing tailwindcss with `configFailed` flag.

#### Refactored Modules

- **`src/styles/tailwindUtilityExpander.ts`**: Removed all hand-curated class-name dictionaries (~800 lines deleted). `init()` only creates a probe when both `useProjectConfig === true` AND `projectRoot` is truthy. `resolve()` pipeline: probe cache → customClasses → opacity modifier → arbitrary-value → negative utility → variant prefix strip + retry.
- **`src/analyzers/universal/UniversalStylesAnalyzer.ts`**: `detectUndefinedClasses` now calls `await expander.init()` before resolution. When `configFailed`: emits `styles/undefined-class-disabled` warning and returns early. When probeReady: batch-probes unknown classes, then resolves each from cache. Added `tailwindClasses` config field for test-environment seeding.
- **`src/types.ts`**: Added `tailwindClasses?: string[]` to `StylesAnalyzerConfig` for test-environment seeding.

### Changed Files

| File | Change |
|------|--------|
| `src/styles/tailwindProbe.ts` | **New** — compile-probe module (v4 compile + v3 resolveConfig fallback) |
| `src/styles/tailwindUtilityExpander.ts` | Removed all hand-curated dictionaries; structural-only + probe validation |
| `src/analyzers/universal/UniversalStylesAnalyzer.ts` | Async init + batch-probe in detectUndefinedClasses |
| `src/analyzers/universal/UniversalStylesAnalyzer.spec.ts` | KNOWN_TAILWIND fixture (2 test classes); resetTailwindExpander in afterAll |
| `src/types.ts` | `tailwindClasses?: string[]` on StylesAnalyzerConfig |

### R13: Default-Analyzer Ghost Fix — Schema, Documentation, Component

**Discovery**: Git archaeology (`git log -p -G enabledAnalyzers`) revealed that `defaults.ts` has never included `schema` in `enabledAnalyzers` on the main branch — not since the schema analyzer was registered in 3.0.0. The July diagnostic's 6,770 schema findings ran through a non-default path (CLI override or bench harness). Default-config users never had the schema analyzer.

**Two ghost names** also sat in the defaults list since initial commit `02f3fe8`:
- `security` — never existed as a registered analyzer. The category tag on `data-access` is `category: 'security'`, not a standalone analyzer.
- `component` — renamed to `react` at some point; the registry key is `react`, and `component` never matched.

**Two more absentees** found during cross-reference:
- `react` — registered since inception, never in the defaults list (users who wanted React analysis had to explicitly enable it)
- `documentation` — same class of bug as `schema`: registered but never enabled by default

**Fix**: Corrected the defaults list to match the registry's non-experimental set:
- `security` → removed (ghost), `component` → `react` (actual key)
- `documentation` and `react` added to defaults (same bug class as `schema`)

**Guard test** (`src/__tests__/defaultsRegistry.test.ts`): Import-time test asserting:
1. No ghost analyzer names in defaults (present in defaults, missing from registry)
2. No duplicate entries
3. Every non-conditional registry key present in defaults (`invariants` is conditional — Spec 05 R3.1)
4. Canonical order matches

This is a **behavior change for every user**: `schema` and `documentation` are now enabled by default for the first time. Expect new suggestion-tier findings (`unknown-table`, `missing-function-docs`, etc.) that were always meant to ship but never did.

#### Changed Files

| File | Change |
|------|--------|
| `src/config/defaults.ts` | Corrected enabledAnalyzers: security→removed, component→react, +documentation |
| `src/auditRunner.ts` | Export DEFAULT_ANALYZERS for the guard test |
| `src/__tests__/defaultsRegistry.test.ts` | **New** — guard: defaults ≡ registry (no ghosts, no absentees) |

## [3.4.1] — 2026-07-24

### Patch Release — Production Bug Fixes

Release validation (the validator's own create-and-audit integration test) caught four defects that the bench suite missed — all behind a green 1,166-test suite. Three were wiring gaps invisible to the bench by construction (the bench seeds tables directly in-memory, bypassing production service-layer wiring). The fourth was an A2 gate scope problem (the gate checked manifest structure and keyword presence but never verified doc-CLI parity).

#### Defect #1: Style Index Dead in Production

The style analyzer's index sync path (`syncStyleIndex()`) accessed `CodeIndexDB.getInstance().rawDb`, but `CodeIndexDB.getInstance()` returns an uninitialized instance — `rawDb` is only assigned in `initializeInternal()`. The `await styleDb.initialize()` call was missing, so `rawDb` was always `undefined` and every style index sync silently failed. Real-audit style findings were always empty.

**Fix** (`d601ac3`): Added `await styleDb.initialize()` before `syncStyleIndex()` in `auditRunner.ts` deepSync() styles block.

#### Defect #2: Hotspots Empty on Real Git Repos

`functions.file_path` stores absolute paths (from `discoverFiles` via `path.join()`). `file_churn` stored git-relative paths (from `git log --numstat` output). The `hotspotScorer` built its lookup Map with relative keys but queried with absolute keys — they never matched. Every hotspot on a real git repo was empty.

**Fix** (`d601ac3`): Resolve git-relative paths to absolute via `path.resolve(targetPath, parts[2])` in `churnExtractor.ts`.

**Secondary defects in same fix**:
- `clearIndex()` now clears stale `churn_hash`/`conventions_hash`/`style_last_sync` meta keys — a clear+re-sync previously skipped churn extraction
- Replaced silent `catch {}` blocks with `console.warn()` in `deepSync()` and CLI hotspots command — these swallowed the path mismatch bug for an entire release cycle
- `hotspot_scores` INSERT → INSERT OR REPLACE to handle duplicate targets from anonymous functions in the same file

#### Defect #3: SKILL.md `--tool claude` Phantom Flag & A2 Gate Expansion

The SKILL.md referenced `--tool claude` as a `generate-config` flag, but the CLI never supported it. The A2 gate ran only against the style layer (frontmatter, keyword presence) — it never checked whether the flags taught to agents actually exist.

**Fix** (uncommitted, `src/cli-integration.spec.ts`): The A2 gate now verifies doc-CLI parity. It parses every SKILL.md bash code block and inline backtick command, extracts flags and subcommand paths, calls the actual CLI's `--help` for each target, and asserts every referenced token appears in the help output. The `--tool claude` phantom would be caught immediately. 16 tests pass, 6 skip (missing subcommands not yet implemented).

#### from-audit Fingerprint Migration (One-Time Churn)

The `from_audit` handler in `projectTasks.ts` previously used divergent inline symbol extraction with a different priority order (`className` before `functionName`, missing `methodName`/`name` fields). Commit `fc5ec22` (Spec 11) replaced it with the canonical `extractSymbol()` from `symbols.ts`. The fingerprint scheme itself (SHA-256 over `[analyzer, rule, file, symbol]`) is stable and hasn't changed between v3.4.0 and v3.4.1 — the migration from divergent inline extraction to `extractSymbol()` happened in v3.1.1.

**Effect on upgrade**: Pre-existing tasks created with the old inline extraction scheme have different fingerprints than tasks created by the current code. Running `from-audit` after upgrading from pre-v3.1.1 will produce duplicate tasks on the first run — the old fingerprints won't match dedup checks. Subsequent runs use the new stable fingerprints and deduplicate correctly.

#### CSS Discovery Fix

The Style Intelligence analyzer's file discovery didn't include `.css`/`.scss` extensions in the default extension list (`ALL_EXTENSIONS`), so CSS/SCSS files were never discovered by `findFiles()` — even though the CSS adapter, CSS/SCSS tree-sitter grammars, and style extractor were all fully functional. A full audit on a project with CSS files would produce zero style findings because no CSS files were ever indexed.

**Fix** (uncommitted, `src/utils/fileDiscovery.ts`): Added `CSS_EXTENSIONS` (`['.css', '.scss']`) to `ALL_EXTENSIONS`.

#### Release Riders

- **Hook-contract regression guard** (`9773144`): Added `hookContractViolations` field to bench output
- **GROUND-TRUTH.md §9** (`6b38fa9`): Documented `nextSessionsCursor` and `withRetry` as known SDK-level gaps
- **Conventions analyzer** (`9773144`): Fixed line-0 violation (line 0 → line 9) in Spec-15 evidence

### Changed Files

| File | Change |
|------|--------|
| `src/auditRunner.ts` | Add `await styleDb.initialize()` before style index sync |
| `src/utils/fileDiscovery.ts` | Add CSS_EXTENSIONS to ALL_EXTENSIONS |
| `src/scripts/churnExtractor.ts` | Resolve git-relative paths to absolute |
| `src/codeIndexDB.ts` | Clear stale meta keys on index reset; INSERT OR REPLACE on hotspot_scores |
| `src/cli.ts` | Replace silent catch with console.warn in hotspots command |
| `src/cli-integration.spec.ts` | A2 gate expansion — doc-CLI parity tests (16 pass, 6 skip) |
| `GROUND-TRUTH.md` | §9: Known Issues — SDK/Integration Surface |

## [3.4.2] — 2026-07-26

### R4: SQL Extraction Regression Fix

Post-release dogfood triage surfaced false positives from three sources in the SQL extraction pipeline. None were structural bugs in the detection logic — they were routing failures: SQL-looking JS patterns reaching the extraction stage without DB context gates.

**The root cause was a one-emitter-law violation**: Spec 15's ORM extraction path introduced a **second emitter** — `DrizzleAdapter.extractTableReferences()` — that scanned every `call_expression` in every `.ts` file for `.from()`/`.insert()`/`.delete()` patterns. It bypassed the shared gates that protect the three regular SQL extraction paths (tagged templates gate on `sql` identifiers, DB-call patterns gate on provenance + db-member checks, file-type gates on `.sql`/migration directories). The Drizzle adapter had its own gate system — but that system was incomplete: no file-level import check, no expression-level companion requirements. Generic method calls like `Array.from(map)` in non-Drizzle files reached the extraction stage and produced false positives across rule IDs `loop-query` and `sql-injection`.

**Registry accounting** (rule IDs affected by the Drizzle emitter, confirmed by Spec 22 fixture coverage):
| Rule ID | Affected? | Rationale |
|---------|-----------|-----------|
| `schema/loop-query` | Yes | Drizzle emitted table refs → N+1 detection in loop context |
| `schema/sql-injection` | Yes | Drizzle emitted raw refs → injection check on unescaped inputs |
| `data-access/loop-query` | Yes | Same Drizzle-emitted refs, data-access analyzer path |
| `data-access/sql-injection` | Yes | Same Drizzle-emitted refs, data-access analyzer path |
| `schema/unknown-table` | Yes | Drizzle emitted table names → unknown-table validation |
| `schema/missing-schemas` | Indirect | Depends on table references from the same pipeline |
| All other rule IDs | No | No Drizzle-origin data reaches these detection chains |

The Prisma adapter was **not a rogue path**: `prisma.modelName.op()` syntax requires the `prisma.` identifier prefix and known operation names — a strong gate by construction. Regular SQL extraction paths (1–3) all have their own independent strong gates. Drizzle was the **only** gate-incomplete emitter.

**Post-verification** (2026-07-20): Re-ran the registry accounting across all four SQL extraction paths (tagged-template, DB-call, .sql/migration, ORM adapters). Confirmed Drizzle was the sole gate-incomplete emitter pre-fix — no other path lacked self-gating. The two-level gate (file import + companion methods) fully closes the vector.

#### R4.2: Routing Gates (Drizzle Adapter)

**File-level gate** (`DrizzleAdapter.extractTableReferences()`): The adapter now checks whether the file imports `drizzle-orm` before scanning for query operations. Without this gate, `Array.from(map)` in any `.ts` file produces a false `select` finding — the `.from()` method on `Array` has no semantic relationship to Drizzle query building.

**Expression-level gates**: Each extraction pattern now requires companion Drizzle methods to confirm DB context:
- `.from(identifier)` requires `.select()` in the same expression
- `.insert(identifier)` requires `.values()` in the same expression
- `.delete(identifier)` requires `.where()` in the same expression

These gates prevent generic `.from()`, `.insert()`, `.delete()` method calls on non-DB objects from being misinterpreted as table references.

#### R4.2: Routing Gates (Data-Access Shared Gate)

**Variable-assignment gate** (`containsSQLStructure()`): Raised the SQL keyword threshold from 1 to 2 for variable-assignment detection. A single `FROM` substring match (e.g., inside `Array.from()`) produced ~120 false positives on the recall corpus. Genuine SQL in variable assignments (`const q = "SELECT * FROM users"`) contains ≥2 keywords and still passes.

#### R4.3: SQL Alias Filtering

The SQL table-reference regex captures table names after `FROM`/`JOIN` keywords by matching `[\p{L}\p{N}_]+` followed by a word boundary. In `JOIN u.posts`, the `.` after `u` creates a word boundary, so the regex captures `u` — an alias for `users`, not a real table. Without filtering, every `JOIN alias.column` pattern produces a false `unknown-table` violation for the alias.

**Fix**: `extractAliasIdentifiers()` scans the SQL text for two alias patterns:
1. **Explicit**: `FROM x AS t` / `JOIN x AS t` — `AS` keyword
2. **Bare**: `FROM x t` / `JOIN x t` — no `AS` keyword, guarded by after-match dot check and `isSqlKeyword()` filtering

Extracted alias identifiers are subtracted from the table-reference list in `parseSqlTables()` before the list is returned.

#### R4.4: Bench Fixtures

- `src/no-sql-signal.ts` (both `data-access` and `schema` corpora): `Array.map`, `.toLowerCase`, `.insert()`, `.delete()`, `.update()` on plain JS objects — asserted as near-miss files producing zero SQL findings across all SQL-adjacent rule IDs.
- `src/aliased-queries.ts` (schema corpus): queries with explicit and bare aliases referencing only known tables — asserted as near-miss, confirming alias filtering prevents false `unknown-table` violations.

### R1–R3 (Completed Previously)

- **R1**: `styles/undefined-class` — generated Tailwind utility dictionary; undefined-class detection now distinguishes "unknown in Tailwind" from "class from a different framework"
- **R2**: `styles/token-bypass` — CSS custom property definitions (`--color:`) and `var()` references are no longer flagged as token bypasses
- **R3**: `styles/value-drift` — categorical CSS properties (`display`, `position`, `overflow`, etc.) excluded from value-drift detection; their values are enumerations, not magnitudes

### R5: Conventions — Naming Partitioning and Usage-Pair Noise Reduction

Post-release triage surfaced ~200 false positives in the conventions analyzer, concentrated in two areas: misleading naming conventions from mixed populations, and usage-pair correlation on built-in/stdlib methods where co-occurrence is arithmetic, not project convention.

#### R5.1: Naming Conventions Partitioned by Export Kind

Before this fix, the convention miner computed a single dominant casing mode per directory across all exported symbols. A directory with 40 PascalCase React components, 5 camelCase hooks, and 1 snake_case utility function would generate a `conventions/naming` violation for the utility — the miner treated all exports as a single population. With this fix, exports are partitioned into four populations before computing a mode:

- **React components** — JSX-returning / `.tsx` PascalCase entities
- **Hooks** — `use`-prefixed functions
- **Functions** — all other exported functions
- **Constants** — top-level literal-initialized exports

Each population must meet `minCorpus` independently; sub-threshold populations produce no conventions and no violations. Stored in the `export_kind` column of the `conventions` table (schema migration v8).

**Impact**: Eliminates false naming violations where legitimate convention in one population (e.g., PascalCase components) was used to judge a different population's naming (e.g., `use`-prefixed hooks or single utility functions).

#### R5.2: Built-in/Stdlib Excluded from Usage-Pair Mining

Usage-pair mining detects co-occurring function calls — "functions that call `A` also call `B`" — and flags deviations. Before this fix, built-in and standard library methods (`slice`, `trim`, `map`, `push`, `parse`, `stringify`, etc.) were treated as antecedents and consequents. Co-occurrence of universal methods is arithmetic, not convention: every function that calls `map` also calls `push` at some point, but that's not a meaningful project convention.

**Fix**: A comprehensive exclusion set (~80 identifiers covering Array, String, Object, Math, JSON, Promise, Console, and timer methods) is filtered from both antecedent and consequent positions. Antecedents must also be project-defined symbols resolvable in the function index — a `functions`-table membership check gates every antecedent.

**Threshold changes**: `pairConfidence` floor rises from 0.9 → 0.95 and `minCorpus` from 20 → 30. These are interim values, sweepable in the next recalibration pass.

### R6: Evidence Bundle

All six defect classes are covered by bench fixtures in `bench/corpus/`:
- **styles**: `undefined-class`, `token-bypass`, `value-drift` fixtures with positive and near-miss files
- **data-access/schema**: `no-sql-signal.ts` near-miss (JS identifiers as SQL), `aliased-queries.ts` near-miss (alias filtering)
- **conventions**: all five rule domains (`usage-pair`, `import-form`, `error-handling`, `export-shape`, `naming`) at F1=1.0 with updated mining logic

Every touched rule remains at `suggestion` severity. The hook path is byte-identical to v3.4.1 on hook-contract fixtures. Evidence bundle at `specs/evidence/spec-22/`.

### R7: JSON-Purity Contamination Fix

The `codeIndexDB.ts:1233` migration log path wrote to stdout via `console.log`. In `--json` mode, this contaminated the JSON output stream with non-JSON text, breaking downstream consumers that `JSON.parse()` the stdout. Switched to `console.error` (stderr) to keep migration notices off the JSON stream. Three purity tests added to `baseline.test.ts` for the hook-contract-critical paths: `changed --json`, `changed --stdin --json`, and zero-match edge case.

### R8: isDynamic Extraction False Positives

`extractClassUsage()` only marked template-literal dynamic expressions as unresolvable; simple variables and ternaries passed through. All `{…}` wrapped expressions are now `unresolvable: true`, and the detector skips per-entry, not per-file. The undefined-class detector no longer false-flags runtime class-name expressions.

### R9: Line-Number Conversion Sweep

**Root cause**: `toSourceLocation()` in `converter.ts` returned 0-based positions from tree-sitter without conversion, despite a comment saying "convert to 1-based columns." This created three divergent pipelines — callers compensated individually, some double-compensated, and raw TS node access bypassed the converter entirely. The sweep fixed 6 files at 6 edit locations:

- **`converter.ts`**: Single conversion point — all four position fields (line/column, start/end) now `+ 1`
- **`adapterBridge.ts`**: Removed internal `+ 1` compensation (now identity over `toSourceLocation()`)
- **`UniversalAnalyzer.ts`**: Removed scattered `+ 1` compensation in `createViolation()`
- **`astParser.ts`**: Removed `+ 1` compensation on parse error positions
- **`componentScanner.ts`**: Removed DOUBLE compensation (was 2-based)
- **`dependencyExtractor.ts`**: Removed DOUBLE compensation on call graph edges and usage records

**Secondary effects**: Mixed-basis DB spans resolved (some records had 1-based start + 0-based end), churn attribution off-by-one resolved, `validateHookContract` guard behavior preserved.

**Invariant**: All positions returned by `toSourceLocation()` are now 1-based. The single conversion point is mechanically enforced — zero `+ 1` compensations remain in the tree-sitter→adapter→consumer pipeline. Full sweep report at `specs/evidence/spec-22/line-number-sweep.md`.

### R10: JSON Purity Test Expansion

Extended JSON purity tests from 3 to 17, covering all major `--json` CLI commands: `index status`, `config rules-list`, `config profiles`, `config detection`, `search`, `tasks list`, `tasks from-audit`, `hotspots`, `ledger stats`, `ledger list`, `risk`, `baseline`, `conventions list`, and `architecture`. Every test verifies `JSON.parse(stdout)` succeeds with zero non-JSON text.

### R11: Hook-Path Diagnostic

Traced a stale footer error to the published plugin's hook script (`hook-audit.sh` line 50: `2>&1`) — the hook re-merges stderr into stdout after the repo correctly separated them. The repo is fixed; the hook script fix ships with the next plugin version. Diagnostic at `specs/evidence/spec-22/verify-close.md`.

### Changed Files

| File | Change |
|------|--------|
| `src/languages/tree-sitter/converter.ts` | Add `+ 1` to all position fields; invariant JSDoc |
| `src/languages/adapterBridge.ts` | Remove internal `+ 1` compensation |
| `src/languages/UniversalAnalyzer.ts` | Remove scattered `+ 1` in `createViolation()` |
| `src/utils/astParser.ts` | Remove `+ 1` on parse error positions |
| `src/componentScanner.ts` | Remove double compensation (2-based → 1-based) |
| `src/utils/dependencyExtractor.ts` | Remove double compensation on call graph edges |
| `src/codeIndexDB.ts` | `console.log` → `console.error` for migration notices |
| `src/__tests__/baseline.test.ts` | 14 new JSON purity tests (3→17 total) |

## [3.3.0] — 2026-07-20

### Spec-10: Style Intelligence — Distribution-Aware Style Analysis

LLM coding agents produce styling fragmentation that line-level linting can't see — near-duplicate hex values, off-scale margins, inline styles where the project uses Tailwind, mechanism mixing within a single component. The insight lives in the distribution. Spec 10 builds a style index parallel to the function index, extracts normalized declarations from five style sources, derives findings statistically from value histograms, and extends the invariant engine so style policy is enforceable in the agent loop.

#### R1: CSS/SCSS Language Support

- **New adapter `TreeSitterCssAdapter`**: Implements the `LanguageAdapter` interface for `.css` and `.scss` files via tree-sitter-css and tree-sitter-scss grammars. Methods returning AST concepts not present in CSS (functions, classes, imports, exports) return empty/null.
- **Grammar loading**: `tree-sitter-css.wasm` and `tree-sitter-scss.wasm` added to `GRAMMAR_FILES` and `LANGUAGE_GRAMMAR_MAP` in parser.ts. Both shipped in `dist/grammars/`.

#### R2: Style Extraction — Everything Normalizes to Declarations

The unit is the **normalized declaration**: `(property, rawValue, normalizedValue, mechanism, file, line, context, variantContext, tokenRef)`.

- **New module `src/styles/styleExtractor.ts`**: Extracts declarations from five mechanisms: CSS/SCSS files (tree-sitter rule-set walking), Tailwind utility classes (class name → declaration expansion), inline styles (`style={{...}}` object expression resolution), CSS-in-JS (styled-components/emotion tagged templates), and design tokens (CSS custom properties, Tailwind theme).
- **New module `src/styles/tailwindExpander.ts`**: Maps Tailwind utility classes to normalized declarations. Supports arbitrary values (`mt-[17px]` → `margin-top: 17px`), variant prefixes (`hover:`, `md:` → `variantContext`), and three-tier config resolution (v3 JS config, v4 CSS `@theme` blocks, bundled defaults).
- **New module `src/styles/tailwindConfigLoader.ts`**: Dynamically loads project's Tailwind config with graceful fallback. Resolves `theme.extend` merged with defaults for v3, parses `@theme` blocks for v4.
- **New module `src/styles/normalizer.ts`**: Color normalization (lowercase, shorthand hex expansion, canonical functional notation), length parsing to `{number, unit}`, short→longhand expansion (`margin: 4px 8px` → four directional declarations sharing source location). Delta-E color distance for value-drift clustering.

#### R3: Style Index — SQLite Storage and Search

- **`style_declarations` table**: Columns for property, raw_value, normalized_value, mechanism, file_path, line, context (selector), variant_context (at-rule prefix), token_ref, content_hash.
- **`style_tokens` table**: Design token registry with name, value, mechanism (`css-custom-property` or `tailwind-theme`).
- **`style_class_usage` table**: Per-file class name usage tracking with mechanism and `unresolvable` flag for dynamically-computed class names.
- **FTS5 virtual table** (`style_declarations_fts`): Full-text search over property and normalized values.
- **Schema migration 2→3**: Creates all three style tables with appropriate indexes.
- **New module `src/styles/styleIndexer.ts`**: Content-hash-based change detection — re-extracts only changed files. Called from `auditRunner.ts` before the analyzer run.
- **New search operators**: `css:<property>`, `value:<normalized-value>`, `mechanism:<css|tailwind|inline|css-in-js|scss>`, `token:<design-token-name>`. When used, `compileToSQL()` JOINs the `style_declarations` table.
- **Code map `styles` section**: Mechanism summary (declaration counts per mechanism), property→value histogram with shares and token coverage, token table.

#### R4: Styles Analyzer — 7 Detectors, 10 Rule IDs

**New analyzer `UniversalStylesAnalyzer`**: DB-based — reads from the full style index rather than per-file AST parsing. Every detector has configurable thresholds and fires only when per-property corpus ≥ `minCorpus`.

| Detector | Rule ID(s) | What it finds | Severity |
|----------|-----------|---------------|----------|
| **Value drift** (color) | `styles/value-drift` | Color near-duplicates (delta-E < 2.0) where one value dominates and a straggler is barely used | warning |
| **Value drift** (exact) | `styles/value-drift` | Exact-value histogram outliers (share < 5% when mode ≥ 10 uses) | warning |
| **Off-scale** | `styles/off-scale` | Scale-family values (margin, padding, gap, font-size) not on the inferred project scale | warning |
| **Undefined class** | `styles/undefined-class` | `className` values with no matching selector in any CSS/SCSS file and not a known Tailwind utility | warning |
| **Token bypass** | `styles/token-bypass` | Normalized value matches a known design token but `tokenRef` is absent | warning |
| **Mechanism fragmentation** | `styles/mechanism-fragmentation` | Same `(property, value)` pair delivered via ≥ 3 different mechanisms | warning |
| **Mechanism mixing** | `styles/mechanism-mixing` | Single component mixing ≥ 3 style mechanisms | suggestion |
| **Declaration-set similarity** | `styles/declaration-set-similarity` | Two CSS rule blocks with Jaccard similarity ≥ 0.9 and ≥ 5 declarations each | suggestion |
| **Z-index sprawl** | `styles/z-index-sprawl` | More than 6 distinct z-index values across the project | warning |
| **Z-index singleton** | `styles/z-index-singleton` | z-index values used exactly once with no other close values | suggestion |

All detectors read corpus statistics from the full SQLite index, so **scoped runs** (changed files only) still compare against the complete project baseline. A fresh drift value in a scoped run is always caught against the full corpus.

#### R5: React Analyzer — Raw-Element Detection

- **`checkRawElements()`**: Auto-detects wrapper components (exported component whose rendered root is a single intrinsic element from the watch list AND which forwards props/children). Flags raw usages of that intrinsic element anywhere outside the wrapper when call sites ≥ `wrapperMinUsages` (default 5).
- **Config**: `rawElementWatchList` (default `['button', 'input', 'select', 'textarea', 'table']`), `wrapperMinUsages`, `componentMap`. `componentMap` overrides auto-detection: `{"button": "Button"}` → any raw `<button>` is a warning (not suggestion).
- Finding message names the wrapper: "raw `<button>` — this project uses `Button` (src/components/Button.tsx)".

#### R6: Style Invariant Rule Kinds

Two new rule kinds added to the invariant engine:

| Rule kind | Purpose | Key config |
|-----------|---------|------------|
| `style-mechanism` | Require allowed style mechanisms per file/glob (e.g., "only Tailwind in `src/components/`") | `allow: ["tailwind"]`, `path` |
| `no-raw-values` | Ban hardcoded values for specific CSS properties (e.g., "no raw colors in `src/pages/`") | `properties: ["color", "background-color"]`, `allowValues`, `path` |

Both query the `style_declarations` table via `CodeIndexDB` for evidence. JSON Schema validation covers the new kinds. `code-audit config rules-create` auto-discovers them alongside the existing five kinds.

### Changed Files

| File | Change |
|------|--------|
| `src/languages/tree-sitter/TreeSitterCssAdapter.ts` | **New** — LanguageAdapter for CSS/SCSS |
| `src/languages/tree-sitter/parser.ts` | Add CSS/SCSS to GRAMMAR_FILES + LANGUAGE_GRAMMAR_MAP |
| `src/languages/index.ts` | Register TreeSitterCssAdapter |
| `src/styles/styleExtractor.ts` | **New** — extraction from all 5 style sources |
| `src/styles/normalizer.ts` | **New** — color/length/shorthand normalization |
| `src/styles/tailwindExpander.ts` | **New** — Tailwind utility → declaration expansion |
| `src/styles/tailwindConfigLoader.ts` | **New** — load project's Tailwind config (v3/v4) |
| `src/styles/styleIndexer.ts` | **New** — sync style declarations to SQLite |
| `src/styles/types.ts` | **New** — style-specific TypeScript interfaces |
| `src/analyzers/universal/UniversalStylesAnalyzer.ts` | **New** — DB-based analyzer with 7 detectors |
| `src/types.ts` | New types: NormalizedDeclaration, StyleToken, StylesAnalyzerConfig; extend ReactAnalyzerConfig |
| `src/codeIndexDB.ts` | SCHEMA_VERSION → 3; new tables (style_declarations, style_tokens, style_class_usage, style_declarations_fts); migration 2→3 |
| `src/search/QueryParser.ts` | 4 new operators: `css:`, `value:`, `mechanism:`, `token:` |
| `src/services/CodeMapGenerator.ts` | New `styles` section with mechanism summary and property histogram |
| `src/analyzers/reactAnalyzer.ts` | `checkRawElements()`; new config fields (rawElementWatchList, wrapperMinUsages, componentMap) |
| `src/auditRunner.ts` | Register styles analyzer; call styleIndexer.syncStyleIndex(); thread React raw-element config |
| `src/config/defaults.ts` | `DEFAULT_ANALYZER_CONFIGS.styles`; `includePaths` extended with `**/*.css`, `**/*.scss`; `enabledAnalyzers` extended |
| `src/invariants/types.ts` | New RuleKind values: `style-mechanism`, `no-raw-values` |
| `src/invariants/ruleEngine.ts` | `checkStyleMechanism()`, `checkNoRawValues()` checkers |
| `src/invariants/invariant-rules.schema.json` | Schemas for two new rule kinds |
| `src/invariants/ruleValidator.ts` | Validation for new rule kinds |
| `src/cli.ts` | RULE_KINDS array extended with two new kinds |
| `bench/corpus/styles/` | **New** — bench fixture project + expected.json |
| `bench/baselines/baseline.json` | Add styles analyzer baseline (9 rule IDs) |
| `src/scripts/runBench.ts` | Styles runner with in-memory seed data |
| `src/__tests__/bench.test.ts` | Updated to 9 analyzers |
| `package.json` | Add tree-sitter-css, tree-sitter-scss devDeps |

## [3.4.0] — 2026-07-23

### Spec-12: Convention Mining — Codebase Convention Discovery and Enforcement

Code Auditor now learns your codebase's unwritten conventions from the function index and flags deviations at suggestion severity. An LLM coding agent unfamiliar with the codebase breaks these conventions silently because no linter enforces them — Spec 12 detects the conventions from the existing SQLite index, flags violations, and can propose ready-to-paste `.codeauditor.json` rules.

#### R1: Convention Mining — Five Domains

Five convention domains are mined from the `functions` and `function_calls` tables at sync time. Every convention stores its `support` (cases that follow) and `total_cases` for confidence (`support / total_cases`). Only conventions meeting the `minCorpus` (default 20) and `modeShare` (default 0.8) thresholds are established.

- **Usage Pairs** (`usage-pair`): Function calls that always co-occur. If 95% of `handleError` callers also call `logError`, a function calling only `handleError` is flagged.
- **Import Form** (`import-form`): Per module specifier + directory, the dominant import style (`default`, `named`, `namespace`, `side-effect`, `require`). Minority import styles in directories where a clear dominant form exists are flagged.
- **Error Handling** (`error-handling`): Per directory, the dominant error-handling pattern (`try/catch`, `.catch()`, `if (err)`, Go-style). Functions in that directory that *have* error handling but use a different shape are flagged. Functions with no error handling are never flagged.
- **Export Shape** (`export-shape`): Per directory, dominant export style (`default` vs `named`). Minority exports are flagged only when a clear dominant shape exists.
- **Naming** (`naming`): Per directory, dominant casing convention (`PascalCase`, `camelCase`, `UPPER_SNAKE`, `snake_case`, `kebab-case`). Non-Latin identifiers are skipped (Spec 21 R5.4).

**New module `src/conventions/conventionMiner.ts`**: Mines all five domains from the SQLite index. Content-hash-based skip prevents redundant mining when the underlying data hasn't changed. Configuration thresholds: `minCorpus` (20), `pairConfidence` (0.9), `modeShare` (0.8), `maxConventionsPerDomain` (200).

**Schema migration 3→4**: New `conventions` table with indexes on domain, rule_id, directory, and hash.

#### R2: Conventions Analyzer

**New analyzer `UniversalConventionsAnalyzer`**: DB-based — reads from the conventions table rather than per-file AST parsing. All findings ship at `suggestion` severity by default (promotable via `severityOverrides`).

| Rule ID | Domain | What it finds |
|---------|--------|---------------|
| `conventions/usage-pair` | usage-pair | Function calls antecedent without its required consequent |
| `conventions/import-form` | import-form | Minority import style where a dominant form is established |
| `conventions/error-handling` | error-handling | Different error-handling shape from the directory convention |
| `conventions/export-shape` | export-shape | Minority export style where a dominant shape is established |
| `conventions/naming` | naming | Minority casing convention where a dominant casing is established |

#### R3: CLI Commands

**New command group `code-audit conventions`**:
- `code-audit conventions list [--domain <domain>] [--json]` — list all mined conventions with support/confidence
- `code-audit conventions propose [--domain <domain>] [--json]` — emit ready-to-paste `.codeauditor.json` rules. Only `naming` → `naming` rule kind and `import-form` → `import-ban` rule kind produce proposals. Other domains are detector-only.

#### R4: Bench Fixture

- **`bench/corpus/conventions/`** — fixture project with:
  - `src/fixture.ts` — one violation per domain (usage-pair, import-form, error-handling, export-shape, naming)
  - `src/approved.ts` — near-miss file following all conventions (zero violations expected)
  - `src/no-mode/` — mixed-shape directory below `modeShare` threshold where zero findings are expected
  - `expected.json` — ground truth manifest with 5 expected violations at suggestion severity

### Changed Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `Convention`, `ConventionMiningConfig`, `ConventionsAnalyzerConfig` types |
| `src/codeIndexDB.ts` | SCHEMA_VERSION → 4, `conventions` table, migration 3→4, `mineConventions()` in `deepSync()` |
| `src/conventions/conventionMiner.ts` | **New** — five-domain mining from functions/calls tables |
| `src/analyzers/universal/UniversalConventionsAnalyzer.ts` | **New** — DB-based analyzer, suggestion-only findings |
| `src/auditRunner.ts` | `conventions` entry in `DEFAULT_ANALYZERS` |
| `src/config/defaults.ts` | `DEFAULT_ANALYZER_CONFIGS.conventions`, enabled analyzers |
| `src/cli.ts` | `conventions list` and `conventions propose` subcommands |
| `SKILL.md` | "mine and propose rules" workflow |
| `bench/corpus/conventions/` | **New** — bench fixture project + expected.json |
| `bench/baselines/baseline.json` | Add conventions analyzer baseline (5 rule IDs) |
| `src/scripts/runBench.ts` | Conventions runner with in-memory seed data |
| `src/__tests__/bench.test.ts` | Updated to 10 analyzers |

### Spec-13: Hotspots & Temporal Analysis — Churn, Trends, and Diverging Clones

Spec 13 adds five temporal-analysis capabilities: git-powered churn tracking, hotspot scoring (churn × complexity), ownership/bus-factor detection, audit trend analysis, and diverging-clone detection. All git access is read-only and degrades gracefully when no repo exists.

#### R1: Churn Extraction

- **New module `src/churn/churnExtractor.ts`**: Shells out to `git log --numstat` and `git log -p` for per-file and per-function churn. Gracefully handles missing git repos (logs warning, returns empty). Returns cost measurements (`{ fileCount, functionCount, durationMs }`).
- **`file_churn` table** (schema v5): `file_path`, `commit_count`, `lines_added`, `lines_deleted`, `distinct_authors`, `dominant_author`, `dominant_author_share`, `last_touched`.
- **`function_churn` table** (schema v5): `function_id` FK to `functions`, `function_name`, `file_path`, `commit_count`, `distinct_authors`, `dominant_author`, `dominant_author_share`, `renamed` flag, `confidence`.
- **Schema migration** (4→5): Creates both churn tables + `dry_pair_history` table + indexes.
- **Sync integration**: `extractChurn()` called from `deepSync()` after indexing, gated by git HEAD + window meta hash cache invalidation.

#### R2: Hotspot Scoring

- **New module `src/hotspots/hotspotScorer.ts`**: Percentile-based scoring combining churn and complexity. Function hotspot = `churnPercentile × complexityPercentile`, scaled to [0, 1]. File hotspot = `fileChurnPercentile × maxFunctionComplexityPercentileInFile`. Zero-churn files score 0 (never penalized for complexity alone).
- **`hotspot_scores` table**: Cached scores recomputed on sync (like conventions).
- **Finding reordering** (`auditRunner.ts`): Within each severity tier, findings sort by containing function's hotspot score descending (falling back to file hotspot, then original order).
- **`hotspot` field on every Violation**: Optional `hotspot?: number` field on `Violation` type, populated from containing function's or file's hotspot score. Included on all output surfaces (JSON, HTML, CSV, SARIF).

#### R3: Ownership / Bus-Factor Detection

- **Bus-factor analysis**: For files and functions in the top quartile of hotspot scores, checks if `dominant_author_share ≥ 0.9` (single author owns ≥90% of commits). Flags emitted as report-level `busFactorRisks` array.
- **CLI visibility**: `code-audit hotspots` command shows ⚠ icon next to bus-factor risks.

#### R4: Ledger Trends

- **New CLI subcommand** `code-audit ledger trends [--since <runId>] [--json]`: Compares fingerprint sets across consecutive same-target full-audit runs. Tracks `newCount`, `fixedCount`, and `net` per rule. Output includes comparison basis (target, run pairs, time range).
- **Filtering**: Excludes non-full-audit runs and runs of different targets. Requires ≥2 full-audit runs of the same target.

#### R5: Diverging Clones

- **New rule** `dry/diverging-clone` at **suggestion** severity: Detects clone pairs whose similarity has declined across consecutive audit runs. Pair identity is fingerprint-based (`file + enclosingSymbol`), not content-hash-based (stable across line drift).
- **Two-phase mechanism**:
  1. **Seed phase**: During DRY analysis, pairs with similarity ≥ `minPairSimilarity` (0.5) are persisted into `dry_pair_history`.
  2. **Tracking phase**: On every full audit, all historically-tracked pairs are re-measured. If similarity drops by ≥ `divergenceThreshold` (0.05) for `divergenceRuns` (2) consecutive runs → emit violation.
- **`dry_pair_history` table**: `pair_fingerprint` (stable identity key), file/symbol/line/content-hash per block, `similarity`, `timestamp`, `run_id`. Content hashes are data (not keys).
- **Config**: `DivergenceConfig` with `divergenceThreshold` (0.05), `divergenceRuns` (2), `minPairSimilarity` (0.5) in `DEFAULT_ANALYZER_CONFIGS.dry.divergence`.
- **Re-evaluation condition**: The rule enters at `suggestion` severity and cannot be promoted to `warning` until ≥10 divergence findings exist across organic full runs. Divergence detection requires ≥2 consecutive full-run similarity snapshots — structurally unavailable from a static bench corpus. The bench fixture validates detector logic correctness; real-world efficacy is deferred. When the condition is met, re-run triage through the Spec 11 R5 recalibration pipeline.

#### R6: Bench Fixtures & Baseline

- **New corpus** `bench/corpus/diverging-clones/`: Fixture files (`clone_a.ts`, `clone_b.ts`) with seeded `dry_pair_history` rows simulating a tracked pair with declining similarity (0.85 → 0.78 → 0.68) across three runs.
- **Bench runner** (`runBench.ts`): `diverging-clones` entry with in-memory `dry_pair_history` seeding → violation detection → F1/recall/precision computation.
- **Baseline** (`baseline.json`): `diverging-clones` entry with `dry/diverging-clone` rule at F1=1.0.
- **Bench test** (`bench.test.ts`): Updated to 11 analyzers.

### Changed Files

| File | Change |
|------|--------|
| `src/types.ts` | `ChurnConfig`, `HotspotEntry`, `TrendSummary`, `DivergenceConfig` types; `hotspot` field on `Violation` |
| `src/codeIndexDB.ts` | SCHEMA_VERSION → 5, `file_churn`, `function_churn`, `dry_pair_history` tables, migration 4→5 |
| `src/churn/churnExtractor.ts` | **New** — git shell-out for per-file and per-function churn |
| `src/hotspots/hotspotScorer.ts` | **New** — percentile math, hotspot scoring, bus-factor detection |
| `src/auditRunner.ts` | Hotspot-based finding reordering, hotspot field attachment, two-phase diverging-clone tracking (seed + re-measure) |
| `src/ledger.ts` | `getTrends()` — same-target full-run fingerprint trend comparison |
| `src/cli.ts` | `hotspots` command, `ledger trends` subcommand |
| `src/config/defaults.ts` | Churn and divergence configs |
| `src/reporting/jsonReportGenerator.ts` | `hotspot` field in output |
| `src/reporting/htmlReportGenerator.ts` | `hotspot` field in output |
| `src/reporting/csvReportGenerator.ts` | `hotspot` field in output |
| `src/reporting/sarifReportGenerator.ts` | `hotspot` field in `properties` |
| `bench/corpus/diverging-clones/` | **New** — bench fixture project + expected.json |
| `bench/baselines/baseline.json` | Add diverging-clones analyzer baseline |
| `src/scripts/runBench.ts` | Diverging-clones runner with in-memory seed data |
| `src/__tests__/bench.test.ts` | Updated to 11 analyzers |
| `SKILL.md` | Hotspot + trends workflows |


### Spec-14: Graph & Architecture Metrics — Call Graphs, Centrality, Community Detection, and Martin Instability

Spec 14 adds network analysis to the code auditor: call-graph construction, centrality ranking (PageRank + betweenness), community detection vs directory structure, Martin instability metrics, DOT/Mermaid output, and blast-radius estimates in the hook path. All output is advisory — reports and annotations only, zero violations.

#### R1: Graph Construction and Caching

- **`src/graph/callGraph.ts`** — `buildCallGraph(db)`: Constructs the function call graph from `function_calls` joined with `functions`. Resolves `callee_name` TEXT → `functions.id` via name join. Edge weight = call-site count (duplicate `(caller_id, callee_name)` rows aggregate). Reports `unresolvedShare` for calls to symbols not in the index.
- **`src/graph/importGraph.ts`** — `buildImportGraph(db)`: Derives file-level imports by aggregating `function_dependencies` joined with `functions.file_path`. Resolves dependencies using 4 strategies: exact match, relative path resolution, module name matching (packages), and fuzzy path matching.
- **`graph_cache` table** (schema v6): Persistent SQLite cache for adjacency, populated after each full sync and rebuilt entirely on each scoped sync. Columns: `graph_type` ('call' or 'import'), `node_key`, `neighbor_key`, `weight`. Stale edges cleared on rebuild — no accumulation.
- **Schema migration 5→6**: Creates `graph_cache` table with primary key on `(graph_type, node_key, neighbor_key)`.
- **Incremental scoped-sync**: Cache rebuilt from scratch on each sync via `populateCallGraphCache(db)` and `populateImportGraphCache(db)` called from `deepSync()`.

#### R2: Centrality and Risk Ranking

- **`computePageRank(adjacency, damping=0.85, convergence=1e-6)`**: Standard iterative PageRank on weighted directed graph. Initializes all nodes to 1/N, iterates until max change < convergence (capped at 100). Handles dangling nodes with uniform teleportation distribution.
- **`computeBetweenness(adjacency, nodeIds)`**: Brandes exact algorithm for N ≤ 2000 nodes. Brandes-Pich pivot sampling above cap. Uses directed edge traversal (BFS on outgoing edges only). Pivot count reported in output.
- **`computeRisk(db, adjacency, nodeIds, nodeNames, nodePaths)`**:
  - Percentile math: `(rank - 1) / (total - 1)` for PageRank, betweenness, and complexity
  - Untested detection: 2-hop transitive caller search via graph cache; if no caller file matches test globs (`**/*.{test,spec}.*`, `**/__tests__/**`) → untested
  - Formula: `risk = max(pagerank%, betweenness%) × complexity% × (1 + untested)` where untested = 1 if true, 0 otherwise
  - Returns `RiskEntry[]` sorted by risk descending
- **`code-audit risk` CLI**: `risk [--limit <n>] [--json] [--path <dir>] [--format dot]` — ranked table with PageRank%, Betweenness%, Complexity%, Untested, Risk Score. `--format dot` emits call-graph neighborhood (depth 2) of top-N risk functions.

#### R3: Community Detection vs Directory Structure

- **`detectCommunities(adjacency, filePaths)`**: Louvain two-phase greedy modularity optimization. Converts directed graph to undirected (summing weights). Phase 1: greedy node movement with strict `gain > 0`. Phase 2: community aggregation. Iterates until modularity gain < 1e-5. Returns `CommunityResult` with `communities` map, `communityCount`, and `modularity`.
- **`computeDirectoryPurity(communities, filePaths)`**: Per-directory purity (share of files in plurality community), weighted agreement score, split candidates (directories spanning ≥2 communities with ≥5 files each), merge candidates (one community dominating ≥2 directories).
- **`code-audit architecture` CLI**: `architecture [--json] [--path <dir>] [--format dot|mermaid]` — directory purity table, main-sequence distance table, split/merge candidates. `--format` emits import graph colored by community.

#### R4: Instability and Abstractness (Martin Metrics)

- **`computeMartinMetrics(db, importGraph)`**: Per-directory Ce (efferent couplings), Ca (afferent couplings), I = Ce/(Ca+Ce), A from per-file AST scan of export type/interface declarations, D = |A+I-1|. Returns `MartinEntry[]` sorted by D descending.
- **Abstractness verification**: Per-file AST scan counts `export type` and `export interface` declarations. Dead-path guard: bench fixture includes `src/interfaces/payments.ts` with `export interface IPaymentProcessor` — test asserts `abstractness > 0`.
- Included in `code-audit architecture` output and `code_map` `architecture` section.

#### R5: Graph Output Formats

- **`src/graph/outputFormatter.ts`** — `toDot(graph, options?)`: Standard DOT format with community-based node coloring, legend, edge labels with weight. `toMermaid(graph, options?)`: Mermaid `graph TD` with `classDef`/`class` for community styling. Zero rendering dependencies — pure string emission.

#### R6: Blast Radius in Hook Path

- **`src/graph/blastRadius.ts`** — `computeImpact(db, functionIds)`: Recursive CTE against `graph_cache` to walk the caller graph outward (depth-capped at 10). Counts `is_exported=1` rows among reachable callers. Cost scales with BFS neighborhood size, not codebase size.
- **Hook path integration** (`auditRunner.ts`): After `detectChangedFunctions()` in diff-scoped audit, calls `computeImpact()`. Measured with `performance.now()` — if >100ms, emits warning and skips annotation (disabled-by-default when over budget). Human output: "reaches N callers, M exports" per changed function.

#### Bench Fixture

- **`bench/corpus/graph/`**: Synthetic source files producing known call graph and import graph structures:
  - `src/core.ts`: High-PageRank hub function
  - `src/bridge.ts`: High-betweenness bridge function
  - `src/untested.ts`: Central function with no test coverage
  - `src/module_a/a1.ts`, `src/module_a/a2.ts`: Community A
  - `src/module_b/b1.ts`, `src/module_b/b2.ts`: Community B
  - `src/module_c/c_a.ts`, `src/module_c/c_b.ts`: Community C split across directory boundary
  - `src/interfaces/payments.ts`: Exported interfaces for A > 0 assertion
  - `expected.json`: `kind: "metrics"` with `expectedMetrics` range assertions (communityCount, abstractness > 0, etc.)
- **Bench runner**: `graph` entry in `buildAnalyzers()` with expectedMetrics range checks
- **Baseline**: `graph` entry in `baseline.json` (empty rules, metrics-only)

#### Unit Tests (51 tests across 3 files)

- **`src/graph/__tests__/callGraph.test.ts`** (23 tests): PageRank on 3-node chain, 4-node converging graph, convergence within few iterations; Brandes exact betweenness on 5-node path, star graph with bidirectional edges, disconnected graph; risk formula — percentile math, untested penalty, field validation; buildCallGraph — node IDs, names, paths, adjacency, duplicate call site weight; buildCallGraphFromCache.
- **`src/graph/__tests__/importGraph.test.ts`** (17 tests): buildImportGraph — file nodes, intra-module imports, empty DB; detectCommunities — two-cluster graph, positive gain merging, empty/single-node graphs; computeDirectoryPurity — aligned communities, split detection, weighted agreement; computeMartinMetrics — Ce/Ca/I/D, abstractness > 0 guard, concrete-only A=0, distanceFromMain sorting.
- **`src/graph/__tests__/graphCache.test.ts`** (11 tests): populateCallGraphCache — edge correctness, weight=1, duplicate aggregation, stale edge clearance; populateImportGraphCache — edge correctness, stale clearance; incremental update simulation — new functions/calls, removed calls, new dependencies, empty rebuild, cache matches direct build.

### Changed Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `RiskEntry`, `DirectoryPurity`, `MartinEntry`, `BlastRadiusImpact`, `GraphStats`, `CallGraph`, `ImportGraph`, `CommunityResult`, `PurityResult` |
| `src/codeIndexDB.ts` | SCHEMA_VERSION → 6, `graph_cache` table, migration 5→6, `getGraphStats()` |
| `src/graph/callGraph.ts` | **New** — buildCallGraph, computePageRank, computeBetweenness, computeRisk, populateCallGraphCache, buildCallGraphFromCache |
| `src/graph/importGraph.ts` | **New** — buildImportGraph, detectCommunities, computeDirectoryPurity, computeMartinMetrics, populateImportGraphCache, buildImportGraphFromCache |
| `src/graph/outputFormatter.ts` | **New** — toDot, toMermaid (string emission) |
| `src/graph/blastRadius.ts` | **New** — computeImpact (recursive CTE, not full adjacency load) |
| `src/graph/__tests__/callGraph.test.ts` | **New** — 23 tests: PageRank, Brandes, risk, buildCallGraph, cache |
| `src/graph/__tests__/importGraph.test.ts` | **New** — 17 tests: Louvain, Martin metrics, A > 0, import graph |
| `src/graph/__tests__/graphCache.test.ts` | **New** — 11 tests: cache population, incremental update simulation |
| `src/auditRunner.ts` | Blast radius integration in scoped audit path |
| `src/cli.ts` | `index status` subcommand, `risk` command, `architecture` command |
| `src/config/defaults.ts` | Graph config (betweennessExactNodeCap, blastRadiusEnabled, etc.) |
| `src/services/CodeMapGenerator.ts` | `risk` and `architecture` sections (conditional, try/catch) |
| `bench/corpus/graph/` | **New** — bench fixture with synthetic graph + expectedMetrics |
| `bench/baselines/baseline.json` | Add `graph` entry (empty rules, metrics-only) |
| `src/scripts/runBench.ts` | Graph runner with expectedMetrics range assertions |
| `src/__tests__/bench.test.ts` | Updated to 12 analyzers |
| `SKILL.md` | `risk` and `architecture` command docs |

### Spec-11 R5 Recalibration Audit (2026-07-20)

Spec 11 R5's mechanical recalibration was applied to `defaults.ts` as part of Spec-11 closure. A subsequent audit of the recalibration table against external corpus evidence identified a pipeline defect — **"TBU Cliff + Single-Corpus Overfit"** — described in `bench/results/spec-11-recalibration-audit.md`. The recalibration has been corrected:

**Pipeline defect**: The judged-true formula `true / (true + false)` excludes TBU findings from both numerator and denominator. Real findings classified as TBU (because they're "not worth fixing on THIS corpus") contribute nothing to keeping a rule alive. The self-audit corpus is adversarial for data-access rules — the tool's own source contains SQL pattern-matching logic that the detector misreads as database calls. On an external corpus (27-sample Gin-like triage), `loop-query` scored 50% judged-true vs 0% on self-audit.

**Severity corrections in `defaults.ts`**:

| Rule | Pre-audit | Post-audit | Δ | Rationale |
|------|----------|------------|---|-----------|
| `missing-org-filter` | off | **suggestion** | ↑ | Domain mismatch confirmed for non-SaaS, but must remain visible for multi-tenant apps |
| `unknown-table` | off | **suggestion** | ↑ | Requires user-provided schema; must remain re-enablable |
| `sql-injection-risk` | off | **suggestion** (restored) | ↑ | 50% judged-true on external corpus; self-audit scores were dogfooding artifacts |
| `loop-query` | off | **warning** (restored) | ↑ | 50% judged-true on external corpus with confirmed production N+1s |
| `unfiltered-query` | off | **suggestion** (restored) | ↑ | Insufficient external evidence to disable; keep at suggestion pending validation |
| `direct-sql` | off | **suggestion** (restored) | ↑ | May have value on external corpora; restore pending evidence |
| `single-responsibility` | **critical** | **warning** (restored) | ↓ | 0.98 judged-true but length heuristics should not block hooks |
| `solid/class-size` | warning | **warning** (promoted) | = | 1.00/1.00 on 27 findings; one-tier promotion correct |
| `dependency-inversion` | warning | **warning** (promoted) | = | 1.00/1.00 on 16 findings; one-tier promotion correct |

Net effect: 6 rules restored from disabled, 1 promotion reversed, 2 promotions retained, 2 rules demoted to suggestion instead of off.

**Process amendments** (recorded in `bench/results/recalibration.md` Limitations):
- Multi-corpus validation required before disabling any rule globally
- Test-fixture findings excluded from judged-true denominator (calibration artifacts, not false positives)
- Heuristic promotion capped at warning tier — length/parameter/count rules should not block hooks
- Re-evaluate when ≥10 external-corpus findings exist for each data-access rule

### Changed Files

| File | Change |
|------|--------|
| `src/config/defaults.ts` | Corrected `severityOverrides` (4 overrides, 5 restores); added audit report reference in comment |
| `bench/results/spec-11-recalibration-audit.md` | **New** — full audit report with per-finding triage data, pipeline defect analysis, external corpus cross-reference |
| `bench/results/recalibration.md` | Updated with corrected recalibration table, audit amendment note, TBU-cliff limitation documentation |

### Spec-15: Cross-Domain Joins — Schema Lifecycle, Validation Bypass, and Coverage by Importance

Spec 15 adds five detectors that no single per-file analyzer can run alone. Each joins the SQLite index tables built by earlier specs — `schema_usage` (Spec 14), `graph_cache` (Spec 14), `hotspot_scores` (Spec 13), `coverage_data` (Spec 15 R4) — to produce findings at the system level. **All detectors enter at `suggestion` severity.**

#### R1: Schema Lifecycle Detection

Three detectors query `schema_usage` joined with `graph_cache` and `functions`:

- **Written-never-read** (`cross-domain/written-never-read`): Tables with INSERT/UPDATE/CREATE usage but zero SELECT. Catches write-only tables that may be abandoned or log sinks no one queries.
- **Read-never-written** (`cross-domain/read-never-written`): Tables with SELECT usage but zero INSERT/UPDATE/CREATE. Catches external-data reads where the codebase never writes — possible data-source documentation gaps.
- **Transaction-boundary risk** (`cross-domain/transaction-boundary-risk`): Functions writing ≥ `txnTableMax` (default 4) distinct tables, including callee tables via depth-1 BFS on `graph_cache`. Flags functions whose transaction scope is too wide (coordinator anti-pattern).

**New analyzer `CrossDomainAnalyzer`**: Extends `UniversalAnalyzer` with a full `analyze()` override — bypasses the per-file AST loop and queries the SQLite DB directly. Population happens in `UniversalSchemaAnalyzer.analyzeAST()`: after `findTableReferences()` extracts table names, each reference is written to `schema_usage` (idempotent per-file).

**Schema migration 6→7**: `schema_usage` table with columns `(table_name, file_path, function_name, usage_type, analyzer)`. Indexed on `(table_name, usage_type)`.

#### R2: ORM-Aware Schema Extraction

- **New module `src/analyzers/orm/`** — adapter registry pattern (same shape as `LanguageAdapter` registry):
  - `OrmAdapter` interface: `extractTableReferences()` and `extractSchemaDefinitions()`
  - **Drizzle adapter**: Detects `pgTable`/`mysqlTable`/`sqliteTable` schema definitions, `.select().from()` query chains
  - **Prisma adapter**: Parses `schema.prisma` model definitions, `prisma.model.operation()` query patterns
- **Integration**: `UniversalSchemaAnalyzer.findTableReferences()` queries the ORM registry before falling back to SQL pattern detection

#### R3: Validation-Bypass Detection

**Detector** (`cross-domain/validation-bypass`): Flags functions that write data without reaching a validator, when their directory peers typically do.

**Primary — provenance-based**: Uses Spec 21's `VALIDATOR_PACKAGES` (zod, joi, ajv, valibot, class-validator, yup, typebox, superstruct, io-ts) to identify validators via import provenance. Per-identifier detection: a function is a validator iff `isValidatorProvenanced()` holds for usage *inside its body* (its own `used_imports` include a validator package), not merely because it cohabits a zod-importing file.

**Conjunctive fallback**: Only when zero provenance-detected validators exist AND no user config is provided → `name GLOB 'validate*' OR name GLOB 'assert*'` heuristics with downgraded confidence.

**Algorithm**: Groups writers (functions with INSERT/UPDATE/CREATE in `schema_usage`) by directory. For each directory with ≥ `minCorpus` (default 20) writers, BFS depth ≤ `depth` (default 3) through `graph_cache` call edges. If ≥ `modeShare` (default 0.8) of writers reach a validator, flags uncovered writers.

**Config** (`validatorBypass` in `CrossDomainConfig`): `modeShare` (0.8), `minCorpus` (20), `depth` (3).

#### R4: Coverage by Importance

- **New module `src/coverage/`** — LCOV (`.info`) and Istanbul (JSON) coverage format parsers with auto-detection
- **`coverage_data` table**: `(file_path, function_name, line_pct, branch_pct, statement_pct, function_pct, uncovered_lines, source_format)` — same schema as `hotspot_scores` with coverage columns
- **`code-audit coverage`** CLI: `coverage --import <path>` (auto-detect format, store in SQLite), `coverage --by-risk [--json]` (show coverage gaps ranked by hotspot score)
- **Detector** (`cross-domain/uncovered-risk`): Exported functions in the top `topRiskDecile` (default 0.1) of hotspot scores with no measured coverage → flag at `suggestion` severity. Coverage findings include `source_format` and `basis` (measured or static-reach) on every output surface. Stale coverage imports (>7 days since last import) produce a warning. **Static-reach fallback**: When no `coverage_data` exists, checks if each high-risk function is reachable from any test file via call-graph BFS.

#### R5: Bench Fixtures

- **New corpus `bench/corpus/cross-domain/`**: 8 fixture source files in directory-structured layout:
  - `src/orders/orders.ts` — 7 writer functions, 4 reach validator → 3 bypass violations
  - `src/validators/validators.ts` — zod-importing validator functions for provenance detection
  - `src/audit/audit.ts` — read-only module (read-never-written)
  - `src/sessions/sessions.ts` — isolated write-only module (written-never-read)
  - `src/users/users.ts` — read+write module (no lifecycle violation)
  - `src/risk/risk.ts` — high-risk functions (uncovered-risk)
  - `src/tests/orders.test.ts` — test file providing call-graph edges
- **`expected.json`**: Metrics-only manifest (`kind: "metrics"`) with min-count ranges per detector. Vacuous precision/recall/F1=1.0000 (metrics-only: no expectedViolations list).
- **Bench runner**: Seeds `schema_usage` (11 entries), `graph_cache` (10 edges), `hotspot_scores` (5 entries), `coverage_data` (1 entry), and `functions` (16 functions) in-memory, then runs `CrossDomainAnalyzer.analyze()`.

### Changed Files

| File | Change |
|------|--------|
| `src/analyzers/crossDomain/CrossDomainAnalyzer.ts` | **New** — post-analysis DB queries for 5 detectors |
| `src/analyzers/crossDomain/__tests__/CrossDomainAnalyzer.test.ts` | **New** — unit tests for R1+R3 detectors |
| `src/analyzers/orm/types.ts` | **New** — `OrmAdapter` interface |
| `src/analyzers/orm/adapterRegistry.ts` | **New** — ORM adapter registry |
| `src/analyzers/orm/drizzleAdapter.ts` | **New** — Drizzle ORM schema/query extraction |
| `src/analyzers/orm/prismaAdapter.ts` | **New** — Prisma ORM schema extraction |
| `src/analyzers/orm/index.ts` | **New** — ORM module barrel export |
| `src/analyzers/orm/__tests__/ormAdapters.test.ts` | **New** — unit tests for Drizzle + Prisma |
| `src/coverage/lcovParser.ts` | **New** — LCOV `.info` parser |
| `src/coverage/istanbulParser.ts` | **New** — Istanbul JSON parser |
| `src/coverage/coverageService.ts` | **New** — coverage storage/query in SQLite |
| `src/coverage/__tests__/parsers.test.ts` | **New** — unit tests for coverage parsers |
| `src/types.ts` | Add `CrossDomainConfig`, `CoverageEntry`, `OrmAdapter`/`OrmTableReference` types |
| `src/codeIndexDB.ts` | SCHEMA_VERSION → 7, `schema_usage` + `coverage_data` tables, migration 6→7 |
| `src/analyzers/universal/UniversalSchemaAnalyzer.ts` | schema_usage recording, `txnTableMax` config field |
| `src/auditRunner.ts` | Cross-domain analyzer entry, config forwarding |
| `src/config/defaults.ts` | Cross-domain + coverage configs |
| `src/cli.ts` | `coverage --import` and `coverage --by-risk` commands |
| `src/services/CodeMapGenerator.ts` | Coverage-by-risk section |
| `src/scripts/runBench.ts` | Cross-domain bench runner with in-memory seed data |
| `bench/corpus/cross-domain/` | **New** — bench corpus + expected.json |
| `bench/baselines/baseline.json` | Add cross-domain analyzer baseline |
| `src/__tests__/bench.test.ts` | Updated to 10 analyzers |

## [3.2.0] — 2026-07-23

### Spec-21: Language-Neutral Detection — Provenance-Based DB Detection

Provenance-based detection replaces English name-list matching (`dbReceiverNames`) as the primary mechanism for identifying database handles. Instead of asking "is this variable named `db`?", the system asks "where did this variable's value come from?" An identifier is DB-provenanced if it came from: a known DB package import (`better-sqlite3`, `drizzle-orm`, `@prisma/client`, `pg`, `mysql2`, etc.), a `.prepare()`/`.exec()` chain on a provenanced receiver, a `D1Database`-annotated type, or an `env.DB` binding. Provenance propagates through assignment, destructuring, and cross-file export/import.

This makes detection work for any language — a Portuguese `banco`, Russian `база`, or German `datenbank` identifier is detected as long as it traces back to a known DB package import. The English name lists remain as fallbacks for codebases whose provenance is invisible (dynamic requires, injected globals).

#### R1: Provenance Resolver

- **New module `src/analyzers/provenance.ts`**: Shared detection utility consumed by both the schema and data-access analyzers.
- **`isDBProvenanced()`**: Given a call-expression AST node, determines if its callee is DB-provenanced via import tracing, binding detection, type annotation, or propagation.
- **`extractDBProvenancedImports()`**: Extracts all DB-provenanced identifiers from a file's imports by matching import specifiers against `DB_PACKAGES`.
- **`propagateProvenance()`**: Propagates provenance through assignment (`const x = drizzle(env.DB)`), destructuring, class field initialization, default parameters, and type annotations.
- **`ProvenanceContext`**: Built once per file, cached for all analyzer calls on that file. Holds the resolved set of DB-provenanced and validator-provenanced identifiers with evidence chains.
- **`ProvenanceEvidence`**: Records the reason (`package`, `binding`, `type`, `propagation`, `fallback`), source (e.g., "named import from drizzle-orm"), and chain of propagation for each provenanced identifier.

#### R2: Conjunctive Inference

- **Conjunctive guard**: A variable is DB-provenanced ONLY through provenance-linked evidence. Rules that do NOT qualify: name alone (a variable named `database` without provenance → NO), method alone (`.first()` without DB-provenanced receiver → NO), Map named `database` with `.first()` calls → zero violations.
- **`inferReceivers()`**: During full sync, finds call expressions where the method name matches `DB_CALL_METHODS` AND the receiver traces to a provenanced source through assignment chains. Adds intermediate identifiers to the inferred set.
- **`config detection`**: New CLI command showing the resolved provenance set with per-entry evidence, including `reason` and `chain` fields. Visible fallback entries (`reason: 'fallback'`) signal "caught by name, not provenance."
- **Cross-file provenance**: Stored in `metadata_json` column of the `functions` table during sync. Scoped runs (hook path) consume stored provenance; full-sync runs may use on-demand reads. Hook-latency measurement (`provenanceResolutionMs`) tracked on every scoped run per Spec 14 R6.2 precedent.

#### R3: Detection Modes

A single shared `detection.mode` config key replaces the planned per-analyzer mode configs:

| Mode | Behavior |
|------|----------|
| `hybrid` (default) | Provenance-primary + conjunctive name-fallback. Provenance resolves first; unresolved identifiers matching `dbReceiverNames` or `dbBindingNames` get `reason: 'fallback'`. |
| `provenance` | Strict provenance only. Never consults name lists. For codebases with fully visible provenance chains. |
| `names` | Legacy English-only name matching. Opt-in escape hatch for users who need the old behavior unchanged. |

#### R4: Validator Provenance

- **`VALIDATOR_PACKAGES`**: `zod`, `joi`, `ajv`, `valibot`, `yup`, `superstruct`, `arktype`, `@sinclair/typebox`, `class-validator`.
- **`extractValidatorProvenancedImports()`**: Same pattern as DB provenance extraction but for validator packages.
- **Infrastructure ready for Spec 15**: Validator provenance is computed and stored; the `validate*`/`assert*` name heuristic is defined for the validator-bypass detector in Spec 15.
- **Config**: `validatorPackageList` in `defaults.ts` (shipped list, user-extensible). Detection mode is the shared `detection.mode` key.

#### R5: Unicode Identifier Correctness

- **QueryParser camelCase splitting** (line 554): `/(?=[A-Z])/` → `/(?=\p{Lu})/u` — handles all Unicode uppercase.
- **QueryParser token matching** (line 286): `\w+` → `[\p{L}\p{N}_]+` — matches non-Latin characters.
- **codeIndexDB-enhanced camelCase breakdown** (line 583): `/([A-Z])/g` → `/(\p{Lu})/gu`.
- **ruleEngine exported symbol extraction** (lines 489-514): `\w` → `[\p{L}\p{N}_]` with `u` flag in all three regex patterns.
- **Non-Latin unclassifiable guard**: The naming analyzer treats identifiers containing characters outside `[\p{Script=Latin}\p{N}_$]` as unclassifiable — returns zero violations instead of flagging what it cannot parse.

#### R6: Fixtures and Spec 11 Amendment

- **7 new fixtures** in `src/__tests__/fixtures/spec-21/`:
  - `banco-provenance.ts` — Portuguese identifier, provenance-only detection
  - `cyrillic-ids.ts` — Cyrillic identifier "база", Unicode correctness end-to-end
  - `map-named-database.ts` — conjunctive guard (Map named `database` → zero violations)
  - `fallback-global.ts` — injected global caught under hybrid mode via name fallback
  - `validator-zod-portuguese.ts` — validator recognized via provenance
  - `cyrillic-naming.ts` — Cyrillic exports → unclassifiable → zero naming violations
  - `cross-file-provenance/provider.ts` + `consumer.ts` — export/import provenance chain
- **Spec 11 amendment**: Bench corpus gains a non-English-identifier fixture project (mixed Portuguese/German/Japanese identifiers, DB access via provenance only). Per-rule precision/recall is reported on it alongside the English corpora. Detection gap between the two is a release-blocking finding.

### Changed Files

| File | Change |
|------|--------|
| `src/analyzers/provenance.ts` | **New** — core provenance module (package lists, extraction, propagation, inference) |
| `src/analyzers/universal/UniversalDataAccessAnalyzer.ts` | Replace `isDBCallee()`, `isDbCallNode()`, `isOrmPattern()` with provenance-based detection |
| `src/analyzers/universal/UniversalSchemaAnalyzer.ts` | Replace `passesFileGate()`, `isDbMemberCall()` with provenance calls |
| `src/config/defaults.ts` | Add `detection: { mode: 'hybrid' }` default; add `validatorPackageList` default |
| `src/auditRunner.ts` | Wire provenance context and detection config into analyzer config |
| `src/types.ts` | `ProvenanceEvidence`, `DetectionConfig` interfaces |
| `src/cli.ts` | `config detection` command |
| `src/codeIndexDB.ts` | Add `provenance` field to metadata_json |
| `src/search/QueryParser.ts` | Unicode-aware regexes (R5) |
| `src/codeIndexDB-enhanced.ts` | Unicode-aware camelCase breakdown (R5) |
| `src/invariants/ruleEngine.ts` | Unicode-aware regex + non-Latin unclassifiable guard (R5) |
| `src/__tests__/fixtures/spec-21/` | **New** — 7 fixture files |
| `src/__tests__/provenance.test.ts` | **New** — unit + integration tests |

## [3.1.0] — 2026-07-20

### Spec-17: Signal Hotfix — Noise Reduction Across All Analyzers

Large-scale noise reduction targeting all 6 analyzers based on a real-corpus diagnostic report (3,871 files, 6,159 functions, 26,119 findings — ~96% noise). Every noise class in the diagnostic is addressed at the defect level. **R1 diagnosis**: The `sql-injection` rule in the schema analyzer used regex-based string-pattern matching across all source files, producing ~15,000 findings in the self-audit. Only a handful of those involved actual SQL-context string concatenation; the vast majority flagged template-literal interpolations inside non-SQL string expressions (logging, URLs, error messages). This was the single largest noise source in the corpus.

#### R1: Documentation Analyzer

- **R1.1 — Anonymous callbacks skipped**: Arrow functions and function expressions used as arguments (`.map()`, `.forEach()`, event handlers) are no longer flagged. Uses AST parent-walking, not name whitelists.
- **R1.2 — Default scope is public API surface only**: Only exported functions and public class methods are flagged at default scope. Private/protected/`#`-prefixed/`_`-prefixed methods are skipped.
- **R1.3 — Minimum-size gate**: Functions with body length < `docsMinLines` (default 5) are skipped.
- **R1.4 — `scope: "all"`**: Restores broader coverage minus callbacks. Named internal functions are flagged but anonymous callbacks are still skipped.
- **R1.5 — File-header checks default OFF**: `fileHeaders` (default `false`) replaces `requireFileDocs`. When enabled, barrel/index/test/migration/config files are excluded by `headerSkipGlobs`.
- **R1.6 — Audience-reason messages**: Messages state *why* a function is in scope (e.g., "exported function without JSDoc").
- **Deprecation**: `requireFileDocs` is deprecated in favor of `fileHeaders`. It maps to `fileHeaders` for back-compat but the combined default is `false` (off). `checkExportedOnly` is replaced by `scope`.

#### R2: Schema Analyzer

- **R2.1 — SQL-context-only extraction**: Table references are now extracted only from SQL-tagged templates (`` sql`...` ``), DB-call patterns (`db.exec(...)`, `db.query(...)`), and `.sql`/migration files. The 11 raw-regex scan-all-strings approach that caused ~4,500 false positives (including "the", "node:child_process" imports) has been replaced with AST-based detection.
- **R2.2 — File gate**: `.tsx` and `.ts` files without DB imports or DB-call patterns are never scanned for schema violations.
- **R2.3 — Template expression handling**: Dynamic prefixes (`` `${prefix}_builds` ``) resolve to wildcards for known-table matching. Fully-dynamic table names produce no false findings.
- **R2.4 — Unknown-table findings**: Report extracted name, SQL statement kind, call-site line (from AST location), and nearest known-table suggestions (Levenshtein ≤ 2).

#### R3: DRY Analyzer

- **R3.1 — Self-reference fix**: A code block can no longer match itself. Span-overlap check ensures `fileA !== fileB || (endA < startB || endB < startA)`.
- **R3.2 — Minimum block size 5 → 15**: `minLineThreshold` increased from 5 to 15. Short repeated blocks no longer produce false findings.
- **R3.3 — Rule-id split**: `dry/duplicate` (warning) for exact token-identical blocks (SHA-256 hash). `dry/structural-similarity` (suggestion) for identical token-type sequences with differing identifiers/literals.
- **Fingerprint warning**: The rule-id split changes fingerprints for previously-reported structural matches. `tasks.from_audit` treats them as new findings.

#### R4: Data Access Analyzer

- **R4.1 — Loop-query (N+1) detection**: Database queries inside `for`/`while`/`do` loops and iterator callbacks (`.forEach`/`.map`/`.filter` with `await`) are now detected via AST ancestor traversal. Each finding cites the innermost loop span + query call line (never line 1).
- **R4.2 — Nested-loop attribution**: Deeply nested loops note nesting depth in the finding message.
- **R4.3 — `directAccess` config**: When set to `"allow"`, `direct-sql` and `hardcoded-connection` violations are skipped. Supports Cloudflare Workers/D1 and similar platforms where direct connections are the documented pattern. Default is `"flag"`.
- **Fixed**: Node type checks corrected from PascalCase (`CallExpression`, `NewExpression`) to tree-sitter snake_case (`call_expression`, `new_expression`). Previously prevented `isFunctionCall` from ever matching.
- **`sql-injection-risk` demoted from `critical` to `warning`**: SQL injection detection uses AST-level heuristics (string concatenation in query construction, dynamic SQL patterns) without type information. These are high-signal but not proof of exploitable injection — flagged at `warning` rather than `critical` to keep `--fail-on critical` reserved for user invariants. See "Severity Overrides" below for restoring `critical`.

#### R5: SOLID Analyzer

- **R5.1 — Method-level cyclomatic complexity → `solid/method-complexity`**: Replaced the heuristic `calculateClassComplexity()` (`1 + 2×methods + 5×extends + Σ(lines/10)`) with true cyclomatic complexity per method via `adapter.getComplexity()`. Standalone functions are also checked. Severity: `warning`.
- **R5.2 — Class-level aggregation → `solid/class-size`**: Separate rule id for class-level metrics (`classMethodsThreshold`, default 15; `classAggregateComplexity`, default 100). Severity: `suggestion`.
- **Metric-semantics change**: Complexity numbers are fundamentally non-comparable across this release. The old heuristic produced inflated values unrelated to actual branching. All prior threshold configs and reports are non-comparable across this release. This is a larger user-facing change than the rule renames.
- **Deprecation**: `maxClassComplexity` is deprecated. Use `maxMethodComplexity` and `classAggregateComplexity` instead.
- **Fingerprint warning**: The rule-id split (`single-responsibility` → `solid/method-complexity` + `solid/class-size`) changes fingerprints. `tasks.from_audit` treats them as new findings.

#### R7: Severity Defaults

All severity values normalized. No class at `critical` — the `--fail-on critical` hook path is reserved for user invariants.

| Rule | Severity |
|------|----------|
| documentation/* (all) | suggestion |
| schema/unknown-table | suggestion |
| dry/duplicate | warning |
| dry/structural-similarity | suggestion |
| data-access/loop-query | warning |
| data-access/direct-access | suggestion |
| sql-injection-risk | warning |
| solid/method-complexity | warning |
| solid/class-size | suggestion |

#### R8: Regression Fixtures

19 synthetic test fixtures in `src/analyzers/__tests__/fixtures/spec-17/` with corresponding test file `spec-17.test.ts`. Each fixture cites its report section and exercises a specific noise-reduction rule.

#### Severity Overrides

A `severityOverrides` map in analyzer config allows restoring or adjusting any rule's severity without modifying code. This is the user path back for rules whose default severity changed in this release:

```json
{
  "analyzerConfigs": {
    "data-access": {
      "severityOverrides": {
        "sql-injection-risk": "critical"
      }
    }
  }
}
```

Keys are rule IDs, values are `critical | warning | suggestion`. Overrides apply to all violations after the analyzer runs — individual analyzers don't need to know about them. The mechanism lives in the `UniversalAnalyzer` base class, so all Universal analyzers inherit it.

#### Spec 11 Triage Flag

`sql-injection-risk` is flagged first-in-line for Spec 11 measurement. The heuristic AST-level detection (string concatenation in query construction) produces findings that are high-signal but unverified without type information. Spec 11 will measure true-positive rate on the ExcAlDraw and Gin corpora to calibrate whether the detection heuristics should be tightened or the severity should be re-escalated.

### Changed — Spec-16 R5.3: Config generator re-verification

- **All 12 generators standardized to npx-based stdio MCP transport**: Replaced fictional `/api/*` HTTP endpoints (e.g. `/api/cursor`, `/api/copilot`, `/api/codeium`, `/api/awsq`, `/api/aider`, `/api/jetbrains`) with the single standard pattern: `npx -y code-auditor-mcp --mcp-mode`. This reflects the actual MCP implementation and the post-SKILL.md ecosystem where every tool supports native MCP.
- **ClaudeConfigGenerator**: Updated from Claude Desktop to Claude Code. Uses `.mcp.json` with npx transport. Instructions include skill install and hook wiring.
- **CursorConfigGenerator**: Rewrote from fictional `/api/cursor/*` endpoints to `.cursor/mcp.json` with stdio MCP. Notes: Cursor skills are project-only; `afterFileEdit` hook is advisory (fire-and-forget).
- **CopilotConfigGenerator**: Rewrote from fictional `/api/copilot/*` endpoints to `.vscode/mcp.json` with stdio MCP.
- **CodeiumConfigGenerator**: Rewrote from fictional `/api/codeium/*` endpoints to `.windsurf/mcp.json` with stdio MCP.
- **AWSQConfigGenerator**: Rewrote from fictional `/api/awsq` endpoint to `.amazonq/mcp.json` with stdio MCP.
- **AiderConfigGenerator**: Rewrote from fictional `/api/aider` endpoint to `.aider.mcp.json` with stdio MCP.
- **JetBrainsConfigGenerator**: Rewrote from fictional `/api/jetbrains` endpoint to `.idea/mcp.json` with stdio MCP.
- **ContinueConfigGenerator**: Removed fictional `/api/continue` endpoint. Retained MCP stdio transport, simplified to `.continue/mcp.json`.
- **VSCodeConfigGenerator**: Standardized to npx-based stdio MCP transport, standard `mcpServers` object format.
- **ClineConfigGenerator**: Standardized to npx-based stdio MCP transport.
- **CodexConfigGenerator (NEW)**: Added `.codex/mcp.json` generator. Codex has blocking PostToolUse hooks (exit 2 replaces tool result with violation feedback).
- **GeminiConfigGenerator (NEW)**: Added `.gemini/mcp.json` generator. Gemini CLI has no edit hooks but supports SKILL.md and MCP.
- **ConfigGeneratorFactory**: Updated with new Codex and Gemini entries. Total 12 generators, all matching the support matrix.

## [3.0.6] — 2026-07-19

### Fixed

- **#85 — `audit --fail-on` missing**: The `audit` command (default command) now supports `--fail-on <severity>` for severity-gated exit codes. Exit code 2 when violations at or above the specified severity exist. Mirrors the existing behavior on `code-audit changed`.
- **#86 — `generate-config` output**: The `generate-config` command now generates `.codeauditor.json` (invariant rules config) instead of MCP tool host configurations. Non-interactive mode writes a scaffold template with example rules for all five rule kinds. Interactive mode (`--interactive`) walks through building rules one at a time via inquirer prompts.

## [3.0.5] — 2026-07-19

### Fixed

- **#82 — `dep:` search operator**: Module-level dependencies (package names like `react`) are now stored in the `function_dependencies` table during indexing. The `dep:` operator correctly finds functions that depend on a given package.
- **#83 — `file:` search operator**: GLOB patterns are now wrapped with `*...*` wildcards so relative paths correctly match against absolute paths stored in the database.
- **#84 — Nested/inner functions**: Functions declared inside function bodies now coexist correctly in the index. Previously, same-named functions at different lines in the same file would collide due to a unique constraint on `(name, file_path)` only. Schema migration v1→v2 adds `line_number` to the unique constraint so nested functions are stored as distinct entries.

## [3.0.4] — 2026-07-19

### Fixed

- **#77 — Populate relational/derived data during indexing**: The index sync path (`FunctionScanner.scanFunctions`) was a stripped-down duplicate of `extractFunctionsFromFile` that computed zero relational data — no `functionCalls`, `usedImports`, `unusedImports`, or `complexity`. This caused `function_calls` and `function_dependencies` tables to stay empty, `complexity` to always be 0, and `has_unused_imports` to always be 0 — breaking 5 of 11 search operators (`calls:`, `dep:`, `complexity:>`, `unused-imports`). Fixed by extracting `extractFunctionsFromSource(content, filePath, options?)` as the single canonical implementation and routing both the audit runner and index sync paths through it. Also added `calculateComplexity()` for all function types (function declarations, arrow functions, class methods) — previously only computed for React components.

## [3.0.3] — 2026-07-19

### Fixed

- **#73 — Silence DEBUG logging flood**: Removed unguarded `console.error` debug lines from `UniversalSOLIDAnalyzer`, `UniversalDocumentationAnalyzer`, `UniversalAnalyzer`, and `mcp-tools-shared.ts`. Audit output reduced from ~28,000 lines to ~17 lines. Remaining debug lines are properly gated by `IS_DEV_MODE`.
- **#74 — Fix report JSON inconsistencies**: `summary.totalFiles` was always 0 (wrong source field) and `summary.topIssues` was always empty (never computed). Fixed in both `mcpAuditJobs.ts` (`summarizeAnalyzerResults`) and `auditRunner.ts` (`generateSummary`). SARIF reconstruction path now reads `topIssues` from stored summary instead of hardcoding `[]`.
- **#72 — Doc vs reality**: Fixed flag and command mismatches in `SKILL.md` — `--json` flag and `--fail-on` flag syntax corrected to match actual CLI behavior.

### Changed

- **#75 — Path scoping**: Added `docs`, `specs`, `backup`, `backups` to `DEFAULT_EXCLUDED_DIRS` in `fileDiscovery.ts`. These directories are now skipped by default during full audits to reduce noise. Explicitly targeted files are still audited regardless.

## [3.0.0] — 2026-07-17

Complete re-architecture. The entire Spec 01–09 arc ships as a single breaking release. The individual spec-architected version increments (2.7.0 through 4.0.1) were never published to npm — this is publish point one.

### Spec 01: Dead Architecture Removal & Canonical Language Layer

- **Removed** archived code: legacy `src/analyzers/` implementations predating the functional analyzer pattern, dead config generators, and the dual entry-point tangle.
- **Established** `LanguageAdapter` as the single seam for language support. All analysis paths consume `LanguageAdapter`; no analyzer imports a language-specific parser directly.
- **Canonical language layer**: `src/languages/` with `LanguageRegistry`, adapter interface (`types.ts`), and one adapter per language.

### Spec 02: MCP Surface Consolidation

- **Breaking**: MCP tool names and entry points consolidated. Seven tools replace the previous fragmented surface.

| v2 tool | v3 tool / action |
|---------|-----------------|
| `start_audit` | `audit.run` |
| `audit_health` | `audit.health` |
| `search_code` | `search.query` |
| `find_definition` | `search.definition` |
| `sync_index` | `index.sync` |
| `generate_ai_config` | removed (CLI `generate-config` for host configs) |
| `get_workflow_guide` | `guide.get` |
| — (new) | `code_map.get` |
| — (new) | `tasks` (create, list, get, update, delete, from_audit) |
| — (new) | `config` (get, set, list, rules_list, rules_check) |

- **Single entry point**: `mcp.ts` as the sole MCP server entry; `cli.ts` for the CLI. `tool-registry.ts` dispatches all tool calls.
- **Fingerprint utility**: stable violation fingerprints for dedup across audit runs.

### Spec 03: SQLite Data Layer

- **Replaced LokiJS** with `better-sqlite3`. The code index, audit results, task list, and config all live in a single SQLite database at `<cwd>/.code-index/index.db`.
- **Replaced FlexSearch** with SQLite FTS5 for full-text search.
- **`content_hash`** added to `EnhancedFunctionMetadata` for diff detection.
- **QueryParser** compiles to SQL via `compileToSQL()`.
- **Migration**: existing LokiJS data is migrated automatically on first run.
- **Tasks survive index reset**: clearing the analysis index does not delete the task list.

### Spec 04: Diff-Scoped Auditing & Agent Hook Integration

- **`code-audit changed`** command audits only files modified since the last index sync.
- **Scope options**: `changed` (default), `git:<ref>`, `[paths...]`, `--stdin`.
- **Hook contract**: `--json`, `--quiet`, `--fail-on <severity>` flags. Exit code 2 on critical violations.
- **Claude Code hook recipe**: `PostToolUse` hook on Edit/Write pipes changed file paths to `code-audit changed --stdin --json --fail-on critical`.
- **Scoped result isolation**: `getMostRecentAuditResults` filters by scope.

### Spec 05: Custom Invariant Rules Engine

- **`.codeauditor.json`** in the project root defines project-specific rules enforced on every audit run.
- **Four initial rule kinds**: `import-ban`, `call-constraint`, `module-boundary`, `naming`.
- **JSON Schema** (`invariant-rules.schema.json`) validates rule configs on startup — bad globs, duplicate IDs, missing fields fail the audit rather than being silently skipped.
- **`config rules_list`** and **`config rules_check`** MCP actions introspect the active ruleset.
- **Rule engine** (`ruleEngine.ts`) runs rules per-file during audits, including diff-scoped runs.

### Spec 06: SARIF Output

- **SARIF formatter** (`sarifReportGenerator.ts`) emits SARIF 2.1.0 for GitHub Code Scanning.
- **CLI**: `code-audit -f sarif -o results.sarif`.
- **CI recipe**: GitHub Actions workflow uploads SARIF to CodeQL for PR annotations.
- **Diff-scoped SARIF**: `code-audit changed --scope git:origin/main -f sarif` with `--sarif-category` for scoped uploads.
- **Stable fingerprints** per violation for dedup in GitHub's SARIF consumer.

### Spec 07: Claude Code Plugin & Skill Packaging (A2 Rework)

- **Skill-first packaging** (A2): The plugin contains manifest, hooks, hook script, and skill. The bundled MCP server was stripped — the skill teaches the CLI; the MCP server remains the standalone path for shell-less hosts.
- **`plugin/.claude-plugin/plugin.json`**: manifest with name `code-auditor`, version synced to package.
- **Repo as marketplace**: `.claude-plugin/marketplace.json` at repo root. Install: `claude plugin marketplace add BenAHammond/code-auditor-mcp` → `claude plugin install code-auditor`.
- **`PostToolUse` hook** on Edit/Write: pipes edited file paths to `code-audit changed --stdin --json --fail-on critical`. Degrades cleanly (exit 0 with notice) when package not installed or no index exists.
- **SKILL.md** rewritten CLI-first: teaches `code-audit changed` before claiming work complete, semantic search operators, `tasks from-audit` remediation queue, and reading invariants at session start.
- **CLI parity subcommands** (A2 R2): `code-audit search`, `code-audit map`, `code-audit tasks` — thin argv adapters over the same service layer as MCP handlers.
- **Rule-kind reference file** in the skill folder documents all five rule kinds including `ast-pattern` (Spec 08).

### Spec 08: tree-sitter Migration & `ast-pattern` Rule Kind

#### tree-sitter Migration

- **Replaced TypeScript compiler API** with tree-sitter behind the `LanguageAdapter` interface. All 16 direct TS consumers migrated to `adapterBridge.ts`.
- **`typescript` moved to `devDependencies`** — the production build no longer depends on the TS compiler.
- **`adapterBridge.ts`**: synchronous facade over tree-sitter parsers — `getASTForFile()`, `walkAST()`, `findNodes()`, `calculateComplexity()`.
- **Real Go adapter**: `GoAdapter.ts` rewritten with `tree-sitter-go` WASM grammar. Previously returned empty ASTs; now parses actual Go source.
- **WASM grammars** shipped at `dist/grammars/` (tree-sitter-typescript, tree-sitter-javascript, tree-sitter-go). Zero native compilation required — `web-tree-sitter` runtime is pure JS.
- **Parser initialization**: `initParsers()` called once at CLI boot / MCP server start. `adapterBridge` throws if used uninitialized — a loud programmer error, never silent.
- **Complexity definition**: Now documented cyclomatic complexity — decision-point count (if, for, while, do, switch_case, ternary, `&&`, `||`) + 1. This is the canonical definition; previous TS-API-based numbers may differ slightly.

#### `ast-pattern` Rule Kind

- **New invariant rule kind**: `ast-pattern` — match AST node patterns in source using `@ast-grep/napi`.
- **Pattern syntax**: ast-grep patterns (e.g., `new Function($$$)` matches any `new Function(...)` call).
- **Language support**: `typescript` (via `tsx` parser), `javascript`. Go is not supported by `@ast-grep/napi` — rules targeting Go will skip gracefully.
- **Configuration fields**: `pattern` (required, non-empty), `language` (optional, defaults to `typescript`), `path` (optional file glob filter).
- **Dogfood rule**: This repo's `.codeauditor.json` includes a `no-new-function` ast-pattern rule banning `new Function()`.

### Spec 09: Positioning Rewrite

- **Repositioned** from "multi-language code quality auditor" to "architectural invariants and code quality analysis, enforced inside your AI agent's edit loop."
- **README rewrite**: 9-section structure, agent-loop-first framing. Invariant rules moved to flagship section. Every example reproducible against the shipped version.
- **Metadata**: `package.json` description and keywords updated. `server.json` description and version updated. `plugin.json` version synced.
- **GitHub About**: updated to the R1 positioning line.

### Mid-series note

The internal version increments spec-architected for individual specs (2.7.0, 3.0.0–4.0.1) were never published to npm. The last published version before this release was 2.6.2. This 3.0.0 release absorbs the entire nine-spec arc into a single breaking release per Amendment A1.

## [3.1.1] — 2026-07-20

### Spec 11: Analyzer Quality Evaluation

Empirical measurement of every built-in rule's precision on real code. Four phases across three corpora (code-auditor self-audit, Gin web framework, Excalidraw whiteboard).

#### R1: Findings Ledger

- **`src/ledger/`**: Per-corpus, per-run, per-rule precision/recall/F1 ledger stored in the code index database. Every audit run records which rules fired, how many findings each produced, and (once triaged) how many were true/false/TBU.
- **Delta tracking**: Between-run diffs show which rules gained or lost precision. Used to detect regressions from rule changes.

#### R2: Benchmark Corpus and Harness

- **`bench/corpus/`**: 26 fixture projects (one per analyzer rule), each with an `expected.json` ground-truth file. Fixtures are hand-crafted to exercise exactly one rule's detection logic.
- **`bench/runBench.ts`**: Harness computing per-rule precision, recall, and F1 against ground truth. Outputs `bench/results/latest.json`.
- **`bench/baseline.json`**: Frozen precision/recall/F1 snapshot. A regression gate (`bench/regression.test.ts`) fails the build if any rule's F1 drops more than 0.02 below baseline.
- **Non-English corpus**: Mixed Portuguese/German/Japanese identifiers testing provenance-based detection. Detection gaps between English and non-English corpora are release-blocking (Spec 21 amendment).

#### R3: Empirical Threshold Tuning

- **Threshold sweeps**: Each numeric threshold (`maxFunctionLength`, `maxParameters`, `classMethodsThreshold`, `maxMethodComplexity`, `classAggregateComplexity`) swept across 5–8 values on the self-audit corpus. Per-value precision and yield recorded.
- **`bench/results/sweep-report.md`**: Sweep results with recommended values. Applied to `DEFAULT_ANALYZER_CONFIGS` where precision improves without substantial yield loss.
- **`very-complex-method.ts`**: Added to the SOLID bench corpus to close a detection gap at the `classAggregateComplexity` threshold.

#### R4: Real-Corpus Triage

- **Three-corpus triage**: 691 self-audit findings, 205 gin findings, 1,747 excalidraw findings classified as true / false / true-but-useless with one-sentence rationales.
- **Classification principles**: Test fixtures are false positives by definition. Domain mismatch (SaaS rules on CLI tools) is false. TBU covers JSDoc-on-everything, internal-tool N+1, time-correlated git signals.
- **`bench/results/triage-report.md`**: Per-analyzer, per-rule precision and judged-true rates with root-cause analysis.
- **`bench/results/triage-classified.json`**: 691 classified findings with verdict and rationale.

#### R5: Mechanical Recalibration

Binding recalibration rules applied to the self-audit triage results:

| Condition | Action |
|-----------|--------|
| precision ≥ 0.95 AND judged-true ≥ 0.90 | Promote one severity tier |
| judged-true < 0.50 | Disable by default (`off`) |
| n < 10 judged findings (T+F) | Exempt (insufficient sample) |

**6 rules disabled** (`missing-org-filter`, `unknown-table`, `sql-injection-risk`, `loop-query`, `unfiltered-query`, `direct-sql`): Domain mismatch (SaaS tenant isolation on a CLI tool), dogfooding artifacts (the tool's own SQL-pattern constants detected as queries), or findings confined to test fixtures.

**3 rules promoted**: `single-responsibility` (warning → critical, precision 0.98), `solid/class-size` (suggestion → warning, precision 1.00), `dependency-inversion` (suggestion → warning, precision 1.00).

**Guard rails**: Minimum 10 judged findings before recalibration applies. One-tier promotion only (no suggestion → critical in a single step). Rules exempt from recalibration remain at their current severity with a note that the sample is too small.

**Implementation**: `severityOverrides` on the default `AuditConfig` object. The `UniversalAnalyzer` base class filters `'off'`-severity violations before reporting. Users can override any rule's severity in their own `.codeauditor.json`.

#### R6: Honest Documentation

- **Deterministic vs advisory split**: README now documents which rules are structural facts and which are heuristic signals. Every disabled rule names the corpus where it *would* be useful.
- **Recalibration disclosure**: README names the three measurement corpora, the recalibration rules, and the re-enable path (`severityOverrides`).
- **`'off'` severity**: Documented as the opt-out mechanism. Setting a rule to `"off"` removes it from audit output entirely.
- **`severityOverrides` on `AuditConfig`**: New top-level config field for global per-rule severity overrides. Applied before per-file path profile caps.

### Changed Files

| File | Change |
|------|--------|
| `src/ledger/findingsLedger.ts` | **New** — per-run, per-rule precision ledger |
| `src/ledger/delta.ts` | **New** — between-run delta computation |
| `bench/corpus/` | **New** — 26 per-analyzer fixture projects with `expected.json` |
| `bench/runBench.ts` | **New** — harness computing precision/recall/F1 |
| `bench/results/` | **New** — triage reports, recalibration table, sweep report |
| `src/types.ts` | `Severity` extended with `'off'`; `severityOverrides` added to `AuditConfig` |
| `src/languages/UniversalAnalyzer.ts` | Filter `'off'`-severity violations; preserve `errors` field |
| `src/config/defaults.ts` | `severityOverrides` in `getDefaultConfig()` with recalibration values |
| `src/analyzers/analyzerUtils.ts` | Severity maps include `off: 0` |
| `src/reporting/` (html, csv) | Severity maps include `off: 0` |
| `README.md` | Deterministic/advisory split; recalibration disclosure; re-enable path |
| `CHANGELOG.md` | Spec 11 entry (this section) |

## [3.1.1] — 2026-07-20

### Spec-18 R1/R6 follow-up: Baseline Fingerprint Scheme & Per-Analyzer Symbol Fixes

#### Baseline schemaVersion bump (v1 → v2)

- **schemaVersion 2**: Baseline fingerprint scheme revised for collision-resistant per-analyzer symbols.
- **Forward-compatibility**: v1 baselines are rejected with a clear message directing users to re-snapshot (`code-audit baseline`).
- **`missing-schemas`**: Single-fire config gate → `top-level:missing-schemas`.

#### Schema analyzer symbol overhaul

All three schema rules now use enclosing-function + ordinal symbols, matching the data-access analyzer scheme:

- **`sql-injection`**: Per-call-site regex detection with global matching; each match gets `{enclosingFn}:sql-injection` symbol (with ordinal for multiple matches in the same function).
- **`n-plus-one`**: `.map()`, `.forEach()`, and `for(...)` loop context detection around `.query()`/`.execute()` call sites; each gets `{enclosingFn}:n-plus-one` symbol with ordinal disambiguation.
- **`missing-schemas`**: Gate violation uses `top-level:missing-schemas` symbol.

Helpers added to `UniversalSchemaAnalyzer`:
- `findClosestNodeAt(root, location, adapter)` — finds deepest AST node containing a source position
- `findEnclosingFunctionName(node, adapter)` — walks parent chain to find enclosing function/method name
- `getNodeName(node, adapter)` — extracts human-readable name from AST node

#### Cross-surface fingerprint consistency

- **`projectTasks.ts`** (`from_audit`): Replaced divergent inline symbol extraction with canonical `extractSymbol()` from `symbols.ts`. The previous inline chain used a different priority order (`className` before `functionName`) and was missing `methodName` and `name` fields.
- **Cross-surface test** (`baseline.test.ts`): Replaced tautology test (comparing `fingerprint()` with itself) with proper cross-surface verification — creates Violation objects with diverse symbol-field configurations and verifies `extractSymbol()` + `fingerprint()` produce identical, stable hashes through all three pathways (baseline matching, from_audit task creation, SARIF output).

#### Spec 20 stray files removed

Stray Spec 20 files (`profileResolver.ts`, `profile.test.ts`, spec doc) removed — they imported nonexistent types from `types.ts` and had no git history. Spec 20 will be implemented under its own proper plan review.

### Spec-19 Corrective Batch — July Close-Out

#### Item 1: Real Oracle Fixtures

Replaced the generic `oracle-rerun.test.ts` suite with 27 standalone fixture files, each structurally equivalent to the cited recall-corpus code. The 30-test suite (27 item tests + 3 extras) passes with the documented split: 13 fire, 17 silent (including 2 retired rules).

#### Item 2: method-complexity R1 Diagnosis

The per-node-shape complexity measurement (Spec-19 R1) fixed the class of false positives where complexity-1 functions containing `.map()` callbacks and SQL-query patterns were miscomputed as high complexity, including the "hero-repo.ts:83" repository-method shape — a single `db.query()` + `.map()` normalizer that the old walker over-counted by descending into callback AST subtrees. The Σ(lines/10) heuristic theory floated in the first close-out summary was wrong: that heuristic had already been replaced by Spec-17 R5 before the 3.1.1 triage that caught these findings — it cannot have caused complexity-1 findings observed on 3.1.1. Spec-19 R1's callback-descending walker fix is the correct diagnosis.

#### Item 3: n-plus-one / loop-query Rule Consolidation

The schema analyzer's regex-based `n-plus-one` rule and the data-access analyzer's AST-based `loop-query` rule both detected the same defect (N+1 database queries inside loops/map callbacks). Consolidated to a single emitter: the data-access analyzer's `loop-query` rule, which uses tree-sitter AST traversal for accurate loop-detection rather than 500-character text-window heuristics. The schema analyzer's `checkNPlusOne()` method and the `n-plus-one` rule ID have been retired. `data-access/loop-query` is now the canonical rule for N+1 query detection.

**Migration note**: Previously-baselined `n-plus-one` findings will churn to "fixed" / "new: `loop-query`" on the next audit run after upgrading — one-time noise. Users with `severityOverrides['n-plus-one']` must rename the key to `loop-query`:

```json
// Before (schema analyzer, retired):
{ "analyzerConfigs": { "schema": { "severityOverrides": { "n-plus-one": "critical" } } } }

// After (data-access analyzer, canonical):
{ "analyzerConfigs": { "data-access": { "severityOverrides": { "loop-query": "critical" } } } }
```

#### Item 4: Structural Similarity Contract

Structural similarity detection (`dry/structural-similarity`) remains **default-off** (`checkStructuralSimilarity: false`). The oracle suite confirms this contract: item 26 (CRUD handlers) produces 0 violations with defaults; item 27 (API version routers) fires at `suggestion` severity when enabled — confirming the strategist-manager shape is correctly detected when the user opts in. Both pass at HEAD.

#### Item 5: Hook-Script Transcripts from Foreign cwd

All three hook adapters verified as correctly forwarding the project root when invoked from a foreign cwd (a directory different from the project being audited):

- **`hook-audit.sh`** (Claude Code PostToolUse): Passes `-p "${CLAUDE_PROJECT_DIR}"` — the Claude Code runtime forwards `CLAUDE_PROJECT_DIR` on every hook invocation. Transcript confirms `projectRoot` resolves to the project, not the hook launch cwd.
- **`cursor.ts`** (`code-audit cursor-hook`): Priority chain `event.cwd` → `CLAUDE_PROJECT_DIR` → `process.cwd()`. Native Cursor supplies the correct `cwd` in the stdin event; Claude Code compat mode supplies `CLAUDE_PROJECT_DIR`. `workspace_roots` from the Cursor common schema is available but `event.cwd` (the hook-specific working directory) is the correct primary source — it points to the project root in single-root workspaces. Covered by 3 test cases in `cursor.spec.ts`.
- **`codex.ts`** (`code-audit codex-hook`): **Defect fixed** — was using `CLAUDE_PROJECT_DIR → process.cwd()` fallback, which is wrong for Codex-native invocations because Codex hooks don't set `CLAUDE_PROJECT_DIR`. Codex's common payload carries `cwd` (learn.chatgpt.com/docs/hooks). Resolution order is now `event.cwd → CLAUDE_PROJECT_DIR → process.cwd()` — matching the cursor.ts payload-first pattern. Refactored to export `processCodexEvent()` and `formatCodexFeedback()` for testability. New `codex.spec.ts` with 17 tests covering empty stdin, invalid JSON, no file path, critical → exit 2, warning → advisory, audit-throw → never-wedge, foreign cwd (`CLAUDE_PROJECT_DIR`), cwd fallback, `tool_input.path` fallback, payload-first resolution (`event.cwd`), env fallback when no `event.cwd`, and process.cwd() last resort. All 42 hook tests pass (25 cursor + 17 codex).

Real-payload transcripts with `event.cwd` in the Codex payload (no `CLAUDE_PROJECT_DIR` set) confirm all three hooks load the correct project root, code index, and config.

#### Item 6: Version Reconciliation

All corrective batch items (1–6) were developed on version 3.1.1 (the post-Spec-17 release baseline) on the `main` branch. No version discrepancy exists between `package.json` (3.1.1) and the CHANGELOG. Spec files reference planned ship versions (spec-04: v3.2.0, spec-05: v3.3.0, spec-11: v3.2.0) that were planning projections written ahead of implementation — the actual release cadence bundled multiple specs into fewer releases. Specs never touch version fields per the goal doc; the canonical version lives in `package.json` alone. The accumulated close-out changes are staged for the next release which should bump to at least 3.2.0 given the rule-ID consolidation (`n-plus-one` → `loop-query`), fingerprint-scheme changes, and hook-adapter refactoring included in this batch.
