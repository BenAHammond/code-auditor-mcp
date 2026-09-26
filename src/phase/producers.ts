/**
 * Spec 68 §3.1 — one producer per fact kind, enforced by a mapped type.
 *
 * `ProducerMap` is a mapped type over {@link FactKind}: exhaustive by
 * construction. A fact kind with no entry fails the type (residue check #1 in
 * checks.ts); a second producer for one kind is a duplicate object key
 * (single-producer check). There is no list to be omitted from — which is the
 * defect class Spec 68 §0, row 2 exists to remove.
 *
 * The entries below are the *registration* of every fact kind's producer, with
 * the id / produces / formats (or upstream `needs`) that §5's DAG and §8's
 * coverage are derived from. Their `process` bodies are wired in §3.2 (the six
 * extraction visitors) and §9 (the Go binary); until then each throws — the
 * registry is the schedule, the body is the implementation, and the two are
 * deliberately separate so a producer can be *declared* (and thus fail the
 * residue check if absent) before its extraction is migrated.
 */

import type {
  FactKind,
  FileProcessor,
  CorpusProcessor,
  Producer,
  ParsedFile,
  FactFragment,
  Format,
} from './types.js';

/** Exhaustive map over every fact kind. `satisfies` is the single-producer check. */
export type ProducerMap = { readonly [K in FactKind]: Producer<K> };

/**
 * The fact kinds a producer currently serves. Derived from the actual keys of
 * {@link PRODUCERS}, not re-declared — add a producer and this widens with it.
 */
export type ProducedFactKind = keyof typeof PRODUCERS;

/** A per-file producer whose extraction body is migrated in §3.2 / §9. */
function fileProducer<K extends FactKind>(
  id: string,
  produces: K,
  formats: readonly Format[],
): FileProcessor<K> {
  return {
    id,
    produces,
    formats,
    process(_file: ParsedFile): FactFragment<K> {
      throw new Error(`spec68 §3.2: producer "${id}" is declared but not yet migrated`);
    },
  };
}

/** A corpus producer whose reduction body is migrated in §3.2 / §5. */
function corpusProducer<K extends FactKind, N extends readonly FactKind[]>(
  id: string,
  produces: K,
  needs: N,
): CorpusProcessor<K, N> {
  return {
    id,
    produces,
    needs,
    process(): ReturnType<CorpusProcessor<K, N>['process']> {
      throw new Error(`spec68 §3.2: producer "${id}" is declared but not yet migrated`);
    },
  };
}

export const PRODUCERS = {
  // ── §3.2: the six extraction visitors, re-registered as FileProcessors ────
  'file-symbols': fileProducer('file-symbols', 'file-symbols', ['typescript', 'tsx', 'javascript']),
  'function-index': fileProducer('function-index', 'function-index', ['typescript', 'tsx', 'javascript']),
  'schema-json': fileProducer('schema-json', 'schema-json', ['typescript', 'tsx', 'javascript']),
  'schema-code': fileProducer('schema-code', 'schema-code', ['typescript', 'tsx', 'javascript']),
  'schema-usage': fileProducer('schema-usage', 'schema-usage', ['typescript', 'tsx', 'javascript']),
  'styles-css': fileProducer('styles-css', 'styles-css', ['css', 'scss']),
  'cross-language-entities': fileProducer('cross-language-entities', 'cross-language-entities', ['typescript', 'tsx', 'javascript', 'go']),
  'data-access-calls': fileProducer('data-access-calls', 'data-access-calls', ['typescript', 'tsx', 'javascript']),

  // ── §3.2: corpus processors producing derived facts ───────────────────────
  'table-catalog': corpusProducer('table-catalog', 'table-catalog', ['schema-json', 'schema-code']),

  // ── §9: the Go binary as an external-process FileProcessor ────────────────
  'go-imports': fileProducer('go-imports', 'go-imports', ['go']),
  'go-error-bindings': fileProducer('go-error-bindings', 'go-error-bindings', ['go']),
  'go-goroutines': fileProducer('go-goroutines', 'go-goroutines', ['go']),
  'go-channels': fileProducer('go-channels', 'go-channels', ['go']),
} satisfies ProducerMap;
