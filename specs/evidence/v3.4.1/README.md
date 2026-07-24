# v3.4.1 — Evidence Bundle

**Date**: 2026-07-24
**Release**: Patch release — production bug fixes

---

## Send-Back Items

The release validator caught four defects behind a green 1,166-test suite. The validator runs a real create-and-audit integration test — it creates a small project, syncs, audits, and inspects the output. Three of the four defects were wiring gaps invisible to the bench by construction (the bench seeds tables directly in-memory, bypassing production service-layer wiring). The fourth was an A2 gate scope problem.

| # | Item | Gate | Evidence |
|---|------|------|----------|
| 1 | Defect #3: SKILL.md `--tool claude` phantom flag + A2 gate doc-CLI parity expansion | 16 pass, 6 skip (unimplemented subcommands) | [verify-close.md §1](verify-close.md#1-item-1--a2-gate-doc-cli-parity) |
| 2 | from-audit fingerprint migration — CHANGELOG note + root-cause confirmation | Fingerprint scheme verified stable; migration documented | [verify-close.md §2](verify-close.md#2-item-2--from-audit-fingerprint) |
| 3 | Real-surface transcripts for Defects #1, #2, #3 | Before/after transcripts confirming fixes | [verify-close.md §3](verify-close.md#3-item-3--real-surface-transcripts) |
| 4 | CSS discovery integration test at installed surface (Gap 4) | 3 new CLI integration tests pass | [verify-close.md §4](verify-close.md#4-item-4--css-discovery-integration-test) |

---

## verify:close output

```
> vitest run

 Test Files  1 failed | 42 passed (43)
      Tests  3 failed | 740 passed (743)
```

The 3 failures are pre-existing baseline test failures (present on HEAD before any v3.4.1 changes) — see [verify-close.md §Baseline Failures](verify-close.md#pre-existing-baseline-failures) for diagnosis.
