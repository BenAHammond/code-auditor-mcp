# Spec 70 — TS within-file-provenance split: the expression descriptor

Item 3 of the Spec 70 Item 4 work (collapse the double-parse). This records the
descriptor decision and the extract/classify seam shape, so the choice is not
re-litigated later.

## The decision

`member.receiver` is a **full recursive `TsExpressionDescriptor`** — *not* a
flattened `string | null`. (Option (a) of the two the user offered.)

Why:

1. **Symmetry.** `call.callee` is a full descriptor; a `member.receiver` that is
   a `string | null` breaks the symmetry the rest of the type holds.
2. **Parity with Go.** `GoValueDescriptor.operand` / `.function` / `.typeNode`
   are recursive descriptors, not flattened strings. The TS descriptor should
   project the chain the same way.
3. **The extract arm stays structural.** If `member.receiver` were the resolved
   leftmost root, `describeTsExpression` would have to run `resolveReceiverRoot`
   at extract time — semantic resolution (a `this`/`super` special case, a
   builder-chain descent) leaking into what is supposed to be a pure projection.
   Keeping the chain defers that resolution to the classify arm, where the
   provenance/bindings are known.
4. **`this.env.DB` / `a.b.c.d.query()` are nested receivers.** The user's own
   motivating shapes. A flattened string cannot re-walk them; a recursive
   descriptor can.

The one case that stays a string is `new.ctorName`: `tryPropagateFromExpression`
derives it via `extractIdentifierName`, which is *already* a pure structural
flatten to the leftmost identifier (no `this`/`super` special case, no semantic
lookup), so a string there is faithful, not a loss.

## The descriptor (closed set)

```ts
export type TsExpressionDescriptor =
  | { readonly kind: 'await';     readonly operand: TsExpressionDescriptor | null }
  | { readonly kind: 'new';       readonly ctorName: string | null }
  | { readonly kind: 'call';      readonly callee: TsExpressionDescriptor | null;
                                   readonly args: readonly TsExpressionDescriptor[] }
  | { readonly kind: 'identifier'; readonly name: string }
  | { readonly kind: 'member';    readonly receiver: TsExpressionDescriptor | null;
                                   readonly property: string | null }
  | { readonly kind: 'unproven' }; // residue — literal/object/array/this/super/anything
```

`unproven` is the residue, guarded by the same compile-time `Exclude` idiom as
`handleIdentification.ts` and `phase/seeded-defects.ts`: the classify switch has
no `default` arm, and an unused `@ts-expect-error` seed fails the build if a
discriminant is removed from the type but not the switch.

## The two arms (mirror of the Go split)

Go already has the shape: `buildGoBindingEnv`/`buildGoImportMap` (extract, AST →
serializable `GoBinding`/`GoValueDescriptor`) → `classifyGoBindings` (classify,
no-AST, pure over the maps). The TS arm is the same split, but the TS provenance
is a *fixed point* (propagate → wrappers → returning-functions, ≤10 passes), so
the extract carries more structure than Go's flat bindings.

### Extract (`describeTsExpression` + `extractTsWithinFileProvenance`)

Projects, from a single file's AST, everything `computeTsWithinFileProvenance`
reads — in AST pre-order so the classify arm can reproduce the propagation
fixed point exactly:

- **seeds** — `extractDBProvenancedImports` (DB-package import names → evidence).
- **propagation rules** — ordered lists of `variable_declarator` /
  `assignment_pattern` (default param) / `field_definition` /
  `assignment_expression` (`this.x = …`) entries, each `{ names/name/field, value:
  TsExpressionDescriptor }`.
- **localFunctions** — the `collectLocalFunctionNames` set (S5f refuses to
  forward through these).
- **wrapper functions** — `{ name, ownCalls }` where each own call is a
  descriptor + a pre-computed `isD1Rest` flag (`isD1RestCall` is provenance-free,
  so it is folded at extract time).
- **wrapper classes** — `{ name, classCalls }` (new/call expressions, same flags).
- **returning functions** — `{ name, returnExprs: TsExpressionDescriptor[] }`.

### Classify (`classifyTsExpression` + `classifyTsWithinFileProvenance`)

Re-runs the fixed point over the projection. `classifyTsExpression` reproduces
`tryPropagateFromExpression`; `classifyTsWithinFileProvenance` reproduces the
`computeTsWithinFileProvenance` loop (propagate → wrappers → returning) with no
AST and no live node.

## Parity

`spec70-ts-within-file-parity.spec.ts` pins the split: for each fixture,
`classifyTsWithinFileProvenance(extractTsWithinFileProvenance(ast, …), seeds)`
is asserted byte-identical to `computeTsWithinFileProvenance(ast, …, seeds)`.
That assertion is the guard the whole collapse hangs on — when the second parse
is deleted, it is the only proof the new corpus producer re-derives the old
`resolveReceiverProvenance` output.

## The seam

`ResolutionImplementation` (handleIdentification.ts) gains `extract` + `classify`
for all nine formats; Go registers its existing `buildGoWithinFileProvenance` /
`classifyGoBindings` arms unchanged; the non-code formats return an empty
projection (a CSS/JSON/SQL file has no executable receiver, so its within-file
provenance is the empty map).
