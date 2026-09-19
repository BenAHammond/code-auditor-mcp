DROP TABLE generation_queue;

CREATE TABLE generation_jobs (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL
);

CREATE TABLE reads_jobs (
  id INTEGER PRIMARY KEY,
  dedup_key TEXT NOT NULL
);
