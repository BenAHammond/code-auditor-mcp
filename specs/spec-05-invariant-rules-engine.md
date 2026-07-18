# Spec 05 — Custom Invariant Rules Engine

**Project:** code-auditor-mcp
**Ships as:** v3.3.0
**Done means:** published to npm, all tests green, build clean.
**Depends on:** Spec 04 merged and published.

## Context

The differentiating feature: users declare their codebase's laws — "no direct imports of X," "nothing outside this module calls that function" — and the auditor enforces them on every run, including diff-scoped agent-loop runs. Generic SOLID checks are table stakes; project-specific invariants enforced against an autonomous implementor are the product.

## Requirements

### R1 — Rule declaration

1. Rules live in a `rules` array inside the existing `.codeauditor.json`. JSON only. Validated with ajv against a published JSON Schema (shipped in the package and referenced via `$schema` support so editors autocomplete).
2. Every rule has: `id` (unique string), `kind` (enum below), `severity` (`critical` | `warning` | `suggestion`), optional `message` (shown verbatim in the violation — this is where the user explains the *why*), plus kind-specific fields. Nothing else. Unknown fields are a config error, not ignored.
3. Config errors (bad schema, duplicate ids, invalid globs/regex) fail the audit with a structured error naming the rule id and problem. Invalid rules are never silently skipped.

### R2 — Rule kinds (four, exactly)

1. **`import-ban`** — `{ module: string, except?: string[] }`. No file may import `module` (exact specifier or glob, e.g. `@ai-sdk/*`) unless the importing file matches an `except` path glob. Catches static imports, dynamic `import()`, and `require()`.
2. **`call-constraint`** — `{ callee: string, allowFrom?: string[], denyFrom?: string[] }` (exactly one of `allowFrom`/`denyFrom`; both or neither is a config error). `callee` is a function name, optionally path-qualified as `path/glob#name`. Enforced via the `function_calls` index: callers outside `allowFrom` (or inside `denyFrom`) are violations.
3. **`module-boundary`** — `{ from: string, to: string }` (path globs). Files matching `from` may not import — directly — from files matching `to`.
4. **`naming`** — `{ path: string, exports: string }`. Exported symbols in files matching the `path` glob must match the `exports` regex.

Path globs are picomatch-style, matched against repo-root-relative paths. Case-sensitive.

### R3 — Execution as a first-class analyzer

1. New analyzer `invariants`, conforming to `AnalyzerFunction` like every other analyzer: enabled by default when a `rules` array exists, selectable via `-a invariants`, configurable through the `config` tool.
2. Runs in full and scoped audits (Spec 04 semantics). Scoping note: `import-ban`, `module-boundary`, and `naming` are per-file and scope cleanly; `call-constraint` checks scoped functions as callers against the constraint — like DRY, it evaluates the scope against the full index so a new illegal call site is always caught.
3. Violations carry the rule `id`, the user's `message`, and standard location data; they flow through results, `tasks.from_audit`, fingerprinting, and (Spec 06) SARIF like any other violation.

### R4 — MCP and docs

1. `config` tool gains actions `rules_list` and `rules_check` (validate current config, report errors) so an agent can introspect the laws it's operating under.
2. README gains an "Invariant rules" section: the four kinds, one realistic example each, and a worked example of the full loop — declare a rule, agent edits code violating it, hook-driven `code-audit changed` reports it with the rule's `message`.

## Acceptance evidence

1. `pnpm run build` clean; `pnpm test` green. New tests per kind: violation and non-violation fixtures; `except`/`allowFrom` behavior; dynamic import and `require()` detection for `import-ban`; config-error cases (duplicate id, both `allowFrom`+`denyFrom`, bad regex); scoped-run catch of a new illegal call site.
2. Dogfood: add a real `rules` array to this repo's own `.codeauditor.json` (minimum: an `import-ban` guarding against reintroducing `lokijs`, and a `module-boundary` keeping `languages/` from importing analyzers). `code-audit -a invariants` runs clean; a deliberately violating scratch edit is caught, shown in transcript, then reverted.
3. JSON Schema file present in the published package; ajv validation wired; `$schema` reference documented.
4. Transcript of the R4.2 worked example end-to-end.
5. `npm view code-auditor-mcp version` returns 3.3.0.

## Explicitly out of scope

- `ast-pattern` rule kind — ships in Spec 08 with the tree-sitter/ast-grep engine. The v3.3.0 schema contains exactly the four kinds above.
- Cross-file taint/dataflow analysis. `call-constraint` is call-graph membership, not flow analysis.
