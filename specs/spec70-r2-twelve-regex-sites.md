# Spec 70 R2 — twelve regex sites → sqlAst (grep proof)

The bar this release holds is: **a regex that answers an unanswerable question is
worse than honest `cannot-fire`.** Every SQL-*content* fact the old regexes
guessed at — which tables, is it a write, is it filtered, is it tenant-scoped,
which columns does a DDL declare — is now derived from a `node-sql-parser` AST.
Nothing stays on a SQL-content regex.

This document is the grep proof that the twelve R2 bodies are **gone, not
wrapped**. "Wrapped" means the old regex survives under the same or a new name
and still runs; "gone" means the body was deleted and a `parseSql`-derived
function takes its place. Three independent greps establish the former:

1. **Identifier sweep** — every old site identifier, grepped across non-test
   `src/`, appears only inside a comment/docstring (an obituary naming the
   replacement), or as a legitimate survivor whose meaning changed (see
   "Survivors" below). No `function <oldName>` / `const <oldName>` definition
   remains for any converted site.
2. **Deleted-body diff** — `git diff` on the two former homes
   (`UniversalDataAccessAnalyzer.ts`, `schema/migrations.ts`) shows each regex
   literal / hand-rolled scanner as a `-` (deleted) line.
3. **Distinctive-fragment absence** — the pattern fragments that were the old
   bodies (`REPLACE\s+INTO`, `ON\s+CONFLICT`, `UPDATETABLE`, `VIRTUAL\s+TABLE`,
   `FOREIGN\s+KEY\s*`, the `alwaysTrue` tautology builder, `containsSQLKeywords`
   aside) are absent from non-test `src/`.

## The twelve sites

`sqlAst.ts` line numbers are the AST replacements; every one takes a parsed
`AST` (node-sql-parser statement), never text.

| # | site | old body (deleted) | AST replacement |
| --- | --- | --- | --- |
| 1 | `extractTables` | regex walk of FROM/JOIN over SQL text | `collectRelations` `sqlAst.ts:452`; `extractTableNames` `sqlAst.ts:537` |
| 2 | `hasQueryFilter` + `whereClauseIsTautology` | `/\bWHERE\b/…/\bHAVING\b/…/\bLIMIT\b/` + a `new RegExp(\`^${alwaysTrue}…\`)` tautology builder | `whereFacts` `sqlAst.ts:594` → `hasWhere` / `whereIsTautology` |
| 3 | `hasWriteVerb` (+ `hasMassWriteVerb`, `isUpsertForm`) | `/\bINSERT\b/ \|\| /\bDELETE\b/ … /\bREPLACE\s+INTO\b/`, `/\bUPDATE\s+\S+\s+SET\b/`, `/\bON\s+CONFLICT\b/ …` | `isWriteStatement` `sqlAst.ts:614`; `isMassWriteStatement` `:623`; `isUpsertStatement` `:633` |
| 4 | `containsSQLStructure` | keyword-scan that drove table extraction | obviated — SQL-ness is `parseSqlProgram`'s verdict; only the `.includes()` candidate gate remains (below) |
| 5 | `hasOrganizationFilter` (raw-SQL arm) | `comparisonRe = new RegExp(\`\\b${alt}\\b\\s*(?:=\|!=\|…\|IN\|LIKE)\`)` + `.test()` | `whereColumnRefs` `sqlAst.ts:672`; `hasTenantPredicate` `:715` |
| 6 | `isRawSqlInsert` / `rawInsertColumnList` | functions regexing `INSERT … VALUES` column lists | `ResolvedQuery.isRawInsert` (bool) + `insertColumns` `sqlAst.ts:653` → `insertColumns: string[] \| null` |
| 7 | `DDL_RE` | one giant `CREATE\|DROP\|ALTER … TABLE` state-machine regex | `isDdlStatement` `sqlAst.ts:727`; `ddlTableNames` `:735` |
| 8 | `DDL_PRESENCE_RE` | `/(?:CREATE\|DROP\|ALTER)\s+(?:VIRTUAL\s+)?TABLE/i` + `.test()` | obviated — `kindOf` `sqlAst.ts:1032` / `isDdlStatement` classify a parsed statement |
| 9 | `extractDdlTableColumns` + `leadingColumnName` + `splitColumnDefs` | hand-rolled paren-depth + quote-tracking scan, plus `/^\s*(?:CONSTRAINT…)?\s*(`…`\|"…"\|\\w+)/` | `ddlColumnDefinitions` `sqlAst.ts:821`; `ddlConstraintColumns` `:1005` |
| 10 | FK-constraint regexes (`fkRe`) | `/\bALTER\s+TABLE…FOREIGN\s+KEY\s*\(([^)]*)\)\s+REFERENCES/gi` | `ddlForeignKeys` `sqlAst.ts:922` |
| 11 | `checkQuerySecurity` | **not converted** — host-language injection-surface detection | unchanged (`UniversalDataAccessAnalyzer.ts:1912`) |
| 12 | `extractTablesFromRegistry` | **already AST** — walked the registry, not SQL text | unchanged (`schema/discovery.ts:440`) |

