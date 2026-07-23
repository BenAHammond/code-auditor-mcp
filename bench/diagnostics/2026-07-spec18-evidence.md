# Spec-18 Acceptance Evidence

**Spec:** Spec-18 — Baseline, Ratchet & Report Inversion
**Date:** 2026-07-21
**Test file:** `src/__tests__/baseline.test.ts` — 33 tests, all passing

---

## Evidence Summary

### R1 — The Baseline (`src/baseline.ts`)

| Requirement | Test | Status |
|------------|------|--------|
| loadBaseline returns null when no file exists | "loadBaseline returns null when no file exists" | PASS |
| Invalid JSON → null | "loadBaseline returns null for invalid JSON" | PASS |
| Wrong schemaVersion → null | "loadBaseline returns null for wrong schemaVersion" | PASS |
| Save + load round-trip | "saveBaseline / loadBaseline round-trip" | PASS |
| Invariant violations excluded from baseline | "createBaselineFromFindings excludes invariant violations" | PASS |
| Dedup by fingerprint | "createBaselineFromFindings deduplicates by fingerprint" | PASS |
| Fingerprint stability under line drift | "R6.6 — fingerprint unchanged by line drift" | PASS |
| Symbol extraction stability across entity fields | "R6.6 — extractSymbol produces stable output" | PASS |
| Hash deterministic | "hashBaseline produces stable, deterministic output" | PASS |

### R2 — Match & Classify

| Requirement | Test | Status |
|------------|------|--------|
| Known violation → classified as "known" | "R6.1 — matchFindings classifies a known violation as 'known'" | PASS |
| Unknown violation → classified as "new" | "R6.2 — matchFindings classifies an unknown violation as 'new'" | PASS |
| Invariants always "new" regardless of baseline | "R6.3 — invariant violations are always 'new'" | PASS |
| Fixed findings reported | "R6.4 — diffBaselines reports findings that were fixed" | PASS |
| Absorbed findings reported | "R6.4 — diffBaselines reports absorbed findings" | PASS |
| Scoped files correctly limits "fixed" | "R6.5 — matchFindings with scopedFiles correctly limits 'fixed'" | PASS |
| Full audit includes all entries in "fixed" | "R6.5 — full audit (no scopedFiles) includes all baseline entries in fixed" | PASS |
| Baseline resolved from project root (not cwd) | "R6.7 — loadBaseline uses the given projectRoot, independent of cwd" | PASS |
| Regression detection (debt increase) | "R6.8 — total debt exceeding baseline.totalFindings is regression" | PASS |
| No regression when debt same/lower | "R6.8 — total debt not exceeding baseline is not regression" | PASS |

### R3 — Audit Pipeline Integration

| Requirement | Test | Status |
|------------|------|--------|
| Known finding in baseline → not reported as new | "R6.1 — known finding in baseline is not reported as new" | PASS |
| New finding not in baseline → reported as new | "R6.2 — new finding not in baseline is reported as new" | PASS |
| Fixed finding drops from baseline on re-snapshot | "R6.4 — fixed finding is removed from baseline on re-snapshot" | PASS |
| No baseline → metadata.baseline is undefined | "when no baseline exists, metadata.baseline is undefined" | PASS |
| Cross-surface fingerprint identity | "cross-surface: baseline.fingerprint and standalone fingerprint() produce identical hashes" | PASS |

### R4 — CLI End-to-End

| Requirement | Test | Status |
|------------|------|--------|
| `--fail-on suggestion` exits 2 for new, 0 after baseline | "R6.1/2 — CLI: --fail-on suggestion exits 2 for new finding, 0 after baseline" | PASS |
| Fixed finding drops from baseline file | "R6.4 — CLI: fixed finding drops from baseline file" | PASS |
| `--json` on baseline command | "R6.4 — CLI: --json flag on baseline command produces parseable JSON output" | PASS |
| `changed` from foreign cwd resolves via `-p` | "R6.7 — CLI: changed from foreign cwd resolves baseline via -p" | PASS |
| `--fail-on-regression` exits 2 on debt increase | "R6.8 — CLI: --fail-on-regression exits 2 when debt increases" | PASS |
| `--fail-on-regression` exits 0 when debt same/lower | "R6.8 — CLI: --fail-on-regression exits 0 when debt is same or lower" | PASS |
| No baseline → full output with hint | "R6.1 — CLI: no baseline present → full output with hint" | PASS |

### R5 — Report Formats

Verified via `src/reporting/sarifReportGenerator.spec.ts` (32 tests — includes per-violation `new` field and `baseline` block).

### R6 — Cross-Surface Fingerprint Identity

Verified via "cross-surface: baseline.fingerprint and standalone fingerprint() produce identical hashes for same inputs" — `baseline.ts`, `projectTasks.ts`, and `sarifReportGenerator.ts` produce identical fingerprints for the same violation (all go through `extractSymbol()`).

---

## Implementation Files

| File | Purpose |
|------|---------|
| `src/baseline.ts` | BaselineManager: load, save, createFromFindings, matchFindings, diffBaselines |
| `src/symbols.ts` | `extractSymbol()` — canonical symbol extraction for fingerprinting |
| `src/fingerprint.ts` | `fingerprint()` — SHA-256 of `[analyzer, rule, file, symbol]` |
| `src/auditRunner.ts` | Baseline matching injected post-analysis, pre-summary |
| `src/cli.ts` | `baseline` command, `--full`, `--fail-on-regression`, delta output |
| `src/types.ts` | `AuditConfig.hookIncludeKnown`, `AuditResult.metadata.baseline` |
| `src/config/defaults.ts` | `hookIncludeKnown: false` |
| `src/reporting/*.ts` | JSON/SARIF/CSV/HTML baseline-aware fields |

## Full Suite

- `src/__tests__/baseline.test.ts`: **33 tests PASS**
- `src/reporting/sarifReportGenerator.spec.ts`: **32 tests PASS**
- All other test files: **347 tests PASS**
- **Total: 412 tests, 30 files, all passing**
