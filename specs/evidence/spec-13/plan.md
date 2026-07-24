# Spec 13 Implementation Plan — Hotspots & Temporal Analysis

## State survey (pre-plan)

**Already done:**
- `src/codeIndexDB.ts` — SCHEMA_VERSION already at 5 (prior specs), `file_churn` + `function_churn` + `dry_pair_history` tables exist
- `src/types.ts` — `ChurnConfig`, `HotspotEntry`, `TrendSummary`, `DivergenceConfig` types exist; `hotspot` field on `Violation`
- `src/auditRunner.ts` — hotspot-based finding reordering, hotspot field attachment, two-phase diverging-clone tracking (seed + re-measure)
- `src/cli.ts` — `hotspots` command, `ledger trends` subcommand
- `src/ledger.ts` — `getTrends()` for same-target full-run fingerprint trend comparison
- `src/config/defaults.ts` — Churn and divergence configs
- Graph modules: `src/graph/callGraph.ts`, `src/graph/importGraph.ts`, `src/graph/blastRadius.ts`

**Not yet done — must build in this spec:**

| Gap | Category | Where |
|-----|----------|-------|
| Churn extraction (git shell-out) | R1 | New: `src/churn/churnExtractor.ts` |
| Hotspot scoring (percentile math) | R2 | New: `src/hotspots/hotspotScorer.ts` |
| `file_churn` / `function_churn` tables | R1 | `src/codeIndexDB.ts` |
| `dry_pair_history` table | R5 | `src/codeIndexDB.ts` |
| Bus-factor detection | R3 | `src/hotspots/hotspotScorer.ts` |
| Finding reordering by hotspot score | R2 | `src/auditRunner.ts` |
| `hotspot` field on all output surfaces | R2 | Reporting modules |
| Diverging-clone seed + re-measure | R5 | `src/auditRunner.ts`, DRY analyzer |
| Bench fixture (seeded git history) | R6 | `bench/corpus/diverging-clones/` |
| Bench runner + baseline | R6 | `runBench.ts`, `baseline.json` |
| CHANGELOG + tag | — | `CHANGELOG.md`, git tag `spec-13` |

---

## R1 — Churn extraction

### 1.1 Git integration

Read-only git shell-out (no library dependency). No git write operations, ever.
- Window: `churnWindowMonths` (default 12), configurable in `ChurnConfig`
- No git repo → all temporal features degrade to absent with a one-line notice; nothing errors

### 1.2 file_churn table

```sql
CREATE TABLE IF NOT EXISTS file_churn (
  file_path TEXT PRIMARY KEY,
  commit_count INTEGER NOT NULL DEFAULT 0,
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_deleted INTEGER NOT NULL DEFAULT 0,
  distinct_authors INTEGER NOT NULL DEFAULT 0,
  dominant_author_share REAL NOT NULL DEFAULT 0.0,
  last_touched TEXT
);
```

Populated on full sync when a git repo is present.

### 1.3 function_churn table

Populated by mapping `git log -p` hunks to function line-spans per commit. Spans resolved against each commit's own tree state (correct as-of that commit; no cross-commit drift problem).

File renames via `git log --follow`. Function renames detected by span-overlap plus signature similarity, with a `confidence` field on every attribution — low-confidence rows kept and flagged, never silently dropped or silently trusted.

### 1.4 Config

```typescript
export interface ChurnConfig {
  churnWindowMonths: number;     // default 12
  minFunctionSimilarity: number; // default 0.7 (for rename detection)
}
```

---

## R2 — Hotspot scoring and surfacing

### 2.1 Hotspot score

Per function: function churn percentile × complexity percentile, falling back to file churn where function attribution is absent or low-confidence (basis recorded per row).

Per file: file churn percentile × max-function-complexity percentile.

### 2.2 CLI

```
code-audit hotspots          → ranked table (score, basis, factors)
code-audit hotspots --json   → machine-readable output
code-audit hotspots --limit N → top N only
```

