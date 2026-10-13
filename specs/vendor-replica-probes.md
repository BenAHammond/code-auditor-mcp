# Item B — vendor-replica lists → per-run vendor probes

`src/analyzers/universal/UniversalDataAccessAnalyzer.ts` once hand-maintained
13 method-name / keyword lists. A hand-copied vendor list drifts: the vendor
adds, renames, or removes a method and the replica silently goes stale (the
`.get()` gap, the deferred `.iterate()`, the missing lateral joins). Item B's
directive is to name each list's vendor source of truth and **read it** instead
of replicating it; where a list encodes a judgment no vendor publishes, keep it
and say what makes it irreducible.

The reissued directive tightens the mechanism: **nothing about a vendor's API is
committed to this repo, and nothing is fetched from the network at analysis
time.** Each vendor's declaration is resolved **from the tree under analysis,
per run** — the `node_modules` (or workspace) path that tree's *own* imports
resolve to, at the version that tree actually installs. A tree on Kysely 0.29 is
judged by 0.29's declarations.

Three of the four method lists derive from a vendor `.d.ts`; the fourth
(`COLLECTION_TRANSFORM_METHODS`) is a runtime probe over `Array.prototype` and
has no vendor declaration. Each derived set is the union of the analyzer's
**irreducible cross-vendor baseline** (present regardless of what resolves) and
the per-run **probe** — the methods only a specific vendor publishes. When a
declaration cannot be resolved in the tree, the site is **`unproven`** with a
reason naming what could not be resolved — not a fallback list, not a stale
snapshot, not silence.

## Classification

| # | List | Source of truth | Disposition |
|---|------|-----------------|-------------|
| 1 | `SQL_KEYWORDS` | (none) — security subset | **Kept** (irreducible) |
| 2 | `QUERY_BUILDER_COMPANIONS` | (none) — chain grammar | **Kept** (irreducible) |
| 3 | `PRISMA_VERBS` | generated per-schema (`prisma generate`) | **Kept** (irreducible) |
| 4 | `EAGER_DB_METHODS` | better-sqlite3 / node:sqlite / D1 `.d.ts` | **Resolved** (baseline + probe) |
| 5 | `D1_CONVENIENCE` | (none) — discriminator vocabulary | **Kept** (irreducible) |
| 6 | `ORM_TABLE_VERBS` | Kysely `QueryCreator` | **Resolved** (baseline + probe) |
| 7 | `ORM_JOIN_VERBS` | Kysely `SelectQueryBuilder` | **Resolved** (baseline + probe) |
| 8 | `LLM_PROVIDER_RE` | (none) — judgment regex | **Kept** (irreducible) |
| 9 | `LLM_ACTION_RE` | (none) — judgment regex | **Kept** (irreducible) |
| 10 | `LLM_CLIENT_ARG_NAMES` | (none) — judgment set | **Kept** (irreducible) |
| 11 | `MESSAGE_LIFECYCLE_METHODS` | (none) — queue contract | **Kept** (irreducible) |
| 12 | `COLLECTION_TRANSFORM_METHODS` | ECMAScript `Array.prototype` | **Resolved** (runtime probe) |
| 13 | `CHUNK_HELPER_RE` | (none) — name pattern | **Kept** (irreducible) |

**4 resolved, 9 kept-and-documented.** The four resolved lists are exactly the
ones whose members a vendor (or the runtime) publishes; the nine kept lists each
encode a *selection* or a *shape* no vendor declares.

---

## Resolved (read from the tree under analysis, per run)

### The per-run resolution (`src/analyzers/vendorSurfaces.ts`)

`resolveVendorSurfaces(projectRoot)` walks up from the project root looking for
each vendor package's `node_modules` directory, reads the shipped `.d.ts` for
the named declaration types, and returns eight member-name sets plus a
`resolutions` record per (package, type) attempt. The four packages and their
declaration types:

| Package | Types | Entry |
|---------|-------|-------|
| `@types/better-sqlite3` | `Database`, `Statement` | `index.d.ts` |
| `@types/node` | `DatabaseSync`, `StatementSync` | `sqlite.d.ts` |
| `@cloudflare/workers-types` | `D1Database`, `D1PreparedStatement` | `index.d.ts` |
| `kysely` | `QueryCreator`, `SelectQueryBuilder` | walked (split across subpath `.d.ts`) |

