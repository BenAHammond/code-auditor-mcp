# Spec 11 Implementation Plan — Analyzer Quality Evaluation

## State survey (pre-plan)

**Already done:**
- `src/ledger.ts` — `writeAuditToLedger()`, `exportLedger()`, `getLedgerStats()`, `listRuns()`, `importLedgerFromDir()`, `detectRunInput()`, `updateLedgerRunStatus()`
- `src/__tests__/ledger.test.ts` — 14 tests, all passing in isolation
- `src/scripts/runBench.ts` — full harness: corpus fixtures, expected.json, known-miss reconciliation, trueRecall/trueF1, `runSweep()`, precision-first op-point selection
- `bench/corpus/` — 8 fixture projects (data-access, documentation, dry, invariants, reactivity, schema, security, non-english), each with `expected.json` + source files
- `bench/baselines/baseline.json` — per-analyzer F1/precision/recall at schemaVersion=1
- `bench/corpus/non-english/` — Spec 21 amendment corpus with 3 annotated known-misses

**Not yet done — must build in this spec:**

| Gap | Category | Where |
|-----|----------|-------|
| Ledger tables not in schema init | R1 | `codeIndexDB.ts` ~line 95 (near `analyzer_results`) |
| clearIndex() doesn't preserve ledger | R1 | `codeIndexDB.ts` line 1439 |
| Ledger not wired to auditRunner | R1 | `auditRunner.ts` ~line 631 (after result) |
| No `code-audit ledger` CLI | R1 | `cli.ts` |
| D1 interim import — no-op | R1 | Chapter-close in CHANGELOG |
| Per-rule metrics in bench harness | R2 | `runBench.ts` `runCorpus()` |
| Per-rule baseline rows | R2 | `baseline.json` |
| `pnpm bench` script | R2 | `package.json` |
| Sweep parameter completion | R3 | `runBench.ts` sweep definitions |
| External corpus triage | R4 | Manual — scoped below |
| Recalibration table | R5 | Mechanical from R2+R3+R4 data |
| Message rewrite (action-naming) | R5 | Every analyzer message |
| README deterministic vs advisory | R6 | `README.md` |
| Ledger schemaVersion bump + migration | R1 | `codeIndexDB.ts` |

---

## R1 — Findings Ledger (Wire to all surfaces)

### 1.1 Schema: Add ledger tables to codeIndexDB

Add two CREATE TABLE statements near the `analyzer_results` table (around line 95):

```sql
CREATE TABLE IF NOT EXISTS findings_ledger_runs (
  run_id TEXT PRIMARY KEY,
  git_sha TEXT,
  git_dirty INTEGER NOT NULL DEFAULT 0,
  tool_version TEXT NOT NULL,
  command TEXT NOT NULL,
  surface TEXT NOT NULL CHECK(surface IN ('cli','mcp','library','hook')),
  scope TEXT NOT NULL DEFAULT 'full',
  target TEXT NOT NULL DEFAULT '.',
  violation_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  exit_status INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  metadata_json TEXT DEFAULT '{}',
  is_full_sync INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS findings_ledger_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES findings_ledger_runs(run_id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  analyzer TEXT NOT NULL,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER,
  symbol TEXT,
  message TEXT,
  suggestion TEXT,
  metadata_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ledger_findings_run ON findings_ledger_findings(run_id);
CREATE INDEX IF NOT EXISTS idx_ledger_findings_fp ON findings_ledger_findings(fingerprint);
CREATE INDEX IF NOT EXISTS idx_ledger_findings_analyzer ON findings_ledger_findings(analyzer, rule);
CREATE INDEX IF NOT EXISTS idx_ledger_runs_started ON findings_ledger_runs(started_at);
```

These match exactly what `ledger.ts`'s `ensureLedgerTables()` expects.

### 1.2 clearIndex() preservation

Add `findings_ledger_runs` and `findings_ledger_findings` to the preserved-table set in `clearIndex()` (line 1439). Currently preserved: `project_tasks`, `analyzer_configs`, `whitelist`. Add the two ledger tables.

### 1.3 Wire into auditRunner

In `createAuditRunner()`, after the `AuditResult` is constructed (~line 631), call `writeAuditToLedger()`:

