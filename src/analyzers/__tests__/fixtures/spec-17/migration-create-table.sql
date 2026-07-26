-- Spec 22 Item 2 — Migration fixture with CREATE TABLE
-- This .sql file gets scanned by discoverTablesFromMigrations()
-- and feeds "heroes" into the known-table set (allTables).

CREATE TABLE IF NOT EXISTS heroes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  class TEXT,
  level INTEGER DEFAULT 1
);

CREATE TABLE quests (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  hero_id INTEGER REFERENCES heroes(id)
);
