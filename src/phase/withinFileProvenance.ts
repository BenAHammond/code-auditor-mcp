/**
 * Spec 70 Item 4 (2a) — the per-file `within-file-provenance` producer.
 *
 * The extract half of the TS/Go within-file-provenance split. Each format's
 * {@link ResolutionImplementation} exposes `extract(ast, adapter, sourceCode)`
 * (the seam extended in Step 2), which projects everything the within-file
 * fixed point reads into a serializable descriptor carrying no live node. This
 * producer calls that seam and re-projects the two `interface`/`Map`/`Set`
 * members the seam cannot serialize — `seeds` (Map) and `localFunctions` (Set)
 * on the TS arm, and the `imports`/`bindings` Maps on the Go arm — into the
 * §4-serializable `WithinFileProvenanceFact` shape.
 *
 * Using the exact seam extractor (not a re-implementation) makes the per-file
 * projection byte-identical to what `classify(extract(ast, …))` re-derives, so
 * the corpus `receiver-provenance` producer can rehydrate it with no translation
 * and no AST. The parity spec (`spec70-ts-within-file-parity.spec.ts`) already
 * pins `classify(extract(ast))` ≡ `compute(ast)` for every fixture; this
 * producer is the serialization boundary that lets the corpus fixed point read
 * the extract without re-parsing the file.
 */

import type { AstFile, WithinFileProvenanceFact, ProvenanceEvidenceFact, WithinFileOwnCall, TsBindingFact } from './types.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';
import type { OwnCall } from '../analyzers/tsExpressionDescriptor.js';
import type { Binding } from '../analyzers/receiverRoot.js';
import { RESOLUTION_IMPLEMENTATIONS } from '../analyzers/handleIdentification.js';
import { isTestFile } from '../languages/testConventions.js';

/** Project a `ProvenanceEvidence` (interface) into its §4-serializable `type`.
 *  Exported so the `receiver-provenance` corpus producer projects the fixed
 *  point's `Map<string, ProvenanceEvidence>` through the *same* mapping — one
 *  projection, not two that could drift.
 * @param e - The interface-form evidence to project into its serializable type.
 * @returns The §4-serializable `ProvenanceEvidenceFact`, with `packageName`
 *   present only when the evidence carries one. */
export function evidenceToFact(e: ProvenanceEvidence): ProvenanceEvidenceFact {
  const base = {
    identifier: e.identifier,
    reason: e.reason,
    source: e.source,
    chain: [...e.chain],
  };
  return e.packageName === undefined ? base : { ...base, packageName: e.packageName };
}

/** Project an `OwnCall` (interface) into its §4-serializable `type`. */
function ownCallToFact(c: OwnCall): WithinFileOwnCall {
  return { callee: c.callee, isD1Rest: c.isD1Rest };
}

/** Project a `Binding` (interface) into its §4-serializable `type`. Exported so the
 *  `receiver-activity` producer projects its bindings through the *same* mapping —
 *  one projection, not two that could drift (the `receiver-activity` fact also
 *  carries the binding env for the build-side `classifyBuildProvenance`).
 * @param name - The bound name.
 * @param b - The interface-form binding to project.
 * @returns The §4-serializable `TsBindingFact`, omitting absent optional fields. */
export function bindingToFact(name: string, b: Binding): TsBindingFact {
  return {
    name,
    kind: b.kind,
    ...(b.source !== undefined ? { source: b.source } : {}),
    ...(b.importKind !== undefined ? { importKind: b.importKind } : {}),
    ...(b.typeText !== undefined ? { typeText: b.typeText } : {}),
    ...(b.value !== undefined ? { value: b.value } : {}),
    ...(b.scope !== undefined ? { scope: b.scope } : {}),
  };
}

/**
 * One file's within-file provenance, as a single `WithinFileProvenanceFact`.
 *
 * @param file - The parsed code file whose within-file provenance is projected.
 * @returns A one-element array carrying the file's TS or Go provenance
 *   projection, or `[]` for a format with no executable receiver (the producer
 *   is only ever registered for the four code formats, but the `*_test.go`
 *   exemption mirrors the deleted Go subprocess's `filePatterns`).
 */
export function extractWithinFileProvenance(file: AstFile): WithinFileProvenanceFact[] {
  if (isTestFile('go', file.file)) return [];

  const impl = RESOLUTION_IMPLEMENTATIONS[file.format];
  const extract = impl.extract(file.ast, file.adapter, file.source);

  if (extract.kind === 'none') return [];

  if (extract.kind === 'ts') {
    return [
      {
        file: file.file,
        format: file.format as 'typescript' | 'tsx' | 'javascript',
        ts: {
          seeds: [...extract.projection.seeds.values()].map(evidenceToFact),
          bindings: [...extract.projection.bindings.entries()].map(([name, b]) => bindingToFact(name, b)),
          localFunctions: [...extract.projection.localFunctions],
          propagationRules: extract.projection.propagationRules,
          wrapperFunctions: extract.projection.wrapperFunctions.map((fn) => ({
            name: fn.name,
            ownCalls: fn.ownCalls.map(ownCallToFact),
          })),
          wrapperClasses: extract.projection.wrapperClasses,
          returningFunctions: extract.projection.returningFunctions,
          interfaceFields: [...(extract.projection.interfaceFields ?? new Map()).entries()].map(
            ([name, fields]) => ({
              name,
              fields: [...fields.entries()].map(([field, typeText]) => ({ name: field, typeText })),
            }),
          ),
        },
      },
    ];
  }

  return [
    {
      file: file.file,
      format: 'go',
      go: {
        imports: [...extract.projection.imports.entries()].map(([name, source]) => ({ name, source })),
        bindings: [...extract.projection.bindings.entries()].map(([name, binding]) => ({ name, binding })),
      },
    },
  ];
}