```typescript
// After result construction, before return
try {
  writeAuditToLedger(db, {
    gitSha: options.gitSha ?? '',
    gitDirty: options.gitDirty ?? false,
    toolVersion: getVersion(),
    command: process.argv.slice(2).join(' '),
    surface: options.surface ?? 'cli',
    scope: scope ?? 'full',
    target: projectRoot,
  }, result.analyzerResults.flatMap(ar => ar.violations), durationMs, exitStatus);
} catch (err) {
  // Ledger write is non-fatal — audit result still valid
}
```

This covers all four surfaces because `auditRunner` is the single audit execution path:
- **CLI**: `cli.ts` → `createAuditRunner()` → ledger written
- **MCP**: `mcp.ts` → `createAuditRunner()` → ledger written
- **Library**: `index.ts` → `createAuditRunner()` → ledger written
- **Hook**: `cli.ts changed` → `createAuditRunner()` → ledger written

### 1.4 CLI subcommand

Add `code-audit ledger` with subcommands:

```
code-audit ledger list [--limit N] [--json]    → listRuns()
code-audit ledger export [--since ISO] [--json] → exportLedger()
code-audit ledger stats [--json]                → getLedgerStats()
code-audit ledger import --dir <path>           → importLedgerFromDir()
```

### 1.5 D1 interim import

No `bench/ledger-interim/` directory exists. Add a note in implementation: if D1 was the prior persistence surface, this chapter closes clean — the new ledger starts fresh from this version. Document in CHANGELOG that D1 migration path is `code-audit ledger export --json > audit-history.json` on old version → `code-audit ledger import --dir` on new version.

---

## R2 — Benchmark Corpus and Harness (per-rule)

### 2.1 Per-rule metrics in runBench.ts

Currently `runCorpus()` returns `AnalyzerMetrics` with per-analyzer aggregates. Extend to compute per-rule:

```typescript
interface RuleMetrics {
  rule: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  knownMisses: number;     // annotated on this rule
  recoveredMisses: number; // known-misses that DID fire
  trueRecall: number;      // recall including known-misses in denominator
  trueF1: number;          // F1 using trueRecall
}
```

Add `ruleMetrics: RuleMetrics[]` to `AnalyzerMetrics`. Compute in `runCorpus()` by grouping matched/unmatched violations by rule.

### 2.2 Baseline schemaVersion bump and per-rule rows

Bump `baseline.json` `schemaVersion` from 1 to 2. Add `rules` object per analyzer:

```json
{
  "schemaVersion": 2,
  "analyzers": {
    "data-access": {
      "f1": 1.0, "precision": 1.0, "recall": 1.0,
      "rules": {
        "loop-query": { "f1": 1.0, "precision": 1.0, "recall": 1.0 },
        "missing-org-filter": { "f1": 1.0, "precision": 1.0, "recall": 1.0 },
        ...
      }
    },
    ...
  }
}
```

### 2.3 Baseline comparison at per-rule level

Extend the regression gate in `runBench.ts` to compare per-rule metrics against baseline. If a rule drops below baseline F1, the gate fails with a specific message naming the rule and the delta.

### 2.4 `pnpm bench` script

Add to `package.json` `scripts`:

```json
"bench": "node dist/scripts/runBench.js"
```

Ensure `runBench.ts` compiles to `dist/scripts/runBench.js` (already in tsconfig outDir path).

### 2.5 Commit per-rule baseline

After computing with the full corpus, commit `bench/baselines/baseline.json` at the new schemaVersion with all per-rule metrics.

---

## R3 — Empirical Threshold Tuning

### 3.1 Complete sweep parameter definitions

Current `runSweep()` already sweeps DRY similarity and a few others. Extend to cover all sweepable parameters:

| Analyzer | Parameter | Range | Step |
|----------|-----------|-------|------|
| DRY | minSimilarity | 0.50–0.95 | 0.05 |
| DRY | minBlockSize | 3–15 | 1 |
| method-complexity | maxCyclomaticComplexity | 5–30 | 5 |
| method-complexity | maxLinesPerFunction | 30–200 | 20 |
| documentation | requireJsDoc (all exported) | true/false | — |
| style/project | styleThreshold (default-disabled) | N/A | — |

### 3.2 Precision-first operating point selection

For each parameter, sweep across all corpora. The operating point is the tightest threshold where precision ≥ 0.95. Output a recommendation table.

### 3.3 Update default config values

