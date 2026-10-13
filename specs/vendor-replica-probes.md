# Item B — vendor-replica lists → vendor probes

`src/analyzers/universal/UniversalDataAccessAnalyzer.ts` hand-maintained 13
method-name / keyword lists. A hand-copied vendor list drifts: the vendor adds,
renames, or removes a method and the replica silently goes stale. Item B's
directive is to name each list's vendor source of truth and **read it** instead
of replicating it; where a list encodes a judgment no vendor publishes, keep it
and say what makes it irreducible.

The mechanism is a committed **vendor-declaration snapshot**
(`src/analyzers/universal/vendor-declarations.json`) produced by a generator that
reads each vendor's *shipped* `.d.ts`, plus a runtime probe (`Array.prototype`)
for the one list whose vendor is the ECMAScript runtime. The analyzer derives its
sets from that snapshot; the guard test (`src/__tests__/vendor-probe-dataaccess.spec.ts`)
pins the derivation so a later edit cannot silently regress it back to a copy.

## Classification

| # | List | Vendor source of truth | Disposition |
|---|------|------------------------|-------------|
| 1 | `SQL_KEYWORDS` | (none) — security subset | **Kept** (irreducible) |
| 2 | `QUERY_BUILDER_COMPANIONS` | (none) — grammar | **Kept** (irreducible) |
| 3 | `PRISMA_VERBS` | `@prisma/client` (schema-generated) | **Kept** (irreducible) |
| 4 | `EAGER_DB_METHODS` | better-sqlite3 / node:sqlite / D1 `.d.ts` | **Replaced** (vendor union) |
| 5 | `D1_CONVENIENCE` | (none) — D1 + generic judgment | **Kept** (irreducible) |
| 6 | `ORM_TABLE_VERBS` | Kysely `QueryCreator` | **Replaced** (vendor read) |
| 7 | `ORM_JOIN_VERBS` | Kysely `SelectQueryBuilder` | **Replaced** (vendor read + judgment) |
| 8 | `LLM_PROVIDER_RE` | (none) — judgment regex | **Kept** (irreducible) |
| 9 | `LLM_ACTION_RE` | (none) — judgment regex | **Kept** (irreducible) |
| 10 | `LLM_CLIENT_ARG_NAMES` | (none) — judgment set | **Kept** (irreducible) |
| 11 | `MESSAGE_LIFECYCLE_METHODS` | (none) — judgment set | **Kept** (irreducible) |
| 12 | `COLLECTION_TRANSFORM_METHODS` | ECMAScript `Array.prototype` | **Replaced** (runtime probe) |
| 13 | `CHUNK_HELPER_RE` | (none) — judgment regex | **Kept** (irreducible) |

**4 replaced, 9 kept-and-documented.** The four replaced lists are exactly the
ones whose members a vendor publishes verbatim; the nine kept lists each encode a
*selection* or a *shape* no vendor declares.

---

## Replaced (read from the vendor)

### 6. `ORM_TABLE_VERBS` — Kysely `QueryCreator`

- **Old:** `new Set(['selectFrom', 'deleteFrom', 'insertInto', 'updateTable'])`
- **Vendor source of truth:** Kysely's `QueryCreator` interface, published in the
  shipped `kysely@0.27.4` ESM `.d.ts` (read by the generator).
- **Replacement:** the analyzer filters its candidate table-entry names against
  the snapshot surface, so a name that is not a real `QueryCreator` member is
  dropped at load time:
  ```ts
  export const ORM_TABLE_VERBS = new Set(
    ['selectFrom', 'deleteFrom', 'insertInto', 'updateTable', 'mergeInto', 'replaceInto']
      .filter((m) => KYSELY_QUERY_CREATOR.has(m)),
  );
  ```
- **Judgment retained:** the *selection* — which `QueryCreator` members take a
  table as their first argument — is ours. `selectNoFrom` is in the vendor
  surface but takes a **selection** (a column list), not a table, so it is
  deliberately excluded. `with`/`withRecursive`/`withSchema`/`withPlugin`/
  `withoutPlugins` are CTE/schema/config members, not table-entry verbs.
- **Net change:** +`mergeInto`, +`replaceInto`. No member of the old set was
  removed.

### 7. `ORM_JOIN_VERBS` — Kysely `SelectQueryBuilder`

