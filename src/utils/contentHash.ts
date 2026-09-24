import { createHash } from 'crypto';

/**
 * SHA-256 of a normalized body + signature pair — the identity used to detect
 * whether an indexed function changed since its last sync.
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
 * `signature` normalizes through `(signature ?? '')` because the pipeline
 * writes `''` while `FunctionScanner` leaves the field `undefined`; both must
 * hash identically for the diff to stay quiet on a no-edit run.
 */
export function computeContentHash(
  body: string | undefined,
  signature: string | undefined
): string {
  const normalized =
    (body ?? '').replace(/\s+/g, ' ').trim() + '|' + (signature ?? '').trim();
  return createHash('sha256').update(normalized).digest('hex');
}
