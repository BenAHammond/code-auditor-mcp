-- D1/Workers corpus reduction schema. Declares the single-tenant `users`
-- table that statements.ts / upsert.ts reference, so `unknown-table` is
-- satisfied. Single-tenant by design: this fixture targets the loop-query /
-- unfiltered-query / dependency-inversion fixes from the D1 report (Spec 52),
-- not tenancy.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
