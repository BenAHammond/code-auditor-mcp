/**
 * Spec 68 §2.1 — the migrated-rules registry.
 *
 * A rule enters this array only when it satisfies all four migration
 * conditions: it is a `RuleDefinition` with `analyze(ctx)`; every fact it
 * declares has a live producer; the old analyzer path for it is deleted; and a
 * parity test pins its findings against the pre-migration output on a fixture.
 * Partial states are zero — a rule with `analyze(ctx)` written but its old path
 * still live, or with no parity test, is not listed here.
 *
 * The single failing assertion that drives the migration is the size of this
 * array against 100 (spec68-registry-size.spec.ts): it reads 0 today and goes
 * green at 100. A rule is added here in the same edit that deletes its old path
 * and pins its parity test — never before, and never as a placeholder.
 */

import type { RuleDefinition } from '../types.js';
import { solidRules } from './solid.js';
import { dataAccessRules, loopQueryRules } from './dataAccess.js';
import { dependencyGraphRules } from './dependencyGraph.js';
import { schemaValidatorRules } from './schemaValidator.js';
import { documentationRules } from './documentation.js';
import { stylesRules } from './styles.js';
import { crossDomainRules, multiTableWriteRule } from './crossDomain.js';
import { schemaRules, dynamicSqlRules } from './schema.js';
import { schemaJsonRules } from './schemaJson.js';
import { conventionsRules, conventionsExportShapeRules, conventionsImportFormRules } from './conventions.js';
import { dryRules } from './dry.js';
import { securityRules } from './security.js';
import { secretsRules } from './secrets.js';
import { securityDefectRules } from './securityDefects.js';
import { functionBodyRules } from './functionBodies.js';
import { reactRules } from './react.js';
import { fileDocumentationRules } from './fileDocumentation.js';
import { unreferencedModuleRule } from './unreferencedModule.js';
import { goRules } from './goRules.js';

/**
 * The 12 already-pinned rules that are parity-clean on the *full* pipeline
 * (Spec 68 §11.2): 9 SOLID + 3 data-access. Each has `analyze(ctx)`, live
 * producers for every declared fact, and a green parity test pinned on
 * `(file, line, column, rule, severity)`, and flipping it changes nothing a
 * full-pipeline audit reports (composite-fixtures pins the complete set by
 * equality, so a rule whose phase output diverges anywhere stays off this list).
 *
 * The 2 schema rules (`unknown-table`, `table-naming-convention`) land once the
 * `.sql` DDL source (§5) and the provenance-aware `db.query("SELECT …")` string-
 * argument extraction are in: `unknown-table` reads `table-catalog` (now fed by
 * `.sql` migration files via the `ddl-declarations.sql` producer), and
 * `table-naming-convention` reads `schema-usage` (now extracting string-arg
 * references). Their bucket is the one rule-level override in the both-paths
 * re-emission (`table-naming-convention → schema-code`), matching the legacy
 * schema-code visitor's result key.
 *
 * The 8 dependency-graph rules (`circular-dependency`, `break-cycles`,
 * `tight-coupling`, `reduce-coupling`, `hub-nodes`, `split-responsibilities`,
 * `orphaned-nodes`, `review-orphans`) read the `cross-language-entities` fact
 * through `DependencyGraphBuilder` — the same class the legacy Stage-4 reducer
 * ran — so their full-pipeline output is byte-for-byte the reducer's.
 *
 * The 3 schema-validator rules (`schema-field-mismatch`, `missing-field`,
 * `extra-field`) read the same fact through `SchemaValidator`/`extractSchemas`
 * — the same class the legacy Stage-4 reducer ran, and the producer already
 * emits the `parameters`/`metadata.fields` they read, so they need no shape
 * enrichment.
 *
 * The 9th dependency-graph rule, `unreferenced-module` (file-level
 * imports/reachability — RENEW, §8), reads the `file-imports` + `reachability`
 * facts and lands as its own rule in `unreferencedModule.ts`.
 *
 * The remaining 74 land one fact kind at a time (§11.3), and the size drives
 * spec68-registry-size.spec.ts (0 → … → 100).
 */
export const MIGRATED_RULES: readonly RuleDefinition<any>[] = [
  ...solidRules,
  ...dataAccessRules,
  ...loopQueryRules,
  ...dependencyGraphRules,
  ...schemaValidatorRules,
  ...documentationRules,
  ...stylesRules,
  ...crossDomainRules,
  multiTableWriteRule,
  ...schemaRules,
  ...schemaJsonRules,
  ...dynamicSqlRules,
  ...conventionsRules,
  ...conventionsExportShapeRules,
  ...conventionsImportFormRules,
  ...dryRules,
  ...securityRules,
  ...secretsRules,
  ...securityDefectRules,
  ...functionBodyRules,
  ...reactRules,
  ...fileDocumentationRules,
  unreferencedModuleRule,
  ...goRules,
];
