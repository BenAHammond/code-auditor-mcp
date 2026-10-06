#!/usr/bin/env node
/**
 * Generate the Go stdlib package snapshot (`src/languages/go/stdlib-packages.json`)
 * from the installed Go toolchain, never from a hand-maintained list.
 *
 * The stdlib is enumerable: `go list std` is the authoritative list of every
 * package in the Go standard library. A receiver whose import path resolves to a
 * stdlib package (`fmt`, `strings`, `net/http`, `reflect`, …) is `not-handle` —
 * it cannot be a database client — so the Go resolution classifier needs the
 * stdlib set as the "definitively not a DB" half of its three-way disposition
 * (`handle` via the database-packages manifest, `not-handle` via stdlib, and
 * `unproven` for an unrecognized third-party path).
 *
 * The snapshot is committed (so the shipped package resolves stdlib roots without
 * invoking `go` at runtime) and this generator is committed beside it, so the
 * snapshot is reproducible rather than hand-edited. Regenerate with:
 *
 *   node scripts/generate-go-stdlib.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '..', 'src', 'languages', 'go', 'stdlib-packages.json');

// `go list std` prints one import path per line. Sort for a stable committed
// diff across Go versions (the list itself is already sorted, but sort again to
// be explicit) and drop the trailing newline split artifact.
const raw = execFileSync('go', ['list', 'std'], { encoding: 'utf8' });
const packages = raw.split('\n').map((p) => p.trim()).filter((p) => p.length > 0).sort();

writeFileSync(outPath, JSON.stringify(packages, null, 2) + '\n');
process.stdout.write(`generate-go-stdlib → ${packages.length} stdlib packages\n`);
