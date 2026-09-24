import { createHash } from 'crypto';

/**
 * SHA-256 of a normalized body — the identity used to detect whether an indexed
 * function changed since its last sync.
 *
 * This is the single canonical definition. The pipeline writes this hash when
 * it indexes a function (`pipelineAdapters.createFunctionIndexVisitor`), and
 * `CodeIndexDB.detectChangedFunctions` recomputes it to decide changed-vs-not.
 * The two sides previously carried byte-identical copies in `codeIndexDB.ts`
 * and `pipelineAdapters.ts`; had they ever drifted, the stored hash and the
 * recomputed hash would diverge silently and every no-edit `changed` run would
 * report the whole file changed. One definition, imported by both, keeps them
 * in step by construction.
 *
 * The `signature` second argument is gone (Spec 63 R6). Every producer fed it
 * an empty value — the pipeline wrote the literal `''`, and `FunctionScanner`
 * left the field `undefined` — so it contributed a constant `|` suffix to every
 * hash and never distinguished one function from another. It was a dead seam:
 * it looked like it identified the function's declaration while no producer
 * populated it. Hashing the body alone is what change detection actually needs.
 */
export function computeContentHash(body: string | undefined): string {
  const normalized = (body ?? '').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}
