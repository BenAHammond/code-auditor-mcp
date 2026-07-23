# Spec 11 — verify:close

**Date**: 2026-07-23
**Gate**: `verify:close` exits 0
**Branch**: `main`
**Tag**: `spec-11` (to be applied)

## verify:close output

```
> code-auditor-mcp@3.1.1 verify:close
> npm run test && npm run verify:dist

> vitest run
 Test Files  36 passed (36)
      Tests  529 passed (529)

> bash scripts/verify-dist.sh
PASS: code-audit changed runs end-to-end
PASS: web-tree-sitter loads
PASS: All WASM grammars present in dist/grammars/
========================================
  All distribution checks PASSED
========================================
```

## Bench harness

```
> npm run bench
══════════════════════════════════════════════
  Summary
══════════════════════════════════════════════
  Analyzers: 8
  Passed:    8
  Failed:    0
  Known misses: 3
  μPrecision: 1.0000
  μRecall:    1.0000
  μF1:        1.0000
  μTrueRecall: 0.9302
  μTrueF1:     0.9638

  Report: bench/results/latest.json
```

## Acceptance evidence checklist

| # | Requirement | Evidence | Status |
|---|-------------|----------|--------|
| 1 | `pnpm bench` green with committed baseline; harness tests green; full suite green | bench 8/8 passed; 529/529 tests; verify:close exits 0 | ✅ |
| 2 | Ledger populated across all four surfaces; D1 interim files imported | `findings_ledger_runs` and `findings_ledger_findings` tables in codeIndexDB schema; `writeAuditToLedger()` wired in `auditRunner.ts` (covers CLI, MCP, library, hook); `code-audit ledger` CLI subcommand with list/export/stats/import; no D1 interim directory exists (clean start) | ✅ |
| 3 | Sweep curves for every R3 parameter with chosen operating points; defaults diff | `bench/results/sweep-report.md` (13 parameters swept, 10 changed, 3 confirmed); defaults updated in `src/config/defaults.ts` with per-change comments | ✅ |
| 4 | Triage report with per-rule judged rates, sampling disclosures, benchmark-vs-reality gap analysis | `bench/results/triage-report.md` (691 findings, 16.4% effective precision, per-analyzer breakdowns); `bench/results/triage-classified.json` (691 classified with verdict + rationale) | ✅ |
| 5 | Recalibration table; message before/afters; README analyzers section rewritten | `bench/results/recalibration.md` (6 disabled, 3 promoted, guard rails documented); README deterministic vs advisory split; CHANGELOG Spec 11 section | ✅ |
| 6 | Non-English corpus inclusion (Spec 21 amendment) | `bench/corpus/non-english/` with mixed Portuguese/German/Japanese identifiers; 3 known-misses annotated in `expected.json` | ✅ |

## Per-rule recalibration summary

### Disabled (judged-true < 0.50)

| Rule | n | Precision | Judged-true | Rationale |
|------|---|-----------|-------------|-----------|
| `missing-org-filter` | 50 | 0.00 | 0.00 | Domain-specific (SaaS tenant isolation) |
| `unknown-table` | 50 | 0.00 | 0.00 | External SQL files by design |
| `sql-injection-risk` | 50 | 0.00 | 0.00 | Dogfooding artifact |
| `loop-query` | 40 | 0.00 | 0.00 | False positives dominate |
| `unfiltered-query` | 33 | 0.00 | 0.00 | False on production + TBU on tests |
| `direct-sql` | 18 | 0.00 | 0.00 | Test/bench fixture findings only |

### Promoted (precision ≥ 0.95, judged-true ≥ 0.90)

| Rule | n | Precision | Judged-true | Change |
|------|---|-----------|-------------|--------|
| `single-responsibility` | 50 | 0.98 | 0.98 | warning → **critical** |
| `solid/class-size` | 27 | 1.00 | 1.00 | suggestion → **warning** |
| `dependency-inversion` | 16 | 1.00 | 1.00 | suggestion → **warning** |

## Implementation artifacts

| Artifact | Location |
|----------|----------|
| Severity type extended (`'off'`) | `src/types.ts` |
| `severityOverrides` on `AuditConfig` | `src/types.ts` |
| Default recalibration values | `src/config/defaults.ts` — `getDefaultConfig().severityOverrides` |
| `'off'` filtering in base class | `src/languages/UniversalAnalyzer.ts` |
| Severity maps include `off: 0` | `src/analyzers/analyzerUtils.ts`, `src/reporting/htmlReportGenerator.ts`, `src/reporting/csvReportGenerator.ts` |
| Bench corpus (8 analyzers) | `bench/corpus/{data-access,documentation,dry,invariants,non-english,react,schema,solid}/` |
| Bench harness | `bench/runBench.ts` |
| Bench baseline | `bench/baselines/baseline.json` |
| Triage report | `bench/results/triage-report.md` |
| Sweep report | `bench/results/sweep-report.md` |
| Recalibration report | `bench/results/recalibration.md` |
| Findings ledger schema | `src/codeIndexDB.ts` (tables + clearIndex preservation) |
| Ledger wiring | `src/auditRunner.ts` |
| Ledger CLI | `src/cli.ts` (`code-audit ledger`) |
| Ledger library | `src/ledger.ts`, `src/ledger/` |
| README deterministic/advisory split | `README.md` |
| CHANGELOG Spec 11 section | `CHANGELOG.md` |
