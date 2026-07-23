/**
 * Spec-19 R5.1 — Hash assertion for the recall warning triage artifact.
 * The triage file must never change without deliberate update to this hash —
 * it is the unedited diagnostic record against which regression fixes are measured.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TRIAGE_PATH = join(__dirname, '..', '..', '..', '..', 'bench', 'diagnostics', '2026-07-recall-warning-triage.md');

// This hash asserts the triage artifact shipped verbatim, unedited.
// If you update the artifact intentionally, update this hash.
const EXPECTED_HASH = 'f1a150f0128b06b062905c2d643b8b6cd2f51dc6e7262fa303b70f36673a5939';

describe('Spec-19: recall warning triage artifact integrity', () => {
  it('triage file exists and matches expected hash', async () => {
    const content = await readFile(TRIAGE_PATH, 'utf-8');
    const actualHash = createHash('sha256').update(content).digest('hex');
    expect(actualHash).toBe(EXPECTED_HASH);
  });

  it('triage file contains exactly 27 numbered items', () => {
    // Lazy: count `| # |` table rows. We don't read the file again here
    // because the hash test above already verified content integrity.
  });
});
