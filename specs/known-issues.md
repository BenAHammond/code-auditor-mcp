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
