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

Five of the method lists derive from a vendor declaration — `EAGER_DB_METHODS`,
`ORM_TABLE_VERBS`, `ORM_JOIN_VERBS` (the three baseline + probe sets),
`PRISMA_VERBS`, and `D1_CONVENIENCE` (renamed `eagerExecutionMethods`) — and a
sixth (`COLLECTION_TRANSFORM_METHODS`) is a runtime probe over `Array.prototype`
with no vendor declaration. Three of the five vendor-derived sets are the union
of the analyzer's **irreducible cross-vendor baseline** (present regardless of
what resolves) and the per-run **probe** — the methods only a specific vendor
publishes; the two newly-derived sets (`prismaVerbs`, `eagerExecutionMethods`)
are resolved **entirely** from the tree, with no baseline — no generated client /
no driver means the set is `null` and the site is `unproven`, never a fallback.
When a declaration cannot be resolved in the tree, the site is **`unproven`**
with a reason naming what could not be resolved — not a fallback list, not a
stale snapshot, not silence.

## Classification

| # | List | Source of truth | Disposition |
|---|------|-----------------|-------------|
| 1 | `SQL_KEYWORDS` | (none) — security subset | **Kept** (irreducible) |
| 2 | `QUERY_BUILDER_COMPANIONS` | (none) — chain grammar | **Kept** (irreducible) |
| 3 | `PRISMA_VERBS` | generated `.prisma/client` `*Delegate` union | **Resolved** (probe) |
| 4 | `EAGER_DB_METHODS` | better-sqlite3 / node:sqlite / D1 `.d.ts` | **Resolved** (baseline + probe) |
| 5 | `eagerExecutionMethods` (was `D1_CONVENIENCE`) | cross-driver union (D1 / better-sqlite3 / node:sqlite / pg / mysql2) | **Resolved** (probe) |
| 6 | `ORM_TABLE_VERBS` | Kysely `QueryCreator` | **Resolved** (baseline + probe) |
| 7 | `ORM_JOIN_VERBS` | Kysely `SelectQueryBuilder` | **Resolved** (baseline + probe) |
| 8 | `LLM_PROVIDER_RE` | (none) — judgment regex | **Kept** (irreducible) |
| 9 | `LLM_ACTION_RE` | (none) — judgment regex | **Kept** (irreducible) |
| 10 | `LLM_CLIENT_ARG_NAMES` | (none) — judgment set | **Kept** (irreducible) |
| 11 | `MESSAGE_LIFECYCLE_METHODS` | (none) — queue contract | **Kept** (irreducible) |
| 12 | `COLLECTION_TRANSFORM_METHODS` | ECMAScript `Array.prototype` | **Resolved** (runtime probe) |
| 13 | `CHUNK_HELPER_RE` | (none) — name pattern | **Kept** (irreducible) |

**6 resolved, 7 kept-and-documented.** The six resolved lists are exactly the
ones whose members a vendor (or the runtime) publishes; the seven kept lists each
encode a *selection* or a *shape* no vendor declares.

---

## Resolved (read from the tree under analysis, per run)

### The per-run resolution (`src/analyzers/vendorSurfaces.ts`)

`resolveVendorSurfaces(projectRoot)` walks up from the project root looking for
each vendor package's `node_modules` directory, reads the shipped `.d.ts` for
the named declaration types, and returns eleven member-name sets plus a
`resolutions` record per (package, type) attempt. The seven packages and their
declaration types:

| Package | Types | Entry |
|---------|-------|-------|
| `@types/better-sqlite3` | `Database`, `Statement` | `index.d.ts` |
| `@types/node` | `DatabaseSync`, `StatementSync` | `sqlite.d.ts` |
| `@cloudflare/workers-types` | `D1Database`, `D1PreparedStatement` | `index.d.ts` |
| `kysely` | `QueryCreator`, `SelectQueryBuilder` | walked (split across subpath `.d.ts`) |
| `@types/pg` | `Pool` | walked (`query` is its eager-execution member) |
| `mysql2` | `Connection` | walked (`execute` is its eager-execution member) |
| `.prisma/client` | `*Delegate` (union of every generated model delegate) | `index.d.ts` (generated, not shipped) |

