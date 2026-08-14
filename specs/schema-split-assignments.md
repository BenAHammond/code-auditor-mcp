# Spec 34 — Schema Split Assignments

Durable assignment table for splitting `UniversalSchemaAnalyzer.ts` by
responsibility. This document is the only state that survives between sessions:
it maps every class method and module-level function to a target module so the
extraction (Step 2) can resume without re-deriving the plan.

## Target modules

| Module | Status | Responsibility |
| --- | --- | --- |
| `schema/types.ts` | ✅ reconciled | Shared interfaces/types (imports `../../../types.js`) |
| `schema/config.ts` | ✅ reconciled | SQL-context constants + `DEFAULT_SCHEMA_CONFIG` + `escapeRegex` |
| `schema/migrations.ts` | ✅ reconciled | Migration/DDL replay + one-hop barrel re-export resolution |
| `schema/discovery.ts` | ⬜ to extract | Table discovery (migrations/wrangler/schema-files/ORM/registry) + file walking/gating |
| `schema/codeAnalysis.ts` | ⬜ to extract | SQL-context code analysis + AST/source helpers |
| `schema/jsonSchema.ts` | ⬜ to extract | JSON-schema validation (module-level functions at file tail) |
| `schema/violations.ts` | ⬜ to extract | Violation construction (`createSchemaViolation`, `emitViolation`) |

Dependency direction is leaf → parent, no cycles:

```
violations.ts ──(types.js)
discovery.ts ──(types, migrations, config, violations)
codeAnalysis.ts ──(types, config, violations)
jsonSchema.ts ──(types, config, violations)
```

None of the four modules import the `UniversalSchemaAnalyzer` class (no cycle
back through the class).

---

## Class methods (lines 90–1843) — assignment

Legend: **MOVE** = extract to module-level free function, delete/replace the
class body. **DELEGATE** = keep a thin class method that calls the free
function (external callers). **STAY** = keep the class method body.

| # | Method | Line | Visibility | Target module | Action | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| — | `_pendingSchemaRecords` | 97 | field | (class) | STAY | instance state |
| 1 | `stripIdentifier` | 104 | public | migrations | DELEGATE | already delegates |
| 2 | `processMigrationSource` | 114 | public | migrations | DELEGATE | already delegates |
| 3 | `applyMigrationOps` | 129 | public | migrations | DELEGATE | external `a.applyMigrationOps` (pipelineAdapters:1300) |
| 4 | `analyze` | 144 | async public | (class) | STAY | entry-point override |
| 5 | `analyzeAST` | 220 | protected async | (class) | STAY | required override; 103-line body → thin orchestrator after extraction |
| 6 | `_walkFiles` | 333 | private async | discovery | MOVE | |
| 7 | `_discoverTablesFromMigrations` | 371 | private async | discovery | MOVE | |
| 8 | `_discoverTablesFromWrangler` | 392 | private async | discovery | MOVE | |
| 9 | `_discoverTablesFromSchemaFiles` | 452 | private async | discovery | MOVE | |
| 10 | `_discoverTablesFromOrmSchemas` | 475 | private async | discovery | MOVE | |
| 11 | `passesFileGate` | 528 | public | discovery | DELEGATE | |
| 12 | `findTableReferences` | 611 | public | codeAnalysis | DELEGATE | |
| 13 | `recordTableUsage` | 721 | public | (class) | STAY | mutates `_pendingSchemaRecords`; refactor to accept state param |
| 14 | `parseSqlTables` | 773 | public | codeAnalysis | DELEGATE | |
| 15 | `extractAliasIdentifiers` | 861 | private | codeAnalysis | MOVE | |
| 16 | `resolveTemplateExpressions` | 921 | private | codeAnalysis | MOVE | |
| 17 | `getNearestTableSuggestions` | 936 | public | codeAnalysis | DELEGATE | |
| 18 | `levenshteinDistance` | 962 | public | codeAnalysis | DELEGATE | pure |
| 19 | `checkNamingConventions` | 994 | public | codeAnalysis | DELEGATE | |
| 20 | `checkQueryPatterns` | 1040 | public | codeAnalysis | DELEGATE | |
| 21 | `checkSQLInjection` | 1091 | public | codeAnalysis | DELEGATE | |
| 22 | `getCallee` | 1151 | private | codeAnalysis | MOVE | |
| 23 | `hasTemplateArgument` | 1170 | private | codeAnalysis | MOVE | |
| 24 | `getTemplateText` | 1184 | private | codeAnalysis | MOVE | |
| 25 | `getFirstStringArgument` | 1198 | private | codeAnalysis | MOVE | |
| 26 | `extractTablesFromRegistry` | 1252 | public | discovery | DELEGATE | |
| 27 | `resolveImportMap` | 1292 | private | discovery | MOVE | |
| 28 | `_resolveImportedName` | 1337 | private | discovery | MOVE | |
| 29 | `getArgStringLiteral` | 1393 | private | discovery | MOVE | |
| 30 | `_extractCalleeTables` | 1433 | private | discovery | MOVE | |
| 31 | `_extractDecoratorTables` | 1499 | private | discovery | MOVE | |
| 32 | `isDbMemberCall` | 1562 | private | codeAnalysis | MOVE | |
| 33 | `getCallLocation` | 1581 | private | codeAnalysis | MOVE | |
| 34 | `offsetToLocation` | 1588 | private | codeAnalysis | MOVE | |
| 35 | `isSystemTable` | 1607 | private | codeAnalysis | MOVE | |
| 36 | `isTableValuedFunction` | 1634 | private | codeAnalysis | MOVE | |
| 37 | `isSqlKeyword` | 1655 | private | codeAnalysis | MOVE | |
| 38 | `isModuleImportFrom` | 1687 | private | codeAnalysis | MOVE | |
| 39 | `countQueries` | 1701 | private | codeAnalysis | MOVE | |
| 40 | `findNodeByLocation` | 1721 | private | codeAnalysis | MOVE | |
| 41 | `findClosestNodeAt` | 1748 | public | codeAnalysis | DELEGATE | |
| 42 | `findEnclosingFunctionName` | 1790 | public | codeAnalysis | DELEGATE | |
| 43 | `getNodeName` | 1818 | private | codeAnalysis | MOVE | |

