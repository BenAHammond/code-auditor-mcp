# Spec 70 — SQL parser residual, and the "different parser" cost

The `known-issues.md` "node-sql-parser rejects valid sqlite" entries were filed
under the wrong category. They are not a permanent ceiling: they were a defect,
and the defect is being fixed by *normalizing the declared input before the parse*
— the same move that already closed `text(N)`. This document records what that
pass closed, what it deliberately leaves closed, and — for the residue that
normalization genuinely cannot cover — the finding Ben asked for: **the answer is
a different SQL parser**, costed rather than written down as our ceiling.

## What normalization now covers (the "do the same" inventory)

Every rewrite below is an *input* rewrite, not a regex fallback: it changes a
spelling node-sql-parser rejects into an equivalent spelling it accepts, without
changing anything a rule reads (tables, filters, statement kind). A literal that
still fails after all of these is a real `cannot-fire`.

| normalizer | input it recovers | what it rewrites to |
| --- | --- | --- |
| `stripComments` | a quote inside a block/line comment opening a string | comments removed before any rewrite |
| `normalizePositionalParams` | D1 numbered params `?1` `?2` | bare `?` |
| `normalizeTemplateSubstitutions` | `${name}` template substitutions | bare `?` |
| `normalizeLimitOffsetPlaceholders` | bare `?` in `LIMIT ?` / `OFFSET ?` | `LIMIT 1` / `OFFSET 0` |
| `normalizeEscapeClause` | `ESCAPE '\'` (backslash in a single-quoted escape char) | `ESCAPE '\\'` |
| `normalizeSqliteTextLength` | `text(N)` length-qualified column (Drizzle-sqlite default) | `varchar(N)` |
| `normalizeVirtualTable` | FTS5 `CREATE VIRTUAL TABLE … USING fts5(…)` | `CREATE TABLE … (cols)` |
| `splitSqlStatements` | a `;` inside a `CREATE TRIGGER … BEGIN … END` body | splits only at top level, BEGIN/CASE-aware |
| `truncateConflictClause` | `INSERT … ON CONFLICT (…) DO UPDATE` | parses the INSERT prefix, flags the upsert |
| `isStandaloneTransactionControl` | `BEGIN`/`COMMIT`/`ROLLBACK` | recognized as SQL with no facts |

The no-fact DDL set (`PRAGMA` / `DROP INDEX` / `DROP VIEW` / `DROP TRIGGER` /
`CREATE VIEW` / `CREATE TRIGGER`) is **DDL-path only** — applied in
`parseSqlProgramTolerant` for migration files, never in `parseSql` or
`parseSqlTables` for code SQL arguments, where a `PRAGMA table_info(x)` must
surface as a parse failure (it names `x`) rather than read "no tables" as clean.

## The residue normalization cannot cover

