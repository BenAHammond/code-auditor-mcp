# Changelog

All notable changes to the Code Auditor MCP project.

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
