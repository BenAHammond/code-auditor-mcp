# Spec 70 — the SQL grammar gap, and what a different parser costs

This is a **finding**, not a board. The `known-issues.md` "node-sql-parser
rejects valid sqlite" entries were filed under the wrong category: they were a
defect, and the defect is fixed by *normalizing the declared input before the
parse* — the same move that closed `text(N)`. This document records (1) what
that pass closed, (2) the two genuine grammar gaps normalization cannot and
should not cover, and (3) the costed different-parser option, for Ben to decide.
Nothing here is a ceiling; nothing here records "a shape we accept not handling".

## 1. The normalization pass is closed — every listed shape is accounted for

Every rewrite below is an *input* rewrite, not a regex fallback: it changes a
spelling node-sql-parser rejects into an equivalent spelling it accepts, without
changing anything a rule reads (tables, filters, statement kind).

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

The remaining shapes Ben listed — *mixed quoting* and *escaped identifiers* —
were probed against SQLite 3.51.0 and are **not gaps**, so there is nothing to
normalize:

- **Mixed quoting** (`"a"` vs `` `b` `` in one statement): both node-sql-parser
  and SQLite accept it. Parses today.
- **Backslash-escaped identifiers** (`` `a\`b` ``): both reject it. It is a
  MySQL-ism, not valid SQLite, so node-sql-parser is correct to reject it.

## 2. Genuine grammar gap 1 — `UPDATE … FROM` (fires in one corpus)

```sql
UPDATE `status_report` SET `page_id` = `t`.`page_id`
  from (select `page_id`, `status_report_id` from `status_reports_to_pages`) `t`
  where `t`.`status_report_id` = `id`;
```

This is genuine SQLite 3.33+ (`UPDATE … FROM`, added 2020-08-14). The grammar's
sqlite UPDATE production stops after the `SET` expression and rejects the `FROM`
token. A plain `FROM t` (no subquery) fails the same way, so it is the clause,
not the subquery. It fires: openstatus's Drizzle migration `0034_serious_shard.sql`
contains it.

Normalization cannot cover it: `FROM` here is a whole clause carrying relation
facts, not a spelling variant. Rewriting it to the pre-3.33 subquery form is a
semantics-preserving transformation a regex cannot do — that is "write a second
parser", which is the boundary of §4.

## 3. Genuine grammar gap 2 — reserved-word aliases (over-broad keyword list, zero corpus occurrence)

An earlier note treated this as "latent, not a gap" on the strength of
`SELECT 1 AS group`, which **both** parsers reject. That was too narrow. Probing
node-sql-parser's actual alias check across the standard SQL keyword vocabulary
shows its sqlite reserved-word list is **over-broad**: seventeen words are valid
SQLite aliases that node-sql-parser rejects —

`asc`, `by`, `current_date`, `current_time`, `current_timestamp`, `desc`, `end`,
`explain`, `full`, `inner`, `left`, `like`, `outer`, `recursive`, `rename`,
`right`, `with`.

`SELECT 1 AS left` and `SELECT 1 AS with` are valid SQLite 3.51.0 and fail
node-sql-parser with the explicit "reserved word, can not as alias clause" error.
Quoting the alias (`AS "left"`, `AS \`with\``) parses and is lossless for fact
extraction, so the divergence *could* be normalized. Two reasons it should not be:

1. **Zero occurrence.** `AS <word>` for all seventeen words greps to **0 matches**
   across the four live corpora and the pinned scratch clones. A normalizer that
   never fires is dead code.
2. **Footgun.** A quote-the-alias rewrite is unlike every normalizer above: those
   target narrow, unambiguous spellings (`text(N)`, `ESCAPE '\'`), while these
   words dominate *non-alias* positions (`ORDER BY`, `GROUP BY`, `LEFT JOIN`,
   `WITH … AS`, `CASE … END`, `EXPLAIN`, `RENAME TABLE`). A regex that quotes them
   only in alias position is a mini-parser, which is the same boundary as §2.

This is the same class of defect as §2 — node-sql-parser's sqlite grammar does
not match SQLite — not a spelling variant. It belongs in the grammar-patch option
below, not in a normalizer.

### The Drizzle directive is not a parser gap

`ALTER TABLE … ALTER COLUMN "a" TO "a" <type>` (openstatus `0041`, `0064`) is
**not valid SQLite at all** — SQLite's `ALTER TABLE` has RENAME / RENAME COLUMN /
ADD COLUMN / DROP COLUMN, and no `ALTER COLUMN … TO …`. It is Drizzle-kit's own
migration directive for a column-type change, which drizzle-kit's migrator
rewrites into a table-rebuild. No SQL parser understands a proprietary migration
DSL; only drizzle-kit does. So it is a *Drizzle-directive recognition* question
(the same treatment as `--> statement-breakpoint`), not a parser gap — it will
never parse, and it should not be counted against any SQL parser.

