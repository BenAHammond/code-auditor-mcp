#!/usr/bin/env node
// Fail fast when free disk space is too low for verify:close, instead of
// letting `npm pack` or test scratch hit ENOSPC and read as a broken gate.
// Spec 46 — disk hygiene: an ENOSPC mid-gate looks like a test failure until
// someone checks the actual error. This makes the next occurrence self-evident.
//
// Uses the temp filesystem (os.tmpdir()) because that is where the scratch
// dirs and npm-pack fixtures actually write, not necessarily the CWD volume.

import { statfsSync } from 'node:fs';
import os from 'node:os';

const MIN_FREE_BYTES = Number(
  process.env.VERIFY_MIN_FREE_BYTES ?? 1 * 1024 * 1024 * 1024, // 1 GiB
);

const gib = (n) => `${(n / 1024 ** 3).toFixed(2)} GiB`;

// statfsSync on the temp root; bavail is free blocks available to an
// unprivileged user (what npm/test actually get).
const stat = statfsSync(os.tmpdir());
const freeBytes = stat.bavail * stat.bsize;

if (freeBytes < MIN_FREE_BYTES) {
  console.error(
    `insufficient disk: ${gib(freeBytes)} free, need at least ${gib(MIN_FREE_BYTES)}. ` +
      'verify:close aborted before running — free up space (e.g. pruned ~/.fcc/logs) and retry.',
  );
  process.exit(1);
}

console.log(`disk ok: ${gib(freeBytes)} free (need ≥ ${gib(MIN_FREE_BYTES)})`);