## Survivors — identifiers that remain, and why they are not a conversion miss

**`hasOrganizationFilter` (`orgFilterTiers.ts:170`, 20 refs).** Only the
*raw-SQL comparison arm* was a SQL-content regex, and that arm is gone (site #5).
What remains is the ORM host-language shape detector — `eq(org_id, v)`,
`where({ org_id })`, `where('org_id', x)`. Those shapes have **no SQL text to
walk**; the org column appears as an ORM argument, not a `WHERE org_id = ?`
clause. They are host-language detection, out of R2's scope, and their tenant
vocabulary is the same `orgPredicateVocabulary` the AST arm uses (`whereColumnRefs`),
so the two halves cannot disagree (§69 Fix 1).

**`checkQuerySecurity` (`UniversalDataAccessAnalyzer.ts:1912`, 6 refs).** Site
#11, explicitly not converted. It reads the *host-language* construction of the
query argument — `+` concatenation, `${…}` interpolation, dynamic string building
— to answer "is this SQL injectable?", a question about the JS/TS code, not the
SQL text. Conversion would require parsing the source, not the SQL; it stays as
is. Its one use of `containsSQLKeywords` (`:1935`) is the *only* remaining call
after the SQL-ness admission role was deleted (§11).

**`extractTablesFromRegistry` (`schema/discovery.ts:440`, 6 refs).** Site #12,
already AST-shaped — it walks a populated schema registry to resolve
import/table references, not a SQL string. Nothing to convert.

**`containsSQLKeywords` (`UniversalDataAccessAnalyzer.ts:1019`).** Not the old
`containsSQLStructure`. It is `SQL_KEYWORDS.some(k => upperText.includes(k))` — a
substring *presence* gate, not a regex and not a fact extractor. Its **SQL-ness
admission role is deleted post-R2** (entry §11 in the worklist): the
`buildDatabaseCall` line that admitted a parse-failed static string on
`containsSQLKeywords(sqlArg)` was a name list doing the parser's job — it
silently dropped keyword-less SQL (`PRAGMA`, `VACUUM`, `ANALYZE`) that provenance
already established as SQL, the opposite of honest `cannot-fire`. That decision
is now provenance/shape/tag-based (`isSqlPosition`). What remains is a single
call site in `checkQuerySecurity` (site #11, `:1935`): deciding whether a
*dynamically-constructed* string carrying SQL keywords is an injection surface —
a host-language dataflow question, not a SQL-ness admission.

## Regex that legitimately remains (not SQL-content fact extraction)

Three regex classes survive the sweep. None answers an unanswerable question;
each is either input *normalization* (documented in `spec70-parse-failure-measurement.md`)
or *host-language* lexical scanning.

- **Input normalization in `sqlAst.ts`** — statement splitting, `?n`→`?`
  positional-parameter rewrite (`/\d/`), trailing-`;` trim, and the
  `{{…}}` template-placeholder classifier. These turn text into *parseable*
  text; the AST then answers the questions.
- **Host-language literal extraction** — `extractDdlSqlFromSource`
  (`migrations.ts:563`) finds a JS string/template literal that carries a
  `CREATE/DROP/ALTER TABLE` header and hands the extracted text to
  `parseMigrationOps` / `extractDdlTableColumns`. It names *strings in JS
  source*, not tables in SQL; the docstring states this is "NOT itself a SQL
  parse."
- **ORM/injection shape detection** — `hasOrganizationFilter` (ORM arm),
  `checkQuerySecurity`, `extractOrmTables`, `builderWriteVerb`: all read the
  host-language call shape, never SQL text.

## Result

Twelve SQL-content regex bodies are deleted and replaced by
`node-sql-parser`-derived facts in `src/languages/sql/sqlAst.ts`. A SQL string
that will not parse yields **no** SQL-content facts — it `cannot-fire` rather
than have a regex guess at it. Full suite green (222 files / 2475 tests, 0
failures) after the dialect-threading fix; `tsc --noEmit` clean.