## 4. The finding — what a different SQL parser costs

For the two genuine grammar gaps (§2, §3), the answer is either fix the grammar
or replace the parser. Costed:

### Option A — patch node-sql-parser's sqlite grammar (proportionate)

The AST model already carries both surfaces: `lib/update.js` `toSQL` emits `FROM`
(`tablesToSQL(from)`), and the alias check is a single reserved-word list. Closing
them is a **grammar edit + rebuild**, not a fork:

- `UPDATE … FROM`: add a `from`-clause alternative to the sqlite UPDATE
  production (mirroring the postgres/other-dialect productions that already
  accept it). The AST node exists, so no extraction-layer change.
- reserved-word aliases: prune the sqlite reserved-word list to SQLite's actual
  set. Because the fact walkers read relation/where/statement-kind, not alias
  names, a narrowed list changes nothing downstream.

- **Cost:** two grammar edits + parse tests, against an upstream repo
  (`taozhi8833998/node-sql-parser`) we do not control — either an upstream PR
  (review latency, may not land) or a vendored patch (`patch-package` / fork)
  re-applied on every version bump. Bounded; the same shape of cost already
  carried for the FTS5 `normalizeVirtualTable` rewrite, only upstream instead of
  local.

### Option B — tree-sitter SQL grammar

The project already ships web-tree-sitter WASM grammars for TypeScript/Go, so a
`tree-sitter-sql` grammar fits the loader architecture. But it is the wrong tool
for this job:

- **Syntax tree, not a semantic AST.** node-sql-parser yields resolved relations,
  where-clauses, statement kind, and DDL definitions; tree-sitter yields concrete
  syntax nodes. Every fact walker (`collectRelations`, `whereFacts`,
  `isWriteStatement`, `ddlColumnDefinitions`, `ddlMigrationOps`) is written
  against the AST shape and needs a full rewrite against CST nodes.
- **Dialect coverage.** `tree-sitter-sql` is MySQL/PostgreSQL-flavored with thin
  SQLite coverage — it would *reintroduce* the exact class of gap being closed,
  in a different dialect.
- **Cost:** a rewrite of `sqlAst.ts`'s relation/where/write/ddl walkers plus new
  CST queries, to fix two grammar gaps.

### Option C — SQLite's own parser (sql.js / @sqlite.org/sqlite-wasm)

The only parser guaranteed to match SQLite is SQLite. But:

- **No AST.** SQLite validates and produces a bytecode program; it exposes
  relations/where-clauses only through the C API (`sqlite3_*` authorizer/vtab
  hooks) or `sql.js` statement introspection — neither maps onto the walkers'
  current inputs. The fact walkers still need a rewrite, now against a
  SQLite-native surface.
- **Binding.** A native C library is a platform binary (WASM or N-API) in the
  shipped package — precisely the native-compilation surface the WASM-grammar
  design exists to avoid.
- **Dialect.** SQLite-only: the polyglot adapter loses whatever the current
  parser covered for other dialects.

### What any swap changes about existing dispositions

Every disposition a swap re-derives — `handle` / `not-handle` / `unproven` /
`cannot-fire`, plus DDL lifecycle facts — feeds the pinned measurement baselines
(`oracle-shortfalls`, `extraction-completeness`, `recall-value-drift`). A parser
swap changes *which* statements parse and therefore which facts emit, so those
baselines would move and need re-recording and re-audit, not just re-running.
Option A is the only option that leaves the AST shape — and therefore the
dispositions — untouched.

## 5. Disposition

- The normalization pass is closed; mixed quoting and escaped identifiers are
  not gaps, and there is nothing left to normalize.
- `UPDATE … FROM` and reserved-word aliases are the two genuine grammar gaps.
  Both report `cannot-fire` today (honest abstain, never a `clean` miss).
- The proportionate fix is **Option A** — a grammar patch that closes both gaps
  at once (one production + one reserved-word-list prune), leaving every existing
  disposition intact.
- The Drizzle `ALTER COLUMN … TO` directive is a separate, non-parser item:
  recognize it as no-fact (a type change adds no column name and no table
  lifecycle op), the same treatment as `--> statement-breakpoint`.
- These are findings with a cost, awaiting Ben's decision — not a ceiling.
