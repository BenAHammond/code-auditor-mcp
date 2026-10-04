/**
 * Measure per-analyzer / per-rule advisory finding counts for one corpus, read-only.
 *
 * Spec 44 item 6 — re-pin the corpus baselines after the rule rework. This
 * script is the measurement half: it runs the full audit against one project
 * and prints per-analyzer totals plus a per-rule breakdown, so the post-rework
 * counts can be diffed against the pre-rework committed baselines and every
 * delta attributed to a named cause.
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   CODE_AUDITOR_DATA_DIR=/tmp/code-auditor-corpus \
 *     npx tsx scripts/measure-corpus-counts.ts /path/to/corpus
 *
 * Writes nothing into the target project. The index DB and ledger go to
 * CODE_AUDITOR_DATA_DIR (elsewhere), and no report file is emitted — only
 * stdout. The target is read as read-only reference.
 *
 * The scratch dir in CODE_AUDITOR_DATA_DIR is deleted on exit when it resolves
 * under a temp location (/tmp, /private/tmp, /var/tmp, os.tmpdir()) — repeated
 * measurement runs used to accumulate GBs of index/ledger scratch in
 * `/tmp/ca-corpus-*` and fill the disk (see spec-46 *Disk hygiene* note). A
 * non-temp data dir is a real project index and is never touched.
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAudit } from '../src/auditRunner.js';
import type { Violation } from '../src/types.js';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-corpus-counts.ts <projectRoot>');
  process.exit(2);
}

/**
 * The pinned corpus SHAs (Spec 44 item 6 / SHA-pinning). Each entry records the
 * commit at which that corpus's baseline was last re-pinned. When a re-measure
 * sees a different HEAD, it reports drift instead of a bare finding-count delta —
 * a corpus that has moved is a corpus change, not a tool change.
 */
const PINS_PATH = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  'specs',
  'corpus-pins.json',
);

/**
 * A corpus pin: the commit SHA (provenance) plus a content hash that proves the
 * *bytes* of the tracked tree. The SHA alone cannot catch a dirty working tree
 * or a force-pushed/reset tree that sits at the same SHA with different content —
 * `corpus-pins.json` records both so a corpus that moved content (with or without
 * a SHA change) is detected, not measured through.
 */
interface CorpusPin {
  readonly sha: string;
  readonly content: string;
}

