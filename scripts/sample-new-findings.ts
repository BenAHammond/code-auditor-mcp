/**
 * Sample findings from the newly-firing rules (Spec 68 §13.4 — "new findings
 * sampled"). Prints up to N findings per rule with file + line + message, and
 * the source line at the reported location, so each sample can be hand-confirmed
 * genuine. Read-only; writes nothing into the target.
 *
 * Usage:
 *   CODE_AUDITOR_DATA_DIR=/tmp/ca-sample npx tsx scripts/sample-new-findings.ts <projectRoot> [limit]
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAudit } from '../src/auditRunner.js';
import type { Violation } from '../src/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.argv[2];
const limit = Number(process.argv[3] ?? 5);
if (!projectRoot) {
  console.error('usage: sample-new-findings.ts <projectRoot> [limit]');
  process.exit(2);
}

// The rules that began firing only after the config gates came off (§14 / #301).
const NEW_RULES = new Set([
  'documentation::parameter-documentation',
  'documentation::return-documentation',
  'dry::duplicate-string-literal',
  'dry::duplicate-import',
  'dry::dry/structural-similarity',
]);

function cleanupScratch(): void {
  const dir = process.env.CODE_AUDITOR_DATA_DIR?.trim();
  if (!dir) return;
  const resolved = path.resolve(dir);
  const tempRoots = [path.resolve(os.tmpdir()), '/tmp', '/private/tmp', '/var/tmp'];
  if (!tempRoots.some((r) => resolved === r || resolved.startsWith(r + path.sep))) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

async function main() {
  initializeLanguages();
  await initParsers();
  const result = await runAudit({ projectRoot } as any);
  const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
    (r: any) => r.violations ?? [],
  );

  const byRule = new Map<string, Violation[]>();
  for (const v of all) {
    const key = `${v.analyzer}::${(v as any).rule}`;
    if (!NEW_RULES.has(key)) continue;
    (byRule.get(key) ?? byRule.set(key, []).get(key)!).push(v);
  }

  for (const [rule, vs] of [...byRule.entries()].sort()) {
    console.log(`\n===== ${rule} (${vs.length} total) =====`);
    for (const v of vs.slice(0, limit)) {
      const file = (v as any).file ?? (v as any).filePath ?? '?';
      const line = (v as any).line ?? (v as any).lineNumber ?? '?';
      const msg = (v as any).message ?? (v as any).description ?? '';
      let src = '';
      if (typeof file === 'string' && typeof line === 'number') {
        const abs = file.startsWith('/') ? file : path.join(projectRoot, file);
        try {
          const lines = fs.readFileSync(abs, 'utf8').split('\n');
          src = (lines[line - 1] ?? '').trim();
        } catch {
          src = '(unreadable)';
        }
      }
      console.log(`- ${file}:${line}  ${src}`);
      if (msg) console.log(`    ↳ ${msg}`);
    }
  }
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => cleanupScratch());
