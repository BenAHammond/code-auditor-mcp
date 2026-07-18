# Spec 06 — SARIF Output

**Project:** code-auditor-mcp
**Ships as:** v3.4.0
**Done means:** published to npm, all tests green, build clean.
**Depends on:** Spec 05 merged and published.

## Context

One output format addition puts audit findings — including invariant rule violations — onto GitHub PR annotations via code scanning. This is where findings become visible to teams instead of individuals.

## Requirements

### R1 — SARIF 2.1.0 emitter

1. `code-audit -f sarif` (alongside existing html/json/csv) writes a valid SARIF 2.1.0 log. MCP `audit results` gains `format: "sarif"`.
2. One `run` per invocation. `tool.driver`: name `code-auditor-mcp`, package version, `informationUri` pointing at the repo.
3. `tool.driver.rules`: one entry per analyzer rule that produced results, with stable rule ids (`solid/single-responsibility`, `invariants/<user-rule-id>`, etc.), short description, and full description. Invariant rules use the user's `message` as the description.
4. Each violation becomes a `result`: `ruleId`, `level` mapped critical→`error`, warning→`warning`, suggestion→`note`, `message`, `locations` with repo-root-relative `artifactLocation` and `region` (start/end line and column where available).
5. `partialFingerprints` populated from the Spec 02 fingerprint utility, so GitHub deduplicates findings across pushes even as line numbers shift.

### R2 — Scoped-audit compatibility

`code-audit changed -f sarif` works; scoped SARIF output contains only scoped results (GitHub treats uploads per-category — document `--sarif-category <name>` passthrough guidance in R3's recipe rather than inventing category logic in the tool).

### R3 — CI recipe

README's CI section is replaced with a complete GitHub Actions workflow: checkout → `npx code-audit -f sarif -o results.sarif` → `github/codeql-action/upload-sarif@v3`. Includes the diff-scoped PR variant using `git:origin/main` scope.

## Acceptance evidence

1. `pnpm run build` clean; `pnpm test` green. New tests: emitter output validates against the SARIF 2.1.0 JSON Schema (schema vendored into test fixtures, validated with ajv); severity mapping; fingerprint presence; invariant rule id and message passthrough.
2. Generated SARIF for a fixture project with at least one violation from every analyzer (including `invariants`) committed as a golden-file test.
3. Transcript: run the R3 workflow file's audit step locally, show the resulting SARIF passes `ajv validate` against the official schema.
4. `npm view code-auditor-mcp version` returns 3.4.0.

## Explicitly out of scope

- Uploading to GitHub from within the tool — the Action does that.
- Baseline/suppression files (`whitelist` already covers suppression; SARIF `suppressions` mapping of whitelist entries is included only if whitelisted violations would otherwise appear in output — they must not appear at all, matching current whitelist behavior).