Each `VendorResolution` carries the resolved `.d.ts` path, the installed package
version, and — when unresolvable — a reason naming what could not be resolved
(e.g. ``package `kysely` is not installed under …/node_modules``, or ``type
`SelectQueryBuilder` is not declared in the shipped `kysely` declarations
(0.29.6)``). No snapshot is committed, no network fetch occurs, and nothing is
cached across runs.

### `deriveVendorSets` — the baseline + probe union

The analyzer reads three derived sets, each the union of the baseline and the
probe:

| Set | Baseline (irreducible cross-vendor grammar) | Probe addition (vendor-only) |
|-----|---------------------------------------------|------------------------------|
| `eagerMethods` | `query run all get first raw exec batch` | `iterate` (better-sqlite3 `Statement`) |
| `ormTableVerbs` | `selectFrom deleteFrom insertInto updateTable` | `mergeInto` `replaceInto` (Kysely `QueryCreator`) |
| `ormJoinVerbs` | `join leftJoin rightJoin innerJoin` | every Kysely `SelectQueryBuilder` member ending in `Join` / `JoinLateral` |

The six probe-only methods the directive names are exactly `iterate`,
`mergeInto`, `replaceInto`, `fullJoin`, `innerJoinLateral`, `leftJoinLateral`.
When the corresponding vendor does not resolve, its probe additions are absent
and the resolution record carries the reason — the honest `unproven` state, never
a fallback list.

The baseline is **not** a copy of any single vendor's declaration: it is the
analyzer's accumulated judgment of the generic SQL-driver/builder grammar — the
same criterion that keeps the nine irreducible lists. The probe supplies exactly
what that grammar misses and only a vendor publishes.

### 12. `COLLECTION_TRANSFORM_METHODS` — ECMAScript `Array.prototype`

- **Old:** `new Set(['slice','splice','map','filter','concat','flatMap'])`
- **Source of truth:** the ECMAScript runtime — `Array.prototype` (no `.d.ts`
  publishes "which array methods return a collection"; the runtime is the
  authority on existence).
- **Replacement:** a runtime probe:
  ```ts
  export const COLLECTION_TRANSFORM_METHODS = new Set(
    ['slice','splice','map','filter','concat','flatMap']
      .filter((m) => typeof (Array.prototype as unknown as Record<string, unknown>)[m] === 'function'),
  );
  ```
- **Judgment retained:** the *selection* of which array methods return a
  collection (`map`/`filter`/`concat`/`flatMap`/`slice`/`splice`) vs. consume or
  reduce one (`forEach`/`reduce`/`find`/`some`/`every`). The names are the
  runtime's; the batch-vs-reduce classification is ours.
- **Net change:** none.

---

## Kept (irreducible — no vendor publishes this)

Each of these encodes a selection or shape no vendor declares. For each, the
list, the judgment it encodes, and what makes it unobtainable from any vendor
declaration:

### 1. `SQL_KEYWORDS`

- **List:** `SELECT INSERT UPDATE DELETE FROM WHERE JOIN CREATE DROP ALTER
  TRUNCATE`
- **Judgment:** a *security* subset feeding only `checkQuerySecurity` (the
  host-language dataflow gate). It is deliberately **not** the SQL-ness
  admission gate (that is provenance/shape/tag-based).
- **Unobtainable:** no vendor has a notion of "keywords that evidence a
  dynamic-string injection surface." The SQL keyword list itself is a *spec*
  artifact (the SQL standard), not a declaration; and the *selection* — which
  keywords evidence an injection surface, deliberately narrower than "all SQL
  keywords" — is a security judgment, not something any vendor publishes.

### 2. `QUERY_BUILDER_COMPANIONS`

- **List:** a verb→required-companion grammar — `.select(…)`⇒`.from`,
  `.insert`⇒`.values`, `.update`⇒`.set`/`.where`, `.delete`⇒`.where`.
- **Judgment:** the *call shape* that distinguishes a query-builder chain from a
  non-DB method collision (`map.delete(k)`, `createHash().update(b)`,
  `cookies.delete(n)`, `stripe.customers.update(id, data)` all lack the
  companion and fail).
- **Unobtainable:** this is a **cross-builder grammar**, not any one vendor's
  method list. No `.d.ts` declares "`.select` must be followed by `.from` to
  count as a table query." The companion relation is a chain-shape judgment over
  callee text; a vendor publishes *methods*, not the *grammar* that constrains
  their admissible ordering.

### 3. `PRISMA_VERBS`

- **List:** `create createMany update updateMany upsert delete deleteMany
  findUnique findFirst findMany findUniqueOrThrow findFirstOrThrow findRaw count
  groupBy aggregate`
