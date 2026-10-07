/**
 * Spec 70 Item 4 (step 3) — the per-file `receiver-activity` producer.
 *
 * The extract half of the corpus-side `dbProvenanced` re-derivation. The four
 * receiver consumers (`schema-usage`, `query-sites`, `data-access-calls`,
 * `loop-queries`) will move from file producers (which read `file.receiverProvenance`
 * seeded by the second parse) to corpus producers (which read the `receiver-provenance`
 * fixed point). To re-derive each file's `buildProvenanceContext` `dbProvenanced`
 * corpus-side — with no AST — the corpus producer needs the three provenance inputs
 * that only the AST walk can supply, projected here while the tree still lives:
 *
 *   • `bindings`  — the TS binding environment (`buildBindingEnv`), which
 *                   `identifyHandle` reads for declaration resolution (R4).
 *   • `r3Sites`   — the R3 sites (`extractR3Sites`), the member calls whose static
 *                   SQL argument proves their receiver a handle (criterion 8),
 *                   re-folded corpus-side by `applyR3FromSites`.
 *   • `dbActivity` — the DB-shaped activity set (`collectDbActivity`), the
 *                   provenance-free file-gate signal `passesFileGate` reads.
 *
 * Go files carry none of these (`collectDbActivity` / `extractR3Sites` return empty,
 * and the Go binding/import env already lives in `within-file-provenance` +
 * `go-package-bindings`), so the producer is registered for the three TS-family
 * formats alone. It emits exactly one fragment per file (null-or-value — a file with
 * no bindings/activity still yields a fragment so the corpus producer sees the file).
 */

import type { AstFile, ReceiverActivityFact } from './types.js';
import { buildBindingEnv } from '../analyzers/receiverRoot.js';
import { collectDbActivity, extractR3Sites } from '../analyzers/provenance.js';
import { bindingToFact } from './withinFileProvenance.js';

/**
 * One file's receiver-resolution inputs, as a single `ReceiverActivityFact`.
 *
 * @param file - The parsed code file whose bindings + R3 sites + DB activity are
 *   projected.
 * @returns A one-element array carrying the file's TS receiver-resolution inputs.
 */
export function extractReceiverActivity(file: AstFile): ReceiverActivityFact[] {
  const bindings = buildBindingEnv(file.ast, file.adapter, file.source);
  const r3Sites = extractR3Sites(file.ast, file.adapter, file.source);
  const dbActivity = collectDbActivity(file.ast, file.adapter, file.source);

  return [
    {
      file: file.file,
      format: file.format as 'typescript' | 'tsx' | 'javascript',
      bindings: [...bindings.entries()].map(([name, b]) => bindingToFact(name, b)),
      r3Sites: r3Sites.map((s) => ({
        root: s.root,
        receiver: s.receiver,
        method: s.method,
        sqlArgument: s.sqlArgument,
        thisField: s.thisField,
        thisHeritage: s.thisHeritage,
      })),
      dbActivity: [...dbActivity],
    },
  ];
}
