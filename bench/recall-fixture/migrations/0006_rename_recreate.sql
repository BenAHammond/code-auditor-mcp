-- 0006: Rename-then-recreate pattern — the rename-replay bug reproducer.
-- Tables renamed to _hist, then recreated under the original name.
-- The sequential state machine must keep the recreated name in the catalog
-- (the old end-replay approach would delete it).

ALTER TABLE posts RENAME TO posts_hist;

CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES accounts(id),
  content TEXT
);

-- Also do a second table that only renames (no recreate) to confirm
-- _hist tables survive in the catalog
ALTER TABLE quoted_table RENAME TO quoted_table_hist;
