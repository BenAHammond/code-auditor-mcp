/**
 * Rule-evidence corpus runner (Spec 69 — the producer contract, Slice 1).
 *
 * Runs the FULL `runAudit` pipeline over `corpus/` and diffs what the analyzer
 * actually emits against each file's header-declared expectation:
 *
 *   @fires <rule> <line>        the rule SHOULD fire on this line
 *   @quiet <rule> <line>        the rule MUST NOT fire on this line
 *
 * A header records the *human* verdict, not the tool's. Where the two disagree
 * (a `@fires` that produced nothing, or a `@quiet` line that produced a
 * finding) the runner prints a `DISAGREE` line and exits 1 — that disagreement
 * is the working list, copied into `REPORT.md`, never "fixed" by editing the
 * sample to match behavior.
 *
 * `--dump` prints every actual finding (rule, file, line, severity) for the
 * rules mentioned in any header, so a corpus author can reconcile a header's
 * line numbers against where the analyzer anchors each finding.
 *
 * Usage:
 *   npx tsx specs/rule-evidence-corpus/runner.ts          # diff, exit 1 on drift
 *   npx tsx specs/rule-evidence-corpus/runner.ts --dump   # raw findings, exit 0
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLanguages } from '../../src/languages/index.js';
import { initParsers } from '../../src/languages/tree-sitter/parser.js';
import { runAudit } from '../../src/auditRunner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, 'corpus');
const DUMP = process.argv.includes('--dump');

/** Source formats that can carry a `@fires`/`@quiet` header. */
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.go']);

interface Directive {
  kind: 'fires' | 'quiet';
  rule: string;
  line: number;
  severity?: string;
  reason?: string;
  file: string;
}

interface ActualFinding {
  rule: string;
  file: string;
  line: number;
  severity: string;
}

async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collectSourceFiles(full)));
    else if (SOURCE_EXTS.has(e.name.slice(e.name.lastIndexOf('.')))) out.push(full);
  }
  return out.sort();
}

const DIRECTIVE_RE =
  /@(fires|quiet)\s+([A-Za-z0-9-]+)\s+(\d+)(?::([A-Za-z]+))?\s*(?:—\s*(.*))?$/;

async function parseHeader(file: string): Promise<Directive[]> {
  const content = await readFile(file, 'utf8');
  const rel = relative(CORPUS_DIR, file);
  const out: Directive[] = [];
  for (const raw of content.split('\n')) {
    const m = DIRECTIVE_RE.exec(raw.trim());
    if (!m) continue;
    out.push({
      kind: m[1] as Directive['kind'],
      rule: m[2],
      line: Number(m[3]),
      severity: m[4],
      reason: m[5]?.trim(),
      file: rel,
    });
  }
  return out;
}

function flattenFindings(analyzerResults: Record<string, any>): ActualFinding[] {
  const out: ActualFinding[] = [];
  for (const r of Object.values(analyzerResults)) {
    for (const v of (r as any).violations ?? []) {
      out.push({
        rule: v.rule,
        file: v.file,
        line: v.line ?? 0,
        severity: v.severity,
      });
    }
  }
  return out;
}

function relOf(file: string, root: string): string {
  return isAbsolute(file) ? relative(root, file) : file;
}

async function main(): Promise<number> {
  initializeLanguages();
  await initParsers();

  const files = await collectSourceFiles(CORPUS_DIR);
  const directives: Directive[] = [];
  for (const f of files) directives.push(...(await parseHeader(f)));

  const trackedRules = new Set(directives.map((d) => d.rule));

  const result = await runAudit({ projectRoot: CORPUS_DIR, writeToLedger: false });
  const all = flattenFindings(result.analyzerResults as Record<string, any>);
  const actual = all
    .map((f) => ({ ...f, file: relOf(f.file, CORPUS_DIR) }))
    .filter((f) => trackedRules.has(f.rule));

  // Index actual findings by file for per-directive matching.
  const byFile = new Map<string, ActualFinding[]>();
  for (const f of actual) {
    const arr = byFile.get(f.file) ?? [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  if (DUMP) {
    console.log('# Actual findings (rule | file | line | severity)');
    for (const f of actual.sort((a, b) =>
      a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log(`${f.rule}\t${f.file}:${f.line}\t${f.severity}`);
    }
    return 0;
  }

  // Per-directive verdict, plus the unannotated findings of tracked rules.
  const rows: Array<{ status: string; directive: Directive; note: string }> = [];
  let disagreements = 0;

  for (const d of directives) {
    const hits = (byFile.get(d.file) ?? []).filter(
      (f) => f.rule === d.rule && f.line === d.line,
    );
    const severityOk = !d.severity || hits.some((h) => h.severity === d.severity);

    if (d.kind === 'fires') {
      if (hits.length === 0) {
        rows.push({ status: 'DISAGREE (missing)', directive: d, note: 'expected a finding, produced none' });
        disagreements++;
      } else if (d.severity && !severityOk) {
        rows.push({
          status: 'DISAGREE (severity)',
          directive: d,
          note: `expected ${d.severity}, produced ${hits.map((h) => h.severity).join(',')}`,
        });
        disagreements++;
      } else {
        rows.push({ status: 'MATCH', directive: d, note: hits.map((h) => h.severity).join(',') });
      }
    } else {
      // quiet — MUST NOT fire.
      if (hits.length > 0) {
        rows.push({
          status: 'DISAGREE (false-positive)',
          directive: d,
          note: `produced ${hits.map((h) => h.severity).join(',')}`,
        });
        disagreements++;
      } else {
        rows.push({ status: 'MATCH (quiet)', directive: d, note: '' });
      }
    }
  }

  // Unannotated actual findings: a tracked rule fired where no header expected it.
  const annotated = new Set(
    directives.map((d) => `${d.file}|${d.rule}|${d.line}`),
  );
  const unannotated = actual.filter((f) => !annotated.has(`${f.file}|${f.rule}|${f.line}`));

  // ── Print ─────────────────────────────────────────────────────────────────
  const byRule = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byRule.get(r.directive.rule) ?? [];
    arr.push(r);
    byRule.set(r.directive.rule, arr);
  }

  for (const [rule, rs] of [...byRule.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`\n## ${rule}`);
    for (const r of rs) {
      const dir = r.directive;
      const head = `${r.status}  @${dir.kind} ${dir.rule} ${dir.file}:${dir.line}${dir.severity ? ':' + dir.severity : ''}`;
      const tail = r.note ? `  — ${r.note}` : '';
      const reason = dir.reason ? `  [${dir.reason}]` : '';
      console.log(`${head}${tail}${reason}`);
    }
  }

  if (unannotated.length > 0) {
    console.log('\n## unannotated (tracked rule fired with no header)');
    for (const f of unannotated.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log(`${f.rule}\t${f.file}:${f.line}\t${f.severity}`);
    }
  }

  const total = directives.length;
  const matches = total - disagreements;
  console.log(`\n## summary  ${matches}/${total} directives match, ${disagreements} disagree, ${unannotated.length} unannotated`);
  return disagreements > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
