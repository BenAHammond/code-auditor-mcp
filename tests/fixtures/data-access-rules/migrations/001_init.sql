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
