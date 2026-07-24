# Spec 10 — Style Intelligence: Implementation Plan

## Context

LLM coding agents produce styling fragmentation that line-level linting can't see — near-duplicate hex values, off-scale margins, inline styles where the project uses Tailwind, mechanism mixing within a single component. The insight lives in the distribution.

Spec 10 builds a style index parallel to the function index, extracts normalized declarations from five style sources, derives findings statistically from value histograms, and extends the invariant engine so style policy is enforceable in the agent loop.

## Design

### R1 — CSS/SCSS Language Support

New `TreeSitterCssAdapter` implementing the `LanguageAdapter` interface for `.css` and `.scss` files via tree-sitter-css and tree-sitter-scss grammars. Methods returning AST concepts not present in CSS return empty/null. Grammar WASM files added to `GRAMMAR_FILES` and `LANGUAGE_GRAMMAR_MAP` in parser.ts, shipped in `dist/grammars/`.

### R2 — Style Extraction Infrastructure

The extraction unit is the **normalized declaration**: `(property, rawValue, normalizedValue, mechanism, file, line, context, variantContext, tokenRef)`.

**New modules:**
- `src/styles/styleExtractor.ts` — Extracts declarations from five mechanisms: CSS/SCSS (tree-sitter rule-set walking), Tailwind utilities (class name → declaration expansion), inline styles (`style={{...}}`), CSS-in-JS (tagged templates), and design tokens (CSS custom properties, Tailwind theme)
- `src/styles/normalizer.ts` — Color normalization (lowercase, shorthand hex expansion, canonical functional notation), length parsing, short→longhand expansion, Delta-E color distance for value-drift clustering
- `src/styles/tailwindExpander.ts` — Maps Tailwind utility classes to normalized declarations, supports arbitrary values and variant prefixes
- `src/styles/tailwindConfigLoader.ts` — Dynamic Tailwind config loading (v3 JS, v4 CSS `@theme`, bundled defaults)

### R3 — Style Index (SQLite Storage and Search)

**New tables in codeIndexDB:**
- `style_declarations` — Normalized declarations per file
- `style_tokens` — Design token registry
- `style_class_usage` — Per-file class name usage tracking
- `style_declarations_fts` — FTS5 full-text search over property and normalized values

**Schema migration 2→3** creates all three style tables with indexes.

**New module `src/styles/styleIndexer.ts`** — Content-hash-based change detection; re-extracts only changed files.

**New search operators:** `css:<property>`, `value:<normalized-value>`, `mechanism:<css|tailwind|inline|css-in-js|scss>`, `token:<design-token-name>`.

**Code map `styles` section** — Mechanism summary, property→value histogram, token table.

### R4 — Styles Analyzer (7 Detectors, 10 Rule IDs)

DB-based `UniversalStylesAnalyzer` reading from the full style index. Every detector has configurable thresholds and fires only when per-property corpus ≥ `minCorpus`.

10 rule IDs across 7 detectors: `styles/value-drift`, `styles/off-scale`, `styles/undefined-class`, `styles/token-bypass`, `styles/mechanism-fragmentation`, `styles/mechanism-mixing`, `styles/declaration-set-similarity`, `styles/z-index-sprawl`, `styles/z-index-singleton`.

### R5 — React Analyzer Raw-Element Detection

`checkRawElements()` — Auto-detects wrapper components and flags raw usages of wrapped intrinsic elements outside the wrapper definition when call sites ≥ `wrapperMinUsages` (default 5).

Config: `rawElementWatchList` (default `['button', 'input', 'select', 'textarea', 'table']`), `wrapperMinUsages`, `componentMap`.

### R6 — Style Invariant Rule Kinds

Two new rule kinds: `style-mechanism` (require allowed style mechanisms per file/glob) and `no-raw-values` (ban hardcoded values for specific CSS properties). Both query the `style_declarations` table via `CodeIndexDB`. JSON Schema validation covers both kinds.

## Implementation Order

1. Create `TreeSitterCssAdapter` + register in language layer
2. Create style extraction modules (extractor, normalizer, tailwind expander, config loader)
3. Add style types (`NormalizedDeclaration`, `StyleToken`, `StylesAnalyzerConfig`)
4. Create style indexer + extend `codeIndexDB` (schema v3, style tables)
5. Create `UniversalStylesAnalyzer` with 7 detectors
6. Wire styles into auditRunner and defaults
7. Add style search operators and code map section
8. Extend React analyzer for raw-element detection
9. Add style invariant rule kinds
10. Create style bench fixture and tests
11. Update docs, CHANGELOG, tag spec-10

## Files Created

| File | Purpose |
|------|---------|
| `src/languages/tree-sitter/TreeSitterCssAdapter.ts` | LanguageAdapter for CSS/SCSS |
| `src/styles/styleExtractor.ts` | Extraction from 5 style sources |
| `src/styles/normalizer.ts` | Color/length/shorthand normalization |
| `src/styles/tailwindExpander.ts` | Tailwind utility → declaration expansion |
| `src/styles/tailwindConfigLoader.ts` | Load project Tailwind config |
| `src/styles/styleIndexer.ts` | Sync style declarations to SQLite |
| `src/styles/types.ts` | Style-specific TypeScript interfaces |
| `src/analyzers/universal/UniversalStylesAnalyzer.ts` | DB-based analyzer with 7 detectors |
| `bench/corpus/styles/` | Bench fixture project + expected.json |

## Files Modified

| File | Change |
|------|--------|
| `src/languages/tree-sitter/parser.ts` | CSS/SCSS grammars |
| `src/languages/index.ts` | Register TreeSitterCssAdapter |
| `src/types.ts` | Style types + React analyzer config extensions |
| `src/codeIndexDB.ts` | SCHEMA_VERSION → 3, style tables, migration 2→3 |
| `src/search/QueryParser.ts` | 4 new style operators |
| `src/services/CodeMapGenerator.ts` | New styles section |
| `src/analyzers/reactAnalyzer.ts` | checkRawElements() |
| `src/auditRunner.ts` | Register styles analyzer, call styleIndexer |
| `src/config/defaults.ts` | DEFAULT_ANALYZER_CONFIGS.styles |
| `src/invariants/types.ts` | style-mechanism, no-raw-values RuleKind |
| `src/invariants/ruleEngine.ts` | checkStyleMechanism(), checkNoRawValues() |
| `src/invariants/invariant-rules.schema.json` | Schemas for new rule kinds |
| `src/invariants/ruleValidator.ts` | Validation for new rule kinds |
| `src/cli.ts` | RULE_KINDS extended |
| `bench/baselines/baseline.json` | styles analyzer baseline |
| `src/scripts/runBench.ts` | Styles runner with in-memory seed data |
| `src/__tests__/bench.test.ts` | Updated to 9 analyzers |
| `package.json` | tree-sitter-css, tree-sitter-scss devDeps |
