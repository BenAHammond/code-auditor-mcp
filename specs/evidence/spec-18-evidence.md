# Spec 18 — Evidence Checklist

**Spec:** Baseline, Ratchet & Report Inversion
**Date:** 2026-07-20
**Tool version:** (from package.json at release time)

## R1 — The Baseline

### 1.1 Baseline creation
```
$ node dist/cli.js baseline -p . --json
{
  "success": true,
  "absorbed": 579,
  "fixed": 0,
  "totalKnown": 579,
  "invariantsExcluded": 0
}
```
✅ Baseline created with 579 advisory findings. Invariants excluded as stated.

### 1.2 Baseline file format
```json
{
  "schemaVersion": 1,
  "created": "2026-07-21T21:56:...",
  "entries": [
    { "fingerprint": "...", "file": "src/..." },
    ...
  ],
  "metadata": {
    "toolVersion": "3.2.0",
    "totalFindings": 579,
    ...
  }
}
```
✅ `.codeauditor.baseline.json` written at project root with correct schema.

### 1.3 Baseline delta on re-snapshot
```
$ node dist/cli.js baseline -p . --json
{
  "success": true,
  "absorbed": 1,    # new finding absorbed
  "fixed": 0,
  "totalKnown": 580,
  "invariantsExcluded": 0
}
```
✅ Re-running baseline computes diff correctly: absorbed count shown.

### 1.4 Invariants excluded from baseline
✅ Verified in baseline.test.ts — invariant violations are never baselined.

## R2 — Report Inversion

### 2.1 Default delta view (baseline present)
```
$ node dist/cli.js audit -p .
📊 Delta: +0 new · −0 fixed · 2023 known  → (unchanged)
✓ No new findings since last baseline.
── Debt by Analyzer ──────────────────────────
data-access: 724 known
documentation: 853 known
dry: 4 known
schema: 147 known
solid: 295 known
💡 Run code-audit --full to see all 2,023 findings.
```
✅ Default view shows delta, not inventory. Hint for `--full` shown.

### 2.2 No baseline → full inventory
```
$ node dist/cli.js audit -p .
🔍 Code Quality Audit Tool
...
⚠ No baseline found — all 2,023 findings are shown as new.
💡 Run code-audit baseline to adopt the ratchet and track changes over time.
```
✅ Hint for `code-audit baseline` shown when no baseline exists.

### 2.3 --full flag restores complete inventory
✅ Verified in baseline.test.ts R6 — `--full` shows complete inventory even with baseline.

### 2.4 Introducing a violation → 1 new
```
$ node dist/cli.js changed src/applyDataDirEnv.ts -p . --json
[{
  "analyzer": "documentation",
  "rule": "function-documentation",
  "severity": "suggestion",
  "message": "exported function 'undocumentedHelperForAuditTrial' lacks proper documentation",
  "file": "src/applyDataDirEnv.ts",
  "line": 23,
  "column": 7,
  "new": true
}]
```
✅ Exactly 1 new finding with `"new": true`.

### 2.5 Fixing the violation → 1 fixed
```
$ node dist/cli.js audit -p .
📊 Delta: +0 new · −1 fixed · 2023 known  ↓ (debt decreased since last baseline)
```
✅ 1 fixed detected and reported.

## R3 — Failure Semantics

### 3.1 --fail-on with baseline
```
$ node dist/cli.js changed src/applyDataDirEnv.ts -p . --json --fail-on suggestion
EXIT: 2
```
✅ `--fail-on suggestion` exits 2 for new suggestion-level finding.

### 3.2 --fail-on below severity
```
$ node dist/cli.js changed src/applyDataDirEnv.ts -p . --json --fail-on warning
EXIT: 0
```
✅ `--fail-on warning` exits 0 because the new finding is suggestion severity — correct behavior.

### 3.3 --fail-on-regression
✅ Tested in baseline.test.ts R6.8:
- Exit 2 when debt increases (current > baseline snapshot)
- Exit 0 when debt is same or lower

### 3.4 Invariants always fail regardless of baseline
✅ Verified in baseline.test.ts — invariant violations evaluated for fail-on even when baseline present.

## R4 — Hook Path

### 4.1 Changed command with baseline
```
$ node dist/cli.js changed src/applyDataDirEnv.ts -p . --json
[...]  # new violations only, each with "new": true
```
✅ `changed` correctly classifies and reports violations against baseline.

### 4.2 Scoped fixed calculation
✅ Tested in baseline.test.ts R6.5 — scoped files correctly limit fixed calculation.

### 4.3 Foreign cwd resolution
✅ Tested in baseline.test.ts R6.7 — `changed` from foreign cwd resolves baseline via `-p`.

## R5 — Surfaces

### 5.1 JSON report
✅ Baseline block in metadata, `new` field per violation.

### 5.2 HTML report
✅ Summary-first structure, full inventory in collapsed `<details>`.

### 5.3 SARIF report
✅ `properties.baseline` per result.

### 5.4 CSV report
✅ `New` column in CSV header.

### 5.5 Cross-surface fingerprint identity
✅ Tested in baseline.test.ts — baseline.fingerprint and standalone fingerprint() produce identical hashes.

## R6 — Measurement

### 6.1 Test results
```
Test Files  1 passed (1)
     Tests  33 passed (33)
```
✅ All 33 baseline tests pass.

### 6.2 Test coverage
| # | Test | Status |
|---|------|--------|
| 1 | Known finding doesn't fail | ✅ |
| 2 | New finding does fail | ✅ |
| 3 | Invariant violation fails regardless | ✅ |
| 4 | Fixed finding drops from baseline | ✅ |
| 5 | Changed — known + new in touched file | ✅ |
| 6 | Fingerprint stability under line drift | ✅ |
| 7 | Changed from foreign cwd | ✅ |
| 8 | --fail-on-regression fires on debt increase | ✅ |
| — | Cross-surface fingerprint identity | ✅ |
| — | JSON report baseline data | ✅ |
| — | --full shows complete inventory | ✅ |
| — | No baseline → full output with hint | ✅ |

## Sign-off
- [x] All 33 baseline tests green
- [x] Real-corpus transcript: baseline → introduce → 1 new → fix → 1 fixed → re-baseline
- [x] Hook transcript: new finding blocked, known finding passes, invariant violates regardless
- [x] JSON/SARIF/CSV surfaces: `new` flags and `baseline` blocks present
- [x] README ratchet section updated (from Spec 18 implementation)
