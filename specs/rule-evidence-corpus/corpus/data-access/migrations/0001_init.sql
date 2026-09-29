-- 0001_init.sql
--
-- The tenant-schema source of truth for the corpus. `missing-org-filter`
-- discovers tenant tables three ways:
--
--   Tier 3 (DDL)      — snake_case tenant columns in CREATE TABLE bodies that
--                       match the default org-filter vocabulary (org_id,
--                       tenant_id, organization_id, workspace_id).
--   Tier 1 (config)   — `team_members` / `projects` / `environments` carry
--                       tenant columns OUTSIDE that vocabulary (team_id,
--                       project_id, environment_id), so `.codeauditor.json`
--                       declares them by table name.
--   Tier 2 (config)   — `audit_events` is a schema-declared table with
--                       `tenant_id` and no DDL file.
--
-- `projects_v2` is the trap: its tenant column is camelCase (`"organizationId"`),
-- which `extractDdlTableColumns` lowercases to `organizationid` — one token, not
-- `organization_id` — so Tier 3 never sees it and it is NOT declared in Tier 1.
-- A query against it with no predicate is a genuine miss the corpus pins.

CREATE TABLE organizations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  handle TEXT NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  total_cents INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE team_members (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL
);

CREATE TABLE environments (
  id INTEGER PRIMARY KEY,
  environment_id INTEGER NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE projects_v2 (
  id INTEGER PRIMARY KEY,
  "organizationId" INTEGER NOT NULL,
  title TEXT NOT NULL
);

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  prefix TEXT NOT NULL UNIQUE,
  hashed_token TEXT NOT NULL,
  org_id INTEGER NOT NULL
);

CREATE TABLE memberships (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  UNIQUE (user_id, org_id)
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  payload TEXT NOT NULL
);

-- Non-tenant catalog tables — deliberately NO organization/tenant column, so
-- the injection (`sql-injection-risk`) and N+1 (`loop-query`) samples can target
-- them without tripping `missing-org-filter` on every query that lacks an
-- organization predicate.
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT NOT NULL,
  price_cents INTEGER NOT NULL
);

CREATE TABLE product_reviews (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  body TEXT,
  summary TEXT
);

-- More non-tenant catalog tables — the join-heavy analytics layer (Slice 2,
-- `complex-query`) joins these against `products`/`product_reviews`. Still no
-- tenant column, so a read against them never trips `missing-org-filter` or the
-- `unfiltered-query` read half.
CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE warehouses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL
);

CREATE TABLE inventory (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL
);
