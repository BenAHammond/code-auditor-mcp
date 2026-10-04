/**
 * Spec 70 Item 4 (2a) — the per-file `go-package-bindings` producer.
 *
 * Projects `buildGoFileBindings` (goResolution.ts) — the exact per-file half of
 * the legacy `buildGoPackageBindings` — onto the serializable package-scope
 * symbol set the cross-file receiver-provenance fixed point groups by directory
 * and merges first-wins. Using the exact legacy extractor (not a
 * re-implementation) makes the per-file binding set byte-identical by
 * construction, so the parity assertion in step 2.5 is a diff of the wiring, not
 * of the extraction.
 */

import type { AstFile, GoPackageBindingFact, GoPackageBinding } from './types.js';
import { buildGoFileBindings } from '../languages/go/goResolution.js';
import { isTestFile } from '../languages/testConventions.js';

/**
 * One Go file's package-scope declarations as a single `GoPackageBindingFact`.
 *
 * @param file - The parsed Go file whose package-scope bindings are projected.
 * @returns A one-element array carrying the file's `{name, binding}` pairs, or
 *   `[]` for a non-Go or `*_test.go` file (the Go producers exempt test files,
 *   matching the deleted Go subprocess's `filePatterns`).
 */
export function extractGoPackageBindings(file: AstFile): GoPackageBindingFact[] {
  if (file.adapter.name !== 'go') return [];
  if (isTestFile('go', file.file)) return [];

  const bindings: GoPackageBinding[] = [...buildGoFileBindings(file.ast).entries()].map(
    ([name, binding]) => ({ name, binding }),
  );
  return [{ file: file.file, bindings }];
}