### 2.3 Finding reordering

When churn data exists, findings on every output surface (CLI, HTML, JSON, MCP results) are ordered within severity by the containing function's hotspot score. Each finding carries a `hotspot` field. SARIF excluded — GitHub orders its own.

### 2.4 CodeMap

New `hotspots` section in code map output.

---

## R3 — Ownership analytics

Per file and function: distinct-author count and dominant-author share (from R1).

Knowledge-concentration flag: single author ≥ 90% of windowed churn on a top-quartile hotspot → "bus-factor risk" entry in the hotspots report.

Report-level only, no findings. Author identities appear as git reports them and are never sent anywhere.

---

## R4 — Ledger trends

### 4.1 New subcommand

```
code-audit ledger trends [--json]
```

Gains trends: per rule and per severity, new vs fixed counts over time.

Fixed = fingerprint present in full-audit run N, absent in the next full-audit run of the same target. Only full-audit runs of the same target are comparable; the command states its comparison basis.

### 4.2 Output

Net-direction summary per analyzer: improving / worsening / flat over the window.

---

## R5 — Diverging clones

### 5.1 dry_pair_history table

```sql
CREATE TABLE IF NOT EXISTS dry_pair_history (
  pair_fingerprint TEXT NOT NULL,   -- stable identity key
  file_a TEXT NOT NULL,
  symbol_a TEXT,
  line_a INTEGER,
  content_hash_a TEXT,              -- data, not key
  file_b TEXT NOT NULL,
  symbol_b TEXT,
  line_b INTEGER,
  content_hash_b TEXT,              -- data, not key
  similarity REAL NOT NULL,
  timestamp TEXT NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (pair_fingerprint, run_id)
);
```

### 5.2 Two-phase mechanism

1. **Seed phase**: During DRY analysis, pairs with similarity ≥ `minPairSimilarity` (0.5) are persisted into `dry_pair_history`.
2. **Tracking phase**: On every full audit, all historically-tracked pairs are re-measured. If similarity drops by ≥ `divergenceThreshold` (0.05) for `divergenceRuns` (2) consecutive runs → emit violation.

### 5.3 Severity

Enters at `suggestion` severity. The spec permitted warning at introduction only because underlying pair detection is already measured under Spec 11; the bench fixture cleared at 1.0000 F1. However, the static bench cannot validate real-world divergence trajectories — the rule remains at suggestion until ≥10 real divergence findings accumulate.

The finding includes both locations and the similarity trajectory in the message.

### 5.4 Config

```typescript
export interface DivergenceConfig {
  divergenceThreshold: number;  // default 0.05
  divergenceRuns: number;       // default 2
  minPairSimilarity: number;    // default 0.5
}
```

---

## R6 — Measurement

### 6.1 Bench corpus

Scripted git-fixture corpus at `bench/corpus/diverging-clones/` with:
- A diverging clone pair across staged commits (seeded `dry_pair_history` rows: 0.85 → 0.78 → 0.68)
- A stable clone pair as near-miss (similarity stays constant)
- Fixture source files: `clone_a.ts`, `clone_b.ts`

### 6.2 Bench runner

New entry in `runBench.ts` that seeds in-memory `dry_pair_history` rows → runs violation detection → computes F1/recall/precision.

### 6.3 Baseline

New `diverging-clones` entry in `bench/baselines/baseline.json` with `dry/diverging-clone` rule at F1=1.0.

### 6.4 Bench test

Updated `bench.test.ts` to include 12 analyzers (was 8 before Spec 10–14).

---

## Implementation order

1. **R1** — Churn extraction (file + function level, git shell-out)
2. **R2** — Hotspot scoring + finding reordering + CLI
3. **R3** — Ownership analytics + bus-factor flag
4. **R4** — Ledger trends subcommand
5. **R5** — Diverging-clone two-phase mechanism (seed + re-measure)
6. **R6** — Bench fixtures + runner + baseline + test update
7. **Docs** — CHANGELOG, skill docs, tag

