# Go analyzer source (historical)

These ten files were the Go analyzer subprocess that preceded the phase model.
They are preserved for reference only, on the orphan branch
`archive/go-analyzer-source` — they are not on `main`, they are not shipped in
the package, and they should not be restored.

## What they were

`main.go` was the JSON-RPC entry point: it read a request over stdio and
dispatched to the `code-auditor-go/analyzer` library. The root `go.mod`
declared module `code-auditor-go` and a `replace` directive pointing at
`./analyzer-src`. The eight files under `analyzer-src/` (module
`code-auditor-go/analyzer`) implemented the analysis:

- `go.mod` — the `code-auditor-go/analyzer` module.
- `analyzer.go` — the `Analyzer` type and analysis options.
- `parser.go` — Go AST parsing.
- `types.go` — shared types.
- `solid.go` — SOLID checks.
- `dataaccess.go` — data-access resolution.
- `indexer.go` — function indexing.
- `testconventions.go` — test-file conventions.

## Why they are gone

Spec 68 §11 (commit `39636d6`) deleted the Go binary path and repointed the
entry points to the phase model. Go analysis now runs through the TypeScript
`GoAdapter` (`src/phase/`), not a spawned subprocess, so these sources are dead.

## Where they live

The surviving copy is the orphan branch `archive/go-analyzer-source`, holding
the ten files in their original layout (top-level `main.go` and `go.mod`, plus
`analyzer-src/`).