Method totals by module:

| Module | MOVE | DELEGATE | STAY |
| --- | --- | --- | --- |
| discovery | 12 | 2 (`passesFileGate`, `extractTablesFromRegistry`) | 0 |
| codeAnalysis | 18 | 9 (public API surface) | 0 |
| class (stays) | 0 | 3 (`stripIdentifier`, `processMigrationSource`, `applyMigrationOps`) | 4 (`analyze`, `analyzeAST`, `recordTableUsage` + field) |

---

## Module-level functions (lines 1845–end) — all MOVE to jsonSchema.ts

| Function | Line | Notes |
| --- | --- | --- |
| `ValidationCtx` (interface) | 1853 | JSON context |
| `analyzeJsonSchemas` (export) | 1873 | public entry; must stay exported from main file via re-export |
| `JsonRunState` (interface) | 1905 | |
| `JsonScanCtx` (interface) | 1911 | |
| `jsonResult` | 1918 | |
| `loadSchemas` | 1932 | |
| `validatePairedData` | 1958 | |
| `validateDiscoveredData` | 1986 | |
| `validateJsonSchema` | 2017 | |
| `validateSchemaTypes` | 2043 | |
| `checkSchemaTypeField` | 2062 | |
| `checkNumericRangeField` | 2074 | |
| `identifySchemaFiles` | 2085 | |
| `identifyDataFiles` | 2096 | |
| `findMatchingSchema` | 2107 | |
| `validateAgainstSchema` | 2127 | |
| `actualTypeOf` | 2146 | |
| `matchesSchemaType` | 2152 | |
| `checkStringConstraints` | 2161 | |
| `checkFormatConstraint` | 2181 | |
| `checkNumberConstraints` | 2196 | |
| `checkArrayConstraints` | 2207 | |
| `checkObjectConstraints` | 2223 | |
| `checkUnexpectedProperties` | 2249 | |
| `checkAdditionalProperties` | 2258 | |
| `checkEnumConstraint` | 2267 | |
| `emit` | 2276 | JSON violation emitter (uses `ValidationCtx`) |

---

## violations.ts contents

| Symbol | Source | Notes |
| --- | --- | --- |
| `emitViolation` | line 2288 (existing) | module-level builder; hardcodes `analyzer: 'schema'`, `line:1/col:1`. Keep as-is. |
| `createSchemaViolation` | NEW | module-level equivalent of base `createViolation` (`analyzer: 'schema'` hardcoded, `location` + `symbol?` preserved). Replaces `this.createViolation` in moved `checkNamingConventions`/`checkQueryPatterns`/`checkSQLInjection`/`analyzeAST`. Preserves `rule` identity exactly. |

---

## Risks carried into Step 2

1. **`this.createViolation` → `createSchemaViolation`**: extracted functions must
   not call `this.createViolation`; use the module-level equivalent with
   `analyzer: 'schema'` passed explicitly and identical `rule` strings.
2. **≤100 lines, ≤6 params, CC ≤50** on every extracted free function — the
   extracted functions are themselves SOLID-checked. `RegistryExtractionContext`
   already bundles the triple (filePath + importMap + readModule) to keep
   signatures at 6 params.
3. **No circular imports**: modules import only from `types.ts` / `config.ts` /
   `migrations.ts` / `violations.ts`, never from the class.
4. **Recall baselines**: schema counts must stay **10 (reducer) + 95 (schema-code)**;
   any movement is a silent behavior change.
5. **`analyzeJsonSchemas`** is an exported public symbol — must be re-exported from
   the main file so existing importers keep working.

## Re-export surface (main file, already wired in Step 0)

Values: `parseMigrationOps`, `extractReExports`, `sqlFileHasDdl`,
`extractMigrationOpsFromFile`, `DB_RECEIVER_NAMES`, `DB_CALL_METHOD_NAMES`,
`DB_BINDING_NAMES`, `DB_WRAPPER_NAMES`, `SQL_TAG_NAMES`, `DEFAULT_SCHEMA_CONFIG`.

Types: `SchemaAnalyzerConfig`, `TableReference`, `TableSourceEntry`,
`TableProvenance`, `TableCatalogEntry`, `RegistryExtractionContext`,
`MigrationOp`, `ReExport`.

Additional value to re-export when jsonSchema lands: `analyzeJsonSchemas`.
