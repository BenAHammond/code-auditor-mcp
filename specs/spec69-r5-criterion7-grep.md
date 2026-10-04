# Spec 69 R5 criterion 7 — `DB_RECEIVER_NAMES` survives in rules/processors (grep artifact)

Criterion 7 requires that receiver identification not be name-based. The grep
below is the standalone artifact proving the name list still lives in the tree,
and classifying every file that references it. §7 is **not met** while a rule or
processor holds the list.

## The grep

```
$ grep -rn "DB_RECEIVER_NAMES" src --include='*.ts' | grep -v __tests__
src/analyzers/universal/UniversalSchemaAnalyzer.ts:38      DB_RECEIVER_NAMES,
src/analyzers/universal/UniversalSchemaAnalyzer.ts:83      DB_RECEIVER_NAMES,
src/analyzers/universal/UniversalDataAccessAnalyzer.ts:21  DB_RECEIVER_NAMES,
src/analyzers/universal/UniversalDataAccessAnalyzer.ts:119 * Defaults to the same canonical list (DB_RECEIVER_NAMES),
src/analyzers/universal/UniversalDataAccessAnalyzer.ts:190 dbReceiverNames: [...DB_RECEIVER_NAMES],
src/analyzers/universal/UniversalDataAccessAnalyzer.ts:475 * blind spot (`DB_RECEIVER_NAMES`) …
src/analyzers/universal/schema/config.ts:23               export const DB_RECEIVER_NAMES = ['db','database','sql','stmt']
src/analyzers/universal/schema/config.ts:57               dbReceiverNames: [...DB_RECEIVER_NAMES],
src/analyzers/universal/schema/discovery.ts:24            DB_RECEIVER_NAMES,
src/analyzers/universal/schema/discovery.ts:335           const receivers = config.dbReceiverNames ?? [...DB_RECEIVER_NAMES];
src/analyzers/universal/schema/codeAnalysis.ts:16         import { … DB_RECEIVER_NAMES … } from './config.js';
src/analyzers/universal/schema/codeAnalysis.ts:158        const dbReceivers = config.dbReceiverNames ?? [...DB_RECEIVER_NAMES];
src/analyzers/universal/schema/codeAnalysis.ts:281        ...(ctx.config.dbReceiverNames ?? [...DB_RECEIVER_NAMES]),
```

Plus the config/preset surface:

```
$ grep -rn "dbReceiverNames" src/config src/presets
src/config/defaults.ts:264   dbReceiverNames: ['db','database','sql','stmt']
src/presets/presets.ts       (per-preset name lists: ['db','database'], ['dataSource','manager','repository','queryRunner','connection'], ['prisma','db'], ['pool','client','db','database'])
```

## Classification

| file | class | refs | what it is |
|---|---|---|---|
| `UniversalSchemaAnalyzer.ts` | **analyzer** | 38, 83 | the schema analyzer's receiver-name seed |
| `UniversalDataAccessAnalyzer.ts` | **analyzer** | 21, 119, 190, 475 | the data-access analyzer's receiver-name seed + default config |
| `schema/discovery.ts` | **processor** | 24, 335 | schema-fact discovery consumes the list |
| `schema/codeAnalysis.ts` | **processor** | 16, 158, 281 | code-analysis fact population consumes the list |
| `schema/config.ts` | **config** | 23, 57 | definition site + `DEFAULT_SCHEMA_CONFIG` |
| `config/defaults.ts` | **config** | 264 | user-facing default |
| `presets/presets.ts` | **config** | 62, 67, 81, 84, 98, 101, 114, 117, 129 | per-preset receiver name lists |

The list is therefore held by **two analyzers and two processors**, plus three
config surfaces. That is exactly the state criterion 7 forbids: the name list
has not been confined to a user-config default — it is a code path in rules and
processors. §7 is **not met** until `DB_RECEIVER_NAMES` and its fallback
machinery (`addNameListFallbacks`, `buildNamesOnlyProvenance`,
`addIdentifierFallbacks`, `addBindingFallbacks`, `detectDbWrapperFunctions`, and
the `'hybrid'`/`'names'` `DetectionMode` branches in `provenance.ts`) are
deleted and the consumers read the in-repo declaration resolution instead.

Note the earlier criterion-10 note recorded "13 refs across 5 files"; the grep
above confirms the same 13 refs across the same 5 files, with the two-arg
config surface (`defaults.ts`, `presets.ts`) additional. The count has not
drifted since that note was written.
