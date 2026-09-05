-- Multi-tenant schema fixture (Spec 39 — derived applicability).
-- The `org_id` column is the tenant-scoping evidence that keeps the
-- `missing-org-filter` predicate `applicable: true` in this fixture.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- `teams` is a near-miss for the removed English fallback list: its name was in
-- the old `fallbackOrgTables`, but it is a single-tenant table (no org/tenant
-- column). It is NOT declared in orgFilterTables, so a query on it must not
-- trigger missing-org-filter.
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
