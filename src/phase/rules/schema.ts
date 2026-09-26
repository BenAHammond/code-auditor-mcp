/**
 * Spec 68 §3.2 — the schema rules that are pure over extracted facts.
 *
 * Two of the five `schema` rules are a clean reduction over facts the producers
 * already extract: `unknown-table` (schema-usage × table-catalog) and
 * `table-naming-convention` (schema-usage alone). Their violation logic is
 * re-homed verbatim from `UniversalSchemaAnalyzer`'s `checkMissingReferences`
 * and `checkNamingConventions` (in `codeAnalysis.ts`), which are pure functions
 * over a table-reference list and a known-table set — exactly the two facts, so
 * `analyze` never touches a tree, an adapter, or source text.
 *
 * The `needs` declarations here CORRECT the registry's placeholder entries,
 * which said `schema-code` for both: the analyzer walked *references* (usages),
 * not DDL declarations. `unknown-table` reads the known-table catalog too, so
 * it declares `table-catalog` — the §5 corpus fact — alongside `schema-usage`.
 * `unknown-table`'s registry entry also claimed `go`; the Node implementation
 * is TypeScript-shaped and cannot evaluate a Go AST, so this declaration omits
 * `'go'` and the rule reports the honest `notApplicable` on a Go corpus (§9).
 *
 * The pure helpers `isSystemTable` / `isTableValuedFunction` /
 * `getNearestTableSuggestions` are imported from `codeAnalysis.ts` — a Spec-34
 * helper module that, like `orgFilterTiers.ts`, survives §15 because it imports
 * no analyzer class and no pipeline.
 *
 * Not here, by design:
 *   - `stale-table-reference` — distinguishes "dropped in a migration" from
 *     "never existed", which needs a migration-history fact (dropped tables)
 *     that no current producer emits; it lands with the §5 corpus reduction.
 *   - `too-many-queries` — walks function *bodies* to count raw `query(`/
 *     `execute(` call sites, a per-function signal `schema-usage` doesn't carry.
 *   - `dynamic-sql-construction` — walks string-literal/concatenation call
 *     sites, a different extraction than resolved table references.
 *   - The unregistered `reserved-word` emission inside the old
 *     `checkNamingConventions` is dropped: it has no registry entry (no
 *     message/docs/thresholds/samples), so it is an emission with no rule
 *     definition — the inverse of §0's "no emission site", to be disposed in
 *     §13 rather than silently re-homed into the unified `ruleId` model.
 */

import type {
  RuleDefinition,
  Finding,
  SchemaUsageFact,
  TableCatalog,
  ThresholdValues,
} from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import {
  isSystemTable,
  isTableValuedFunction,
  getNearestTableSuggestions,
} from '../../analyzers/universal/schema/codeAnalysis.js';

/** The shared declaration for the TS schema rules in this slice. */
type SchemaUsageNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['schema-usage'];
};

/** `unknown-table` additionally reads the known-table catalog (§5). */
type UnknownTableNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['schema-usage', 'table-catalog'];
};

const META = RULE_REGISTRY;

/** The known-table set from the corpus catalog (case-sensitive, as the old
 *  `collectAllTableNames` built it). */
function knownTableSet(catalog: TableCatalog): Set<string> {
  const names = new Set<string>();
  for (const t of catalog.tables) names.add(t.name);
  return names;
}

/** A usage is a candidate when it is a real table reference, not a fluent
 *  query-builder selector or a system/table-valued function. */
function isRealTableRef(u: SchemaUsageFact): boolean {
  return u.origin !== 'query-builder'
    && !isSystemTable(u.tableName)
    && !isTableValuedFunction(u.tableName);
}

// ── unknown-table ───────────────────────────────────────────────────────────

const unknownTable: RuleDefinition<UnknownTableNeeds> = {
  id: 'unknown-table',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['schema-usage', 'table-catalog'] },
  severity: 'critical',
  message: META['unknown-table'].message,
  docs: META['unknown-table'].docs,
  thresholds: META['unknown-table'].thresholds,
  samples: META['unknown-table'].samples,
  analyze(ctx): Finding[] {
    const usages = ctx.facts['schema-usage'];
    const known = knownTableSet(ctx.facts['table-catalog']);

    const unknownRefs = usages.filter(
      (u) => isRealTableRef(u) && !known.has(u.tableName),
    );
    const knownCount = known.size;
    const unknownCount = unknownRefs.length;

    // R2.4 fail-open: at 0 known tables, or an unknown:known ratio above 10,
    // the catalog is not trustworthy enough to flag individual references.
    if (knownCount === 0 || unknownCount / Math.max(knownCount, 1) > 10) {
      return [];
    }

    const out: Finding[] = [];
    for (const ref of unknownRefs) {
      const suggestions = getNearestTableSuggestions(ref.tableName, known, 2);
      const message = suggestions.length > 0
        ? `Reference to unknown table '${ref.tableName}' (${ref.usageType}). Did you mean: ${suggestions.join(', ')}?`
        : `Reference to unknown table '${ref.tableName}' (${ref.usageType})`;
      out.push({
        ruleId: 'unknown-table',
        severity: 'critical',
        message,
        file: ref.filePath,
        line: ref.line,
        column: ref.column,
        symbol: ref.tableName,
      });
    }
    return out;
  },
};

// ── table-naming-convention ─────────────────────────────────────────────────

const tableNamingConvention: RuleDefinition<SchemaUsageNeeds> = {
  id: 'table-naming-convention',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['schema-usage'] },
  severity: 'high',
  message: META['table-naming-convention'].message,
  docs: META['table-naming-convention'].docs,
  thresholds: META['table-naming-convention'].thresholds,
  samples: META['table-naming-convention'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];

    for (const ref of ctx.facts['schema-usage']) {
      // Fluent-builder references carry a dynamic table string; naming
      // conformance is a property of the schema, not the call.
      if (ref.origin === 'query-builder') continue;

      const isSnakeCase = /^[a-z][a-z0-9_]*$/.test(ref.tableName);
      const isTableSuffix = ref.tableName.endsWith('Table');
      if (isSnakeCase || isTableSuffix) continue;

      out.push({
        ruleId: 'table-naming-convention',
        severity: 'high',
        message: `Table name '${ref.tableName}' should use snake_case convention`,
        file: ref.filePath,
        line: ref.line,
        column: ref.column,
        symbol: ref.tableName,
      });
    }
    return out;
  },
};

/** The two TypeScript schema rules this slice migrates, in registry order. */
export const schemaRules: readonly RuleDefinition<
  SchemaUsageNeeds | UnknownTableNeeds
>[] = [unknownTable, tableNamingConvention];
