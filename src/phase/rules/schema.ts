/**
 * Spec 68 §3.2 — the schema rules that are pure over extracted facts.
 *
 * Two of the five `schema` rules are a clean reduction over facts the producers
 * already extract: `unknown-table` (schema-usage × resolution) and
 * `table-naming-convention` (schema-usage alone). Their violation logic is
 * re-homed verbatim from `UniversalSchemaAnalyzer`'s `checkMissingReferences`
 * and `checkNamingConventions` (in `codeAnalysis.ts`), which are pure functions
 * over a table-reference list and a known-table set — exactly the two facts, so
 * `analyze` never touches a tree, an adapter, or source text.
 *
 * The `needs` declarations here CORRECT the registry's placeholder entries,
 * which said `schema-code` for both: the analyzer walked *references* (usages),
 * not DDL declarations. `unknown-table` reads the known-table catalog too, so
 * it declares `resolution` — the §5 corpus fact — alongside `schema-usage`.
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
 *   - `too-many-queries` — walks function *bodies* to count raw `query(`/
 *     `execute(` call sites, a per-function signal `schema-usage` doesn't carry.
 *   - The unregistered `reserved-word` emission inside the old
 *     `checkNamingConventions` is dropped: it has no registry entry (no
 *     message/docs/thresholds/samples), so it is an emission with no rule
 *     definition — the inverse of §0's "no emission site", to be disposed in
 *     §13 rather than silently re-homed into the unified `ruleId` model.
 *
 * `dynamic-sql-construction` lives below in a *separate* array: it reads the
 * `dynamic-sql` fact (dangerous query/execute call sites), not `schema-usage`,
 * so its context carries `dynamic-sql` alone — the same producer-before-rule
 * split as `loop-query` next to `data-access`.
 */

import type {
  RuleDefinition,
  Finding,
  SchemaUsageFact,
  ResolutionFact,
  MigrationHistory,
  ThresholdValues,
} from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import { isTestOrSpecPath } from '../../languages/testConventions.js';
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

/** `unknown-table` additionally reads the known-table catalog (§5) and the
 *  migration-history corpus fact (§5) so it can hand dropped tables to
 *  `stale-table-reference` instead of mislabeling them as never-existed. */
type UnknownTableNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['schema-usage', 'resolution', 'migration-history'];
};

/** `stale-table-reference` additionally reads the migration-history corpus fact
 *  (§5) to distinguish "dropped in a migration" from "never existed". */
type StaleTableReferenceNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['schema-usage', 'resolution', 'migration-history'];
};

/** Join a list of names as prose: "a", "a and b", "a, b and c". Mirrors the
 *  legacy `joinEnglish` in pipelineAdapters.ts (not exported). */
