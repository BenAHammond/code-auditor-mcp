# Spec 69 R5 criterion 8 — the quiet set is natural-UNIQUE, never a primary key

Criterion 8 asks whether the resolution fact carries natural-unique constraints
**distinctly** from primary keys, and whether the `missing-org-filter` bootstrap
lookup quiet reads the natural-unique set alone. Both hold in code; this note
records the hhra-org composition so it is visible that **no primary key is in
the quiet set**.

## The fact carries them distinctly (confirmed)

`ResolutionColumn` (`src/phase/types.ts`) has two separate booleans —
`unique: boolean` (natural UNIQUE) and `primaryKey: boolean`. `producers.ts`
builds them independently: `unique: uniq.has(col)` from
`SchemaDeclaration.uniqueColumns` and `primaryKey: pk.has(col)` from
`primaryKeyColumns`. `SchemaDeclaration` likewise carries `uniqueColumns`
(natural UNIQUE, lowercased) separately from `primaryKeyColumns`
(`types.ts:518`).

## The quiet set reads `unique` alone (confirmed)

`uniqueColumnsForTables` (`src/phase/rules/dataAccess.ts:399`) reads only
`col.unique` — the natural UNIQUE flag — for the tables named in the query:

```ts
for (const col of entry.columns) {
  if (col.unique) set.add(col.name.toLowerCase());   // never col.primaryKey
}
```

`hasUniqueColumnFilter` matches a query's filter columns against that set. A
predicate bound to a natural-UNIQUE column returns at most one row (the
bootstrap-lookup shape), so the rule stays quiet there. A primary key (`id`)
is deliberately **excluded** — an id-keyed lookup on a tenant table with no org
predicate is exactly the IDOR surface the rule must fire on.

(The inline comment above `hasUniqueColumnFilter` says "UNIQUE / PRIMARY-KEY
column"; that is stale. The code reads `unique` only. The comment is the only
place the two are conflated.)

## hhra-org composition — every column in the quiet set, with constraint class

Measured by `scripts/measure-missing-org-filter-detail.ts` (read-only). The
resolution fact holds 33 tables, 14 tenant tables. Every column carrying
`unique: true` anywhere:

| column | tables | constraint class |
|---|---|---|
| `idempotency_key` / `idempotencykey` | `raw_certifier_data`, `upload_jobs` | natural UNIQUE (single column, idempotency key) |
| `sample_id` | `sample_ownership` | composite UNIQUE member (`sample_id, pdp_year, table_name, organization_id`) |
| `pdp_year` | `sample_ownership`, `commodity_recent_years` | composite UNIQUE member in `sample_ownership` |
| `table_name` | `sample_ownership` | composite UNIQUE member |
| `organization_id` | `sample_ownership`, `user_organizations`, `certifications` | composite UNIQUE member |
| `user_id` | `user_organizations` | composite UNIQUE member (`user_id, organization_id`) |
| `certificate_number` | `certifications` | composite UNIQUE member (`organization_id, certificate_number`) |
| `code` | `organizations`, `certifiers`, `subscription_plans` | natural UNIQUE (single column) |
| `email` | `users` | natural UNIQUE (single column) |
| `key` | `file_storage` | natural UNIQUE (single column) |
| `commodity` | `commodity_recent_years` | natural UNIQUE (single column) |
| `product_raw` | `product_mappings` | natural UNIQUE (single column) |
| `residue_raw` | `residue_mappings` | natural UNIQUE (single column) |

**No primary key is in the set.** Every table's primary key is `id`
(`PRIMARY KEY: id` on all 33 tables), and `id` never appears in any table's
`UNIQUE (natural)` list — it carries `primaryKey: true`, `unique: false`. The
quiet set is therefore natural-UNIQUE-only, as criterion 8 requires.

## The composite-UNIQUE over-marking (flagged honestly, not changed here)

Six columns are marked `unique: true` because they are *members* of a composite
UNIQUE constraint, not individually unique:

- `sample_ownership.sample_id / pdp_year / table_name / organization_id` —
  unique only as the four-tuple `(sample_id, pdp_year, table_name, organization_id)`.
- `user_organizations.user_id / organization_id` — unique only as `(user_id, organization_id)`.
- `certifications.organization_id / certificate_number` — unique only as
  `(organization_id, certificate_number)`.

A query filtering on a single composite member (`eq(userOrganizations.userId,
userId)` alone) matches `hasUniqueColumnFilter` and is treated as a
bootstrap-lookup quiet, even though `user_id` alone does not uniquely identify a
row. In practice this rarely matters for `missing-org-filter`: `organization_id`
members are caught first by `hasOrganizationFilter` (they *are* the org
column), and the non-org members (`user_id`, `sample_id`, `pdp_year`,
`table_name`, `certificate_number`, `idempotencyKey`) are the intended
bootstrap-lookup keys. The over-marking is pre-existing (Spec 68 Thing 1) and
out of scope for §10; it is recorded so it is not mistaken for a primary key
leaking into the set — it is a composite-member leak, and a different defect
class from the one criterion 8 forbids.