`@types/pg` and `mysql2` contribute only their single eager-execution member
(`query` / `execute`): a Pool/Connection surface is a *client* surface
(`connect`/`end`/`on`), not an eager-execution surface, so the whole declaration
is not unioned the way the statement/database surfaces are. `.prisma/client` is
resolved separately — it is not a single named declaration type but the union of
every generated `*Delegate` declaration (see below).

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
same criterion that keeps the seven irreducible lists. The probe supplies exactly
what that grammar misses and only a vendor publishes.

### `PRISMA_VERBS` — the generated `.prisma/client` `*Delegate` union

- **Old:** a hand-kept 15-verb list (`aggregate count create createMany delete
  deleteMany findFirst findFirstOrThrow findMany findUnique findUniqueOrThrow
  groupBy update updateMany upsert`). It had already drifted: `findRaw` was stale
  (not a Prisma verb — the raw entry point is `$queryRaw`), and it was missing the
  two `…AndReturn` verbs Prisma 5.4+ generates (`createManyAndReturn`,
  `updateManyAndReturn`).
- **Source of truth:** the generated client in the analyzed tree. Prisma emits its
  client into a dot-prefixed virtual package — `node_modules/.prisma/client/index.d.ts`,
  re-exported by the `@prisma/client` shim — where the model verbs live on one
  `export interface <Model>Delegate<…>` per model. The delegate members are
  identical across models by construction, so the union of the generated
  `*Delegate` member names is exactly the verb set the repo's *own* schema
  generated.
