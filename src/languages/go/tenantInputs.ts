/**
 * Declared-tenancy resolution for the Go subprocess.
 *
 * The Go subprocess is syntax-only: it reads `.go` files and nothing else — not
 * `.codeauditor.json`, not `.sql` migrations. But `missing-org-filter` and
 * `unknown-table` need to know *which tables are tenant-scoped* and *which
 * tables are known*, and that knowledge is declared, not guessable from a table
 * name. The TypeScript pipeline resolves it via {@link buildOrgFilterTierSet}
 * (Tier 1 explicit `orgFilterTables`, Tier 2 configured `schemas`, Tier 3 DDL
 * migrations) — the three-tier model Spec 62 Amendment B unified.
 *
 * This module computes the SAME resolved tiers on the TypeScript side of the
 * Go dispatch and hands them to the subprocess through `AnalysisOptions`, so
 * the Go data-access analyzer reads declared tenancy instead of the hardcoded
 * `tenantTables`/`knownTables` word lists it used to substitute. The subprocess
 * stays a syntax-only analyzer; the tenancy picture is resolved in the one
 * place that already reads config + DDL.
 */

import { promises as fs } from 'fs';
import { findConfigFileUp, loadConfig } from '../../config/configLoader.js';
import { buildOrgFilterTierSet, type OrgFilterConfig } from '../../analyzers/orgFilterTiers.js';
import { walkFiles } from '../../analyzers/universal/schema/discovery.js';
import { extractMigrationOpsFromFile, applyMigrationOps } from '../../analyzers/universal/schema/migrations.js';

/** The declared-tenancy picture handed to the Go subprocess. */
export interface GoTenantInputs {
  /** Tenant-scoped tables across all three tiers, lowercased. */
  orgFilterTables: string[];
  /** Known-table catalog (DDL + configured schemas + explicit tables), lowercased. */
  knownTables: string[];
  /** Tenant-scoping column names that count as a tenant predicate. */
  orgFilterColumns: string[];
}

/** The same SQL globs the TS schema reducer uses to find migration files. */
const SQL_GLOBS = ['**/*.sql', '**/migrations/**'];

/**
 * Resolve declared tenancy for a Go audit. Reads `.codeauditor.json` (if any)
 * for `analyzerConfigs['data-access']`, replays `.sql` migrations for the
 * known-table catalog + Tier-3 DDL columns, and folds them through
 * {@link buildOrgFilterTierSet}. Every step degrades to "no declared tenancy"
 * on failure rather than guessing — the honest fail-open state, never a word
 * list.
 */
export async function computeGoTenantInputs(projectRoot: string): Promise<GoTenantInputs> {
  // Config (may be absent — then nothing is declared and the rules fail open).
  let dataAccess: Record<string, unknown> = {};
  try {
    const configPath = await findConfigFileUp(projectRoot);
    if (configPath) {
      const { config } = await loadConfig({ configPath, projectRoot });
      dataAccess =
        (config.analyzerConfigs?.['data-access'] as Record<string, unknown> | undefined) ??
        (config.analyzerOptions?.['data-access'] as Record<string, unknown> | undefined) ??
        {};
    }
  } catch {
    // Unreadable/invalid config — "no declared tenancy", never a guessed list.
    dataAccess = {};
  }

  // DDL discovery: replay .sql migrations for the known-table catalog and the
  // per-table DDL columns (Tier 3) — the same inputs the TS schema reducer folds.
  // `applyMigrationOps` mutates a raw set in place and preserves identifier
  // case; lower-case the replayed names when folding them into the catalog so
  // `knownTables` is a canonical lowercased set (the Go side lower-cases again,
  // but a canonical set keeps the emitted array deduplicated and deterministic).
  const rawDdlTables = new Set<string>();
  const knownTables = new Set<string>();
  const ddlTableColumns: Record<string, string[]> = {};
  let sqlFiles: string[] = [];
  try {
    sqlFiles = await walkFiles(projectRoot, SQL_GLOBS);
  } catch {
    sqlFiles = [];
  }
  for (const file of sqlFiles.sort()) {
    let source = '';
    try {
      source = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let extracted;
    try {
      extracted = await extractMigrationOpsFromFile(file, source);
    } catch {
      continue;
    }
    applyMigrationOps(extracted.ops, rawDdlTables);
    for (const [table, cols] of Object.entries(extracted.tableColumns)) {
      const lower = table.toLowerCase();
      const set = new Set(ddlTableColumns[lower] ?? []);
      for (const c of cols) set.add(c.toLowerCase());
      ddlTableColumns[lower] = [...set];
    }
  }
  for (const t of rawDdlTables) knownTables.add(t.toLowerCase());

  // Tier resolution — the same function the TS pipeline fires and applies on.
  const tierSet = buildOrgFilterTierSet(dataAccess as OrgFilterConfig, ddlTableColumns);
  const orgFilterTables = new Set<string>();
  for (const t of tierSet.orgFilterTables) orgFilterTables.add(t);
  for (const t of tierSet.schemaOrgTables) orgFilterTables.add(t);
  for (const t of tierSet.ddlOrgTables) orgFilterTables.add(t);

  // Known-table catalog: DDL tables + configured schema tables + explicit
  // org-filter tables (declared = known). There is no `knownTables` config key —
  // the TS pipeline builds this catalog from schema discovery facts, and the Go
  // side reconstructs it from the same DDL + config inputs.
  const schemas = (dataAccess.schemas as any[]) ?? [];
  for (const schema of schemas) {
    for (const table of schema.tables ?? []) {
      if (table?.name) knownTables.add(String(table.name).toLowerCase());
    }
  }
  for (const t of orgFilterTables) knownTables.add(t);

  return {
    orgFilterTables: [...orgFilterTables].sort(),
    knownTables: [...knownTables].sort(),
    orgFilterColumns: tierSet.tenantColumns,
  };
}
