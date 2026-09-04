# Spec 42 — Corrective: Build the Support, Don't Enumerate the Gaps

Deliverable: working stylesheet-dialect support (R1) and two applicability
predicates (R2, R3).

## R1 — Read stylesheets wherever they live

The extractor now reads `<style>` blocks from `.astro`, `.vue`, and `.svelte`
(and `.html`), reads the `lang`/`type` attribute, pads the block body to preserve
source line numbers, and feeds the text to `extractRuleSets` — the same
regex-based rule-set parser the `.scss` path uses. There is no separate SCSS
parser and no per-dialect CSS parser: the `mechanism` field (`css` / `scss` /
`css-in-js` / `tailwind` / `inline`) is a label on the output, not a code path.

Dialects that now extract:

- `.astro` `<style>`, `.vue` `<style>` / `<style scoped>` / `<style module>`,
  `.svelte` `<style>` (including `:global(.foo)`) → `css`
- `<style lang="scss">` in any wrapper → `scss`
- `.module.css` / `.module.scss` → read as `.css` / `.scss` by extension
- styled-components / emotion tagged templates (`styled.x\`…\``, `css\`…\``) →
  `css-in-js`

Receipt: `section-divider-tight` and `kit-cite` are defined in `.astro`
`:global()` blocks that R1 now reads, so the false positives at
`BuildReviewsPanel.tsx:89`, `HeroInfoSection.tsx:72`,
`HeroPatchHistorySection.tsx:105`, and `duo-articles.ts:311` are gone.

### undefined-class on recall: 47, reconciled

The recall `styles/undefined-class` count is **47**, not the 34 that the pre-fix
38 (minus four removed) predicted. Net +9 decomposes into two opposing moves:

- **−4** — the receipt above: `section-divider-tight` (×3) and `kit-cite` (×1)
  were false positives whose `.astro` `:global()` definitions R1 now reads.
- **+13** — `.astro` was absent from the `extractDeclarations` extension switch
  before this change (`default: return []`), so `.astro` class *usages* were
  never scanned. R1 adds `.astro` to the HTML/Vue/Svelte case, and 13
  genuinely-undefined classes in `.astro` files now report for the first time.

All 13 are genuinely undefined, not extraction misses: none has a matching
`.classname` definition anywhere in the tree (`grep -rnE "\.<name>\b" src/`
returns only `class=` usages). The recurring names — `bg-surface-elevated`,
`hover:bg-surface-elevated/50`, `via-surface-elevated`, `duo-article-body`,
`tab-btn`, `retry-btn`, `fp-footer__col`, `magazine-duo-headline-link`,
`magazine-lead-headline-link`, `magazine-section-divider` — are dead class hooks
or Tailwind theme colors with no rule in the read sources. `duo-article-body`
and `bg-surface-elevated` are also flagged in `.tsx` files, so the `.astro`
findings are the same dead classes surfacing in the newly-audited file type,
not a parser regression. (e.g. `fp-footer__col` is used in markup but only
`.fp-footer__cols` / `.fp-footer__colhead` are defined — a real dead hook.)

**38 − 4 + 13 = 47.** The four receipt false positives are gone; the nine-count
rise is the newly-audited `.astro` surface, correct behavior.

## R2 — Never assert undefined when styles were unread

Unread stylesheet sources (`.sass` / `.less` / `.styl` files, and `<style lang="…">`
blocks with an unsupported dialect) are recorded to `style_unread_sources` with a
reason. When any exist, `styles/undefined-class` reports `notApplicable` for the
whole run, naming them.

Forced-failure transcript — fixture with `src/theme.sass` and an `src/App.tsx`
using `className="theme-card"` (defined only in the unread `.sass`):

```
styles/undefined-class coverage:
  { "state": "notApplicable", "count": 0,
    "reason": "stylesheets were not read: /tmp/ca-spec42-r2/src/theme.sass" }
styles violations: 0
```

The rule declines to assert rather than flag a class it cannot see. The unread
sources surface in the coverage `reason` field.

## R3 — missing-org-filter derives its own applicability

No config flag. The predicate checks, in order: Tier 1 (`orgFilterTables` named),
Tier 2 (a configured schema column matching the tenant-column names,
case-insensitive, honoring `orgFilterColumns`), Tier 3 (the DDL-derived table
catalog). No tenant-scoping column anywhere → `notApplicable` with reason
`"no tenant-scoping column found in table catalog"`, emitting nothing.

Receipt: on recall and on knex the rule reports `notApplicable`. The knex
baseline drops 434 → 415, i.e. 19 false positives removed — knex has no
tenant-scoped table, so the rule was previously flagging queries that cannot be
org-filtered.

## Baselines

- primer/css — exact (17).
- blitz — 914 vs 917: the −3 is entirely `invariants` (3 → 0). The live checkout
  `/Users/ben/playground/blitz` has **no** `.codeauditor.json`, so the
  reconstructed 3-rule config (import-ban ×2 + call-constraint ×1, proven correct
  earlier by matching every non-solid/non-documentation analyzer exactly) is
  absent from this cold run — its only carrier was the frozen corpus copy
  `/tmp/corpus-sources/blitz`, now deleted. The config was not wrong; the run
  simply has no config file to read, so `invariants = 0`. Every non-invariant
  analyzer matches the 917 baseline exactly (solid 112, data-access 63, react 87,
  documentation 465, styles 176, schema 4, schema-code 4, conventions 3).
  Measurement artifact — a missing config file in the live tree — not code drift.
- knex — 415 vs 434: the −19 is fully attributed to R3 (above).

The genuinely-dead class hooks on recall still report — `styles/undefined-class`
remains `fired` there (all recall stylesheets are readable), so R2 does not
suppress real findings.

## Verification

- `npx tsc --noEmit` → exit 0
- `npm test` → 69 files / 1061 tests pass
- `npm run test:integration` → 10 files / 281 tests pass

Fixtures: `src/analyzers/universal/UniversalStylesAnalyzer.spec.ts` ("Spec 42 R1 —
dialect stylesheets", six inline fixtures) and `src/analyzers/applicability.spec.ts`
(eleven predicate cases).