After sweep, update `src/config/defaults.ts` with the recommended thresholds. Each change gets a CHANGELOG entry with the before/after value and the precision improvement.

---

## R4 — Real-Corpus Triage

### 4.1 Scope

Three external corpora specified in the spec:
1. **code-auditor self-audit** — audit `app/` itself (~6,059 findings, already baselined per tasks #88)
2. **excalidraw** — OSS whiteboard app (~1,747 findings, already triaged per tasks #85)
3. **gin** — Go web framework (~204 findings, already triaged per tasks #86)

The triage has already been done (tasks #86-#88 completed). The corpora need to be:
- Fetched/checked out if not already in `bench/corpus/external/`
- Re-audited with current defaults
- Findings triaged for judged-true/judged-false
- Results fed into R5 recalibration

### 4.2 Verification check

Re-run audit on each external corpus. If the prior triage (tasks #86-#88) was less than 30 days ago and the analyzer code hasn't changed, the prior judged-true rates stand. Otherwise, re-triage.

### 4.3 Storage

Store a summary JSON per external corpus in `bench/corpus/external/<name>/triage.json`:
```json
{
  "corpus": "excalidraw",
  "triagedAt": "2026-07-20",
  "totalFindings": 1747,
  "judgedTrue": 287,
  "judgedFalse": 1460,
  "byAnalyzer": {
    "data-access": { "findings": 120, "judgedTrue": 15, "judgedFalse": 105 },
    ...
  }
}
```

---

## R5 — Mechanical Recalibration

### 5.1 Rules

Per the goal's binding modifiers:

| Condition | Action |
|-----------|--------|
| precision ≥ 0.95 AND judged-true ≥ 0.90 | Severity → `critical` |
| judged-true < 0.50 | Rule → `disabled` by default |
| Between (precision ≥ 0.70, judged-true ≥ 0.50) | Severity → `warning` |
| Below precision 0.70 | Severity → `suggestion` |

This is a **mechanical** mapping — no judgment calls. Compute from R2 per-rule metrics + R4 judged-true rates, apply the rules, produce a recalibration table.

### 5.2 Recalibration table

Produce a markdown table:

| Analyzer | Rule | Precision | Judged-True | Old Severity | New Severity | Reason |
|----------|------|-----------|-------------|--------------|--------------|--------|
| ... | ... | ... | ... | ... | ... | ... |

Rules with no external-corpus data use per-corpus precision only.

### 5.3 Message rewrite

Every analyzer violation message must name the action. Current examples of bad messages:
- `"N+1 query detected"` → `"Extract query outside loop to avoid N+1 queries"`
- `"Missing org filter"` → `"Add org_id filter to query"`
- `"Function is too complex"` → `"Split function into smaller units"`

Rewrite all analyzer messages to imperative action form.

### 5.4 Apply recalibration

Update `src/config/defaults.ts` severities and disabled flags per the recalibration table. Add a "Recalibration" section to CHANGELOG with the full before/after table.

---

## R6 — Honest Documentation

### 6.1 README analyzer section

Split the analyzer table into two groups:

**Deterministic (invariants, schema):**
| Analyzer | What it catches | Confidence |
|----------|----------------|------------|
| invariants | Project-specific architecture rules from `.codeauditor.json` | 100% — rules are laws |
| schema | Missing schemas, unfiltered queries | High — SQL grammar is unambiguous |

**Advisory (heuristic analyzers):**
| Analyzer | What it catches | Precision | Known gaps |
|----------|----------------|-----------|------------|
| data-access | N+1 queries, missing org filters, direct SQL | 1.00 | Non-English receivers without imports |
| security | Missing auth, missing sanitization | — | P1 non-English auth/sanitization known-misses |
| DRY | Structural clones, repeated blocks | 1.00 | — |
| ... | ... | ... | ... |

Include trueRecall/trueF1 where available, and enumerate known-misses from the non-English corpus.

### 6.2 GROUND-TRUTH.md update

Add Spec 11 section documenting the recalibration-driven severity tiers, the bench corpus law (§7), and the known-miss mechanism as first-class debt tracking.

---

## Implementation order

1. **R1 — Ledger wiring** (codeIndexDB schema, clearIndex, auditRunner, CLI)
2. **R2 — Per-rule metrics** (runBench, baseline, `pnpm bench`)
3. **R3 — Sweep completion** (parameter ranges, operating points)
4. **R4 — External corpus** (re-audit, triage summary)
5. **R5 — Recalibration** (mechanical table, message rewrite, defaults update)
6. **R6 — README + docs** (analyzer table split, GROUND-TRUTH.md)

---

## Files modified

| File | Change |
|------|--------|
| `src/codeIndexDB.ts` | Add ledger CREATE TABLE statements; add to clearIndex() preserved set |
| `src/auditRunner.ts` | Wire writeAuditToLedger() after result construction |
| `src/cli.ts` | Add `ledger` subcommand with list/export/stats/import |
| `src/scripts/runBench.ts` | Add per-rule metrics, per-rule baseline comparison |
| `bench/baselines/baseline.json` | schemaVersion=2, per-rule rows |
| `package.json` | Add `bench` script |
| `src/config/defaults.ts` | Recalibrated severities, disabled flags |
| `src/analyzers/*.ts` | Message rewrite — action-naming |
| `README.md` | Analyzer table split (deterministic vs advisory) |
| `GROUND-TRUTH.md` | Spec 11 section (recalibration, bench law, known-miss mechanism) |
| `CHANGELOG.md` | Spec 11 section with recalibration table |

---

## Verification gates

1. `npm run test` — all existing + ledger schema tests pass
2. `npm run bench` — per-rule metrics output, regression gate passes
3. `node dist/cli.js audit -p .` — audit runs, ledger written
4. `node dist/cli.js ledger list --json` — run visible
5. `node dist/cli.js ledger stats --json` — stats aggregate correctly
6. `node dist/cli.js ledger export --json` — full export works
7. `npm run verify:close` — 529 tests + dist check pass
8. `code-audit changed --json --fail-on critical` — hook path still works

---

## Self-review against Spec 11 requirements

| Requirement | Covered? | How |
|-------------|----------|-----|
| R1: Findings ledger — SQLite tables | Yes | §1.1 — CREATE TABLE in codeIndexDB schema |
| R1: Ledger survives clearIndex | Yes | §1.2 — add to preserved set |
| R1: All surfaces write (CLI, MCP, library, hook) | Yes | §1.3 — single auditRunner wiring covers all four |
| R1: CLI subcommands (list, export, stats, import) | Yes | §1.4 |
| R1: D1 import path | Yes | §1.5 — chapter-close documentation |
| R2: Per-rule precision/recall/F1 | Yes | §2.1 |
| R2: Baseline regression at per-rule level | Yes | §2.2–2.3 |
| R2: `pnpm bench` script | Yes | §2.4 |
| R3: Empirical threshold sweeps | Yes | §3 — all sweepable parameters, precision-first op-point |
| R3: Defaults update from sweep results | Yes | §3.3 |
| R4: Real-corpus triage (3 repos) | Yes | §4 — re-audit + judged-true rates |
| R4: Triage storage | Yes | §4.3 — triage.json per corpus |
| R5: Mechanical recalibration rules | Yes | §5.1 — precision+judged-true → severity |
| R5: Recalibration table in CHANGELOG | Yes | §5.2–5.4 |
| R5: Message rewrite (action-naming) | Yes | §5.3 |
| R6: README deterministic vs advisory split | Yes | §6.1 |
| R6: Known-miss enumeration | Yes | §6.1 advisory table |
| Spec 21 amendment: non-English corpus | Yes | Already exists from Spec 21 close-out |
| Non-English gap is release-blocking | Yes | Known-misses reduce trueF1; baseline gate fails |
| Ground-truth law §7 | Yes | §6.2 — documented in GROUND-TRUTH.md |
| trueRecall/trueF1 first-class | Yes | Already in harness, documented in §6.1 |
| Invariants always block | Yes | Not affected — invariants exempt from severity recalibration |
| Provenance primary, names fallback | Yes | Already implemented in Spec 21 |

**All R1–R6 requirements are addressed. No gaps.**

---

## Estimated effort

- R1: ~2 hours (schema + wiring + CLI — mostly plumbing)
- R2: ~1.5 hours (per-rule metrics + baseline + script)
- R3: ~1 hour (sweep completion + defaults update)
- R4: ~2 hours (re-audit 3 corpora + triage)
- R5: ~2 hours (recalibration table + message rewrite across all analyzers)
- R6: ~1 hour (README + docs)

**Total: ~9.5 hours**
