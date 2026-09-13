-- crowd-answer-game corpus reduction schema. Declares the single-tenant
-- `orders` table that writes.ts / read.ts reference, so `unknown-table` is
-- satisfied. Single-tenant by design: this fixture targets the unfiltered-query
-- (R5), extractTables (FOR UPDATE SKIP LOCKED), and orphaned-nodes (R1) fixes
-- from the crowd-answer-game report (Spec 55), not tenancy.
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL
);
