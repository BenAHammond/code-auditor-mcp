/**
 * Regenerate `specs/corpus-pins.json` from the measurement clones.
 *
 * Usage:
 *   npx tsx scripts/write-corpus-pins.ts <path-to-clone> [<path-to-clone> ...]
 *
 * Each argument is a corpus clone (a clean git checkout at a fixed SHA, with
 * `.code-index/` sparse-excluded). The script records, per corpus:
 *   - `sha`: the clone's HEAD (read from git, never hand-typed), and
 *   - `content`: the tracked-tree content hash, computed by the *same*
 *     `currentContentHash` the `assertCorpusPinned` gate uses.
 *
 * The pin is therefore machine-generated from the tree it describes — the only
 * way a content hash enters the file is by hashing that tree, so the class of
 * hand-transcription error that has corrupted baselines before cannot reach it.
 * `assertCorpusPinned` then verifies a future measurement clone against this
 * file byte-for-byte.
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { currentSha, currentContentHash, type CorpusPin } from './corpus-pins.js';

function pinsPath(): string {
  return path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    'specs',
    'corpus-pins.json',
  );
}

function main(argv: string[]): void {
  const clones = argv;
  if (clones.length === 0) {
    console.error('usage: npx tsx scripts/write-corpus-pins.ts <clone> [<clone> ...]');
    process.exit(2);
  }

  const pins: Record<string, CorpusPin> = {};
  for (const clone of clones) {
    const root = path.resolve(clone);
    const name = path.basename(root);

    const sha = currentSha(root);
    if (!sha) {
      console.error(`✗ ${name}: not a git repo with a resolvable HEAD — skipped`);
      process.exit(2);
    }
    const content = currentContentHash(root);
    if (content === null) {
      console.error(`✗ ${name}: could not hash tracked tree — skipped`);
      process.exit(2);
    }

    pins[name] = { sha, content };
    console.log(`${name}: sha=${sha} content=${content}`);
  }

  const out = pinsPath();
  // Stable key order so a regenerate is byte-for-byte diffable.
  const ordered: Record<string, CorpusPin> = {};
  for (const key of Object.keys(pins).sort()) {
    ordered[key] = pins[key];
  }
  fs.writeFileSync(out, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
  console.log(`\nwrote ${out}`);
}

main(process.argv.slice(2));
