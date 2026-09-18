// Spec 60 — re-run AC3/AC4/AC5 as written.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { discoverFiles } from '../dist/utils/fileDiscovery.js';

function realpath(p){ try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function projectHash(r){ return createHash('sha256').update(realpath(r)).digest('hex').substring(0,16); }
function findNodeModulesDir(start){ let d=path.resolve(start); for(;;){ const c=path.join(d,'node_modules'); if(fs.existsSync(c)&&fs.statSync(c).isDirectory()) return c; const p=path.dirname(d); if(p===d) return null; d=p; } }
function resolveDbPath(root){ const nm=findNodeModulesDir(root); if(nm){ const base=path.join(nm,'.cache','code-auditor'); if(nm!==path.join(root,'node_modules')) return path.join(base,'projects',projectHash(root),'index.db'); return path.join(base,'index.db'); } return path.join(process.env.HOME,'Library','Caches','code-auditor','projects',projectHash(root),'index.db'); }

const corpora = [
  ['/Users/ben/playground/endless-guessing','endless-guessing'],
  ['/Users/ben/playground/knex','knex'],
  ['/Users/ben/playground/blitz','blitz'],
  ['/Users/ben/playground/hhra-org','hhra-org'],
  ['/Users/ben/playground/recall-protocol','recall-protocol'],
  ['/Users/ben/playground/code-auditor/app/src','code-auditor-src'],
];

for (const [root,label] of corpora) {
  const dbPath = resolveDbPath(root);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  console.log(`\n===== ${label} =====`);

  // AC3 — reconstruct the stage-1 discovery corpus set, check membership.
  const corpus = new Set(await discoverFiles(root));
  console.log(`AC3 corpus-set size (discoverFiles): ${corpus.size}`);
  const resolved = db.prepare("SELECT DISTINCT resolved_path FROM import_specifiers WHERE classification='internal-resolved'").all();
  const notInSet = resolved.filter(r => r.resolved_path && !corpus.has(r.resolved_path));
  console.log(`AC3 internal-resolved distinct resolved_path: ${resolved.length}; NOT in corpus set: ${notInSet.length}`);
  for (const r of notInSet) console.log(`  NOT-IN-SET: ${r.resolved_path}`);

  // AC4 — 20 resolved rows, must span >=5 distinct source files.
  const rows20 = db.prepare("SELECT file_path, specifier, resolved_path, line FROM import_specifiers WHERE classification='internal-resolved' LIMIT 20").all();
  const distinctFiles = new Set(rows20.map(r => r.file_path));
  console.log(`AC4 resolved rows (first 20): ${rows20.length}; distinct source files: ${distinctFiles.size}`);
  for (const r of rows20) console.log(`  ${r.file_path} | ${r.specifier} -> ${r.resolved_path}`);

  // AC5 — ALL broken rows (no LIMIT), each with specifier + line.
  const broken = db.prepare("SELECT file_path, specifier, line FROM import_specifiers WHERE classification='internal-broken' ORDER BY file_path, line").all();
  console.log(`AC5 broken rows (all): ${broken.length}`);
  for (const r of broken) console.log(`  ${r.file_path} | ${r.specifier} | L${r.line}`);

  db.close();
}
