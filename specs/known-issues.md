# Known Issues

Persistent detection gaps and parser limitations that are **not** file-local
notes and are **not** scheduled for a fix in the current release. Each entry
names the mechanism, the affected surface, and why it is permanent (or at least
not actionable now) rather than a defect to file against a specific line.

---

## `node-sql-parser` sqlite grammar rejects `text(N)` column spellings

**Surface:** DDL extraction (`ddl-declarations` / `ddlColumnDefinitions` /
`parseSqlTables` — `src/languages/sql/sqlAst.ts`).

**Mechanism.** `node-sql-parser` (5.4.0) under its `sqlite` grammar does not
parse a `text(N)` column type — the `N`-length spelling that Drizzle's SQLite
dialect emits for string columns. `CREATE TABLE t (name text(256), x text(2))`
fails to parse; the un-lengthed `text` and the standard `varchar(255)` spellings
parse fine. This was probed directly (`text` ✓, `varchar(255)` ✓, `text(256)` ✗,
`text(2)` ✗).

**Why it is permanent.** It is an upstream grammar limitation, not a defect in
this tool's extraction logic. The DDL extractors walk the parser's AST; when the
parser refuses the statement there is no AST to walk, so the statement reports
`cannot-fire` (a parse-failure reason) instead of emitting its tables/columns.
`text(N)` is the *default* shape Drizzle-sqlite produces for `text` columns, so
this is a broad, permanent gap across any Drizzle-sqlite corpus — most
acutely openstatus, which is Drizzle-sqlite and carries this spelling throughout.

**Disposition.** Recorded as a known limitation, not a file-local note. The
correct long-term fix is upstream (or a DDL pre-normalization step), not a
regex fallback in this tool — a regex over raw SQL would re-introduce exactly the
hand-rolled parser this release removed (Spec 70 R2/R4). The honest outcome —
`cannot-fire` with a named parse reason — is correct behavior for an unparseable
statement, so nothing fires on a guessed reading.
