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
 * Residue #2 (every produced kind is consumed) has no seed here: it is a runtime
 * assertion over `MIGRATED_RULES`, not a compile check, because it is red for
 * the whole migration (see spec68-consumed-coverage.spec.ts).
 *
 * This file is intentionally NOT a `*.spec.ts` / `*.test.ts`: those suffixes
 * are excluded from the tsconfig, and this file's entire job is to be seen by
 * the type-checker. It is never imported and emits nothing at runtime.
 */

import type { FactKind, Serializable } from './types.js';
import type { ProducedFactKind, ProducerMap } from './producers.js';

// 1. Residue #1 — every fact kind has a producer. `Exclude<FactKind,
//    ProducedFactKind>` is `never` only when every kind is produced; assigning a
//    FactKind value to `never` must not compile.
// @ts-expect-error — an unproduced fact kind would make this a non-never type
const _unproduced: Exclude<FactKind, ProducedFactKind> = 'file-symbols' as FactKind;

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
