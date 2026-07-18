# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
cd app
npm run dev          # Run CLI in dev mode (tsx src/cli.ts)
npm run dev:server   # Run MCP server with watch mode
npm run dev:mcp      # Run MCP server directly
npm run watch        # Watch TypeScript compilation
```

### Building
```bash
cd app
npm run build        # Compile TypeScript to dist/ + copy WASM grammars
```

### Testing
```bash
cd app
npm run test         # Run Vitest tests
npm run test:watch   # Run tests in watch mode
npx vitest run path/to/test.spec.ts  # Run specific test file
```

### Running the Tool
```bash
cd app
npm run audit        # Run audit tool (after build)
npm run start        # Start MCP server
node dist/cli.js changed --json  # Diff-scoped audit
node dist/cli.js map -p .        # Codebase map
```

## Architecture Overview

Code Auditor enforces architectural invariants and code quality rules inside an AI agent's edit loop. It integrates with Claude via Model Context Protocol (MCP), a CLI, and a Claude Code plugin.

### Core Components

1. **Analyzers** (`app/src/analyzers/`)
   - Functional pattern: each analyzer is a function returning arrays of violations
   - Analyzers process tree-sitter ASTs via `adapterBridge.ts`
   - Current analyzers: SOLID, DRY, data access, React, documentation, schema, invariants

2. **Language Layer** (`app/src/languages/`)
   - `LanguageAdapter` interface (23 methods) — the single seam for language support
   - `adapterBridge.ts` — synchronous facade over tree-sitter parsers
   - `tree-sitter/parser.ts` — web-tree-sitter WASM loader (`initParsers()`, `getParser()`)
   - `LanguageRegistry` — singleton; adapters registered by `initializeLanguages()`
   - **Two-phase init**: `initializeLanguages()` (sync, registers adapters) then `initParsers()` (async, loads WASM grammars). Both required before any parsing.
   - Adapters: `TreeSitterTypeScriptAdapter` (`.ts`/`.tsx`/`.js`/`.jsx`), `TreeSitterGoAdapter` (`.go`)
   - WASM grammars at `dist/grammars/` — shipped in the npm package; zero native compilation

3. **Code Index** (`app/src/services/`)
   - `CodeIndexDB`: SQLite-based persistent storage for indexed functions/components, audit results, tasks, and config
   - FTS5 full-text search via `compileToSQL()` on the query parser
   - `content_hash` on every indexed function for diff detection

4. **Invariant Rules** (`app/src/invariants/`)
   - `.codeauditor.json` in the project root defines project-specific rules
   - Five rule kinds: `import-ban`, `call-constraint`, `module-boundary`, `naming`, `ast-pattern`
   - JSON Schema validation on startup — bad configs fail the audit, not silently skipped
   - `ruleEngine.ts` runs rules per-file; `ast-pattern` uses `@ast-grep/napi`

5. **Entry Points**
   - CLI: `src/cli.ts` — `code-audit` (audit, changed, map, search, tasks, generate-config)
   - MCP Server: `src/mcp.ts` — Model Context Protocol server (stdio + HTTP)
   - Library: `src/index.ts` — programmatic API exports

6. **Reporting** (`app/src/reporting/`)
   - HTML, JSON, CSV, and SARIF (2.1.0 for GitHub Code Scanning)

### Key Design Patterns

- **LanguageAdapter seam**: All analysis consumes `LanguageAdapter`; no analyzer imports a language-specific parser directly
- **Functional analyzers**: Pure functions returning arrays of violations; compose via `analyzerUtils.ts`
- **adapterBridge**: Synchronous facade asserting parser is initialized; throws on uninitialized use
- **Diff-scoped auditing**: `detectChangedFunctions()` uses content hashes to find only what changed since last sync
- **Agent hook contract**: `code-audit changed --json --fail-on critical` — exit code 2 on violations at or above specified severity

### Working Directory Structure

When working in `/app`:
- Source code in `src/`
- Tests alongside source files (`*.spec.ts`)
- Build output in `dist/`
- WASM grammars in `dist/grammars/`
- Example configs in `examples/`

### MCP Tools Available

- `audit.run` / `audit.health` — run audits
- `search.query` / `search.definition` — search the code index
- `index.sync` — sync the code index
- `code_map.get` — generate a structured codebase map
- `tasks` (create, list, get, update, delete, from_audit) — per-project task queue
- `config` (get, set, list, rules_list, rules_check) — manage analyzer config and inspect invariant rules
- `guide.get` — workflow recommendations

### Important Notes

- ES Module project (`"type": "module"` in package.json)
- TypeScript strict mode is currently disabled
- `initParsers()` must be called once at entry points before any parsing. Tests need both `initializeLanguages()` + `initParsers()` in `beforeAll`.
- WASM paths resolve via `import.meta.url`, not `cwd` — works from npx, hook launches, and tarball installs
- The `content_hash` field enables diff-scoped change detection; added automatically during indexing
- `dist/grammars/` is listed in `package.json` `files` so `npm publish` ships the WASM
