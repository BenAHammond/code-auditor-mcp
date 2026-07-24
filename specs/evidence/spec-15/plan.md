# Spec 15 — Cross-Domain Joins: Implementation Plan

**Date**: 2026-07-24

## Context

Spec 15 adds cross-domain analysis that no single per-file analyzer can perform alone: schema lifecycle detection (written-never-read, read-never-written, transaction-boundary risk), ORM-aware schema extraction, validation-bypass detection, and coverage-by-importance. **All detectors enter at `suggestion` severity** per the entry rule (new detectors earn higher tiers through Spec 11 R5 recalibration bars: ≥0.95 precision AND ≥0.90 judged-true → promote one tier; <0.50 judged-true → disable). Spec 14 is complete and tagged — `graph_cache` and `schema_usage` tables exist, call-graph traversal patterns (BFS) are proven.

**Pre-existing infrastructure**: Spec 21 provenance module at `src/analyzers/provenance.ts` provides `VALIDATOR_PACKAGES` (9 packages: zod, joi, ajv, valibot, class-validator, yup, typebox, superstruct, io-ts), `buildProvenanceContext()`, and `isValidatorProvenanced()`. This is the **primary validator detection mechanism** for R3 — not English name globs.

**Stated product limit**: No dataflow/taint analysis. "Reach" = call-graph membership, not value flow.

## Architecture

### New modules

| File | Purpose |
|------|---------|
| `src/analyzers/crossDomain/CrossDomainAnalyzer.ts` | R1+R3: post-analysis DB queries joining schema_usage + graph_cache + functions |
| `src/analyzers/crossDomain/__tests__/CrossDomainAnalyzer.test.ts` | Unit tests for R1+R3 detectors |
| `src/analyzers/orm/adapterRegistry.ts` | R2: ORM adapter registry |
| `src/analyzers/orm/drizzleAdapter.ts` | R2: Drizzle ORM schema/query extraction |
| `src/analyzers/orm/prismaAdapter.ts` | R2: Prisma ORM schema extraction |
| `src/analyzers/orm/__tests__/ormAdapters.test.ts` | Unit tests for Drizzle + Prisma extraction |
| `src/analyzers/orm/types.ts` | R2: ORM adapter interface (`OrmAdapter`) |
| `src/coverage/lcovParser.ts` | R4: Parse lcov `.info` files |
| `src/coverage/istanbulParser.ts` | R4: Parse istanbul JSON |
| `src/coverage/coverageService.ts` | R4: Store/query coverage in SQLite |
| `src/coverage/__tests__/parsers.test.ts` | Unit tests for lcov + istanbul parsers |
| `bench/corpus/cross-domain/expected.json` | R5: Ground truth manifest |
| `bench/corpus/cross-domain/src/*.ts` | R5: Fixture source files |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts` | New types for cross-domain entries, coverage, ORM |
| `src/codeIndexDB.ts` | SCHEMA_VERSION → 7, `coverage_data` table, migration |
| `src/analyzers/universal/UniversalSchemaAnalyzer.ts` | schema_usage recording, txnTableMax config, post-analysis phase |
| `src/auditRunner.ts` | cross-domain analyzer entry, config forwarding |
| `src/config/defaults.ts` | cross-domain and coverage configs |
| `src/cli.ts` | coverage commands |
| `src/services/CodeMapGenerator.ts` | coverage section |
| `src/scripts/runBench.ts` | cross-domain bench entry |
| `bench/baselines/baseline.json` | cross-domain entry |
| `src/__tests__/bench.test.ts` | expectedAnalyzers update |

## R1 — Schema Lifecycle Findings

**Population**: After `findTableReferences()` extracts table names + usage types, write each reference to `schema_usage`. Usage types: `select`, `insert`, `update`, `delete`, `create`, `reference`.

**Post-analysis** (CrossDomainAnalyzer.analyze()):
- **Written-never-read**: Tables with INSERT/UPDATE/CREATE but zero SELECT → `suggestion`
- **Read-never-written**: Tables with SELECT but zero INSERT/UPDATE/CREATE → `suggestion`
- **Transaction-boundary risk**: Functions with ≥ `txnTableMax` (default 4) distinct tables written (including depth-1 callees via graph_cache BFS) → `suggestion`

## R2 — ORM-Aware Schema Extraction

- `OrmAdapter` interface with `extractTableReferences()` and `extractSchemaDefinitions()`
- `OrmAdapterRegistry` (same shape as LanguageAdapter registry)
- Drizzle adapter: `pgTable`/`mysqlTable`/`sqliteTable` schema extraction, `.select().from()` query extraction
- Prisma adapter: `schema.prisma` parsing, `prisma.model.operation()` query extraction

## R3 — Validation-Bypass Detection

**Primary — provenance-based detection:**
1. Query `functions` for files importing `VALIDATOR_PACKAGES`
2. All exported functions from provenanced files = validators
3. Deduplicate by function ID

**Conjunctive fallback**: Zero provenance-detected validators AND no user config → `name GLOB 'validate*' OR name GLOB 'assert*'`

**Detection**: For each directory with ≥ `minCorpus` writers — if ≥ `modeShare` of peers reach a validator (BFS depth ≤ 3 in call graph), flag writers that reach none → `suggestion`

## R4 — Coverage by Importance

- New `coverage_data` table in SQLite
- lcov + istanbul parsers, auto-detect format on import
- `code-audit coverage --import <path>`, `coverage --by-risk [--json]`
- Exported functions in top risk decile with no coverage → `suggestion`
- Static-reach fallback when no measured coverage data

## R5 — Measurement

- Bench fixtures for all detectors (all severity: suggestion)
- Metrics-only expected.json (kind: "metrics")
- Sweep: txnTableMax [2..10], modeShare [0.5..0.95], depth [1..5]

## Implementation order

1. Types → 2. Schema migration → 3. R1 population → 4. R1 post-analysis → 5. R2 ORM adapters → 6. Unit tests R1+R2 → 7. R3 validator bypass → 8. R3 CLI inspectability → 9. Unit tests R3 → 10. R4 coverage module → 11. R4 CLI → 12. R4 CodeMap → 13. Unit tests R4 → 14. Cross-domain wiring → 15. Bench fixtures → 16. Bench runner → 17. Baseline → 18. Bench test → 19. Docs → 20. Evidence bundle → 21. Tag
