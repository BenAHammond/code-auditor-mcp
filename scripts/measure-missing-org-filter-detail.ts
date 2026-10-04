/**
 * Dump per-finding detail for `missing-org-filter` + the resolution fact's
 * tenant-table UNIQUE/PK columns, for one corpus, read-only.
 *
 * Two outputs in one pass:
 *   1. Every `data-access::missing-org-filter` finding as `file:line | symbol |
 *      message` — the ground truth for the IDOR-vs-unfiltered split.
 *   2. Every table in the resolution fact that carries a tenant column
 *      (`organization_id`), with each column's `unique` / `primaryKey` flags —
 *      the ground truth for the natural-UNIQUE-only quiet set (criterion 8).
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   CODE_AUDITOR_DATA_DIR=/tmp/ca-detail \
 *     npx tsx scripts/measure-missing-org-filter-detail.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAudit } from '../src/auditRunner.js';
import { findFiles } from '../src/utils/fileDiscovery.js';
import { buildResolution } from '../src/phase/runner.js';
import type { InputFile } from '../src/phase/runner.js';
import type { Violation } from '../src/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());

function cleanupScratch(): void {
  const dir = process.env.CODE_AUDITOR_DATA_DIR?.trim();
  if (!dir) return;
  const resolved = path.resolve(dir);
  const tempRoots = [path.resolve(os.tmpdir()), '/tmp', '/private/tmp', '/var/tmp'];
  if (!tempRoots.some((r) => resolved === r || resolved.startsWith(r + path.sep))) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    console.error(`[measure] cleaned scratch dir ${resolved}`);
  } catch {
    /* best-effort */
  }
}

async function main() {
  initializeLanguages();
  await initParsers();

  // 1. Findings.
  const result = await runAudit({ projectRoot } as any);
  const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
    (r: any) => r.violations ?? [],
  );
  const mof = all.filter((v) => (v as any).rule === 'missing-org-filter');
  console.log(`\n=== missing-org-filter findings: ${mof.length} (${projectRoot}) ===`);
  for (const v of mof) {
    const symbol = (v as any).symbol ?? v.functionName ?? '';
    console.log(`${v.file}:${v.line} | ${symbol} | ${v.message}`);
  }

  // 2. Resolution fact → tenant tables with UNIQUE/PK flags.
  const files = await findFiles(projectRoot);
  const inputs: InputFile[] = [];
  for (const f of files) {
    if (f.includes('node_modules')) continue;
    let content: string;
    try {
      content = await fs.readFile(f, 'utf-8');
    } catch {
      continue;
    }
    inputs.push({ path: f, content });
  }
  const resolution = await buildResolution(inputs);

  const tenantTables = resolution.tables.filter((t) =>
    t.columns.some((c) => c.name.toLowerCase() === 'organization_id'),
  );
  console.log(`\n=== resolution fact: ${resolution.tables.length} tables, ${tenantTables.length} tenant tables ===`);
  for (const t of tenantTables) {
    const uniq = t.columns.filter((c) => c.unique).map((c) => c.name);
    const pk = t.columns.filter((c) => c.primaryKey).map((c) => c.name);
    const nn = t.columns.filter((c) => c.notNull).map((c) => c.name);
    const fk = t.columns.filter((c) => c.foreignKey).map((c) => `${c.name}->${c.foreignKey!.table}.${c.foreignKey!.column}`);
    console.log(`\n[${t.name}] (source ${t.source})`);
    console.log(`  UNIQUE (natural): ${uniq.length ? uniq.join(', ') : '(none)'}`);
    console.log(`  PRIMARY KEY:      ${pk.length ? pk.join(', ') : '(none)'}`);
    if (nn.length) console.log(`  NOT NULL:         ${nn.join(', ')}`);
    if (fk.length) console.log(`  FOREIGN KEY:      ${fk.join(', ')}`);
  }

  // Also list every column that is unique=true anywhere (the quiet-set vocabulary).
  const allUnique = new Map<string, string[]>();
  for (const t of resolution.tables) {
    for (const c of t.columns) {
      if (c.unique) {
        const k = c.name.toLowerCase();
        allUnique.set(k, [...(allUnique.get(k) ?? []), t.name]);
      }
    }
  }
  console.log(`\n=== natural-UNIQUE columns anywhere in the resolution fact ===`);
  for (const [col, tables] of [...allUnique.entries()].sort()) {
    console.log(`  ${col}: ${tables.join(', ')}`);
  }
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => cleanupScratch());
