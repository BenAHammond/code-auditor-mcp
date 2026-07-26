# Spec 22 — verify:close

**Date:** 2026-07-20
**Gate Status:** ✅ GREEN

## Exit Criteria

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Triage committed verbatim with hash assertion | ✅ `specs/test-feedback/test-feedback.md` |
| 2 | Resolutions doc cites items → requirements | ✅ `resolutions.md` |
| 3 | Fixture-per-class as specified | ✅ R1–R5 bench fixtures exist |
| 4 | Before/after counts with per-requirement attribution | ✅ See `resolutions.md` |
| 5 | All touched rules remain suggestion-tier | ✅ Confirmed — severity audit pass |
| 6 | Hook path byte-identical on hook fixtures | ✅ Hook-contract regression test passes |
| 7 | `verify:close` green | ✅ This document |
| 8 | Tag `spec-22` | ✅ |

## Test Results

```
npm run test:  755/755 passing (includes 3 new JSON-purity tests)
npm run bench: 11/11 passing; all corpora at F1=1.0
```

## Build

```
npm run build: clean
```

## CHANGELOG

`CHANGELOG.md` — Unreleased section "Spec 22 Signal Hotfix 2" documents all R1–R6 changes.

## Close-Out Extension (2026-07-25)

Three additional defects discovered during release validation:

| # | Defect | Root Cause | Fix | Verification |
|---|--------|-----------|-----|-------------|
| 7 | JSON-purity contamination | `codeIndexDB.ts:1233` migration log via `console.log` (stdout) | Switched to `console.error` (stderr); 3 purity tests added to `baseline.test.ts` | `changed --json` stdout parses clean; `changed --stdin --json` hook path parses clean |
| 8 | 10 baseline test failures | `createViolation()` passed tree-sitter 0-based line numbers; `validateHookContract()` (commit `d601ac3`) dropped `line < 1` | `createViolation()` line → line + 1 | 752→755 passing; per-test dispositions in `GROUND-TRUTH.md` §10 |
| 9 | isDynamic extraction false positives | `extractClassUsage()` only marked template-literal dynamic expressions as unresolvable; simple variables/ternaries passed through | All `{…}` wrapped expressions now `unresolvable: true`; detector skips per-entry not per-file | Undefined-class detector no longer false-flags runtime class-name expressions |

### GROUND-TRUTH Closures

- **§9.1 `nextSessionsCursor`**: Flipped from "guard contains it" to concrete reproduction steps (10+ audits → page truncation → silent data loss). Mitigation path documented.
- **§9.2 `withRetry`**: Flipped from "caller-side concern" to concrete reproduction (kill transport mid-audit → hard error → no resume). Mitigation path documented.

## Acceptance Checklist

- [x] styles/undefined-class fixes (R1)
- [x] styles/token-bypass fixes (R2)
- [x] styles/value-drift fixes (R3)
- [x] SQL extraction regression fixes (R4)
- [x] conventions naming partitioning (R5.1)
- [x] conventions built-in/stdlib exclusion (R5.2)
- [x] JSON-purity enforcement (R7 — 3 CLI output tests)
- [x] isDynamic extraction fix (R8 — root cause at extraction time)
- [x] 10 baseline test failures — per-test dispositions (GROUND-TRUTH §10)
- [x] GROUND-TRUTH §9 closures (fixtures that fire)
- [x] Bench fixtures for all defect classes
- [x] All analyzers at F1=1.0 on bench corpus
- [x] CHANGELOG updated
- [x] Evidence bundle produced
- [x] Tag applied
- [x] Footer-error diagnosis — see §Hook-Path Diagnostic below
- [x] Line-number conversion sweep — see [line-number-sweep.md](line-number-sweep.md)
- [x] GROUND-TRUTH §10 red-gate law — third confirmation

## Line-Number Conversion Sweep (2026-07-25)

The release-gating line-number conversion sweep is complete. See [line-number-sweep.md](line-number-sweep.md) for the full report.

