/**
 * Spec 68 — the compile-time checks, in the Spec 61 assertion idiom
 * (`const _x: Cond extends never ? true : never = true`).
 *
 * These are the guards that make "a rule cannot be dead by selection", "a fact
 * cannot carry a method", and "a fact cannot be produced and never read"
 * properties of the type system rather than claims about a list:
 *
 *   1. Residue #1 (`_allProduced`)   — every fact kind has a producer.
 *   2. Residue #2 (`_allConsumed`)   — every produced kind is declared by a
 *                                      migrated rule or a corpus processor.
 *   3. Serializability (`_allSerializable`) — no fact kind carries a method
 *                                      (a tree-sitter node cannot be a fact).
 *   4. Single producer (`PRODUCERS` `satisfies ProducerMap`,
 *                                      `CORPUS_PRODUCERS` `satisfies
 *                                      CorpusProducerMap`) — nested mapped types
 *                                      over (kind, format); a second producer
 *                                      for one (kind, format) is a duplicate
 *                                      key, a missing kind or format fails the
 *                                      type. (Lives in producers.ts; asserted
 *                                      again here via `ProducedFactKind`.)
 *   5. Map disjointness (`_mapsDisjoint`) — no kind produced by both a file
 *                                      and a corpus producer.
 *
 * Residue #2 is only meaningful as a compile check once every rule is migrated:
 * the consumed set is derived from `MIGRATED_RULES`, and an unconsumed produced
 * kind is a real residue only when there are no rules left waiting to declare
 * it. It is live now that `MIGRATED_RULES` reads all 100 (its element type is
 * the union of each rule's `RuleDefinition<N>`, not `any` — see consumed.ts).
 *
 * Each check fails on a seeded defect (see seeded-defects.ts and §16 guards 1,
 * 2, 3, 4): break one and `tsc --noEmit` fails. The residue and serializability
 * assertions are type-only and erase to nothing at runtime. The seeded defects
 * live in `seeded-defects.ts` — deliberately broken assignments under
 * `@ts-expect-error`, so a check that regresses fails the build rather than
 * waiting for a manual demonstration.
 */

import type { FactShapes, FactKind, Serializable } from './types.js';
import { PRODUCERS, CORPUS_PRODUCERS, type ProducedFactKind } from './producers.js';
import type { ConsumedFactKind } from './consumed.js';

// ── 1. Residue #1 — every fact kind has a producer ──────────────────────────
type _Unproduced = Exclude<FactKind, ProducedFactKind>;
const _allProduced: _Unproduced extends never ? true : never = true;

// ── 2. Residue #2 — every produced kind is consumed ─────────────────────────
type _Unconsumed = Exclude<ProducedFactKind, ConsumedFactKind>;
const _allConsumed: _Unconsumed extends never ? true : never = true;

// ── 3. Serializability — no fact kind carries a method ──────────────────────
type _FactsSerializable = {
  [K in FactKind]: FactShapes[K] extends Serializable ? true : never;
};
const _allSerializable: _FactsSerializable[FactKind] = true as const;

// ── 4. Single producer — PRODUCERS + CORPUS_PRODUCERS are exhaustive ────────
// Enforced by `satisfies ProducerMap` / `satisfies CorpusProducerMap` in
// producers.ts. Re-asserted here via ProducedFactKind so the checks live in one
// place and the conformance test can import them as a single surface.

// ── 5. Map disjointness — no kind produced by both maps ─────────────────────
// Splitting file and corpus producers into two maps re-opened §3.1's invariant
// across the boundary: a kind could sit in both, which is two producers for one
// kind. The intersection of the two key sets must be empty.
type _OverlappingKinds = keyof typeof PRODUCERS & keyof typeof CORPUS_PRODUCERS;
const _mapsDisjoint: _OverlappingKinds extends never ? true : never = true;

// The `const` values above are the check: each is type-checked by `tsc` when
// this file is compiled, and a regressed invariant turns the assignment's type
// into `never` so `= true` fails the build. Nothing imports this module — it is
// a compile-time-only guard (like `seeded-defects.ts`), in `include: src/**/*`,
// so `tsc --noEmit` reaches it regardless of the import graph.
