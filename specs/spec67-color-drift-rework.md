# Spec 67 — Color-Drift Rework: pairwise perceptual drift, not scarcity

`styles/value-drift` flags **rare** colors, not **drifted** ones. The Spec 66
follow-up (#253) eliminated 1,057 length false findings by routing the rule to
colors only — but the color path it left behind still measures the wrong thing.
Its predicate is *scarcity*: "a color whose share of its property's color
declarations is under `outlierMaxShare` (5%) while a dominant value exists." A
color used once — however deliberately different from the dominant value — fires;
two near-identical colors used rarely never cluster with each other, because the
`colorDeltaE: 2.0` threshold is so tight only *exact* matches merge.

Sampling recall's 27 survivors bore this out: ~22 are deliberately-different
palette colors (`#4aecff` cyan, `#e0a13a` orange, `#e08a8a` red-pink, `#93c5fd`
blue, …), and only a handful are genuine near-duplicate pairs. The rule's name
says "drift"; its predicate measures rarity. This spec redefines it around its
name.

## Definition

**Drift is a pairwise property, not a relationship to a dominant value.** Two
colors that are perceptually near-identical and unequal are drift — somebody
typed `#06121a` where `#06131c` already existed. How often either appears is
irrelevant. A lone value, however rarely used, is not drift.

## Status

- **Landed (R1–R5).** The rework is implemented and the four corpora re-measured;
  `corpus-baselines.md` re-pins `styles::styles/value-drift` at the new drift
  count (see below).

## R1 — real ΔE via CIELAB

`deltaE` (`UniversalStylesAnalyzer.ts:256`) computes Euclidean RGB distance and
labels it "CIE76". Euclidean RGB is not perceptually uniform — a fixed step means
different visible differences at different lightness — and the label is a lie.
Replace it with CIELAB ΔE76, the standard:

1. sRGB → linear: `c = c/255; c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`
2. linear RGB → XYZ (D65): the standard 3×3 matrix
   (`0.4124564/0.3575761/0.1804375`, `0.2126729/0.7151522/0.0721750`,
   `0.0193339/0.1191920/0.9503041`).
3. XYZ → Lab (D65 white `Xn=0.95047, Yn=1.0, Zn=1.08883`), `f(t) = t > ε ?
   cbrt(t) : (κt + 16)/116` with `ε = 0.008856, κ = 903.3`.
4. ΔE76 = Euclidean distance in Lab.

~40 lines, no new dependencies. The `colorDeltaE` config key keeps its name — the
conversion is what makes the name true. Its *value* is re-pinned in R5.

## R2 — pairwise clustering, not dominant-value scarcity

Delete the dominant-cluster model and `outlierMaxShare`. The new predicate:

- Parse every color declaration (subject to R4) to Lab.
- Cluster **distinct values** by single-linkage at ΔE76 < `colorDeltaE` (an edge
  exists between two values iff they are perceptually near-identical).
- A cluster holding **≥ 2 distinct values** is drift. A cluster holding one
  distinct value (however many identical declarations) is **not**.

Scarcity plays no part. `outlierMaxShare` and the dominant-cluster
`modeMinCount` gate are removed from the config defaults, the interface, and
`detectColorDrift`/`flagColorDriftStragglers` (the latter is rewritten). The
greedy centroid loop in `clusterByDeltaE` is replaced by single-linkage connected
components — the centroid-of-first-item anchor can mis-partition a chain, and
"pairwise" is the defined semantics. `minCorpus` is **dropped** from the drift
predicate — not lowered. It was a statistical floor for a statistical predicate
(a histogram over a sample); the pairwise predicate is not statistical, and a
floor of 20 hides exactly the small-project drift that matters most: two
near-identical colors in a three-declaration file *is* drift. The removal is
scoped to drift: `off-scale` keeps a usage floor — a property with a handful of
declarations is not a meaningful population to judge against the design scale.
The named-floor observation: the other three structure detectors each carry a
*named* floor (`mechanismFragmentationMinMechanisms`, `zIndexMaxDistinct`,
`declarationSetMinDeclarations`), while drift and off-scale shared a generic
`minCorpus`. Once drift drops `minCorpus` entirely, that generic key serves only
off-scale, so its usage floor is renamed to the named key
**`offScaleMinDeclarations`** (default 20, unchanged) — a usage floor should be
named for what it floors, not for a shared histogram concept that no longer
exists. `mechanism-fragmentation`, `z-index-sprawl`, and
`declaration-set-similarity` never read `minCorpus` and are untouched.

## R3 — one finding per non-canonical member, naming the canonical

Within a drift cluster the most-used distinct value is **canonical** (tie-break:
lexicographically first, deterministic). Every *other* distinct value gets one
finding, anchored at that value's first occurrence (`file_path`, `line`) — the
developer's edit site and SARIF's anchor. A cluster of three values yields two
findings, because it needs two edits.

Message names the canonical, its count, and the distance:

> `Color drift in "{property}": "{value}" is near-identical to "{canonical}"
> (used {canonicalCount} time(s), ΔE = {d}). Consider using "{canonical}".`

`symbol` stays `declValueKey(decl)` — the non-canonical value's `property: value`
— so the fingerprint remains per-value and the ratchet can tell one drift from
another.

## R4 — keywords are not colors

`parseColorToRGB` (`:205`) currently maps `transparent → [0,0,0]`, which is why
recall's `background` cluster was dominated 25× by a keyword and every real color
was flagged against it. Return `null` for the keyword set —
`transparent`, `currentColor`, `inherit`, `initial`, `unset`, `none` — so those
declarations never enter clustering. Named colors (`red`, `white`, `black`,
`blue`, `green`) still parse; only the keyword-as-color mapping goes.

## R5 — threshold re-pinning, fixture re-authoring, baseline re-pin

`colorDeltaE` is re-pinned in Lab units. The current `2.0` is an RGB distance and
is meaningless in ΔE76. Measured ΔE76 for recall's candidate pairs:

| pair | ΔE76 | RGB (old) | verdict |
| --- | --- | --- | --- |
| `#06121a` ↔ `#06131c` | 1.06 | 2.24 | drift |
| `#5f7488` ↔ `#637688` | 1.59 | 4.47 | drift |
| `#cfe0ef` ↔ `#cfe2ee` | 1.82 | 2.24 | drift (surfaced only under Lab) |
| `#e0e8f0` ↔ `#f1f5f9` | 5.34 | 23.22 | not drift |
| `#0f172a` ↔ `#101b26` | 6.76 | 5.74 | distinct — correctly not drift under 2.5 |
| `#8395a6` ↔ `#637688` | 12.15 | 53.71 | not drift |
| `#4aecff` ↔ `#06131c` | 88.72 | 321.31 | deliberately different |

The genuine pairs land at 1.06–1.82; the nearest false at 5.34, so **2.5** sits
cleanly in the gap (JND-adjacent: ≤ 2.3 is "just noticeable"). The conversion is
not cosmetic: it keeps the two true pairs — one dark, one mid-slate — and
*surfaces* a light pair (`#cfe0ef`/`#cfe2ee`, 1.82) that the old RGB metric put at
2.24, just outside its own threshold, so a real light-palette drift was invisible
for reasons that had nothing to do with whether it was drift. It also confirms
the two `background` findings (`#0f172a`/`#101b26`, 6.76) are genuinely distinct
under 2.5 — they fired only because `transparent → [0,0,0]` made a keyword the
dominant color (R4), never because they were near-identical. The rework does not
set out to catch them.

The threshold is pinned by the **bench fixture, not by recall's palette**. That
palette is a single data point and the only one available: primer-css and hhra-org
route colors through `var(--…)` tokens, so they contribute nothing to calibration,
and 2.5 would otherwise rest on recall alone. The re-authored `bench/corpus/styles`
color-drift section encodes the boundary directly, with the two ΔE76 values
computed (not read off by eye):

- **must fire** — `#4e5568` ↔ `#4a5568` = **1.505** (< 2.5): both in
  `background-color`, `#4a5568` the more-used canonical, one finding naming it.
- **must not fire** — `#535568` ↔ `#4a5568` = **3.446** (> 2.5): the near-pair
  lives in `color`, a *separate* property, because `#4e5568` ↔ `#535568` = 1.941
  would otherwise chain the two near-pairs into one cluster under single-linkage
  (R2) and wrongly fire `#535568`.

The threshold is then defended by the bench gate, not by a corpus whose palette
can change under it — and if 2.5 ever moves, the fixture says exactly what broke.
The old `#111111` ×20 + `#ff0000` ×1 section is a scarcity case that produces 0
findings under R2 and is deleted; `outlierMaxShare` and `modeMinCount` no longer
exist in the fixture's `expected.json` `config`.

## Ledger / baseline / fixture impacts

- **`corpus-baselines.md`** — `styles::styles/value-drift` was **unpinned** (the
  recall `27` is a scarcity count, not a drift count); it is re-pinned at the new
  drift count after R1–R5 land and all four corpora are re-measured
  (recall/primer-css/hhra-org/blitz).
- **`rule-authenticity-ledger.md`** — the `styles/value-drift` row's mechanism
  recorded "greedy `clusterByDeltaE` (CIE76, `cfg.colorDeltaE` 2.0)"; that "CIE76"
  was the Euclidean-RGB mislabel R1 fixes, and the row's `[overclaim]` noted only
  the "token" misnomer, not the "drift = scarcity" one. Both are corrected at
  implementation: the post-rework row is `honest` with no overclaim — the
  predicate now measures exactly the named thing.
- **CHANGELOG.md** — a `value-drift` entry describing the rework lands with the
  implementation commit.

## Verification

- Unit: the Lab conversion reproduces known ΔE76 values (`#06121a`↔`#06131c`
  ≈ 1.06); keywords return `null`; a two-value near-duplicate cluster fires **one**
  finding (the non-canonical member) naming the canonical, a singleton cluster
  fires none, an identical-value cluster fires none.
- Bench: the re-authored styles fixture is green under the multiset comparator
  (`bench/verify.ts`), proving the *pairwise* predicate is what's pinned — the
  `#4e5568`↔`#4a5568` (1.505) pair fires and the `#535568`↔`#4a5568` (3.446) pair
  does not.
- Corpus: re-measure recall/primer-css/hhra-org/blitz fresh-index to confirm the
  rework's *behavior* — recall's genuine pairs fire and the deliberately-different
  palette colors drop out; the three tokenized-color corpora stay 0. This is a
  sanity check, not the threshold's defense — the boundary is pinned by the bench
  fixture above.
