# Item 4 — Spec 19 remainder

**Gate**: Hash test green; no warning-tier `sql-injection` path.

## 4a. dry/structural-similarity — restored, default-off

Verified: `dry/structural-similarity` is present in `UniversalDRYAnalyzer.ts` as a selectable, default-off rule.

```typescript
// src/analyzers/universal/UniversalDRYAnalyzer.ts:25
/** R4.2: Enables dry/structural-similarity analysis. Default false. */
```

```typescript
// src/analyzers/universal/UniversalDRYAnalyzer.ts:150
'dry/structural-similarity',
```

Registered in `ruleRegistry.ts` with `analyzer: 'dry'`, `field: 'rule'`, severity `suggestion`.

## 4b. Triage hash test

```
npx vitest run src/__tests__/fixtures/spec-19/triage-hash.test.ts
 ✓ src/__tests__/fixtures/spec-19/triage-hash.test.ts (2 tests)
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

The triage file is byte-verbatim and the hash test asserts the ORIGINAL bytes, confirming no content drift in the triage document.

## 4c. sql-injection blanket demotion

Verified: `sql-injection` severity is `suggestion` (not `warning`, not `critical`).

```typescript
// src/analyzers/universal/UniversalSchemaAnalyzer.ts:635
'suggestion',  // Spec 11 R4 blanket demotion: all survivors → suggestion
```

Placeholdered queries produce no finding (AST gate requires actual SQL-context strings). All survivors are `suggestion`-tier.

**Grep for warning-tier sql-injection paths**:
```bash
grep -rn "'warning'.*sql-injection\|sql-injection.*warning" src/ --include="*.ts" | grep -v node_modules | grep -v dist | grep -v ".test."
# No matches — zero warning-tier sql-injection paths
```

## 4d. R1 diagnosis sentence in CHANGELOG

From `CHANGELOG.md`, Spec-17 section:

> **R1 diagnosis**: The `sql-injection` rule in the schema analyzer used regex-based string-pattern matching across all source files, producing ~15,000 findings in the self-audit. Only a handful of those involved actual SQL-context string concatenation; the vast majority flagged template-literal interpolations inside non-SQL string expressions (logging, URLs, error messages). This was the single largest noise source in the corpus.