- **Old:** `new Set(['join', 'leftJoin', 'rightJoin', 'innerJoin'])`
- **Vendor source of truth:** Kysely's `SelectQueryBuilder` interface (same
  shipped `.d.ts`). Its `Join` family is `fullJoin`, `innerJoin`,
  `innerJoinLateral`, `leftJoin`, `leftJoinLateral`, `rightJoin`.
- **Replacement:**
  ```ts
  export const ORM_JOIN_VERBS = new Set([
    ...[...KYSELY_SELECT_QB].filter((m) => m.endsWith('Join') || m.endsWith('JoinLateral')),
    'join',
  ]);
  ```
  The lateral variants end in `JoinLateral`, not `Join`, so both suffixes are
  matched; the guard test pins the exact six-member family.
- **Judgment retained:** bare `join` is **not** a Kysely verb (the snapshot proves
  `SelectQueryBuilder` has no `join`). It is retained for non-Kysely builders
  (`knex('t').join('u', …)`, Objection-style `.join`), which no single vendor
  `.d.ts` models here. That is the irreducible part.
- **Net change:** +`fullJoin`, +`innerJoinLateral`, +`leftJoinLateral`; the old
  set's members are all preserved.

### 4. `EAGER_DB_METHODS` — better-sqlite3 / node:sqlite / Cloudflare D1

- **Old:** `new Set(['run','all','first','raw','exec','batch','query','get'])`
- **Vendor source of truth:** the *statement* and *database* surfaces of
  `@types/better-sqlite3` (`Statement`/`Database`), `@types/node` `sqlite.d.ts`
  (`StatementSync`/`DatabaseSync`), and `@cloudflare/workers-types`
  (`D1PreparedStatement`/`D1Database`).
- **Replacement:** a cross-vendor union, each name validated against the surface
  that publishes it:
  ```ts
  export const EAGER_DB_METHODS = new Set([
    ...['run','get','all','iterate','raw'].filter((m) => BETTER_SQLITE3_STATEMENT.has(m)),
    ...['exec'].filter((m) => BETTER_SQLITE3_DATABASE.has(m)),
    ...['run','get','all','iterate'].filter((m) => NODE_SQLITE_STATEMENT.has(m)),
    ...['exec'].filter((m) => NODE_SQLITE_DATABASE.has(m)),
    ...['all','first','run','raw'].filter((m) => D1_PREPARED_STATEMENT.has(m)),
    ...['batch','exec'].filter((m) => D1_DATABASE.has(m)),
    'query',
  ]);
  ```
- **Judgment retained:** *which* statement methods are eager I/O (return rows) vs.
  configuration-only (`bind`, `pluck`, `expand`, `safeIntegers`, …) is ours. The
  vendor surfaces enumerate the names; the eager/configure classification is the
  documented judgment. `query` is the generic driver abstraction
  (`IndexHandle.query`), not a single vendor.
- **Net change:** +`iterate` (the driver-method gap deferred in #329 is now read
  from the vendor surface instead of left out). `.get()` is confirmed present on
  both better-sqlite3 and node:sqlite statement surfaces.

### 12. `COLLECTION_TRANSFORM_METHODS` — ECMAScript `Array.prototype`

- **Old:** `new Set(['slice','splice','map','filter','concat','flatMap'])`
- **Vendor source of truth:** the ECMAScript runtime itself — `Array.prototype`
  (no `.d.ts` publishes "which array methods return a collection"; the runtime
  is the authority on existence).
- **Replacement:** a runtime probe, mirroring the repo's existing
  `builtinModules` / `globalThis` enumeration precedent:
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

Each of these encodes a selection or shape no vendor declares. They are left as
hand-written, and the reason is stated in an inline comment where it was not
already present.

1. **`SQL_KEYWORDS`** — a *security* subset feeding only `checkQuerySecurity`
   (the host-language dataflow gate). It is deliberately **not** the SQL-ness
   admission gate (that is provenance/shape/tag-based), so it must stay a
   curated subset: expanding it to "all SQL keywords" would be wrong, and a
   vendor has no notion of "keywords that evidence a dynamic-string injection
   surface."
2. **`QUERY_BUILDER_COMPANIONS`** — a verb→required-companion **grammar**
   (`.select`⇒`.from`, `.insert`⇒`.values`, `.update`⇒`.set`/`.where`,
   `.delete`⇒`.where`). Pure syntax, no vendor publishes it.
