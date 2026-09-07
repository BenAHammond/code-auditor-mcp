# Corpus baselines — post-rework (Spec 49 acceptance #10)

Re-pinned after the 33-rule crude sweep (Sessions 1–27) and the after-33 pass
(Sessions 28–30). Each row is `analyzer::rule → count`, full per-rule
attribution so any future delta can be attributed to a named cause.

Measured read-only with `scripts/measure-corpus-counts.ts`
(`CODE_AUDITOR_DATA_DIR=/tmp/ca-baseline-<name> npx tsx scripts/measure-corpus-counts.ts <corpus>`),
which runs the same `runAuditDispatch` path the CLI uses and writes nothing into
the target project.

**Corpora measured**: recall-protocol, hhra-org, knex, primer-css, blitz.
**Corpora not on disk** (could not be re-measured): gin, svelte-realworld.

Timestamp: 2026-09-07.

---

## recall-protocol — 4,351 advisory findings (4,268 files)

| analyzer::rule | count |
| --- | --- |
| solid::function-length | 902 |
| styles::styles/off-scale | 735 |
| documentation::function-documentation | 574 |
| styles::styles/token-bypass | 456 |
| data-access::loop-query | 301 |
| dependency-graph::unreferenced-module | 124 |
| react::raw-element | 111 |
| dependency-graph::orphaned-nodes | 104 |
| react::no-error-boundary | 103 |
| react::performance | 95 |
| schema-code::too-many-queries | 95 |
| solid::parameter-count | 89 |
| documentation::method-documentation | 80 |
| data-access::complex-query | 67 |
| react::complexity | 66 |
| conventions::conventions/usage-pair | 60 |
| styles::styles/mechanism-fragmentation | 52 |
| conventions::conventions/error-handling | 51 |
| styles::styles/undefined-class | 47 |
| solid::solid/method-complexity | 33 |
| data-access::unfiltered-query | 32 |
| cross-domain::cross-domain/read-never-written | 21 |
| dry::dry/similar-expression | 21 |
| styles::styles/declaration-set-similarity | 21 |
| documentation::class-documentation | 16 |
| react::accessibility | 13 |
| conventions::conventions/naming | 10 |
| cross-domain::cross-domain/multi-table-write | 10 |
| schema::unknown-table | 10 |
| styles::styles/mechanism-mixing | 9 |
| cross-domain::cross-domain/written-never-read | 8 |
| styles::styles/z-index-singleton | 7 |
| dry::dry/duplicate | 6 |
| conventions::conventions/import-form | 5 |
| data-access::sql-injection-risk | 4 |
| solid::solid/dependency-inversion | 3 |
| solid::solid/class-size | 3 |
| solid::interface-size | 2 |
| conventions::conventions/export-shape | 1 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::hub-nodes | 1 |
| styles::styles/z-index-sprawl | 1 |

## hhra-org — 1,213 advisory findings (760 files)

| analyzer::rule | count |
| --- | --- |
| solid::function-length | 381 |
| styles::styles/undefined-class | 346 |
| react::no-error-boundary | 79 |
| documentation::method-documentation | 69 |
| dependency-graph::unreferenced-module | 60 |
| react::performance | 57 |
| documentation::function-documentation | 51 |
| documentation::class-documentation | 39 |
| react::complexity | 36 |
| data-access::loop-query | 18 |
| dependency-graph::orphaned-nodes | 17 |
| schema-code::too-many-queries | 17 |
| solid::solid/dependency-inversion | 8 |
| solid::solid/method-complexity | 7 |
| conventions::conventions/naming | 6 |
| conventions::conventions/usage-pair | 5 |
| dry::dry/similar-expression | 5 |
| cross-domain::cross-domain/written-never-read | 2 |
| solid::parameter-count | 2 |
| cross-domain::cross-domain/read-never-written | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::hub-nodes | 1 |
| react::accessibility | 1 |
| schema::invalid-json | 1 |
| schema-code::dynamic-sql-construction | 1 |
| solid::solid/class-size | 1 |

## knex — 405 advisory findings (474 files)

| analyzer::rule | count |
| --- | --- |
| schema-code::too-many-queries | 181 |
| solid::function-length | 60 |
| solid::solid/class-size | 31 |
| solid::solid/dependency-inversion | 20 |
| dependency-graph::orphaned-nodes | 17 |
| schema::unknown-table | 17 |
| data-access::hardcoded-connection | 16 |
| data-access::unfiltered-query | 15 |
| solid::solid/open-closed | 12 |
| solid::interface-size | 8 |
| data-access::loop-query | 6 |
| solid::parameter-count | 6 |
| data-access::sql-injection-risk | 5 |
| cross-domain::cross-domain/read-never-written | 4 |
| cross-domain::cross-domain/written-never-read | 1 |
| dependency-graph::hub-nodes | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::tight-coupling | 1 |
| dry::dry/similar-expression | 1 |
| schema-code::table-naming-convention | 1 |
| secrets::hardcoded-secret | 1 |

## primer-css — 124 advisory findings (137 files)

| analyzer::rule | count |
| --- | --- |
| styles::styles/off-scale | 101 |
| styles::styles/z-index-singleton | 11 |
| dependency-graph::orphaned-nodes | 5 |
| solid::function-length | 3 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::unreferenced-module | 1 |
| documentation::function-documentation | 1 |
| styles::styles/z-index-sprawl | 1 |

## blitz — 918 advisory findings (788 files)

| analyzer::rule | count |
| --- | --- |
| documentation::function-documentation | 191 |
| documentation::method-documentation | 161 |
| styles::styles/declaration-set-similarity | 161 |
| solid::function-length | 88 |
| react::raw-element | 54 |
| styles::styles/off-scale | 50 |
| dependency-graph::orphaned-nodes | 47 |
| documentation::class-documentation | 34 |
| data-access::unfiltered-query | 30 |
| react::no-error-boundary | 16 |
| styles::styles/token-bypass | 16 |
| styles::styles/undefined-class | 15 |
| solid::solid/dependency-inversion | 12 |
| react::performance | 9 |
| solid::parameter-count | 9 |
| schema::unknown-table | 4 |
| schema-code::reserved-word | 4 |
| react::complexity | 3 |
| secrets::hardcoded-secret | 3 |
| conventions::conventions/naming | 2 |
| data-access::loop-query | 2 |
| solid::solid/open-closed | 2 |
| conventions::conventions/export-shape | 1 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::hub-nodes | 1 |
| solid::solid/method-complexity | 1 |
