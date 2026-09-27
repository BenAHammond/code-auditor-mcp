/**
 * Spec 68 §3.2 — the per-file `react-component` producer.
 *
 * Projects a parsed file's React components onto the serializable
 * `ReactComponentScan` fact by running `scanParsedFile` — the scan half of
 * `componentScanner.scanFile` — over the already-parsed `AstFile`. The legacy
 * react visitor called `scanFile` (which read the file off disk and re-parsed);
 * the phase model already holds the parsed tree, so the producer runs the scan
 * body directly over `file.ast` + `file.source` and lets the tree die with the
 * file.
 *
 * The producer never decides "is this a finding" — it projects the component
 * universe (metadata, imports, JSX elements, hooks, props, complexity). The
 * rules own the classification: they re-cast the fact back to
 * `ComponentScanResult` (structurally identical) and run the existing
 * `analyzeComponent` / `checkCircularDependencies` / `checkErrorBoundaryUsage` /
 * `checkRawElements` detectors, so the classification half is bit-identical to
 * the legacy path.
 *
 * `extractHooks` is always true here: the legacy visitor tied it to
 * `checkHooksRules`, but `hooks-naming` gates on that flag itself, so the
 * extraction choice has no effect on findings — and a fact should carry the
 * full projection regardless of which rules happen to be enabled.
 */

import type { AstFile, ReactComponentScan } from './types.js';
import { scanParsedFile } from '../componentScanner.js';

/** The options the legacy react visitor used, with `extractHooks` pinned true. */
const SCAN_OPTIONS = {
  includeTests: false,
  includeStories: false,
  extractProps: true,
  extractHooks: true,
  extractImports: true,
  detectComplexity: true,
};

/** One file's scanned components as a single `ReactComponentScan` fragment. */
export function extractReactComponents(file: AstFile): ReactComponentScan {
  const scanned = scanParsedFile(file.ast, file.source, file.file, SCAN_OPTIONS);
  // The scan result is already plain data; the cast drops the interface/object-
  // literal distinction that §4's `Serializable` arm cannot see through.
  return scanned as unknown as ReactComponentScan;
}
