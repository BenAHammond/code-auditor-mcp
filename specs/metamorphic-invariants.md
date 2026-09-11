# Metamorphic Invariants — Spec 53 R2

What this is: for each analyzer rule we care about, we declare **which
semantics-preserving source transformations MUST NOT change its findings**, then
transform real corpus files and verify the declaration holds. A delta is either
a real invariance violation (fix the analyzer) or an artifact of a broken
transform (fix the harness). The deliverable is the *delta list in full*, plus
the per-rule invariance declaration — a summary is not the finding.

Harness: `scripts/metamorphic/run.mjs` + `scripts/metamorphic/transforms.mjs`
(against `dist/`, never `src/`). Corpus: 7 real files from `recall-protocol`.
Full report artifact: `specs/evidence/r2-metamorphic-report.json`.

---

## 1. The transformations

Nine semantics-preserving transforms, each `apply(src) -> { source, detail } | null`:

| # | transform | shape |
| --- | --- | --- |
| 1 | `rename-local-identifier` | rename a non-exported local binding + all refs |
| 2 | `reorder-statements` | swap two adjacent *independent* statements |
| 3 | `add-comment` | prepend a line comment |
| 4 | `remove-comments` | strip all comments |
| 5 | `reformat` | re-indent to 4-space |
| 6 | `wrap-iife` | wrap an expression statement in `(() => { … })()` |
| 7 | `wrap-promise-all` | wrap a statement in `await Promise.all([…])` |
| 8 | `function-to-arrow` | `function f() {}` → `const f = () => {}` |
| 9 | `add-optional-chaining` | `a.b` → `a?.b` |

---

## 2. Per-rule invariance declaration

"Invariant" means: the rule's finding set (rule × line × message) must be
byte-for-byte identical before and after the transform. For transforms that
*do* change structure in a way a rule is legitimately sensitive to (e.g.
`wrap-iife` adds a function), the table marks them **not required** — those
transforms are not part of that rule's invariance contract.

| rule family (example rule IDs) | invariant under | not required |
| --- | --- | --- |
| dependency-graph (`hub-nodes`, `orphaned-nodes`, `tight-coupling`, `unreferenced-module`, `circular-dependency`) | 1–5, **8**, 9 | 6, 7 (adds anonymous call sites) |
| schema/cross-domain (`cross-domain/read-never-written`, `written-never-read`, `multi-table-write`, `unknown-table`) | 1–5, 8, 9 | 6, 7 |
| data-access (`loop-query`, `too-many-queries`, `unfiltered-query`, `sql-injection-risk`) | 1, 3, 4, 5, 8, 9 | 2 (guarded), 6, 7 |
| documentation (`*-documentation`) | 1, 2, 5, 6, 7, 8, 9 | 3, 4 (comment presence is the *input*) |
| structure/complexity (`function-length`, `parameter-count`, `solid/method-complexity`, `class-size`) | 1, 3, 4, 5, 8, 9 | 6, 7 (nesting) |
| styles (`value-drift`, `undefined-class`, `off-scale`, …) | 1, 2, 3, 4, 5, 8, 9 | 6, 7 |

The one transform every rule family MUST be invariant under is
**`rename-local-identifier`** (name-agnosticism), **`reformat`** and
**`add-comment`/`remove-comments`** (whitespace/comment-insensitivity), and
**`function-to-arrow`** (the `function f(){}` ↔ `const f = () => {}` equivalence
is a direct test of the extractor's declaration-vs-expression symmetry — the
weak spot Spec 53 R1/R2 is hunting for).

---

## 3. The delta list — in full

**Result after harness fix: 0 deltas across 7 files × 9 transforms.**

Three deltas were found on the first run, all on `function-to-arrow`, all on
dependency-graph rules:

| file | rule | before → after |
| --- | --- | --- |
| `src/lib/stage0/ingest-foundational-kit.ts` | `hub-nodes` | 1 → 0 |
| `src/lib/admin-asset-rehost-map.ts` | `orphaned-nodes` | 1 → 0 |
| `scripts/run-knowledge-downstream.ts` | `orphaned-nodes` | 0 → 1 |

Every other transform on every other file was already invariant (deltas: none).

### Root cause — a harness bug, not an analyzer bug

The `function-to-arrow` transform emitted a declaration with the **`const`
keyword dropped**:

```js
// was (buggy):
const arrow = `${name} = ${params.text} => ${body.text}`;   // "nowIso = () => {}"
// now (fixed):
const arrow = `const ${name} = ${asyncPrefix}${params.text}${ret} => ${body.text}`;
```

`nowIso = () => {}` parses as an `assignment_expression` (an assignment to an
undeclared identifier), **not** a `lexical_declaration → variable_declarator →
arrow_function`. `clExtractTSEntities` (`src/pipelineAdapters.ts`) has no
`assignment_expression` branch — and correctly so, an assignment to a
free-standing identifier is not a function declaration. So the "converted"
function dropped out of the dependency-graph entity set, which:

1. removed its incoming call edges from its callers (`ingestFoundationalKit`
   lost its 4 `nowIso` edges, out-degree 11 → 7, under the hub threshold) → `hub-nodes` 1→0;
2. removed `remoteColCondition` as a (false-positive) orphan → `orphaned-nodes` 1→0;
3. removed `parseArgs` while leaving its nested arrow `flag`, which became a
   newly-unreachable orphan → `orphaned-nodes` 0→1.

The transform also dropped the return type (`function f(): string {}` →
`() => {}`), fixed at the same time.

The fix restores the declaration shape (`const f = (): string => {}`), which
`clExtractTSEntities`'s `variable_declarator` branch already handles. Re-run:
**0 deltas** — confirming the dependency-graph rules are invariant under the
correct function→arrow transform, and that the extractor's two branches
(`function_declaration` vs `variable_declarator`+`arrow_function`) are
equivalent for the purposes of the graph.

### What was *not* changed

No analyzer or extractor source changed for R2. The only edit is to the R2
harness transform. Baselines (`specs/corpus-baselines.md`) are unchanged.

---

## 4. Non-invariance that would be a *real* finding

The harness has, so far, produced no genuine invariance violation. The shapes
that would count as real (and where to look next) are:

- a `rename-local-identifier` delta → a rule keyed on a raw name string instead
  of the AST symbol (name-agnosticism broken);
- a `function-to-arrow` delta on `parameter-count` → would mean the SOLID
  size check treats `function f(a, b)` and `const f = (a, b) => {}` differently.
  It does not: `parameter-count` reads `adapter.extractFunctions()`
  (`TreeSitterTypeScriptAdapter.buildFunctionInfo`), which calls
  `extractParameters` for `arrow_function` nodes exactly as it does for
  `function_declaration`. (Note this is a *different* extraction path from
  `clExtractTSEntities`, the cross-language entity visitor, whose
  `variable_declarator`+`arrow_function` branch passes `[]` for `parameters` —
  an inert metadata gap, since no cross-language reducer reads entity
  `parameters`; see the extractor map §"cross-language entity extraction".)
- a `remove-comments` delta on a documentation rule → the rule is reading
  comments it shouldn't.

---

## 5. Re-run the harness

```bash
cd app && node scripts/metamorphic/run.mjs > /tmp/r2-report.json 2>/tmp/r2-run.log
# then, to list any delta:
python3 -c "import json;[print(f['file'],t,json.dumps(v['deltas'])) for f in json.load(open('/tmp/r2-report.json')) for t,v in f['transforms'].items() if v.get('deltas')]"
```

Run only after `npm run build` (it imports `dist/`).
