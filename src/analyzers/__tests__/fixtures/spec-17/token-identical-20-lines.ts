/**
 * Spec-17 R8 Fixture 13: token-identical-20-lines
 * Report section: R3.3 — dry/duplicate rule (exact token match)
 *
 * Two genuinely token-identical 15+ line for-loop blocks must produce a
 * `dry/duplicate` finding (warning severity), with the "first occurrence"
 * message citing the earlier block's location, never its own.
 *
 * The blocks must be extracted by the significant-block path
 * (isSignificantBlock), which requires the snake_case node-type fix
 * from the PascalCase→snake_case sweep (Task #32).
 *
 * Each for-loop has 18 non-blank lines after whitespace normalization.
 */

export function processBatch(items: string[]): string[] {
  const results: string[] = [];

  // Block A: token-identical to Block B (20+ lines raw, ~18 after normalization)
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || item.length === 0) {
      continue;
    }
    const trimmed = item.trim().toLowerCase();
    if (trimmed.startsWith("err:")) {
      results.push(`[ERROR] ${trimmed.slice(4)}`);
      continue;
    }
    if (trimmed.startsWith("warn:")) {
      results.push(`[WARN] ${trimmed.slice(5)}`);
      continue;
    }
    if (trimmed.startsWith("info:")) {
      results.push(`[INFO] ${trimmed.slice(5)}`);
      continue;
    }
    if (trimmed.startsWith("debug:")) {
      results.push(`[DEBUG] ${trimmed.slice(6)}`);
      continue;
    }
    results.push(trimmed);
  }

  // Block B: token-identical to Block A (20+ lines raw, ~18 after normalization)
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || item.length === 0) {
      continue;
    }
    const trimmed = item.trim().toLowerCase();
    if (trimmed.startsWith("err:")) {
      results.push(`[ERROR] ${trimmed.slice(4)}`);
      continue;
    }
    if (trimmed.startsWith("warn:")) {
      results.push(`[WARN] ${trimmed.slice(5)}`);
      continue;
    }
    if (trimmed.startsWith("info:")) {
      results.push(`[INFO] ${trimmed.slice(5)}`);
      continue;
    }
    if (trimmed.startsWith("debug:")) {
      results.push(`[DEBUG] ${trimmed.slice(6)}`);
      continue;
    }
    results.push(trimmed);
  }

  return results;
}
