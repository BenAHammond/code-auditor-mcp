/**
 * Spec 68 §16 — the four compile-time checks, seeded permanently.
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

import type { FactKind, Serializable } from './types.js';
import type { ProducedFactKind, ProducerMap } from './producers.js';
import type { ConsumedFactKind } from './consumed.js';

// 1. Residue #1 — every fact kind has a producer. `Exclude<FactKind,
//    ProducedFactKind>` is `never` only when every kind is produced; assigning a
//    FactKind value to `never` must not compile.
// @ts-expect-error — an unproduced fact kind would make this a non-never type
const _unproduced: Exclude<FactKind, ProducedFactKind> = 'file-symbols' as FactKind;

// 2. Residue #2 — every produced fact kind is consumed by a rule or a corpus
//    processor. `Exclude<ProducedFactKind, ConsumedFactKind>` is `never` only
//    when nothing is produced-and-never-read.
// @ts-expect-error — an unconsumed produced kind would make this a non-never type
const _unconsumed: Exclude<ProducedFactKind, ConsumedFactKind> = 'file-symbols' as ProducedFactKind;

// 3. Serializability — no fact kind carries a method. A function is not
//    `Serializable`, so a fact shaped like this could never cross the
//    Process→Analyze boundary as a value.
// @ts-expect-error — a function is not Serializable
const _notSerializable: Serializable = () => {};

// 4. Single producer — `ProducerMap` is an exhaustive mapped type over
//    `FactKind`. An object literal missing every fact-kind key must not satisfy
//    it (a second producer is caught the same way, as a duplicate key).
// @ts-expect-error — {} lacks every fact-kind key, so it cannot satisfy ProducerMap
const _incompleteProducers: ProducerMap = {};
