# Item 1 — buildFingerprintInput: canonical resolution with contractType

**Gate**: Cross-surface fingerprint identity test green.

## What changed

`src/fingerprint.ts` — `buildFingerprintInput()` resolution chain extended to include `contractType`:

```
rule ?? violationType ?? contractType ?? type ?? details.rule ?? ''
```

Previously the chain was `rule ?? violationType ?? type ?? details.rule ?? ''` — APIContractAnalyzer violations (which store their ID in `contractType`) resolved to empty string.

## Evidence

### Cross-surface identity test passes

```
npx vitest run src/__tests__/baseline.test.ts -t "cross-surface"
 ✓ src/__tests__/baseline.test.ts (48 tests | 47 skipped) — 1 passed
```

### Adversarial field-path test passes

The `adversarial: buildFingerprintInput resolves rule-id from every analyzer field path` test covers:
- `rule` field (documentation, schema, SOLID, DRY, data-access, invariants analyzers)
- `principle` field (CrossLanguageSOLIDAnalyzer)
- `violationType` field (reactAnalyzer, SchemaValidator)
- `contractType` field (APIContractAnalyzer) — **added in this batch**
- `type` field (lowest-precedence fallback)
- `violationType` over `contractType` when both set (precedence test)

### Source verification

```bash
grep -n "contractType" src/fingerprint.ts
```
```
60: *   4. `violation.contractType` — APIContractAnalyzer
69:    (typeof violation.contractType === 'string' ? violation.contractType : undefined) ??
```

All three fingerprint-consuming surfaces (`baseline.ts`, `projectTasks.ts`, `sarifReportGenerator.ts`) delegate to `buildFingerprintInput()` — the single canonical path.
