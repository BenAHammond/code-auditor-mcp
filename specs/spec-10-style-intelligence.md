# Spec 10 — Style Intelligence: Index, Outliers, Fragmentation

**Project:** code-auditor-mcp
**Ships as:** next minor version, assigned at release time in publish order
**Done means:** published to npm, all tests green, build clean.
**Depends on:** Spec 09 merged and published (requires the tree-sitter parsing layer from Spec 08).

## Context

LLM coding agents copy, paste, and invent styling: a near-duplicate hex here, an off-scale margin there, inline styles where the project uses Tailwind, raw `<button>` where a `Button` component exists. Each edit is locally plausible; the aggregate is fragmentation. Line-level linting can't see this — the insight lives in the distribution. This spec builds a style index parallel to the function index, derives findings statistically from value histograms, and extends the invariant engine so style policy is enforceable in the agent loop like everything else.

## Requirements

### R1 — Style extraction: everything normalizes to declarations

The unit of analysis is the **normalized declaration**: `(property, rawValue, normalizedValue, mechanism, file, line, context, variantContext, tokenRef)`.

Extraction sources, all mandatory:

1. **CSS and SCSS files** — via tree-sitter-css / tree-sitter-scss grammars behind a new `languages/css/` adapter (the `LanguageAdapter` seam from Spec 08; file discovery extends to `.css`/`.scss`). `context` = the full selector. `variantContext` = enclosing media query / pseudo-class.
2. **Tailwind utility classes** in `className`/`class` attributes across TSX/JSX (and plain HTML files if present), **expanded to their underlying declarations** (`mt-4` → `margin-top: 1rem`). Expansion resolves against the project's own Tailwind installation and config when present — both v3 JS config and v4 CSS-based config — falling back to a bundled default-theme mapping when the project has no config. Arbitrary-value utilities (`mt-[17px]`) are parsed directly. Variant prefixes (`hover:`, `md:`) expand the underlying utility with the variant recorded in `variantContext`. `mechanism` = `tailwind`, `context` = the enclosing component, `tokenRef` = the utility class name.
3. **Inline styles** — JSX `style={{...}}` objects. Statically resolvable properties/values are extracted; entries with computed values are recorded as declarations with `normalizedValue = null` (they count for mechanism analysis but not value statistics). `mechanism` = `inline`.
4. **CSS-in-JS** — styled-components and emotion tagged template literals, parsed with the CSS grammar. `mechanism` = `css-in-js`.
5. **Design tokens** — CSS custom property definitions (`--x: value`) and Tailwind theme tokens are indexed separately as the token table; `var(--x)` usages set `tokenRef` on the consuming declaration.

Normalization: colors to a canonical form (lowercased hex8 / structured color record for functional notations), lengths to `{number, unit}`, shorthand properties expanded to longhands (`margin: 4px 8px` → four declarations sharing one source location).

Dynamic `className` expressions (`clsx(...)`, template literals): statically resolvable string parts are extracted; irreducibly dynamic parts are recorded per file as `unresolvable-classnames` markers. These markers exempt the file's class references from dead/undefined-class findings (R3.3) — no false positives from dynamism.

### R2 — Storage, search, and the tree

1. New SQLite tables: `style_declarations` (columns for every R1 field, all queryable fields as real columns), `style_tokens`, `style_class_usage` (className references ↔ defined selectors cross-reference). Per-file extraction participates in the Spec 03/04 content-hash scheme so diff-scoped runs re-extract only changed files.
2. New search operators, wired through QueryParser like the existing set: `css:<property>`, `value:<value>` (matches raw or normalized), `mechanism:<css|scss|tailwind|inline|css-in-js>`, `token:<name>`. Combinable with `file:`.
3. New `code_map` section `styles`: the tree — mechanism summary (declaration counts per mechanism), then property → value histogram (count, share, mechanisms, sample locations, tokenRef coverage), then token table with usage/bypass counts. This is the "tree of data with obvious outliers" surface; it is data, not findings — findings come from R3.

### R3 — The `styles` analyzer

New analyzer `styles`, a standard `AnalyzerFunction`, enabled by default when any style source exists. Findings are statistical; every detector below has concrete configurable defaults (via the `config` tool, analyzer name `styles`) and fires only when the per-property corpus has at least `minCorpus` declarations (default 20).