function loadPins(): Record<string, CorpusPin> {
  try {
    return JSON.parse(fs.readFileSync(PINS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** The corpus's current HEAD, or null when it is not a git repo / git is absent. */
function currentSha(root: string): string | null {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * The content hash of the tracked tree: the working-tree bytes of every tracked
 * file, hashed as a set. `git ls-files -z` lists tracked paths; each is fed to
 * `git hash-object` (which hashes that file's bytes on disk), and the list of
 * blob hashes is itself hashed.
 *
 * This is deliberately NOT `git rev-parse HEAD^{tree}`: that is the *committed*
 * tree and cannot see a dirty working tree or a re-clone/reset that lands at the
 * same SHA with different bytes. Hashing the working-tree bytes of tracked files
 * is what makes a moved corpus detectable regardless of how the move happened.
 */
function currentContentHash(root: string): string | null {
  try {
    const hash = execSync(
      'git ls-files -z | xargs -0 git hash-object | git hash-object --stdin',
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    return hash || null;
  } catch {
    return null;
  }
}

/**
 * The corpus's uncommitted paths, as `git status --porcelain` lines (one per
 * changed/untracked entry). A non-empty list means the working tree is dirty and
 * its content is not reconstructable from the pin — measurement through it would
 * attribute a finding-count delta to the tool when the content itself moved.
 */
function dirtyFiles(root: string): string[] {
  try {
    const out = execSync('git status --porcelain', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out ? out.split('\n').filter((l) => l.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * Delete the measurement scratch dir after a run. Only ever deletes a directory
 * under a temp location — the `CODE_AUDITOR_DATA_DIR` the usage block points at.
 * A non-temp data dir is a real project index and is left untouched.
 */
function cleanupScratch(): void {
  const dir = process.env.CODE_AUDITOR_DATA_DIR?.trim();
  if (!dir) return; // unset → shared default (node_modules/.cache); never delete.
  const resolved = path.resolve(dir);
  const tempRoots = [path.resolve(os.tmpdir()), '/tmp', '/private/tmp', '/var/tmp'];
  const isScratch = tempRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  if (!isScratch) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    console.error(`[measure] cleaned scratch dir ${resolved}`);
  } catch {
    // Best-effort: a lingering scratch dir is an annoyance, not a failure.
  }
}

async function main() {
  initializeLanguages();
  await initParsers();

  // ── Corpus integrity gate (Spec 70 item 2 — pin content, not HEAD) ─────────
  // A corpus whose tracked-tree bytes differ from the pin — whether because the
  // working tree is dirty, the HEAD moved, or a re-clone/reset landed at the same
  // SHA with different content — is a corpus change, not a tool change. Measure
  // through it and a finding-count delta becomes un-attributable. Fail loudly
  // BEFORE the audit: list the drift and refuse to emit counts.
  const pins = loadPins();
  const corpusName = path.basename(path.resolve(projectRoot));
  const pinned = pins[corpusName];
  const sha = currentSha(projectRoot);

  const dirty = dirtyFiles(projectRoot);
  if (dirty.length > 0) {
    console.error(
      `✗ CORPUS DIRTY — ${corpusName} has ${dirty.length} uncommitted path(s); ` +
        'its content is not reconstructable from the pin, so it will not be measured.',
    );
    for (const line of dirty) console.error(`    ${line}`);
    console.error(
      '    Resolve the dirt (commit/revert the changes) before measuring, or ' +
        're-pin after recording the new content hash. This corpus was NOT cleaned ' +
        'automatically — a validation corpus is read-only reference.',
    );
    process.exit(2);
  }

  if (sha) {
    console.log(`corpus at commit: ${sha}`);
  }
  if (pinned) {
    if (sha !== pinned.sha) {
      console.error(
        `✗ CORPUS HEAD DRIFT — corpus at ${sha}, pinned at ${pinned.sha}; ` +
          'a finding-count delta would be un-attributable, so it will not be measured.',
      );
      process.exit(2);
    }
    const contentHash = currentContentHash(projectRoot);
    if (contentHash !== null && contentHash !== pinned.content) {
      console.error(
        `✗ CORPUS CONTENT DRIFT — tracked-tree content hash ${contentHash} does not ` +
          `match the pinned ${pinned.content}. The corpus sits at the right SHA but ` +
          'its bytes differ (a re-clone or reset can produce this); it will not be measured.',
      );
      process.exit(2);
    }
    console.log(`corpus pinned at ${pinned.sha} ✓ (content ${pinned.content} matches)`);
  } else {
    console.log(
      `⚠ no baseline pin for corpus '${corpusName}' — record its HEAD SHA + content ` +
        'hash in specs/corpus-pins.json before re-pinning.',
    );
  }

  // Route through the same dispatcher the CLI uses: projects containing `.go`
  // files go to the Go phase rules (which emit the reimplemented liskov /
  // error-handling / goroutines categories), everything else to the TS pipeline.
  const result = await runAudit({ projectRoot } as any);

  const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
    (r: any) => r.violations ?? [],
  );
  const advisory = all.filter((v) => v.analyzer !== 'invariants');

  const byAnalyzer = new Map<string, number>();
  const byRule = new Map<string, number>();
  for (const v of advisory) {
    byAnalyzer.set(v.analyzer, (byAnalyzer.get(v.analyzer) ?? 0) + 1);
    // `rule` is the single source of truth for rule identity (TS and Go alike).
    const rule = `${v.analyzer}::${(v as any).rule}`;
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }

  const sortedAnalyzers = [...byAnalyzer.entries()].sort((a, b) => b[1] - a[1]);
  const sortedRules = [...byRule.entries()].sort((a, b) => b[1] - a[1]);

  console.log(`\n=== CORPUS: ${projectRoot} ===`);
  const filesAnalyzed = (result as any).metadata?.filesAnalyzed;
  console.log(`files analyzed: ${filesAnalyzed ?? 'n/a'}`);
  console.log(`advisory findings: ${advisory.length}`);
  console.log('\n--- per-analyzer ---');
  for (const [name, count] of sortedAnalyzers) console.log(`${name}: ${count}`);
  console.log('\n--- per-rule (analyzer::rule) ---');
  for (const [rule, count] of sortedRules) console.log(`${rule}: ${count}`);

  // Coverage diagnostics (Spec 58 follow-up) — the analyzer's visibility-ended
  // channel, not findings. `unresolved-query` / `unresolved-dynamic-import` carry
  // file + line; `not-run` and zero-files entries are excluded from this count.
  const diagnostics = ((result as any).metadata?.diagnostics ?? []) as Array<{
    kind?: string;
  }>;
  const byDiagnosticKind = new Map<string, number>();
  for (const d of diagnostics) {
    if (!d.kind || d.kind === 'not-run') continue;
    byDiagnosticKind.set(d.kind, (byDiagnosticKind.get(d.kind) ?? 0) + 1);
  }
  if (byDiagnosticKind.size > 0) {
    const sortedKinds = [...byDiagnosticKind.entries()].sort((a, b) => b[1] - a[1]);
    console.log('\n--- coverage diagnostics (kind) ---');
    for (const [kind, count] of sortedKinds) console.log(`${kind}: ${count}`);
  }
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => cleanupScratch());
