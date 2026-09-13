-- Composite data-access fixture schema. Declares the single-tenant `users`
-- table that mixed.ts references, so the schema analyzer's `unknown-table`
-- rule is satisfied. `users` is deliberately single-tenant (no org column):
-- this fixture targets the query-shape rules (loop-query, unfiltered-query),
-- not tenancy, so no `orgFilterTables` is declared and `missing-org-filter`
-- is out of scope here.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  touched INTEGER NOT NULL DEFAULT 0
);
