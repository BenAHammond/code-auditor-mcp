# Spec 08 — tree-sitter Migration & `ast-pattern` Rule Kind

**Project:** code-auditor-mcp
**Ships as:** v4.0.0 (parsing engine replacement; analyzer output may shift in documented ways)
**Done means:** published to npm, all tests green, build clean.
**Depends on:** Spec 07 merged and published.

## Context

The TypeScript compiler API is used as a runtime parsing dependency across the analyzers and function scanner. TS 7 is the native Go port and does not expose that API surface — the project is pinned to an API being sunset, not merely an old version. This spec replaces the parsing layer with tree-sitter behind the existing `LanguageAdapter` seam, removes the runtime `typescript` dependency, and adds the fifth invariant rule kind (`ast-pattern`, ast-grep syntax) now that the pattern engine exists.

## Requirements

### R1 — tree-sitter parsing layer

1. `languages/typescript/TypeScriptAdapter.ts` and `languages/go/GoAdapter.ts` reimplemented on tree-sitter (node bindings; grammars: tree-sitter-typescript covering TS + TSX, tree-sitter-javascript for JS/JSX, tree-sitter-go). The `LanguageAdapter` interface is the seam — it may evolve where the old interface leaked TS-compiler types, but everything above the interface (orchestrator, registry, analyzers, function scanner consumers) changes only where those leaked types force it.
2. Everything currently extracted into `EnhancedFunctionMetadata` is extracted from tree-sitter ASTs: signatures, parameters, JSDoc, exports, hooks, props, call expressions (for `function_calls`), imports/dependencies, unused imports, complexity, body content. Complexity is computed by an explicit documented definition (cyclomatic: decision-point count) — if the resulting numbers differ from the TS-API implementation, the new definition is canonical and the delta is reported.
3. `typescript` is removed from `dependencies` (remains in `devDependencies` for building the project itself). `pnpm ls --prod` shows no `typescript`.
4. `functionScanner.ts` consumes adapters through the interface only — zero `import ... from 'typescript'` anywhere in `src/` outside type-only build tooling.

### R2 — `ast-pattern` rule kind

1. Fifth invariant rule kind via `@ast-grep/napi`: `{ pattern: string, path?: string, language?: "typescript" | "javascript" | "go" }` — ast-grep pattern syntax, matched over files matching `path` (default all files of `language`; `language` default typescript). Every match is a violation at the match location, carrying the rule's `message`.
2. JSON Schema, ajv validation, `rules_check`, docs, `tasks.from_audit`, fingerprinting, and SARIF all extend to the new kind exactly as the other four.
3. README invariant section gains an `ast-pattern` example: banning a concrete API call shape (e.g. any `new Function(...)` construction).

### R3 — Behavior parity audit

1. Run a full audit of this repo on v3.5.0 and on this build. Report: indexed function count delta, per-analyzer violation count delta, and an explanation for every delta (new complexity definition, parser edge cases, genuine fixes). Unexplained deltas are bugs and block completion.
2. The existing test suite is the primary parity instrument: analyzer tests, scanner tests, and Spec 05 invariant fixtures all pass unmodified except where they asserted TS-compiler-specific internals, each such modification listed.

### R4 — Multi-language posture

Adding a language after this spec = grammar + one adapter implementing `LanguageAdapter`. Document this in CONTRIBUTING.md with the adapter checklist. No new languages ship in this spec.

## Acceptance evidence

1. `pnpm run build` clean; `pnpm test` green; modification list per R3.2.
2. `grep -rn "from 'typescript'\|from \"typescript\"" src/` — zero matches; `pnpm ls --prod` output showing no `typescript`, no `lokijs`, no `flexsearch`.
3. Parity report per R3.1.
4. `ast-pattern` tests: match/non-match fixtures per language, config-error cases, SARIF and fingerprint passthrough. Dogfood rule added to this repo's `.codeauditor.json`.
5. Performance: full sync + full audit timing vs v3.5.0 (tree-sitter should win; report either way).
6. `npm view code-auditor-mcp version` returns 4.0.0. CHANGELOG documents the complexity-definition change and any analyzer behavior shifts from R3.1.

## Explicitly out of scope

- New languages (Python, Rust, etc.) — the door is open; nothing walks through it in this spec.
- vitest upgrade (still v1; it has survived this long — it gets evaluated after the series, not inside it).