function joinEnglish(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const META = RULE_REGISTRY;

/** The known-table set from the corpus catalog (case-sensitive, as the old
 *  `collectAllTableNames` built it). */
function knownTableSet(catalog: ResolutionFact): Set<string> {
  const names = new Set<string>();
  for (const t of catalog.tables) names.add(t.name);
  return names;
}

/** A usage is a candidate when it is a real table reference, not a fluent
 *  query-builder selector, a system/table-valued function, or a host-language
 *  template substitution. The `${…}` form is a table name filled in at
 *  query-composition time (`FROM "${this.tableName}"`), not a literal name the
 *  catalog can resolve — the same carve-out `table-naming-convention` already
 *  draws, so a dynamic table name is not misreported as unknown/stale. */
function isRealTableRef(u: SchemaUsageFact): boolean {
  return u.origin !== 'query-builder'
    && !isSystemTable(u.tableName)
    && !isTableValuedFunction(u.tableName)
    && !u.tableName.includes('${');
}

/**
 * The shared unknown-reference set + fail-open guard that BOTH `unknown-table`
 * and `stale-table-reference` compute identically, so a reference lands in
 * exactly one rule: dropped tables partition to `stale-table-reference`, the
 * rest to `unknown-table`. The guard (R2.4) is the legacy fail-open — at 0
 * known tables, or an unknown:known ratio above 10, the catalog is not
 * trustworthy enough to flag individual references, so neither rule fires.
 */
function unknownRefs(
  usages: readonly SchemaUsageFact[],
  catalog: ResolutionFact,
): { refs: SchemaUsageFact[]; knownCount: number; failOpen: boolean } {
  const known = knownTableSet(catalog);
  // Symmetric scoping (#408): a file excluded from schema *declaration* is
  // excluded from schema *reference*. The DDL replay drops `isTestOrSpecPath`
  // files from the known-table set, so a table declared only in a test/spec file
  // reads as unknown; references in those same test/spec files must not then
  // fire `unknown-table`/`stale-table-reference`. Same predicate, both directions.
  const refs = usages.filter(
    (u) => isRealTableRef(u) && !isTestOrSpecPath(u.filePath) && !known.has(u.tableName),
  );
  const knownCount = known.size;
  const failOpen = knownCount === 0 || refs.length / Math.max(knownCount, 1) > 10;
  return { refs, knownCount, failOpen };
}

// ── unknown-table ───────────────────────────────────────────────────────────

const unknownTable: RuleDefinition<UnknownTableNeeds> = {
  id: 'unknown-table',
  analyzer: 'schema',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['schema-usage', 'resolution', 'migration-history'] },
  severity: 'critical',
  message: META['unknown-table'].message,
  docs: META['unknown-table'].docs,
  thresholds: META['unknown-table'].thresholds,
  samples: META['unknown-table'].samples,
  analyze(ctx): Finding[] {
    const known = knownTableSet(ctx.facts['resolution']);
    const { refs, failOpen } = unknownRefs(ctx.facts['schema-usage'], ctx.facts['resolution']);

    // R2.4 fail-open: at 0 known tables, or an unknown:known ratio above 10,
    // the catalog is not trustworthy enough to flag individual references.
    if (failOpen) {
      return [];
    }

    // Dropped tables are `stale-table-reference`'s, not this rule's: the two
    // rules partition the unknown set by the migration-history provenance.
    const dropped = ctx.facts['migration-history'].dropped;

    const out: Finding[] = [];
    for (const ref of refs) {
      if (dropped[ref.tableName]) continue;
      const suggestions = getNearestTableSuggestions(ref.tableName, known, 2);
      const suggestionNames = suggestions.map((s) => s.replace(/^'|'$/g, ''));
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
        resolution: {
          action: suggestionNames.length > 0 ? 'use-known-table' : 'register-or-fix-table',
          summary: suggestionNames.length > 0
            ? `Rename the table reference '${ref.tableName}' to the nearest known table: ${suggestions.join(', ')}.`
            : `The table '${ref.tableName}' is not in the known catalog — register it, or fix the reference to a known table.`,
          symbols: suggestionNames.length > 0 ? suggestionNames : [ref.tableName],
          files: [ref.filePath],
          lines: ref.line != null ? [ref.line] : undefined,
        },
      });
    }
    return out;
  },
};

// ── table-naming-convention ─────────────────────────────────────────────────

