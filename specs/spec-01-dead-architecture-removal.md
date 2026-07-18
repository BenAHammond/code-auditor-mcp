# Spec 01 — Dead Architecture Removal & Canonical Language Layer

**Project:** code-auditor-mcp
**Ships as:** v2.7.0 (internal refactor; no public API or MCP tool surface change)
**Done means:** published to npm, all tests green, build clean.

## Context

The codebase carries two parallel language-adapter systems: the legacy `adapters/` directory (GoAdapter, TypeScriptAdapter, UniversalAnalyzer, UniversalSOLIDAnalyzer) and the newer `languages/` system (LanguageAdapter interface, LanguageOrchestrator, LanguageRegistry, RuntimeManager, typescript/TypeScriptAdapter, go/GoAdapter). The legacy system is what analyzers actually consume today, routed through per-analyzer compat shims (`solidAnalyzerCompat.ts`, `dryAnalyzerCompat.ts`, documentation/data-access/schema compat layers). Every analyzer change currently touches both systems. This spec makes `languages/` the sole system and deletes everything else.

## Requirements

### R1 — `languages/` is the only language-adapter system

1. Inventory every capability the legacy `adapters/` implementations provide that `languages/` does not (function extraction details, metadata fields, Go struct/interface handling, universal analyzer behaviors — whatever the diff actually is).
2. Port every gap into the corresponding `languages/` adapter. The `LanguageAdapter` interface in `languages/types.ts` is the contract; extend it if a legacy capability has no home, but the extension lives in `languages/`, not in a shim.
3. All analyzers (SOLID, DRY, React, Documentation, Data Access, Schema, and the universal reimplementations under `analyzers/universal/`) consume `languages/` directly.

### R2 — Delete the legacy path

1. Delete the `adapters/` directory entirely.
2. Delete every `*Compat.ts` adapter shim (`solidAnalyzerCompat`, `dryAnalyzerCompat`, and the documentation, data-access, and schema compat layers).
3. Delete the legacy-vs-universal parity test suite and the `test:parity` script from `package.json`. With the legacy path gone there is nothing to be at parity with. Any parity test asserting behavior that is still correct gets converted into a direct test of the `languages/` path before deletion; assertions that only existed to pin legacy behavior are deleted with it.
4. Zero references to `adapters/` remain anywhere in `src/`, `tests/`, or docs after this spec. `grep -r "adapters/" src/ tests/` returns nothing.

### R3 — Dependency hygiene

1. Remove `js-yaml` from `package.json` dependencies and delete the commented-out import.
2. Remove `@types/js-yaml` if present.
3. Run a full unused-dependency check (`pnpm dlx depcheck` or equivalent) and remove anything else with zero references. Report what was removed.

### R4 — Strict mode

1. Set `"strict": true` in `tsconfig.json`.
2. Fix every resulting error across the entire codebase. No `// @ts-expect-error`, no `// @ts-ignore`, no `any`-casting escape hatches added to silence strict errors. Where strictness reveals a real bug (null paths, implicit any on public signatures), fix the bug.
3. Strict mode applies to `src/` and `tests/` both.

## Acceptance evidence

Each item below is reported with the command run and its output:

1. `pnpm run build` — clean, zero errors, with `"strict": true` in effect.
2. `pnpm test` — all tests pass. Test count may change (parity suite deleted, converted tests added); report the before/after count and account for the delta.
3. `grep -rn "adapters/" src/ tests/` — zero matches. `ls src/adapters` — does not exist.
4. `grep -rn "Compat" src/` — zero adapter-shim matches (unrelated identifiers containing "Compat," if any, are listed and justified).
5. `grep -rn "js-yaml" src/ package.json` — zero matches.
6. `grep -rn "@ts-ignore\|@ts-expect-error" src/` — zero matches introduced by this spec (pre-existing occurrences, if any, listed with file/line so we can see they predate this work).
7. npm shows the new version published: `npm view code-auditor-mcp version` returns 2.7.0.

## Explicitly out of scope

- MCP entry point consolidation and tool surface changes (Spec 02).
- LokiJS replacement (Spec 03).
- Parser backend changes — `languages/typescript/TypeScriptAdapter.ts` continues to use the TypeScript compiler API at 5.9.x in this spec; tree-sitter migration is Spec 08.
- vitest major upgrade — stays at v1.
- Any README or positioning changes (Spec 09).
