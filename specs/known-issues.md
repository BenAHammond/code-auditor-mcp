# Known Issues

This file holds **permanent limitations of the design** — and nothing else. It is
not a board: no row waits here. A defect that is fixable in this repo is fixed in
the same pass it is found, or raised to Ben as blocking; it does not sit open in
this file. Each entry below names the mechanism, the affected surface, and why it
is permanent (upstream, or a by-design trade-off that is correct behavior rather
than a defect).

---

## `node-sql-parser` rejects valid sqlite the tool cannot otherwise normalize around

**Surface:** DDL extraction (`ddl-declarations` / `parseSqlTables` —
`src/languages/sql/sqlAst.ts`) and the schema receiver-resolution path
(`src/analyzers/provenance.ts`).

**Mechanism.** node-sql-parser (5.4.0) under its `sqlite` grammar refuses some
statements sqlite itself accepts. The `text(N)` length-qualified column spelling
— Drizzle-sqlite's default for string columns — was the broad case, and it is now
normalized around *before* the parse (`normalizeSqliteTextLength`, commit
`70aa805`), so that class no longer reaches the parser. What remains is a
residual of valid sqlite the grammar still rejects: mixed-quoting and
escaped-identifier forms inside a literal (e.g.
`` create table bar (`i3` integer primary key) `` with backslash escapes). This
is the recall-protocol oracle residual — op-producing statements across a handful
of `.sql` files the grammar cannot parse.

**Why it is permanent.** It is an upstream grammar limitation, not a defect in
this tool's extraction. When the parser refuses a statement there is no AST to
walk, so the statement reports `cannot-fire` with a named parse reason instead of
emitting guessed tables/columns. That honest abstention is correct behavior —
nothing fires on a guessed reading, and the residual shrinks only as upstream
accepts more of the sqlite dialect (or as further lossless normalizations are
added).

---

## `verify:oracle-shortfalls` is a drift ratchet, not a coverage gate

The gate pins the `files` / `expected` / `actual` aggregate per (fact-kind,
corpus) and fails on any field change; the `residual` (`expected − actual`) is
derived, never pinned. The oracle is a broad upper-bound superset (for example
`countQuerySites` counts every `\.\w+\s*\(` member call plus SQL-keyword
occurrences) while the producer emits only what receiver-resolution proves, so
`expected ≫ actual` is by design.

**Why it is permanent.** This is the intended trade-off, not a bug: the gate
exists to catch corpus drift (a corpus edit under the read-only contract) and a
producer emitting *more* than the oracle, not to drive `expected ≈ actual`. Its
known weakness — a producer that silently stops emitting a fact kind is visible
only if the re-recorded baseline is inspected against the `composition` prose —
is a permanent property of a drift ratchet, not a defect to file.

---

## `node-sql-parser` rejects valid-SQLite literals on the SQL-argument path

**Surface:** the receiver-resolution SQL-argument source (`sqlArgumentSource` in
`src/analyzers/handleIdentification.ts`, via `parseSql` →
`src/languages/sql/sqlAst.ts`) — the R3 arm that proves a receiver `handle` when
its static SQL argument parses.

**Mechanism.** node-sql-parser under its `sqlite` grammar (the default) refuses
some literals sqlite itself accepts — `ESCAPE '\'` escape clauses, bare `?`
placeholders in some positions, and reserved-word aliases. When the argument does
not parse, `identifyHandle` returns `unproven` with a reason naming
node-sql-parser, so the receiver surfaces as `cannot-fire` rather than a guessed
`handle` / `not-handle`.

**Why it is permanent.** It is an upstream grammar limitation, not a defect in
this tool's resolution. The honest abstention is correct behavior: "I was handed
SQL-shaped text and could not read it" (Spec 70 R1/R2) is exactly what an
unparseable argument should report, and the residual shrinks only as upstream
accepts more of the sqlite dialect.

---

## A codegen template token as an import specifier resolves to nothing

**Surface:** import-specifier resolution (`resolveSpecifier` →
`src/analyzers/receiverResolution.ts`) — the one seam that answers relative /
`@/`-`~/` alias / tsconfig-`paths` / node_modules-vendor specifiers.

**Mechanism.** blitz's generator templates import a placeholder —
`import db from "__prismaFolder__"` — where `__prismaFolder__` is a codegen token
replaced at scaffold time, not a specifier with any in-tree or vendor target. None
of the four resolution arms reaches it, so the site reports `unproven`.

**Why it is permanent.** The token is not a real import until codegen runs; the
checkout contains the template, not the generated file. Guessing its target would
be a fabrication — the honest answer is `unproven`.

---

## A bare specifier whose mapping is supplied by a build step, not the tree

**Surface:** import-specifier resolution for bare specifiers (`resolveSpecifier`'s
tsconfig-`paths` and vendor arms).

**Mechanism.** blitz's `import db from "db"` resolves through a build-time alias,
not through anything in the analyzed tree: the root tsconfig has no
`compilerOptions.paths`, the `db/` folders carry no `package.json`, the clone has
no `node_modules`, and no manifest declares a `db` dependency. The target module
(`db/index.ts` → `enhancePrisma(PrismaClient)`) *does* exist in the tree — only
the mapping from the bare `"db"` specifier to it is absent. That is why no
resolver reaches it.

**Why it is permanent.** A resolver must not guess by directory name: that
`db/index.ts` exists is a coincidence the specifier cannot reach, and proving a
handle from that coincidence would be a fabrication. The correct, permanent answer
is `unproven`.
