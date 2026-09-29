# Spec 69 R2 — query sites as located facts

R2's defect is structural, not a tuning matter. `checkQueryPatterns` called
`countQueries(funcText)` for every function `extractFunctions` returns, and that
set includes nested arrow functions. Because a closure's text is *inside* its
parent's text, every site the closure issues was counted once in the closure and
again in each enclosing function. No refinement of the text scan fixes it — the
double count is a property of counting over nested text regions.

The fix is to stop counting over text and start counting over *located facts*: a
query site is extracted once from the raw source and attributed to its innermost
enclosing function, so a function's query count is the number of sites whose
enclosing function is that function — a relation, which cannot double-count by
construction.

---

## Part A — the conversion

The `function-bodies` fact (raw per-function source text, which forced the rule
to re-run `countQueries` over text) is replaced by `query-sites`:

| piece | before | after |
|---|---|---|
| fact shape | `FunctionBodyFact` (file + body text) | `QuerySiteFact` (file, 1-based line, column, mechanism label, enclosing-function line/column/name) |
| producer | `functionBodies.ts` — one body per function in a DB-context file | `querySites.ts` — one site per located query, each attributed to its innermost enclosing function |
| attribution | none (the rule re-scanned the whole body) | span containment: among the functions whose `[start,end]` contains the site, the one with the latest start is the innermost |
| rule | `functionBodyRules` — `countQueries(bodyText)` per function | `querySiteRules` — group sites by enclosing-function coordinate, count, apply the ceiling |
| oracle | `countFunctionBodies` (function node types) | `countQuerySites` (member calls + SQL keywords) |

The three-component site scan (`extractQuerySiteOffsets`) is `countQueries`'s own
scan refactored to return locations, and `countQueries` is now literally
`extractQuerySiteOffsets(...).length` — the two cannot drift. The legacy
`checkQueryPatterns` and the spec-52 test suite that pins it are unchanged in
behaviour; only the phase rule's *input* moved from text to located facts.

The site set carries enclosing-function identity as a coordinate (line, column)
plus a resolved name, so a nested closure's sites land on the closure, not on the
parent — the parent keeps only its own sites.

### The fixture

```ts
function outer() {
  db.query("SELECT 1");
  db.query("SELECT 2");
  const inner = () => {
    db.query("SELECT a");  // ×6 — all attributed to `inner`, none to `outer`
    …
  };
}
```

- `buildQuerySites` yields `outer` = 2 sites, `inner` = 6 sites.
- `runQuerySitesSlice` yields one finding, symbol `inner` (6 > 5); `outer` (2 ≤ 5)
  no longer inherits the closure's six.
- The legacy walk double-counts the same fixture — `['inner', 'outer']` — which
  the located-fact rule removes.

Pinned in `src/__tests__/spec68-too-many-queries-parity.spec.ts` (the
"nested-closure double-count is gone" block) alongside the eight non-nested
parity tests that keep `nu === old` on every flat fixture.

---

## Part B — the enumeration: every rule that counts occurrences within a source region

R2 requires the same treatment for *every* rule that counts occurrences within a
source region, and the enumeration is the point. The enumeration below is the
result of a repo-wide sweep for the structural signature — a rule that walks a
nestable region (a function, whose `extractFunctions` set includes nested
closures) and counts pattern occurrences within that region's text.

### The list

| rule | counts | within | verdict |
|---|---|---|---|
| `too-many-queries` | DB-query call sites (`countQueries`) | each function's full text | **converted** — now reads `query-sites` |

**Exactly one rule matches.** `too-many-queries` is the known instance, and the
enumeration confirms it is the *only* one.

### Rules examined and excluded

The sweep checked every rule that either calls `adapter.extractFunctions` or
scans a source slice, and excluded each on a structural ground — it does not
count occurrences within a nestable text region:

| rule / mechanism | why it is out of scope |
|---|---|
| `solid/single-responsibility` (`functionConcerns.ts`) | classifies call *categories* over an AST walk and **already skips nested function bodies** (`NESTED_FUNCTION_TYPES`), so it never double-counts a closure — it is located by construction, just AST-located rather than fact-located |
| `solid/method-complexity`, `solid/class-size` aggregate, react `complexity` | compute cyclomatic complexity by `calculateComplexity` — a node-type walk, not a text scan. Its placement is R4's concern (`method-complexity`'s node-type walk), not R2's |
| `parameter-count` / `function-length` | count `parameters.length` and `end.line − start.line` — structural fields, not occurrences within text |
| `dry/duplicate`, `dry/structural-similarity` | *hash* code blocks (R4's placement list), do not count occurrences within a region |
| `complex-query` | reads the `data-access-calls` fact — a resolved call's table count, already located |
| `unfiltered-query`, `unknown-table`, `missing-org-filter`, `sql-injection-risk` | presence/provenance checks over a located `data-access-calls` fact, not text-region counting |
| `checkUnescapedHtml` (security) | balances `<script>`/`<style>` tags within one template literal's string fragments — a per-node scan, not a per-function region count |
| documentation rules | JSDoc presence/content, not occurrence counts |

The common shape of the exclusions: a rule either (a) reads a *located fact*
already, (b) walks an AST subtree and skips nested functions, or (c) counts a
structural field (`parameters.length`, line span) rather than pattern occurrences
within text. Only `too-many-queries` took the full function text and counted
matches inside it.

---

## Part C — acceptance mapping

- **Criterion 5** — query sites are located facts carrying enclosing-function
  identity; the nested-closure fixture demonstrates the double count is gone.
- **Criterion 6** — the enumeration is the list in Part B: one rule, converted,
  with the excluded rules and their grounds on record.

The R2 change is self-contained: the `function-bodies` fact kind, its producer,
its oracle, and its rule are replaced by `query-sites`; the oracle-shortfall
baseline is re-recorded with the renamed kind (`function-bodies` → `query-sites`,
its composition note updated to the new member-call + SQL-keyword oracle).