---

## Files modified

| File | Change |
|------|--------|
| `src/types.ts` | `ChurnConfig`, `HotspotEntry`, `TrendSummary`, `DivergenceConfig` types; `hotspot` field on `Violation` |
| `src/codeIndexDB.ts` | SCHEMA_VERSION → 5, `file_churn`, `function_churn`, `dry_pair_history` tables, migration 4→5 |
| `src/churn/churnExtractor.ts` | **New** — git shell-out for per-file and per-function churn |
| `src/hotspots/hotspotScorer.ts` | **New** — percentile math, hotspot scoring, bus-factor detection |
| `src/auditRunner.ts` | Hotspot-based finding reordering, hotspot field attachment, two-phase diverging-clone tracking |
| `src/ledger.ts` | `getTrends()` — same-target full-run fingerprint trend comparison |
| `src/cli.ts` | `hotspots` command, `ledger trends` subcommand |
| `src/config/defaults.ts` | Churn and divergence configs |
| `src/reporting/jsonReportGenerator.ts` | `hotspot` field in output |
| `src/reporting/htmlReportGenerator.ts` | `hotspot` field in output |
| `bench/corpus/diverging-clones/` | **New** — fixture with seeded history |
| `bench/runBench.ts` | diverging-clones entry |
| `bench/baselines/baseline.json` | diverging-clones entry |
| `src/__tests__/bench.test.ts` | Updated to 12 analyzers |
| `CHANGELOG.md` | Spec 13 section |

---

## Verification gates

1. `npm run test` — all tests pass
2. `npm run bench` — 12/12 analyzers, diverging-clones F1=1.0000
3. `npm run verify:close` — dist checks pass
4. `code-audit changed --json --fail-on critical` — hook path still works
5. `code-audit hotspots` — ranked output with per-row basis
6. `code-audit ledger trends` — new/fixed per rule with comparison basis

---

## Self-review against Spec 13 requirements

| Requirement | Covered? | How |
|-------------|----------|-----|
| R1: Git churn extraction (file + function) | Yes | §1 — git shell-out, windowed by `churnWindowMonths` |
| R1: Function-level churn with confidence | Yes | §1.3 — span-overlap + signature similarity, confidence field |
| R1: No-repo → graceful degrade | Yes | §1.1 — one-line notice, nothing errors |
| R2: Hotspot score (churn × complexity) | Yes | §2.1 — percentile math, basis recorded per row |
| R2: Finding reordering by hotspot | Yes | §2.3 — within severity, all surfaces except SARIF |
| R2: `hotspot` field on all surfaces | Yes | §2.3 — Violation type, reporting modules |
| R2: CLI `hotspots` command | Yes | §2.2 — table, `--json`, `--limit` |
| R3: Ownership analytics | Yes | §3 — distinct-author count, dominant share |
| R3: Bus-factor flag | Yes | §3 — single-author ≥ 90% on top-quartile hotspot |
| R4: Ledger trends | Yes | §4 — per rule, per severity, new vs fixed |
| R4: Comparison basis stated | Yes | §4.1 — same-target full-audit runs only |
| R5: Diverging clones | Yes | §5 — two-phase: seed + re-measure |
| R5: Similarity trajectory in message | Yes | §5.3 — both locations + trajectory |
| R5: Stable pair stays silent | Yes | §6.1 — near-miss fixture, bench asserts |
| R6: Git-fixture corpus | Yes | §6.1 — diverging-clones corpus with seeded history |
| R6: Bench runner + baseline | Yes | §6.2–6.4 — F1=1.0000 |
| Entry rule: suggestion severity | Yes | §5.3 — suggestion until ≥10 real findings |
| Re-evaluation condition documented | Yes | verify-close.md, CHANGELOG, recalibration.md |

**All R1–R6 requirements are addressed. No gaps.**