- **Judgment:** the Prisma Client object-form admitter's verb core
  (`<recv>.<Model>.<verb>({ … })` with a `where`/`data` key).
- **Unobtainable:** Prisma Client verbs are **generated per-schema** from the
  user's `schema.prisma` by `prisma generate`; model verbs like `findUnique`,
  `upsert`, and `groupBy` exist only *after* generation, emitted into the
  project's `node_modules/.prisma/client` at install time. There is no fixed
  shipped list to read from a pinned package. (Known drift: `findRaw` is not a
  real Prisma verb — the raw entry point is `$queryRaw` — so this list is
  *already* a judgment and stays hand-written until a schema-generation probe is
  warranted.)

### 4. `D1_CONVENIENCE`

- **List:** `all first run query execute`
- **Judgment:** a *discriminator vocabulary* for the parameterized
  single-arg-vs-two-arg check — D1's statement convenience methods (`all`,
  `first`, `run`) plus the generic `query`/`execute`.
- **Unobtainable:** the set is **intentionally broader than any one vendor
  surface.** `execute` is not even a D1 method (D1 uses `exec` on the database,
  `run` on the statement); `query` is a generic abstraction. No single vendor
  declares this union — it is the analyzer's own admission predicate, not a
  replica of one vendor's API.

### 5. `LLM_PROVIDER_RE`

- **List:** `/(?:anthropic|openai|deepseek|claude|gpt|gemini|cohere|mistral|bedrock|vertex|ollama|llm|gateway)/i`
- **Judgment:** an LLM/agent-adjacency signal — which *identifier prefixes*
  denote a provider namespace.
- **Unobtainable:** a judgment about what a **name** means, not a method
  surface. No vendor declares "which identifier prefixes denote an LLM
  provider"; the list is a cross-vendor naming convention.

### 6. `LLM_ACTION_RE`

- **List:** `/(?:embed|reembed|completion|chat|prompt|synthesize|thesis|agent|classify|summarize|translate)/i`
- **Judgment:** LLM action verbs — AI SDK methods and the wrapper names that
  survive the provider-token check (`aiEmbed`, `chatCompletion`,
  `thesisEngine`). Deliberately narrower than `generate`/`extract`, which
  collide with ordinary helpers (`insertSingleGeneratedBuild`).
- **Unobtainable:** the *narrowing* is the judgment. A vendor SDK *does*
  publish method names (e.g. `openai.chat.completions`), but this regex is a
  cross-vendor union of call-name signals filtered to avoid collisions with
  generic code. No single vendor declares "which of these names are ambiguous in
  ordinary code"; the exclusion is the analyzer's call.

### 7. `LLM_CLIENT_ARG_NAMES`

- **List:** `model llm embedder gateway anthropic openai deepseek claude gpt
  gemini cohere mistral bedrock`
- **Judgment:** identifier names that denote an LLM/model client when they
  appear as a call argument (`extractBuildsFromCorpus(db, model, …)`) or as the
  object of a member callee (`model.chat(…)`). Deliberately excludes
  `client`/`ai` (ambiguous — a DB client is also a `client`).
- **Unobtainable:** a naming-convention judgment. No vendor declares "which
  variable names denote an LLM client"; the exclusion of `client`/`ai` is a
  correctness judgment about ambiguity no declaration captures.

### 8. `MESSAGE_LIFECYCLE_METHODS`

- **List:** `ack nack acknowledge deleteMessage retry`
- **Judgment:** the queue-consumer per-message verbs — a loop whose body
  acknowledges/retries the item it iterates over is a queue-consumer message
  loop, so a per-iteration query is the contract, not a batchable N+1.
- **Unobtainable:** a queue **contract**, not a vendor method surface. Different
  brokers publish different spellings (RabbitMQ `ack`/`nack`, SQS
  `deleteMessage`, `acknowledge`), and the set is a cross-broker union plus the
  contextual `retry`. No single vendor's declaration is that union; each broker
  would yield only its own spelling.

### 9. `CHUNK_HELPER_RE`

- **List:** `/^(chunk|chunks|chunkArray|chunkBy|partition|paginate|paged)$/i`
- **Judgment:** a **name pattern** recognizing *user-written* chunking helper
  functions by convention, because a chunking helper's internal shape is
  invisible to the analyzer.
- **Unobtainable:** there is **no vendor** — the helper is user code. The name
  is the only stable signal for a function whose internals the analyzer cannot
  see; no declaration anywhere publishes the naming convention.

