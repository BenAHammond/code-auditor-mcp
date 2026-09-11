# Extractor → Consuming-Rule Map

Spec 53 R4. When a shared extractor changes, *which rules read its output?* This
map answers that from the code today, so a change to an extractor has a known set
of rules to re-measure — rather than being discovered by a corpus delta three
commits later.

The map was produced by tracing call sites (not by reading docs). File:line
references are to `app/src/`.

---

## 1. SQL table parser — `parseSqlTables` / `sqlTablePatterns` / `matchSqlPatterns`

- **Definition**: `analyzers/universal/schema/codeAnalysis.ts:269` (`parseSqlTables`),
  `:202` (`sqlTablePatterns`), `:218` (`matchSqlPatterns`).
- **Callers**: `findTableReferences` (`codeAnalysis.ts:42`) — three call sites at
  `:58` (whole-source migration scan), `:97` (template-literal SQL), `:137`
  (string-literal SQL argument).
- **`findTableReferences` consumers**:
  - `UniversalSchemaAnalyzer.analyze` (`analyzers/universal/UniversalSchemaAnalyzer.ts:172`)
  - `pipelineAdapters.ts:2249` (same schema path, dispatcher-side)
- **Consuming rules**:
  | rule | production site |
  | --- | --- |
  | `schema::unknown-table` | `UniversalSchemaAnalyzer.ts:364`, `codeAnalysis.ts:725` |
  | `schema-code::table-naming-convention` | `codeAnalysis.ts:457` |
  | `cross-domain::cross-domain/written-never-read` | via `recordTableUsage` → `schema_usage` (`UniversalSchemaAnalyzer.ts:206`) |
  | `cross-domain::cross-domain/read-never-written` | via `schema_usage` |
  | `cross-domain::cross-domain/multi-table-write` (transaction boundary) | `CrossDomainAnalyzer.ts:546` via `expandWrittenTables` |

---

## 2. Query counter — `countQueries` / `stripQueryCallBodies`

- **Definition**: `analyzers/universal/schema/codeAnalysis.ts:1023` (`countQueries`),
  `:1051` (`stripQueryCallBodies`).
- **Caller**: `analyzeTooManyQueries` (`codeAnalysis.ts:484`), reached through
  `appendSchemaViolations` (`UniversalSchemaAnalyzer.ts:179`).
- **Consuming rule**: `schema-code::too-many-queries` (`codeAnalysis.ts:512`).

---

## 3. SQL write-verb classification — DUPLICATED across four sites ⚠️

This is the blast radius that Spec 52 R2 hit. The concept "`INSERT [OR …] INTO` /
`REPLACE INTO` is a write" is encoded independently in **four** places, and they
drift. A change to the write classification must touch *all four* — there is no
single source of truth:

| site | shape | feeds |
| --- | --- | --- |
| `sqlTablePatterns` INSERT/REPLACE pattern | `codeAnalysis.ts:206` (regex, `\b`-anchored) | table extraction → the five rules in §1 |
| `countQueries` `sqlPatterns` INSERT/REPLACE pattern | `codeAnalysis.ts:1029` (regex, **not** `\b`-anchored) | `too-many-queries` (§2) |
| `hasWriteVerb` | `UniversalDataAccessAnalyzer.ts:1377` (`\bINSERT\b \| \bDELETE\b \| \bUPDATE\b \| \bREPLACE\s+INTO\b`) | `unfiltered-query` gate (`isUnfilteredQuery`) |
| `hasSqlTag` | `analyzers/universal/schema/discovery.ts:351` (`sql\`INSERT\|REPLACE\|UPDATE\|DELETE\|CREATE`) | file gate (`passesFileGate`) |

The Spec 52 R2 change (`INSERT OR IGNORE`/`OR REPLACE`/`REPLACE INTO` recognized as
writes) edited the first two sites and was already satisfied by the `\bINSERT\b` /
`INSERT` keyword in the last two — but the *second* site's `UPDATE` bare-SQL pattern
double-counted the upsert's `DO UPDATE` clause, a regression found only by corpus
re-measurement. §3 is the reason R4 exists.

---

## 4. Import resolvers — two independent implementations

**4a. Schema/table-source resolver** (`resolveImportMap` / `resolveImportedName`)

- **Definition**: `analyzers/universal/schema/discovery.ts:479` / `:527`.
- **Callers**: within `discovery.ts` (`:452`, `:653`) during table-source discovery
  (`discoverTablesFromMigrations` and friends).
- **Consuming rules**: the discovered table names enter `allTables`, which gates the
  same schema + cross-domain rules as §1 (`unknown-table`, `written-never-read`,
  `read-never-written`, `multi-table-write`).

**4b. Dependency-graph resolver** (`buildImportGraph` / `resolveDependency`)

- **Definition**: `graph/importGraph.ts:52` / `:142`.
- **Consumers**: `pipelineAdapters.ts`, `cli.ts`, `codeIndexDB.ts`,
  `graph/outputFormatter.ts`, `services/CodeMapGenerator.ts`,
  `analyzers/cross-language/DependencyGraphBuilder.ts`.
- **Consuming rules** (`DependencyGraphBuilder.ts`, via `issueType`):
  `orphaned-nodes`, `unreferenced-module`, `hub-nodes`, `circular-dependency`,
  `tight-coupling`.

These two import resolvers share a name but no code — a change to one never fixes
the other. If import resolution is reworked, both must be considered.

---

## 5. Language router — `getLanguageFromPath`

- **Definition**: `utils/fileDiscovery.ts:178`.
- **Consumers**: `pipelineAdapters.ts`, `functionScanner.ts`, `auditRouter.ts`,
  `utils/fileDiscovery.ts`.
- **Consuming rules**: none directly — it selects the `LanguageAdapter` (TypeScript /
  Go / CSS), which determines *which analyzers run at all*. A path-mapping change
  silently moves files between the TS pipeline, the Go subprocess, and the styles
  analyzer.

---

## 6. Style declaration extractor — `extractDeclarations` / `extractDeclarationsFromCSSAst`

- **Definition**: `styles/styleExtractor.ts:38` (`extractDeclarations`),
  `styles/cssAstExtractor.ts:493` (`extractDeclarationsFromCSSAst`).
- **Callers**: `styles/styleIndexer.ts:15` / `:225`, `pipelineAdapters.ts:704` / `:758`.
- **Consuming rules** (all in `analyzers/universal/UniversalStylesAnalyzer.ts`):
  `styles/value-drift`, `styles/off-scale`, `styles/undefined-class`,
  `styles/undefined-class-disabled`, `styles/mechanism-fragmentation`,
  `styles/mechanism-mixing`, `styles/declaration-set-similarity`,
  `styles/token-bypass`, `styles/z-index-sprawl`, `styles/z-index-singleton`.

---

## Re-measure checklist

When any extractor above changes, the rules to re-measure (per the corpus
`specs/corpus-baselines.md`) are:

- `parseSqlTables` / `sqlTablePatterns` → `unknown-table`, `table-naming-convention`,
  `written-never-read`, `read-never-written`, `multi-table-write`.
- `countQueries` / `stripQueryCallBodies` → `too-many-queries`.
- `hasWriteVerb` → `unfiltered-query`.
- `hasSqlTag` → the file gate (changes *which files* are analyzed, so effectively
  every schema rule's population).
- `buildImportGraph` / `resolveDependency` → `orphaned-nodes`, `unreferenced-module`,
  `hub-nodes`, `circular-dependency`, `tight-coupling`.
- `getLanguageFromPath` → the analyzer set (TS vs Go vs styles).
- `extractDeclarations` → all `styles/*` rules.
