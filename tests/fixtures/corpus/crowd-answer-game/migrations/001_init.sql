-- crowd-answer-game corpus reduction schema. Declares the single-tenant
-- `orders` table that writes.ts / read.ts reference, so `unknown-table` is
-- satisfied. Single-tenant by design: this fixture targets the unfiltered-query
-- (R5), extractTables (the FOR UPDATE SKIP LOCKED locking clause — now a
-- mysql-only construct pinned at the unit level), and orphaned-nodes (R1)
-- fixes from the crowd-answer-game report (Spec 55), not tenancy.
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL
);