const tableNamingConvention: RuleDefinition<SchemaUsageNeeds> = {
  id: 'table-naming-convention',
  analyzer: 'schema',
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
      // A `${…}` template substitution is a host-language table name filled in
      // at query-composition time (`FROM "${this.tableName}"`), not a literal
      // name. The producer reports it accurately; naming conformance is a
      // property of the schema, not the substitution — same carve-out rationale
      // as `query-builder` origin above.
      if (ref.tableName.includes('${')) continue;

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

// ── stale-table-reference ────────────────────────────────────────────────────

/**
 * `stale-table-reference` reads the `migration-history` corpus fact (§5) — the
 * drop-provenance map built by the shared `buildDropProvenance` the legacy
 * schema reducer called — alongside `schema-usage` + `resolution`. It is the
 * partition of the unknown-reference set that `unknown-table` hands off: a
 * reference whose table a migration dropped is a stale code reference (the
 * message names the dropping migration and the tables it introduced as
 * evidence, not proof, of a successor), not a typo.
 *
 * Parity holds by construction: `buildDropProvenance` is the identical pure
 * function the legacy reducer ran, and the message/resolution here are the
 * verbatim emission from `UniversalSchemaAnalyzer` (pipelineAdapters.ts).
 */
const staleTableReference: RuleDefinition<StaleTableReferenceNeeds> = {
  id: 'stale-table-reference',
  analyzer: 'schema',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['schema-usage', 'resolution', 'migration-history'] },
  severity: 'critical',
  message: META['stale-table-reference'].message,
  docs: META['stale-table-reference'].docs,
  thresholds: META['stale-table-reference'].thresholds,
  samples: META['stale-table-reference'].samples,
  analyze(ctx): Finding[] {
    const dropped = ctx.facts['migration-history'].dropped;
    const { refs, failOpen } = unknownRefs(ctx.facts['schema-usage'], ctx.facts['resolution']);
    if (failOpen) return [];

    const out: Finding[] = [];
    for (const ref of refs) {
      const drop = dropped[ref.tableName];
      if (!drop) continue;

      const migrationName = drop.migrationFile.split('/').pop() ?? drop.migrationFile;
      const created = [...drop.createdInSameMigration];
      const message = created.length > 0
        ? `${ref.tableName} was dropped in ${migrationName}; that migration creates ${joinEnglish(created)}.`
        : `${ref.tableName} was dropped in ${migrationName} and was not recreated.`;
      out.push({
        ruleId: 'stale-table-reference',
        severity: 'critical',
        message,
        file: ref.filePath,
        line: ref.line,
        column: ref.column,
        symbol: ref.tableName,
        resolution: {
          action: 'update-stale-reference',
          // `created` are evidence the migration replaced the dropped table, not
          // proof of a drop-in successor — the summary names them as context and
          // leaves update-vs-remove to the reviewer.
          summary: created.length > 0
            ? `The table '${ref.tableName}' was dropped in ${migrationName}. That migration introduces ${joinEnglish(created)} — review this reference and update or remove it.`
            : `The table '${ref.tableName}' was dropped in ${migrationName} and was not recreated — update or remove this reference.`,
          symbols: created.length > 0 ? created : [ref.tableName],
          files: [ref.filePath],
          lines: ref.line != null ? [ref.line] : undefined,
        },
      });
    }
    return out;
  },
};

/** The three TypeScript schema rules this slice migrates, in registry order. */
export const schemaRules: readonly RuleDefinition<
  SchemaUsageNeeds | UnknownTableNeeds | StaleTableReferenceNeeds
>[] = [unknownTable, tableNamingConvention, staleTableReference];

// ── dynamic-sql-construction ────────────────────────────────────────────────

/**
 * `dynamic-sql-construction` reads the `dynamic-sql` fact (a flat array of
 * `DynamicSqlFact`, one per dangerous query/execute call site) — not
 * `schema-usage`. It is exported in a *separate* array from `schemaRules`
 * because the two fact kinds are distinct: the schema slice context carries
 * `schema-usage` + `resolution`, while this rule's context carries
 * `dynamic-sql` alone.
 *
 * Detection is the producer's — `collectDynamicSqlCandidates` in `codeAnalysis.ts`,
 * shared with the legacy `checkSQLInjection` — so `analyze` is a pure projection
 * of the pre-computed anchor/enclosingFn/symbol, and parity holds by construction.
 */
type DynamicSqlNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['dynamic-sql'];
};

const dynamicSqlConstruction: RuleDefinition<DynamicSqlNeeds> = {
  id: 'dynamic-sql-construction',
  analyzer: 'schema',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['dynamic-sql'] },
  severity: 'critical',
  message: META['dynamic-sql-construction'].message,
  docs: META['dynamic-sql-construction'].docs,
  thresholds: META['dynamic-sql-construction'].thresholds,
  samples: META['dynamic-sql-construction'].samples,
  analyze(ctx): Finding[] {
    return ctx.facts['dynamic-sql'].map((c) => ({
      ruleId: 'dynamic-sql-construction',
      severity: 'critical',
      message: `SQL query built via string interpolation or concatenation in ${c.enclosingFn}; use parameterized queries.`,
      file: c.file,
      line: c.line,
      column: c.column,
      symbol: c.symbol,
    }));
  },
};

/** The dynamic-sql-construction rule this slice migrates (reads `dynamic-sql`). */
export const dynamicSqlRules: readonly RuleDefinition<DynamicSqlNeeds>[] = [dynamicSqlConstruction];
