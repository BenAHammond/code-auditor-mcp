// Spec 60 verification helper — read-only queries against a corpus index DB.
// Usage: node scripts/spec60-query.mjs <projectRoot> [label]
// Prints: DB path, AC1 total, AC2 per-classification counts, AC3 resolved_path
// existence check, AC9 function_dependencies count, and samples for AC4/AC5.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(process.argv[2]);
const label = process.argv[3] ?? root;

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}
function projectHash(r) {
  return createHash('sha256').update(realpath(r)).digest('hex').substring(0, 16);
}
function findNodeModulesDir(start) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function getFallbackCacheRoot() {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  if (xdg) return path.join(path.resolve(xdg), 'code-auditor');
  if (process.platform === 'darwin') return path.join(process.env.HOME, 'Library', 'Caches', 'code-auditor');
  return path.join(process.env.HOME, '.cache', 'code-auditor');
}
function resolveDbPath(projectRoot) {
  const nm = findNodeModulesDir(projectRoot);
  if (nm) {
    const base = path.join(nm, '.cache', 'code-auditor');
    if (nm !== path.join(projectRoot, 'node_modules')) {
      return path.join(base, 'projects', projectHash(projectRoot), 'index.db');
    }
    return path.join(base, 'index.db');
  }
  return path.join(getFallbackCacheRoot(), 'projects', projectHash(projectRoot), 'index.db');
}

const dbPath = resolveDbPath(root);
console.log(`\n===== ${label} =====`);
console.log(`DB: ${dbPath}`);
if (!fs.existsSync(dbPath)) {
  console.log('DB NOT FOUND — has the audit been run against this path?');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

function one(sql) {
  return db.prepare(sql).get();
}
function all(sql) {
  return db.prepare(sql).all();
}

const total = one('SELECT COUNT(*) AS c FROM import_specifiers');
console.log(`AC1 total rows: ${total.c}`);

console.log('AC2 per-classification:');
for (const r of all('SELECT classification, COUNT(*) AS c FROM import_specifiers GROUP BY classification ORDER BY classification')) {
  console.log(`  ${r.classification}: ${r.c}`);
}

// AC3 — every internal-resolved resolved_path must exist on disk (and therefore
// in the corpus file set, since classification only emits set members).
const badResolved = all(
  "SELECT resolved_path FROM import_specifiers WHERE classification='internal-resolved' AND resolved_path IS NOT NULL"
).filter((r) => !fs.existsSync(r.resolved_path));
console.log(`AC3 resolved_path missing-on-disk: ${badResolved.length}`);
for (const r of badResolved) console.log(`  MISSING: ${r.resolved_path}`);

// AC9 — function_dependencies untouched.
let fdCount = 'n/a';
try { fdCount = one('SELECT COUNT(*) AS c FROM function_dependencies').c; } catch { /* table may not exist */ }
console.log(`AC9 function_dependencies rows: ${fdCount}`);

// Samples for AC4 (internal-resolved) and AC5 (internal-broken).
console.log('AC4 internal-resolved samples (file_path | specifier | -> resolved_path | line):');
for (const r of all("SELECT file_path, specifier, resolved_path, line FROM import_specifiers WHERE classification='internal-resolved' LIMIT 20")) {
  console.log(`  ${r.file_path} | ${r.specifier} | -> ${r.resolved_path} | ${r.line}`);
}
console.log('AC5 internal-broken samples (file_path | specifier | line):');
for (const r of all("SELECT file_path, specifier, line FROM import_specifiers WHERE classification='internal-broken' LIMIT 20")) {
  console.log(`  ${r.file_path} | ${r.specifier} | ${r.line}`);
}
console.log('AC6 .js specifier -> .ts resolved (first 10):');
for (const r of all("SELECT file_path, specifier, resolved_path, line FROM import_specifiers WHERE specifier LIKE '%.js' AND resolved_path LIKE '%.ts' LIMIT 10")) {
  console.log(`  ${r.file_path} | ${r.specifier} | -> ${r.resolved_path} | ${r.line}`);
}
console.log('AC6 count of .js -> .ts rows:',
  one("SELECT COUNT(*) AS c FROM import_specifiers WHERE specifier LIKE '%.js' AND resolved_path LIKE '%.ts'").c);

db.close();