3. **`PRISMA_VERBS`** — Prisma Client verbs are **generated per-schema** from the
   user's `schema.prisma` (model verbs like `findUnique`, `upsert`, `groupBy`
   exist only after `prisma generate`); there is no fixed shipped list to read.
   The 17-name set is the object-form admitter's stable core. Note the known
   drift: `findRaw` is **not** a real Prisma verb (there is no `findRaw`;
   the raw entry point is `$queryRaw`), so this list is *already* a judgment and
   stays hand-written until a schema-generation probe is warranted.
4. **`D1_CONVENIENCE`** — a mixed judgment: D1's `all`/`first`/`run` plus the
   generic `query`/`execute` for the parameterized single-arg-vs-two-arg
   discriminator. `execute` is not even a D1 method (D1 uses `exec` on the
   database, `run` on the statement), so this set is *intentionally* broader than
   any one vendor surface.
5. **`LLM_PROVIDER_RE`** / 6. **`LLM_ACTION_RE`** / 7. **`LLM_CLIENT_ARG_NAMES`**
   — LLM/agent-adjacency signals. Each is a judgment about what a *name* means
   (`gateway`, `deepseek`, `thesisEngine`), and each carries a documented
   exclusion (`client`/`ai`/`generate`/`extract` are ambiguous). No vendor
   publishes "which identifiers denote an LLM client."
8. **`MESSAGE_LIFECYCLE_METHODS`** — queue-consumer per-message verbs
   (`ack`/`nack`/`acknowledge`/`deleteMessage`/`retry`). A queue *contract*, not a
   vendor method surface; different brokers publish different spellings and the
   set is a cross-broker union plus the contextual `retry`.
9. **`CHUNK_HELPER_RE`** — a **name pattern** (`chunk`/`chunks`/`chunkArray`/
   `chunkBy`/`partition`/`paginate`/`paged`) recognizing *user-written* helper
   functions by convention. There is no vendor; the name is the only stable
   signal for a function whose internals the analyzer cannot see.

---

## The probe machinery

- **Generator** — `scripts/generate-vendor-declarations.mjs`: reads the installed
  `@types/better-sqlite3` and `@types/node` `sqlite.d.ts`, and fetches pinned
  `kysely@0.27.4` + `@cloudflare/workers-types@4.20240903.0` via `npm pack`
  (read-only registry fetch, unpacked into a throwaway temp dir and deleted).
  It emits `vendor-declarations.json`: **4 vendors, 141 method names**.
- **Snapshot** — `src/analyzers/universal/vendor-declarations.json`, committed
  and imported with `import … with { type: 'json' }` (the repo's established
  pattern). The analyzer's eight `…_SURFACE` sets are derived from it.
- **Guard test** — `src/__tests__/vendor-probe-dataaccess.spec.ts` pins:
  (a) the snapshot is non-trivial and carries all four vendors; (b) every derived
  name is a real member of its claimed surface; (c) the vendor-only additions
  (`mergeInto`/`replaceInto`, the lateral/full joins, `iterate`) are present;
  (d) the documented judgments hold (`selectNoFrom` excluded from table verbs,
  bare `join` retained despite not being a Kysely verb, `query` retained as
  generic).

## Before/after corpus measurement — zero finding drift

The finding-identity multiset (`ruleId\tfile\tline`, full phase output) is
byte-identical before and after on all seven pinned corpora. The four replaced
lists are now *derived* rather than copied, and the derivation produces the same
effective method sets the old hand-written lists did, plus vendor members
(`mergeInto`, `replaceInto`, `fullJoin`, the lateral joins, `iterate`) that
simply never fire on any pinned corpus.

| Corpus | before | after | added | removed |
|--------|-------:|------:|------:|--------:|
| blitz | 830 | 830 | 0 | 0 |
| endless-guessing | 336 | 336 | 0 | 0 |
| hhra-org | 1358 | 1358 | 0 | 0 |
| knex | 719 | 719 | 0 | 0 |
| openstatus | 4886 | 4886 | 0 | 0 |
| primer-css | 18 | 18 | 0 | 0 |
| recall-protocol | 5157 | 5157 | 0 | 0 |

Measured with `scripts/measure-finding-identity.ts` (full phase finding
multiset, not the four-rule data-access filter).
