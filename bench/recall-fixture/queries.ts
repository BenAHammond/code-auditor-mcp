// Fix 1 — Receipt 2: fully-static STRING WITH extractDatabaseCalls() in checkQuerySecurity() is triggered.
// This is a pure static string with zero interpolation, zero concatenation.
const stmt487 = db.prepare(`
  SELECT TRIM(full_name) AS display
  FROM stadium_data
`);

// Fix 1 — Receipt 3: SQL arithmetic with + in COALESCE, but ? placeholder
// is outside the template literal text (in .bind()), so parameterized stays false.
const stmtCoalesce = db.prepare(`SELECT COALESCE(a + b, 0) FROM data WHERE id = ?`);
stmtCoalesce.bind(userId).run();

// Fix 2 — Safe placeholder list (ids.map(() => "?").join(",")) — MUST NOT FIRE
const ids = [1, 2, 3];
const placeholders = ids.map(() => "?").join(",");
const stmtInList = db.prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`);
stmtInList.bind(1, 2, 3).all();

// Fix 2 — Reassignment of placeholder var — MUST FIRE (conservative)
let p = ids.map(() => "?").join(",");
p = userInput;
const stmtReassigned = db.prepare(`SELECT * FROM posts WHERE id IN (${p})`);

// Fix 2 — Real interpolation danger — MUST FIRE (at suggestion tier)
const userProvided = getUserInput();
const dangerousStmt = db.prepare(`SELECT * FROM posts WHERE name = '${userProvided}'`);

// Fix 3 — References to tables that should be known via wrangler.toml migrations
const stmtPosts = db.prepare('SELECT * FROM posts WHERE id = ?');
const stmtAccounts = db.prepare('SELECT * FROM accounts WHERE id = ?');

// v3.4.8 gap-class tables — must NOT fire unknown-table after regex fix
// quoted_table is renamed to quoted_table_hist in 0006, so it now fires unknown-table
const stmtQuoted = db.prepare('SELECT * FROM "quoted_table"');
const stmtBacktick = db.prepare('SELECT * FROM `backtick_table`');
const stmtFts = db.prepare('SELECT * FROM fts_data');

// v3.4.8 Item 1 — rename-replay fix: posts recreated after rename, MUST NOT fire
const stmtPostsRecreated = db.prepare('SELECT * FROM posts WHERE id = ?');
// posts_hist survives rename — MUST NOT fire unknown-table
const stmtPostsHist = db.prepare('SELECT * FROM posts_hist WHERE id = ?');
// quoted_table_hist survives rename — MUST NOT fire unknown-table
const stmtQuotedHist = db.prepare('SELECT * FROM quoted_table_hist WHERE id = ?');
