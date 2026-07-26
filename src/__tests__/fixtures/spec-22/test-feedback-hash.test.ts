/**
 * Spec-22 R6 — Hash assertion for the post-release dogfood triage artifact.
 * The test-feedback.md file is the unedited diagnostic record from the v3.4.1
 * recall-corpus triage (8,160 findings). It must never change without a
 * deliberate hash update here — it is the evidence that drove all six
 * defect-class fixes in Spec 22.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FEEDBACK_PATH = join(
  __dirname, '..', '..', '..', '..',
  'specs', 'test-feedback', 'test-feedback.md',
);

// SHA-256 of specs/test-feedback/test-feedback.md as committed 2026-07-24.
// If the triage document is intentionally updated, update this hash.
const EXPECTED_HASH = 'f5f82835eaf8f0da8c46dcf86dc8c11b0818a02346c7547f92955cb701a6449b';

describe('Spec-22: post-release triage artifact integrity', () => {
  it('test-feedback.md exists and matches expected hash', async () => {
    const content = await readFile(FEEDBACK_PATH, 'utf-8');
    const actualHash = createHash('sha256').update(content).digest('hex');
    expect(actualHash).toBe(EXPECTED_HASH);
  });
});
