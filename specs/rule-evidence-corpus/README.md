# Rule Evidence Corpus

Production-scale sample code whose only job is to *disagree* with the analyzer
where it is wrong. The existing fixtures in `bench/corpus/` and `src/__tests__`
are small and single-purpose — every defect that shipped this month showed up in
a real repository, not in a fixture. These files are written to look like
something someone shipped: multi-hundred-line modules, layered helpers, queries
built across statements, mixed ORM + raw SQL in the same file, real error
handling, real React components with hooks and effects, a Go package with
goroutines and channels.

Per rule, each module walks the rule's grammar checklist from
`../rule-evidence-audit.md` and exercises every production in the position the
rule inspects — one realistic module carrying many cases, not one file per case.

## Header contract

Every corpus file records its **expected** verdicts in a header comment. The
runner (`runner.ts`) parses these and diffs them against what `runAudit` actually
emits, per rule, per line.

```
@fires <rule> <line>    the rule SHOULD fire on this line (a finding is expected)
@quiet <rule> <line>    the rule MUST NOT fire on this line (a control / near-miss)
```

A line may carry a trailing `— <reason>` (human rationale). A `@fires` may append
`:critical` / `:high` / `:severe` to pin the expected severity. Where the tool
and a careful human auditor disagree, the header records the **human** verdict —
that disagreement is the point, and it becomes a line in `REPORT.md`, not a fix.

Two rules about the corpus itself:

1. **Do not edit a sample to match behavior.** The corpus is the measurement.
2. **Do not fix the analyzer in this pass.** Disagreements go in `REPORT.md`.

## Running

```bash
cd app
npx tsx specs/rule-evidence-corpus/runner.ts
```

The runner calls `initializeLanguages()` + `initParsers()`, then `runAudit({
projectRoot: <corpus>, writeToLedger: false, analyzerConfigs })` and prints the
expected-vs-actual diff plus a `REPORT.md`-ready summary. Exit code 1 means at
least one expected verdict did not match.

## Layout

```
corpus/
  data-access/          rules 24–29 (sql-injection-risk, missing-org-filter,
                        complex-query, unfiltered-query, hardcoded-connection,
                        loop-query)
    migrations/0001_init.sql   DDL — Tier-3 tenant discovery + UNIQUE columns
  .codeauditor.json     tenancy config (Tier 1 + Tier 2)
```

## Config

Tenancy for `missing-org-filter` is declared three ways, all exercised:

- **Tier 1** — `.codeauditor.json` `analyzerConfigs.data-access.orgFilterTables`
  (tables whose tenant column is outside the default snake_case vocabulary, e.g.
  `team_id`, `project_id`, `environment_id`).
- **Tier 2** — `.codeauditor.json` `analyzerConfigs.data-access.schemas` (a
  config-declared schema table with a tenant column, no DDL file).
- **Tier 3** — `migrations/0001_init.sql` `CREATE TABLE` bodies with
  `org_id` / `tenant_id` / `organization_id` / `workspace_id` columns, discovered
  by `extractDdlTableColumns` → `table-catalog`.

The `hasOrganizationFilter` *predicate* detector runs on the analyzer's fixed
default `organizationPatterns` (`organizationId`, `organization_id`, `orgId`,
`org_id`, `tenantId`, `tenant_id`, `companyId`, `company_id`) — it is **not**
configurable and **not** shared with the tenant-column list. That unshared list
is the single largest source of expected disagreement: a `workspace_id`-tiered
table whose predicate scopes on `workspace_id` is scoped in human terms but fires
`missing-org-filter` anyway.
