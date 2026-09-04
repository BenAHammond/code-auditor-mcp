# Item 5 — Spec 18 gaps

**Gate**: Named fixtures green.

## 5a. Invariant violation blocks with baseline present (R6.3)

**Test**: `baseline.test.ts` — `R6.3 — invariant violations are always "new" regardless of baseline`

```
 npx vitest run src/__tests__/baseline.test.ts -t "R6.3"
 ✓ src/__tests__/baseline.test.ts (48 tests | 46 skipped) — 2 passed (unit + integration)
```

The unit test verifies `matchFindings()` classifies invariant violations as "new" even when their fingerprint is in the baseline. The integration test (shells out to CLI, creates invariant rule, runs audit with baseline present) verifies the invariant blocks regardless of baseline state — invariant violations are never baselined.

## 5b. Hook scripts forward project root

The three hook scripts resolve the project root from their respective IDE environments:

- **Claude Code**: Uses `CLAUDE_PROJECT_DIR` environment variable
- **Cursor**: Uses `workspace_roots` from the Cursor extension API payload
- **Codex**: Uses `workspaceFolder` from the Codex extension API payload

Each script extracts the project root and passes it to `code-audit changed --path <projectRoot>`. The `--path` flag ensures the baseline file is found at the correct project root regardless of the current working directory.

**Foreign-cwd test** (R6.7): `baseline.test.ts` — `R6.7 — loadBaseline uses the given projectRoot, independent of cwd`

```
npx vitest run src/__tests__/baseline.test.ts -t "R6.7"
 ✓ src/__tests__/baseline.test.ts (48 tests | 47 skipped) — 1 passed
```

Verifies that `loadBaseline(projectRoot)` reads `.codeauditor.baseline.json` from the specified root, not from `process.cwd()`.

## 5c. exemptPatterns match file paths only, never symbol names

**Test**: `exempt-patterns.test.ts` — 4 tests covering both directions:

```
npx vitest run src/__tests__/exempt-patterns.test.ts
 ✓ src/__tests__/exempt-patterns.test.ts (4 tests)
```

The four fixtures:
1. **`.spec` files are exempt**: Files matching `*.spec.*` glob are exempt from documentation checks — path match works
2. **Functions named like exempt patterns are NOT exempt**: A function named `specialOffer` (matching `spec` substring) in `src/` fires — symbol names never match
3. **Both fixtures together**: Spec file exempt, production file fires — both directions in one test
4. **`mock` pattern exempt by path**: File named `mock-data.ts` is exempt via `mock` glob — confirms multiple exempt patterns work via path only
