// Spec 53 R1 triage — parse Stryker's JSON report and emit the surviving-mutant
// list (file + mutation + replaced guard), grouped for triage. The list is the
// deliverable; the score is not.
//
//   node scripts/triage-survivors.mjs [path/to/mutation.json]
//
// Defaults to reports/mutation/mutation.json. Prints, to stdout:
//   1. a per-mutator survival summary,
//   2. the full survivor list (file:line  mutator  "orig" -> "replacement"),
//   3. a JSON blob of survivors under --json for further processing.
// @ts-nocheck
import fs from 'node:fs';

const path = process.argv[2] ?? 'reports/mutation/mutation.json';
const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
const wantJson = process.argv.includes('--json');

// Stryker 8 JSON reporter: { files: { [path]: { mutants: [ { id, mutatorName,
// replacement, status, location, ... } ] } } }. status is one of
// Killed | Survived | NoCoverage | Timeout | RuntimeError | CompileError.
const files = raw.files ?? {};
const survivors = [];
const byMutator = new Map();
const byStatus = new Map();

for (const [file, entry] of Object.entries(files)) {
  for (const m of entry.mutants ?? []) {
    const status = m.status;
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    if (status === 'Killed' || status === 'Ignored') continue;
    const line = m.location?.start?.line ?? m.location?.line ?? '?';
    const item = {
      file,
      line,
      mutator: m.mutatorName,
      original: m.replacement, // the injected replacement token (the "guard removed" is the inverse)
      description: m.description ?? null,
      status,
      id: m.id,
    };
    survivors.push(item);
    byMutator.set(m.mutatorName, (byMutator.get(m.mutatorName) ?? 0) + 1);
  }
}

if (wantJson) {
  console.log(JSON.stringify({ survivors, byMutator: Object.fromEntries(byMutator), byStatus: Object.fromEntries(byStatus) }, null, 2));
  process.exit(0);
}

console.log('=== status counts ===');
for (const [s, n] of [...byStatus.entries()].sort()) console.log(`  ${s}: ${n}`);
console.log();
console.log('=== survivors by mutator ===');
for (const [m, n] of [...byMutator.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${m}: ${n}`);
console.log();
console.log(`=== survivor list (${survivors.length}) ===`);
for (const s of survivors) {
  console.log(`  ${s.file}:${s.line}  [${s.status}] ${s.mutator}  -> ${JSON.stringify(s.original)}${s.description ? `  (${s.description})` : ''}`);
}
