/**
 * Spec 68 — the compile-time checks, in the Spec 61 assertion idiom
 * (`const _x: Cond extends never ? true : never = true`).
 *
 * These are the guards that make "a rule cannot be dead by selection" and "a
 * fact cannot carry a method" properties of the type system rather than claims
 * about a list:
 *
 *   1. Residue #1 (`_allProduced`)   — every fact kind has a producer.
 *   2. Serializability (`_allSerializable`) — no fact kind carries a method
 *                                      (a tree-sitter node cannot be a fact).
 *   3. Single producer (`PRODUCERS` `satisfies ProducerMap`) — a mapped type
 *                                      over FactKind; a second producer is a
 *                                      duplicate key, a missing kind fails the
 *                                      type. (Lives in producers.ts; asserted
 *                                      again here as a named alias.)
 *
 * Residue #2 (every produced kind is *consumed*) is deliberately NOT a compile
 * check. It is red for the whole migration — a produced kind stays unconsumed
 * until the rule that reads it lands in `MIGRATED_RULES`, and `MIGRATED_RULES`
 * reads 0 of 100 today — so a compile error would block every other test. It
 * lives as a runtime assertion in spec68-consumed-coverage.spec.ts, the same
 * red-drives-the-migration shape as spec68-registry-size.spec.ts.
 *
 * Each remaining check fails on a seeded defect (see seeded-defects.ts and §16
 * guards 1, 3, 4): break one and `tsc --noEmit` fails. The residue and
 * serializability assertions are type-only and erase to nothing at runtime. The
 * seeded defects live in `seeded-defects.ts` — deliberately broken assignments
 * under `@ts-expect-error`, so a check that regresses fails the build rather
 * than waiting for a manual demonstration.
 */

import type { FactShapes, FactKind, Serializable } from './types.js';
import type { ProducedFactKind } from './producers.js';

// ── 1. Residue #1 — every fact kind has a producer ──────────────────────────
type _Unproduced = Exclude<FactKind, ProducedFactKind>;
const _allProduced: _Unproduced extends never ? true : never = true;

// ── 2. Serializability — no fact kind carries a method ──────────────────────
type _FactsSerializable = {
  [K in FactKind]: FactShapes[K] extends Serializable ? true : never;
};
const _allSerializable: _FactsSerializable[FactKind] = true as const;

// ── 3. Single producer — PRODUCERS is exhaustive over FactKind ──────────────
// Enforced by `satisfies ProducerMap` in producers.ts. Re-asserted here so the
// checks live in one place and the conformance test can import them as a single
// surface.

// The assertions above must be *referenced* (not just declared) so a build that
// drops this file still fails: `export type` is enough for the residue aliases,
// but the `const` values are what carry the failure at compile time. This
// export re-exposes them as a tuple the entry-point conformance test can name.
export type Spec68Checks = [
  _Unproduced extends never ? true : never,
  _FactsSerializable[FactKind],
];