---

## The probe machinery

- **Resolver** — `src/analyzers/vendorSurfaces.ts`: `resolveVendorSurfaces`
  (reads the tree's own `node_modules`), `deriveVendorSets` (baseline + probe),
  `VendorSurfaces`/`VendorResolution`/`DerivedVendorSets`/`EMPTY_VENDOR_SURFACES`.
  One pass per run; nothing committed, nothing fetched, nothing cached across
  runs.
- **Threading** — the resolved `VendorSurfaces` is threaded from `auditRunner.ts`
  (`resolveVendorSurfaces(root)`) through the phase model (`PhaseInfra`) into
  every parsed file's `vendorSurfaces`, so the data-access and loop-query
  discriminators read the derived sets instead of module-level constants.
- **Guard/derivation test** — `src/__tests__/vendor-probe-dataaccess.spec.ts`
  pins: (a) the baseline survives an empty surface (no collapse); (b) the probe
  adds exactly the vendor-only methods and only when that vendor resolves; (c)
  `resolveVendorSurfaces` reads a real `.d.ts` with path + version, and is
  `unproven` (`path: null`, a reason naming the miss) on a bare tree; (d)
  `COLLECTION_TRANSFORM_METHODS` are real `Array.prototype` functions.

## Liveness — a finding that only the probe produces

The directive requires a finding that appears **only** because the probe supplied
a method the old hand-kept list lacked, demonstrated on a pinned corpus with the
real vendor installed. None of the six pinned corpora uses any of the six
probe-only methods (grep over all six is empty), so a fixture is required.

`bench/corpus/vendor-probe/` pins `kysely@0.29.6` (`package.json` +
`package-lock.json` committed; `node_modules` gitignored). Its
`src/kysely-full-join.ts` reaches five tables — four through the baseline
grammar (`selectFrom`, `innerJoin`, `leftJoin`), the fifth (`vet`) only through
`fullJoin`:

```ts
return db
  .selectFrom('person')
  .innerJoin('pet', 'pet.person_id', 'person.id')
  .leftJoin('toy', 'toy.pet_id', 'pet.id')
  .innerJoin('owner', 'owner.person_id', 'person.id')
  .fullJoin('vet', 'vet.pet_id', 'pet.id')   // probe-only: fullJoin
  .selectAll();
```

`src/__tests__/vendor-probe-liveness.spec.ts` runs this file through
`runDataAccessSlice` twice — once with the fixture's resolved surfaces (the
probe), once with `EMPTY_VENDOR_SURFACES` (no probe):

- **with the probe:** `complex-query` fires — `Query references 5 tables` (5 >
  `joinedTableCount` = 4).
- **without the probe:** the chain resolves to four tables — exactly the
  threshold — and nothing fires (`[]`).

The same test asserts the probe resolved a *real* declaration from the
fixture's own `node_modules` (path contains `select-query-builder.d.ts`, version
`0.29.6`, `fullJoin` present, bare `join` absent), and that a tree where Kysely
is not installed yields an **`unproven`** resolution (`path: null`,
`version: null`, reason containing `not installed`) with `kyselySelectQueryBuilder
=== null`.

## Per-corpus finding delta — zero drift

The probe can only move a finding when the analyzed tree *uses* one of the six
probe-only methods. `scripts/measure-vendor-probe-delta.ts` runs the data-access
slice (the four rules the probe affects: `sql-injection-risk`,
`unfiltered-query`, `complex-query`, `missing-org-filter`) twice per corpus —
with the tree's resolved surfaces vs. the empty surface — and diffs the finding
multiset (`ruleId\tfile\tline\tmessage`), listing every added and removed
finding:

| Corpus | with-probe | without-probe | added | removed |
|--------|-----------:|--------------:|------:|--------:|
| blitz | 0 | 0 | 0 | 0 |
| endless-guessing | 1 | 1 | 0 | 0 |
| hhra-org | 3 | 3 | 0 | 0 |
| knex | 7 | 7 | 0 | 0 |
| openstatus | 1 | 1 | 0 | 0 |
| primer-css | 0 | 0 | 0 | 0 |
| recall-protocol | 13 | 13 | 0 | 0 |

Every corpus is `added=0 removed=0`: the probe-derived sets produce byte-identical
data-access findings on all six pinned corpora, and the six probe-only methods
simply never fire there — the honest "no drift" the reissued directive asked to
*measure* rather than assume. (The liveness fixture proves the probe is not
vacuous; this table proves it does not perturb the pinned corpora.)