1. **Value drift** — for properties with a dominant mode, low-share stragglers are findings. Colors: cluster by perceptual distance; a value within `colorDeltaE` (default 2.0) of a value ≥10× more frequent → *drift* (suggestion). Non-color: exact-value histogram; share < `outlierMaxShare` (default 0.05) alongside a mode ≥ `modeMinCount` (default 10) → *outlier* (suggestion).
2. **Off-scale values** — for scale-family properties (margins, paddings, gaps, font sizes): infer the project scale from modal values (and Tailwind scale when config present); values off-scale by a non-multiple remainder → finding. The lone `17px` in a 4/8/16/24 codebase.
3. **Dead and undefined classes** — class selectors defined in indexed CSS/SCSS with zero references in `style_class_usage` → *dead-css*; className references resolving to no selector, no Tailwind utility, and no unresolvable-classnames exemption → *undefined-class*.
4. **Token bypass** — a raw value equal (post-normalization; colors within `colorDeltaE`) to an existing token's value, used without the token → finding naming the token. Warning severity.
5. **Mechanism fragmentation** — (a) the same normalized `(property, value)` produced through ≥3 mechanisms codebase-wide → one aggregated finding listing locations per mechanism; (b) a single component mixing ≥3 mechanisms → per-component finding.
6. **Declaration-set similarity** — DRY for style blocks: two rule blocks / inline objects / CSS-in-JS blocks with ≥ `similarityThreshold` (default 0.9) shared normalized declarations and ≥5 declarations each → finding pairing the locations. Reuses the DRY analyzer's similarity machinery where applicable.
7. **Z-index inventory** — distinct z-index value count with singleton values flagged; informational finding when distinct count > `zIndexMaxDistinct` (default 6).

Scoped-run semantics (Spec 04): scoped files are re-extracted, and their declarations are evaluated **against the full style index** — a fresh drift value or token bypass introduced by an agent edit is always caught. Corpus statistics come from the full index, never the scope alone.

### R4 — Raw-HTML detection (React analyzer extension)

1. The React analyzer gains a `raw-element` check: auto-detect wrapper components (an exported component whose rendered root is a single intrinsic element from the watch list and which forwards props/children), and flag raw usages of that intrinsic element outside the wrapper's own definition once the wrapper has ≥ `wrapperMinUsages` (default 5) call sites. Watch list default: `button`, `input`, `select`, `textarea`, `table`; configurable. Finding message names the wrapper: "raw `<button>` — this project uses `Button` (src/components/Button.tsx)". Suggestion severity.
2. An explicit `componentMap` in the React analyzer config (`{"button": "Button", ...}`) overrides auto-detection and raises severity to warning for mapped elements.

### R5 — Style invariant rule kinds

Two new kinds in the Spec 05/08 rules schema (JSON Schema, ajv, `rules_check`, fingerprints, SARIF, `tasks.from_audit` all extend identically):

1. **`style-mechanism`** — `{ allow: string[], path?: string }`; `allow` values from the mechanism enum. Any declaration in matching files via a mechanism outside `allow` is a violation. (`{"allow": ["tailwind"]}` = "this project styles via Tailwind, period"; inline-style bans are this kind with `inline` absent.)
2. **`no-raw-values`** — `{ properties: string[], allowValues?: string[], path?: string }`. Declarations for the listed properties (longhand names, post-expansion) must carry a `tokenRef` (custom property, Tailwind non-arbitrary utility, or theme token) unless the normalized value is in `allowValues`. The agent that writes `style={{marginTop: "17px"}}` gets blocked at the hook with the rule's message.

## Acceptance evidence

1. `pnpm run build` clean; `pnpm test` green. A committed fixture project (React + Tailwind v4 + a CSS file + one styled-components file) seeded with: one hex one Delta-E off the brand color, one `17px` margin, one dead class, one undefined class, one token bypass, one triple-mechanism duplicate value, two near-identical rule blocks, seven z-indexes, a `Button` wrapper plus two raw `<button>`s, and a `clsx` dynamic classname. Tests assert each detector fires exactly on its seed and nowhere else — including that the dynamic-classname file produces zero undefined-class findings.
2. Tailwind expansion tests: v3 JS config, v4 CSS config, no-config fallback, arbitrary values, variant prefixes.
3. Search transcript: `css:margin-top`, `value:#1e2328`, `mechanism:inline`, `token:--color-primary` each returning correct rows against the fixture.
4. `code_map` `styles` section output for the fixture, showing the mechanism summary and a property histogram with the seeded outliers visible in the counts.
5. Rule-kind tests: `style-mechanism` and `no-raw-values` violation/non-violation fixtures, config-error cases, SARIF passthrough; hook-loop transcript per Spec 04 (`code-audit changed` on an edit adding an inline style under a tailwind-only `style-mechanism` rule → blocked with the rule message).
6. Scoped-run test: fixture edit introducing a drift color in one file → scoped run catches it using full-index statistics.
7. release commit sets the next minor version; tag `spec-10`. README gains a "Style intelligence" section (detectors, operators, the two rule kinds, one worked example) consistent with the Spec 09 tone constraints.

## Explicitly out of scope

- Less, Stylus, CSS Modules composition semantics, and Vue/Svelte single-file components. CSS Modules files still index as CSS; only their composition features are unmodeled.
- Autofix/codemod of findings — detection and enforcement only.
- Visual/computed-style analysis (cascade resolution, specificity conflicts, rendering). The index is source-level.
- Non-class selector usage analysis (element/attribute selectors are indexed as declarations but exempt from dead-CSS findings).