After the full inventory, the measured residual is **three statements in one
corpus** (openstatus's Drizzle migration set), in two classes. recall-protocol is
100% clean (0 failures).

### Class 1 — `UPDATE … FROM` (openstatus `0034_serious_shard.sql`)

```sql
UPDATE `status_report` SET `page_id` = `t`.`page_id`
  from (select `page_id`, `status_report_id` from `status_reports_to_pages`) `t`
  where `t`.`status_report_id` = `id`;
```

This is **genuine SQLite 3.33+** (`UPDATE … FROM`, added 2020-08-14). The
grammar's `sqlite` UPDATE production stops after the `SET` expression and rejects
the `FROM` token (`… but "f" found`). A plain `FROM t` (no subquery) fails the
same way, so it is the clause, not the subquery.

Normalization cannot cover it: `FROM` here is a whole clause carrying relation
facts, not a spelling variant, and rewriting it (e.g. to the pre-3.33 subquery
form) is a semantics-preserving transformation a regex cannot do — it is
"write a second parser", which is exactly the boundary below.

### Class 2 — Drizzle `ALTER COLUMN "a" TO "a" <type>` (openstatus `0041`, `0064`)

```sql
ALTER TABLE `status_report_update` ALTER COLUMN "status" TO "status" text NOT NULL;
ALTER TABLE `page_subscriber`   ALTER COLUMN "email"  TO "email"  text;
```

This is **not valid SQLite at all** — SQLite's `ALTER TABLE` has RENAME / RENAME
COLUMN / ADD COLUMN / DROP COLUMN, and no `ALTER COLUMN … TO …`. `ALTER COLUMN "a"
TO "a" type` is Drizzle-kit's own migration directive for a column-type change,
which drizzle-kit's migrator rewrites into a table-rebuild. A "different SQL
parser" will **not** parse it, because no SQL parser understands a proprietary
migration DSL — only drizzle-kit does.

That distinction matters for the disposition: `UPDATE … FROM` is a parser
limitation; `ALTER COLUMN … TO` is a Drizzle directive that should be recognized
(or left as `cannot-fire`), never "parsed".

## The finding

### node-sql-parser's sqlite grammar has a hard ceiling; the honest fix is a grammar patch, not more normalization

The two classes need different answers, and neither is "keep normalizing":

1. **`UPDATE … FROM`** — the parser's AST model already *has* the field: `lib/update.js`
   `toSQL` emits `FROM` (`tablesToSQL(from)`). Only the sqlite *grammar*
   (PeggyJS, compiled into `index.js`) lacks the `FROM` production. Closing it is
   a **grammar edit + rebuild**, not a fork of the whole parser: add a
   `from`-clause alternative to the sqlite UPDATE production (mirroring the
   postgres/other-dialect productions that already accept it), then regenerate.
   Because the AST node already exists, no extraction layer changes.

   - **Cost:** one grammar production + one parse test, against an upstream
     repo (`taozhi8833998/node-sql-parser`) we do not control. Either an
     upstream PR (review latency, may not land) or a vendored patch
     (`patch-package` / a fork) that must be re-applied on every version bump.
     Not free, but bounded: it is the same shape of cost we already carry for
     the FTS5 `normalizeVirtualTable` rewrite, only upstream instead of local.

2. **`ALTER COLUMN "a" TO "a" <type>`** — no SQL parser will ever read it. The
   correct treatment is the one we already apply to Drizzle's other marker,
   `--> statement-breakpoint`: recognize the directive as no-fact (a type change
   adds no column name — the column already exists — and no table lifecycle op),
   not as a parse failure. A `NO_FACTS`-style rewrite for the Drizzle
   `ALTER COLUMN … TO …` shape is small and self-contained.

3. **Reserved-word aliases** (`SELECT 1 AS group`) — node-sql-parser rejects these
   with an *explicit* check ("`group` is a reserved word, can not as alias
   clause"), and backtick-quoting is the accepted spelling (`AS \`group\`` parses).
   It does not currently appear in any corpus, so it is a latent gap, not a
   residual. If it ever appears, the rewrite is a quote-the-alias normalization —
   same family as the ones above, not a parser change.

4. **Backslash-escaped identifiers** (`` `a\`b` ``) — a MySQL-ism, not valid
   SQLite; correctly out of scope for the sqlite grammar.

### The "different parser" option, costed

If the residual must be **zero** and grammar patching is off the table, the answer
is replacing node-sql-parser with SQLite's own parser (the one `better-sqlite3` /
`sql.js` / `@sqlite.org/sqlite-wasm` already embed). That is a real cost, stated
here rather than implied:

- **No AST.** SQLite's parser yields no node-sql-parser-style tree; it validates
  and produces a bytecode program. Every fact walker (`collectRelations`,
  `whereFacts`, `isWriteStatement`, `ddlColumnDefinitions`, `ddlMigrationOps`)
  is written against the node-sql-parser AST shape and would need a rewrite
  against a SQLite-native surface (`sqlite3`'s C API, or `sql.js`'s statement
  introspection) that does not expose relations/where-clauses the same way.
- **Bindings.** A native C library means a platform binary (WASM or N-API) in the
  shipped package — exactly the native-compilation surface this project's WASM-
  grammar design exists to avoid.
- **Cost class.** Roughly a rewrite of `sqlAst.ts`'s relation/where/write/ddl
  walkers plus a new binding layer, versus the *grammar patch + one no-fact
  rewrite* that closes the actual residual. The residual is 3 statements in one
  corpus; the grammar patch is the proportionate fix.

## Disposition

- `UPDATE … FROM` and `ALTER COLUMN … TO` are the only intractable residue, and
  neither is a `clean` miss — each reports `cannot-fire` with a named reason.
- The proportionate fixes are (1) an upstream grammar patch for `UPDATE … FROM`,
  and (2) a Drizzle-directive no-fact recognition for `ALTER COLUMN … TO`. Both
  are recorded here as findings with their cost; neither is a ceiling.
- This file replaces the two `known-issues.md` SQL entries, which were deleted
  (wrong category: a fixable parser gap filed as a permanent limitation).
