/**
 * Shared corpus-integrity gate for measurement scripts.
 *
 * A corpus whose tracked-tree bytes differ from its pin — whether because the
 * working tree is dirty, the HEAD moved, or a re-clone/reset landed at the same
 * SHA with different content — is a corpus change, not a tool change. Measuring
 * through it makes a finding-count delta un-attributable. Every measurement
 * script that reports per-corpus counts must call {@link assertCorpusPinned}
 * BEFORE running, so a dirty/drifted corpus fails loudly rather than emitting a
 * number measured against an unreproducible tree.
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

/**
 * A corpus pin: the commit SHA (provenance) plus a content hash that proves the
 * *bytes* of the tracked tree. The SHA alone cannot catch a dirty working tree
 * or a force-pushed/reset tree that sits at the same SHA with different content —
 * the pin records both so a corpus that moved content (with or without a SHA
 * change) is detected, not measured through.
 */
export interface CorpusPin {
  readonly sha: string;
  readonly content: string;
}

export function loadPins(): Record<string, CorpusPin> {
  const pinsPath = path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    'specs',
    'corpus-pins.json',
  );
  let raw: string;
  try {
    raw = fs.readFileSync(pinsPath, 'utf8');
  } catch {
    throw new Error(`corpus pins file missing or unreadable: ${pinsPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corpus pins file is not valid JSON: ${pinsPath}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`corpus pins file must be a JSON object: ${pinsPath}`);
  }
  return parsed as Record<string, CorpusPin>;
}

/** The corpus's current HEAD, or null when it is not a git repo / git is absent. */
export function currentSha(root: string): string | null {
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
 * file, hashed as a set. Deliberately NOT `git rev-parse HEAD^{tree}` (that is
 * the *committed* tree and cannot see a dirty working tree); hashing the
 * working-tree bytes is what makes a moved corpus detectable regardless of how
 * the move happened.
 */
export function currentContentHash(root: string): string | null {
  try {
    // Exclude `.code-index/` at any depth: the old default index path wrote (and,
    // in recall-protocol and hhra-org, *committed*) an `index.db` blob into the
    // tracked tree. That is tool scratch, not corpus content — the measurement
    // clone sparse-excludes it (so `git hash-object` on the missing path would
    // fail), and the pin's content hash must not depend on a stale committed
    // index the tool is meant to rebuild.
    const files = execSync('git ls-files -z', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .split('\0')
      .filter((f) => f.length > 0 && !f.split('/').includes('.code-index'));
    if (files.length === 0) return null;
    const blobHashes = execSync('git hash-object --stdin-paths', {
      cwd: root,
      input: files.join('\n') + '\n',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();
    if (!blobHashes) return null;
    return execSync('git hash-object --stdin', {
      cwd: root,
      input: blobHashes + '\n',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();
  } catch {
    return null;
  }
}

/** The corpus's uncommitted paths, as `git status --porcelain` lines. */
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
 * Fail loudly (exit 2) when `projectRoot` cannot be proven to match its pin.
 * Returns normally only when the corpus is reconstructable from the pin. This is
 * the one gate every per-corpus measurement must pass — a number measured against
 * an unreproducible tree is not a measurement.
 *
 * Fail-closed: a missing/unreadable pins file, a corpus absent from it, a
 * non-git tree, a dirty tree, a moved HEAD, or a content-hash mismatch all exit 2
 * with a reason. It must be impossible to run a measurement against an unpinned
 * tree and report a number.
 */
export function assertCorpusPinned(projectRoot: string, nameOverride?: string): void {
  const corpusName = nameOverride ?? path.basename(path.resolve(projectRoot));

  let pins: Record<string, CorpusPin>;
  try {
    pins = loadPins();
  } catch (e) {
    console.error(
      `✗ CORPUS PINS UNAVAILABLE — ${e instanceof Error ? e.message : String(e)}. ` +
        'A measurement cannot gate against a tree it cannot pin; it will not be measured.',
    );
    process.exit(2);
  }

  const pinned = pins[corpusName];
  if (!pinned) {
    console.error(
      `✗ CORPUS NOT PINNED — no pin for '${corpusName}' in specs/corpus-pins.json. ` +
        'Record its HEAD SHA + content hash before measuring; an unpinned tree is not a measurement.',
    );
    process.exit(2);
  }

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

  const sha = currentSha(projectRoot);
  if (!sha) {
    console.error(
      `✗ CORPUS HEAD UNREADABLE — '${corpusName}' is not a git repo with a resolvable HEAD; ` +
        'it will not be measured.',
    );
    process.exit(2);
  }
  if (sha !== pinned.sha) {
    console.error(
      `✗ CORPUS HEAD DRIFT — corpus at ${sha}, pinned at ${pinned.sha}; ` +
        'a finding-count delta would be un-attributable, so it will not be measured.',
    );
    process.exit(2);
  }

  const contentHash = currentContentHash(projectRoot);
  if (contentHash === null) {
    console.error(
      `✗ CORPUS CONTENT UNREADABLE — could not hash '${corpusName}' tracked tree; ` +
        'it will not be measured.',
    );
    process.exit(2);
  }
  if (contentHash !== pinned.content) {
    console.error(
      `✗ CORPUS CONTENT DRIFT — tracked-tree content hash ${contentHash} does not ` +
        `match the pinned ${pinned.content}. The corpus sits at the right SHA but ` +
        'its bytes differ (a re-clone or reset can produce this); it will not be measured.',
    );
    process.exit(2);
  }

  console.log(`corpus pinned at ${pinned.sha} ✓ (content ${pinned.content} matches)`);
}

/**
 * Resolve a corpus's read-only validation clone on disk (under `corpus-readonly/`,
 * a sibling of `app`, or the `CORPUS_ROOT` override), or null when it is absent.
 *
 * The read-only clone — not the live development checkout — is the canonical
 * measurement source. It sits detached at the pinned SHA and is never edited, so
 * {@link assertCorpusPinned} holds permanently against it rather than failing
 * whenever the development checkout (a sibling at `<playground>/<name>`) is
 * mid-edit. A validation corpus must be reproducible; the live checkout carries
 * uncommitted work and is development scratch, never a corpus.
 */
export async function resolveCorpusDir(name: string): Promise<string | null> {
  const override = process.env.CORPUS_ROOT;
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const base = override ?? path.resolve(appRoot, '..', '..', 'corpus-readonly');
  const dir = path.resolve(base, name);
  try {
    const st = await fsp.stat(dir);
    return st.isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** Extract the stderr text from an `execSync` throw (its `.stderr` field). */
function execErrorDetail(e: unknown): string {
  if (e && typeof e === 'object' && 'stderr' in e) {
    const s = (e as { stderr?: unknown }).stderr;
    const text = typeof s === 'string' ? s : Buffer.isBuffer(s) ? s.toString('utf8') : '';
    return text.trim();
  }
  return String(e);
}

/**
 * Materialize a clean, pinned checkout of one corpus for measurement, or fail
 * closed (exit 2). This is the gate-entry point every corpus-reading gate must
 * pass through before measuring:
 *
 *   1. The corpus must be pinned (`specs/corpus-pins.json` has a `{sha, content}`
 *      entry) — otherwise `✗ CORPUS NOT PINNED`, exit 2.
 *   2. A fresh clone is checked out at the pinned SHA, so the measurement reads
 *      the *pinned bytes*, never the live tree's uncommitted work.
 *   3. {@link assertCorpusPinned} is then run against the snapshot — the same
 *      fail-closed assertion the pin mechanism defines — so the snapshot cannot
 *      be measured through unless it reconstructs the pin exactly.
 *
 * The snapshot is a throwaway clone under the OS temp dir; callers must invoke
 * the returned `cleanup` (best-effort, on both success and failure).
 */
export async function materializeCorpusSnapshot(
  name: string,
): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const source = await resolveCorpusDir(name);
  if (!source) {
    console.error(`✗ CORPUS ABSENT — read-only clone for '${name}' not found (set CORPUS_ROOT to the read-only clone dir).`);
    process.exit(2);
  }
  const pin = loadPins()[name];
  if (!pin) {
    console.error(
      `✗ CORPUS NOT PINNED — no pin for '${name}' in specs/corpus-pins.json. ` +
        'Record its HEAD SHA + content hash before measuring; an unpinned tree is not a measurement.',
    );
    process.exit(2);
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), `ca-corpus-${name}-`));
  const cleanup = async () => {
    try {
      await fsp.rm(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  try {
    execSync(`git clone --no-checkout --quiet -- "${source}" "${tmp}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    await cleanup();
    throw new Error(`could not clone '${name}' from ${source}: ${execErrorDetail(e)}`);
  }
  try {
    execSync(`git checkout --detach --force --quiet ${pin.sha}`, {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    await cleanup();
    throw new Error(`could not check out pinned SHA ${pin.sha} for '${name}': ${execErrorDetail(e)}`);
  }

  assertCorpusPinned(tmp, name);
  return { dir: tmp, cleanup };
}
