/**
 * Spec 68 §16 — the compile-time checks, seeded permanently.
 *
 * Each block below is deliberately broken and sits under `@ts-expect-error`.
 * The `@ts-expect-error` is what turns criterion 4's seeded demonstration into
 * a permanent test instead of a one-time manual act: it is *satisfied* only
 * while the corresponding check in checks.ts is healthy enough that the broken
 * assignment fails to type-check. If a future edit weakens a check so that the
 * assignment starts to compile, the `@ts-expect-error` becomes an unused
 * directive and `tsc --noEmit` fails — the regression is caught at build time,
 * not found by hand.
 *
 * This file is intentionally NOT a `*.spec.ts` / `*.test.ts`: those suffixes
 * are excluded from the tsconfig, and this file's entire job is to be seen by
 * the type-checker. It is never imported and emits nothing at runtime.
 */

import type { FactKind, FileProcessor, Serializable } from './types.js';
import { PRODUCERS, CORPUS_PRODUCERS, type ProducedFactKind, type ProducerMap } from './producers.js';
import type { ConsumedFactKind } from './consumed.js';

// 1. Residue #1 — every fact kind has a producer. `Exclude<FactKind,
//    ProducedFactKind>` is `never` only when every kind is produced; assigning a
//    FactKind value to `never` must not compile.
// @ts-expect-error — an unproduced fact kind would make this a non-never type
const _unproduced: Exclude<FactKind, ProducedFactKind> = 'file-symbols' as FactKind;

// 2. Residue #2 — every produced kind is consumed by a migrated rule or corpus
//    processor. `Exclude<ProducedFactKind, ConsumedFactKind>` is `never` only
//    when every produced kind is read; assigning a produced kind to `never` must
//    not compile. The seed names `file-symbols`, so it liveness-fails the moment
//    that kind stops being declared by any rule or corpus processor (the
//    `@ts-expect-error` goes unused).
// @ts-expect-error — an unconsumed produced kind would make this a non-never type
const _unconsumed: Exclude<ProducedFactKind, ConsumedFactKind> = 'file-symbols' as ProducedFactKind;

// 3. Serializability — no fact kind carries a method. A function is not
//    `Serializable`, so a fact shaped like this could never cross the
//    Process→Analyze boundary as a value.
// @ts-expect-error — a function is not Serializable
const _notSerializable: Serializable = () => {};

// 4. Single producer — `ProducerMap` is an exhaustive mapped type over
//    `FileFactKind` (each key a second mapped type over its `SupplyingFormats`).
//    An object literal missing every file-kind key must not satisfy it (a
//    second producer for one (kind, format) is caught the same way, as a
//    duplicate key). `CORPUS_PRODUCERS` is checked the same way by its own
//    `satisfies CorpusProducerMap` in producers.ts.
// @ts-expect-error — {} lacks every file-kind key, so it cannot satisfy ProducerMap
const _incompleteProducers: ProducerMap = {};

// 5. Map disjointness — a fact kind must not be produced by both a file
//    producer and a corpus producer (two producers for one kind). The
//    intersection of the two maps' key sets is `never` only while they are
//    disjoint; assigning a FactKind literal to it must not compile. If a kind
//    were present in both, the intersection would widen to that kind's name and
//    this assignment would compile — the `@ts-expect-error` goes unused and the
//    build fails.
// @ts-expect-error — an overlapping kind would make this a non-never type
const _overlap: keyof typeof PRODUCERS & keyof typeof CORPUS_PRODUCERS = 'resolution';

// 6. Producer-side oracle (Spec 69 R1 criterion 1) — `FileProcessor` requires
//    `oracle`. A processor literal that omits it must not satisfy the type, the
//    producer-side forcing function mirroring a rule's `needs` (criterion 4's
//    seeded demonstration in Spec 68). If a future edit makes `oracle` optional,
//    this literal starts to compile and the `@ts-expect-error` goes unused — the
//    build fails.
// @ts-expect-error — a FileProcessor without `oracle` must not satisfy the type
const _noOracle: FileProcessor<'file-symbols', 'typescript'> = { id: 'file-symbols.typescript', produces: 'file-symbols', format: 'typescript', process: (_file) => [] as never };