**Summary:** 6 files touched, 6 edit locations. `toSourceLocation()` now converts tree-sitter 0-based positions to 1-based at the adapter boundary. All downstream compensations removed (3 scattered +1s, 2 double compensations). Mixed-basis DB spans and churn off-by-one resolved as secondary effects. Build clean, 755/755 tests pass, 13/13 bench pass at F1=1.0.

## Hook-Path Diagnostic (2026-07-26)

## Hook-Path Diagnostic (2026-07-26)

The stale footer error reported in-session was traced:

| Question | Answer |
|----------|--------|
| **Hook config location** | `/Users/ben/.claude/plugins/cache/code-auditor-mcp/code-auditor/3.0.2/hooks/hooks.json` |
| **Hook script** | `${CLAUDE_PLUGIN_ROOT}/scripts/hook-audit.sh` (version 3.0.2) |
| **Binary resolution** | Global install: `/Users/ben/.volta/tools/image/node/26.5.0/bin/code-audit` → `code-auditor-mcp@3.4.1` |
| **Stderr merge vector** | Hook script line 50: `2>&1` — merges stderr (log lines) into stdout (JSON), so the agent receives mixed output |
| **Repo built-CLI purity** | ✅ `node dist/cli.js changed --json --fail-on critical 2>/dev/null \| python3 -m json.tool` → clean `[]` |
| **Hook-path purity** | ✅ `echo "src/codeIndexDB.ts" \| node dist/cli.js changed --stdin --json --fail-on critical 2>/dev/null \| python3 -m json.tool` → valid JSON |

**Verdict**: The repo is fixed. The footer error in the session is from the **published plugin's hook script** (`2>&1` in version 3.0.2), not from any repo defect. The hook re-merges stderr into stdout after the repo correctly separated them. This is expected until the next plugin release.

**Next publish**: Either remove `2>&1` from the hook script (Claude Code separates stdout/stderr natively), or redirect stderr to `/dev/null` in the hook invocation. Either fix ships with the next plugin version.

## Open Spec 22 Debt

Items discovered during close-out that should be addressed in a subsequent spec or hotfix:

### 5. Tailwind dictionary — replace hand-curation with the project's own Tailwind as oracle

The R6.5 report documents hand-adding classes to `tailwindUtilityExpander.ts` ("Added missing standard Tailwind classes: flex-grow, flex-shrink-0, group, col-span-{1..12}, outline-none…"). This is a hand-typed list being grown class-by-class as bug reports arrive, violating Spec 22 R1.2 which specified "generated from the Tailwind default theme, not hand-curated."

The 2,837→882 drop is at least partly enumeration whack-a-mole, and it can never converge, because Tailwind's surface isn't a list — it's a grammar (prefixes × theme scale × variants × arbitrary values × opacity modifiers × negative forms), it grows every Tailwind release, and plugins extend it per-project. This is the styles-domain twin of the English word lists Spec 21 killed, and the same doctrine applies: **when an external system defines what's valid, that system is the oracle — never our maintained replica of it.**

**a. PRIMARY — compile-probe:** validate candidate classes against the project's own installed Tailwind (v4: compile via the project's tailwind package with a probe stylesheet; v3: their config through their resolveConfig/postcss). A class is defined iff their compiler emits CSS for it. This makes plugins, theme extensions, and version differences correct by construction — zero dictionaries.

**b. FALLBACK — when the project's Tailwind isn't resolvable:** the existing fail-open rule applies (detector disables with a visible warning). A bundled dictionary may exist ONLY as a build-time artifact generated programmatically from a pinned tailwindcss release, with the generator script committed and a test asserting the artifact matches regenerator output. Hand-editing the artifact is a suite failure (byte-identity pattern, same as SKILL.md).

**c. Grammar shapes:** arbitrary values, variant prefixes, opacity modifiers, and negative forms are parsed structurally, never enumerated.

**d. Evidence:** the recall corpus re-run — the 882 current residuals get re-adjudicated by the oracle, and any hand-added entry in the current expander that the oracle contradicts is listed as a corrected error.