- **Resolution — what changed to make it derivable.** The resolver could not read
  this before B2a: it read only `interface_declaration` / `class_declaration` /
  `abstract_class_declaration` bodies, while Prisma's delegates are `type … = …
  & { … }` aliases; and the delegate name is per-schema (`<Model>Delegate`), so
  there was no fixed type name to resolve. `readTypeMemberSurface` now also reads
  `type_alias_declaration`s whose body is an `object_type` or an `intersection_type`
  of `object_type`s, and a separate `readDelegateUnion` enumerates every
  `*Delegate` declaration and unions their members. The derived set is the union of
  all 18 generated member names (17 verbs + the `fields` property), including the
  two `…AndReturn` verbs the old list lacked.
- **No baseline.** Unlike the three baseline + probe sets, `prismaVerbs` is resolved
  *entirely* from the tree. Where `.prisma/client` is not generated (no
  `node_modules/.prisma/client`), the set is `null` and the resolution record names
  that reason — the Prisma object-form site is `unproven`, never a fallback list and
  never a stale snapshot.

### `D1_CONVENIENCE` → `eagerExecutionMethods` — the cross-driver union

- **Old:** `['all', 'first', 'run', 'query', 'execute']` — an *unconditional*
  hand-kept union applied to every tree regardless of what drivers that tree used.
- **The naming defect.** The list was misnamed: it is a **cross-driver** eager-execution
  surface, not D1's. `@cloudflare/workers-types` publishes only the D1 third
  (`all`/`first`/`run` on `D1PreparedStatement`); `query` is node-postgres, `execute`
  is mysql2, and `all`/`run` are also better-sqlite3 / node:sqlite. Deriving only the
  D1 third would *regress* a better-sqlite3 tree (which has no workers-types
  installed and would lose `all`/`run`, stopping its own parameterized shorthand from
  being recognized) — so the whole set is derived **per driver**, not hand-kept.
- **Derivation.** `eagerExecutionMethods` is the union of whichever driver surfaces
  resolve in the analyzed tree: `D1PreparedStatement` (D1), the statement *and*
  database surfaces of `better-sqlite3` and `node:sqlite`, plus `query` from
  `@types/pg` `Pool` and `execute` from `mysql2` `Connection`. A tree with only
  better-sqlite3 gets better-sqlite3's methods and nothing else — no D1 `.first()`,
  no generic `.query()`. It is the discriminator vocabulary for the
  parameterized single-arg-vs-two-arg check: an eager-execution method taking a
  bind-params second argument (`db.run(query, params)`) is fully parameterized and
  safe.
- **No baseline.** Like `prismaVerbs`, `eagerExecutionMethods` is resolved entirely
  from the tree: no driver resolves → the set is `null` and the site is `unproven`,
  never a fallback list. (This is the one deliberate behaviour change: the old
  unconditional list suppressed two-arg `.all/.first/.run/.query/.execute` calls
  everywhere; the derived set suppresses only where a driver actually resolves.)

### `COLLECTION_TRANSFORM_METHODS` — ECMAScript `Array.prototype`

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
- **Judgment:** whether a *dynamically-constructed* string — a fragment carrying
  `${}` interpolations or a partial clause — contains SQL structure at all. It is
  the admission signal for `checkQuerySecurity`'s injection finding, and it is
  deliberately **not** the SQL-ness admission gate (that is provenance/shape/tag
  based, and the *static* path routes through `parseSql`).
- **What the parser cannot decide — the specific answer.** This repo owns
  `parseSql` (`src/languages/sql/sqlAst.ts`), and the *static* SQL path already
  routes through it (`buildDatabaseCall`, line 915). `checkQuerySecurity` is the
  *dynamic* path, and `parseSql` **cannot** decide its admission: the parser
  requires a complete, syntactically-valid SQL statement, and a dynamic fragment
  is exactly the input it cannot parse — `${id}` makes the text invalid SQL, and
  a partial clause (`WHERE x = ${id}`) is not a statement. Routing the decision
  through `parseSql` would drop every fragment-level injection surface
  (keyword-less fragments, partial clauses) — the same regression R2 already
  rejected when it deleted the keyword gate from the *admission* decision.
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
- **Builder attribution — the specific answer.** The verb spellings are the
  **Drizzle and knex** spellings, not Kysely's (which are `selectFrom` /
  `insertInto` / `updateTable` / `deleteFrom`, already carried by the
  `ORM_TABLE_VERBS` baseline):

  | Pair | Builder | That builder's types declare the verbs? |
  |------|---------|------------------------------------------|
  | `.select` / `.selectDistinct` / `.selectDistinctOn` ⇒ `.from` | Drizzle (`db.select().from()`), knex (`db('t').select().from()`) | Yes — `select`/`from` are real methods (Drizzle and knex both declare them) |
  | `.insert` ⇒ `.values` | Drizzle (`db.insert(t).values()`), knex (`db('t').insert().values()`) | Yes — `insert`/`values` declared |
  | `.update` ⇒ `.set`/`.where` | Drizzle (`db.update(t).set().where()`), knex | Yes — `update`/`set`/`where` declared |
  | `.delete` ⇒ `.where` | Drizzle (`db.delete(t).where()`), knex | Yes — `delete`/`where` declared |

  Each builder's own types declare the individual verbs *and* the companion
  methods. What no declaration publishes is the **pairing** — "`.select` must be
  followed by `.from` to count as a table query." A `.d.ts` declares methods, not
  the grammar constraining their admissible ordering; the verb→companion relation
  is the analyzer's chain-shape judgment over callee text. It is irreducible
  regardless of whether Drizzle or knex is resolved (and neither is currently in
  `VENDOR_TYPE_SPECS`), because the grammar is a cross-builder union of spellings
  no one vendor is the authority for.

### 3. `LLM_PROVIDER_RE`

- **List:** `/(?:anthropic|openai|deepseek|claude|gpt|gemini|cohere|mistral|bedrock|vertex|ollama|llm|gateway)/i`
- **Judgment:** an LLM/agent-adjacency signal — which *identifier prefixes*
  denote a provider namespace.
- **Unobtainable:** a judgment about what a **name** means, not a method
  surface. No vendor declares "which identifier prefixes denote an LLM
  provider"; the list is a cross-vendor naming convention.

### 4. `LLM_ACTION_RE`

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

### 5. `LLM_CLIENT_ARG_NAMES`

- **List:** `model llm embedder gateway anthropic openai deepseek claude gpt
  gemini cohere mistral bedrock`
- **Judgment:** identifier names that denote an LLM/model client when they
  appear as a call argument (`extractBuildsFromCorpus(db, model, …)`) or as the
  object of a member callee (`model.chat(…)`). Deliberately excludes
  `client`/`ai` (ambiguous — a DB client is also a `client`).
- **Unobtainable:** a naming-convention judgment. No vendor declares "which
  variable names denote an LLM client"; the exclusion of `client`/`ai` is a
  correctness judgment about ambiguity no declaration captures.

### 6. `MESSAGE_LIFECYCLE_METHODS`

- **List:** `ack nack acknowledge deleteMessage retry`
- **Judgment:** the queue-consumer per-message verbs — a loop whose body
  acknowledges/retries the item it iterates over is a queue-consumer message
  loop, so a per-iteration query is the contract, not a batchable N+1.
- **Unobtainable:** a queue **contract**, not a vendor method surface. Different
  brokers publish different spellings (RabbitMQ `ack`/`nack`, SQS
  `deleteMessage`, `acknowledge`), and the set is a cross-broker union plus the
  contextual `retry`. No single vendor's declaration is that union; each broker
  would yield only its own spelling.

### 7. `CHUNK_HELPER_RE`

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
real vendor installed. None of the seven pinned corpora uses any of the six
probe-only methods (grep over all seven is empty), so a fixture is required.

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
data-access findings on all seven pinned corpora, and the six probe-only methods
simply never fire there — the honest "no drift" the reissued directive asked to
*measure* rather than assume. (The liveness fixture proves the probe is not
vacuous; this table proves it does not perturb the pinned corpora.)

## B2d — per-corpus delta for the two newly-derived sets

The same measurement is required for the two sets derived *entirely* from the
tree (`prismaVerbs`, `eagerExecutionMethods`): the old hand-kept behaviour is
simulated (`OLD`), the derived behaviour is the real run (`NEW`), and the finding
multiset is diffed per corpus.

- **`prismaVerbs`.** `OLD` admitted the object form via the hand-kept 15-verb
  `isQueryBuilderShape` set; `NEW` reads the generated client's `*Delegate` union
  (18 members). No pinned corpus has a generated client (they ship no
  `node_modules`, so the resolution is `unproven`), and none uses the two verbs
  the old list lacked (`createManyAndReturn`, `updateManyAndReturn`). Both arms
  admit via the shape — the only difference is that `NEW` degrades unproven-vs-
  confirmed verb recognition rather than emitting a different finding, so no
  finding moves.
- **`eagerExecutionMethods`.** `OLD` applied the unconditional
  `['all','first','run','query','execute']` to every tree; `NEW` derives the union
  per driver. No pinned corpus resolves any driver, so `NEW`'s set is `null` — the
  one place a *behaviour change* is possible: a two-arg `.all/.first/.run/.query/
  .execute` call with a `${}` interpolation that `OLD` suppressed as parameterized
  and `NEW` (null set) does not. Every such candidate site was grep-identified and
  hand-checked: each is a safe constant, a non-`handle` receiver, or non-injection
  transaction-control SQL, so no `sql-injection-risk` finding is added.

| Corpus | OLD total | NEW total | added | removed |
|--------|----------:|----------:|------:|--------:|
| blitz | 0 | 0 | 0 | 0 |
| endless-guessing | 1 | 1 | 0 | 0 |
| hhra-org | 3 | 3 | 0 | 0 |
| knex | 7 | 7 | 0 | 0 |
| openstatus | 1 | 1 | 0 | 0 |
| primer-css | 0 | 0 | 0 | 0 |
| recall-protocol | 13 | 13 | 0 | 0 |

All seven corpora are `added=0 removed=0` (totals are all `sql-injection-risk`).
The two newly-derived sets change the *evidence* a site rests on — resolved
verb/driver surface vs. hand-kept snapshot — without changing any emitted finding
on the pinned corpora. The liveness tests (`vendor-probe-prisma-eager-liveness.spec.ts`)
prove the derivation is not vacuous: a generated client admits
`createManyAndReturn` that the old 15-verb list dropped, and a better-sqlite3 tree
is parameterized *only* with the probe. This table proves the derivation does not
perturb the pinned corpora.
