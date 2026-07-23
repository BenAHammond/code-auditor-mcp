# Spec 11 — Analyzer Quality Evaluation: Evidence Bundle

**Date**: 2026-07-23
**verify:close result**: ✅ exits 0 — 529/529 tests pass, bench 8/8 pass, verify:dist passes

---

## Evidence files

| File | Content |
|------|---------|
| [verify-close.md](verify-close.md) | verify:close transcript, bench summary, acceptance checklist, recalibration summary |
| [plan.md](plan.md) | Pre-implementation plan with gap analysis |

## Supporting artifacts (in repo)

| Artifact | Path |
|----------|------|
| Triage report (691 findings) | `bench/results/triage-report.md` |
| Triage classifications (JSON) | `bench/results/triage-classified.json` |
| Sweep report (13 parameters) | `bench/results/sweep-report.md` |
| Recalibration report | `bench/results/recalibration.md` |
| Bench baseline | `bench/baselines/baseline.json` |
| Bench results (latest) | `bench/results/latest.json` |
| Non-English corpus fixtures | `bench/corpus/non-english/` |
| Severity overrides (defaults) | `src/config/defaults.ts` (§ severityOverrides) |

## Gates passed

1. **verify:close**: 36 test files, 529 tests, all dist checks pass
2. **bench**: 8/8 analyzers pass (μF1=1.0000, μTrueF1=0.9638)
3. **build**: TypeScript compiles clean
4. **hook path**: `code-audit changed --fail-on critical` exits correctly
