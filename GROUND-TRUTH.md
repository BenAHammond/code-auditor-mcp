# Ground Truth — Task #105 (Send-back Items 1–3)

*Compiled 2026-07-20. Updated 2026-07-22 for close-out batch (items 1-6).*

---

## 1. Rule-ID Registry — Complete Accounting

### 1.1 One-Emitter-Per-Id Rule

**Constraint**: Every rule ID must be emitted by exactly one analyzer. If two analyzers emit the same ID, their violations cannot be distinguished in fingerprints, baselines, or task deduplication.

**Result**: No violation of one-emitter-per-id at the fixed-ID level. All 79 fixed IDs have exactly one source analyzer. **However**, invariant rule IDs are user-defined and can duplicate fixed IDs — that intersection is not validated at config-load time.

### 1.2 Field Used for Rule ID by Each Analyzer

| Analyzer | Field used | IDs |
|----------|-----------|-----|
| UniversalDocumentationAnalyzer | `rule` (via `createViolation()`) | `file-documentation`, `function-documentation`, `parameter-documentation`, `return-documentation`, `class-documentation`, `method-documentation` |
| UniversalSchemaAnalyzer | `rule` (via `createViolation()`) | 28 IDs: `missing-schemas`, `unknown-table`, `unknown-column`, `naming-convention`, `reserved-word`, `too-many-queries`, `sql-injection`, `n-plus-one`, `invalid-json`, `missing-schema-declaration`, `undefined-required-field`, `invalid-type`, `invalid-range`, `type-mismatch`, `string-too-short`, `string-too-long`, `pattern-mismatch`, `invalid-format`, `below-minimum`, `above-minimum`, `too-few-items`, `too-many-items`, `missing-required-field`, `unexpected-property`, `enum-mismatch`, `file-error` |
| UniversalSOLIDAnalyzer | `rule` (via `createViolation()`) | `solid/class-size`, `solid/method-complexity`, `open-closed`, `single-responsibility`, `interface-segregation`, `liskov-substitution`, `dependency-inversion` |
| UniversalDRYAnalyzer | `rule` (via `createViolation()`) | `dry/duplicate`, `dry/structural-similarity`, `duplicate-string-literal`, `duplicate-import` |
| UniversalDataAccessAnalyzer | `rule` (via `createViolation()`) | `sql-injection-risk`, `missing-org-filter`, `complex-query`, `unfiltered-query`, `hardcoded-connection`, `direct-sql`, `loop-query` |
| invariantsAnalyzer | `rule` (direct assignment in conversion) | User-defined IDs from `.codeauditor.json` `rule.id`; hardcoded meta-errors: `config-error`, `engine-error` |
| **CrossLanguageSOLIDAnalyzer** | **`principle`** | `SRP`, `OCP`, `LSP`, `ISP`, `DIP` |
| **SchemaValidator** | **`violationType`** | `field-mismatch`, `schema-field-mismatch`, `missing-field`, `extra-field`, `constraint-mismatch`, `version-mismatch` |
| **reactAnalyzer** | **`violationType`** | `complexity`, `missing-props`, `no-error-boundary`, `hooks-violation`, `performance`, `accessibility` |
| **APIContractAnalyzer** | **`contractType`** | `api-type-mismatch`, `missing-endpoint`, `api-extra-field`, `api-missing-field`, `method-mismatch`, `auth-mismatch` |

**Key**: Bold rows = NON-STANDARD field. Only 7 of 9 analyzers store rule ID in `rule`. The last 2 use different fields.

**React special case**: The `hooks-violation` type ALSO sets `rule: 'hooks-naming'` on the violation object (line 284), making it the only reactAnalyzer violation visible via the `rule` extraction path. The other 5 react violation types only appear in `violationType`.

### 1.3 Duplicate Rule ID Across Analyzers

`type-mismatch` appears in BOTH:
- **UniversalSchemaAnalyzer** (stored in `rule`): SQL/JSON schema type mismatches
- **SchemaValidator** (stored in `violationType`): cross-language protobuf/GraphQL/OpenAPI type mismatches

Since they use different *fields*, they produce different fingerprint components:
- UniversalSchemaAnalyzer: `rule = "type-mismatch"` → extracted by `violation.rule`
- SchemaValidator: `violationType = "type-mismatch"` → extracted by `violation.violationType`

This was the *SchemaValidator* copy; renamed to `schema-field-mismatch` in Rider 2, Spec 19.

**Verdict**: The duplicate name was cosmetic but not a functional collision because the fingerprint paths differ. Now resolved by renaming.

`missing-field` and `extra-field` also appear in both SchemaValidator and the UNUSED `APIContractAnalyzer` (dead code — never imported or registered).

### 1.4 Total Count

79 fixed rule IDs across 10 analyzers (including APIContractAnalyzer and dependency-graph). `sql-injection` and `n-plus-one` from UniversalSchemaAnalyzer added to registry in close-out item 2.

---

## 2. Fingerprint Extraction — Single Canonical Path (FIXED)

### 2.1 The Ground-Truth Extraction Chain

The correct resolution order (ALL paths MUST follow via `buildFingerprintInput()`):

```
violation.rule ?? violation.principle ?? violation.violationType ?? violation.contractType ?? violation.type ?? violation.details?.rule ?? ''
```

### 2.2 Current State — ALL PATHS CANONICAL (fixed #106, #107, close-out item 1)

All three surfaces now delegate to a single function:

- **`baseline.ts`**: Calls `buildFingerprintInput(violation)` — the shared canonical source. FIXED in #107.
- **`projectTasks.ts` (from_audit)**: Calls `buildFingerprintInput(violation)` — the shared canonical source. FIXED in #106.
- **`sarifReportGenerator.ts`**: Uses `buildFingerprintInput()` for fingerprinting. Has its own `resolveRuleId()` for reporting labels (not fingerprinting).

**Status**: All paths now produce identical fingerprints. The cross-surface identity test in `baseline.test.ts` verifies this.

### 2.3 Cross-Surface Fingerprint Identity (VERIFIED)

A violation from `UniversalDocumentationAnalyzer` with `rule: "function-documentation"` now produces:

| Surface | Rule component | Fingerprint |
|---------|---------------|-------------|
| `baseline.ts` | `"function-documentation"` | `SHA256(["documentation","function-documentation","src/foo.ts","myFunc"])` |
| `projectTasks.ts` from_audit | `"function-documentation"` | `SHA256(["documentation","function-documentation","src/foo.ts","myFunc"])` |
| `sarifReportGenerator.ts` | `"function-documentation"` | Uses same `buildFingerprintInput()` |

**These are identical fingerprints.** Tasks created via `from_audit` can now be deduplicated against baseline entries.

**Close-out item 1**: `contractType` added to `buildFingerprintInput` chain between `violationType` and `type`. APIContractAnalyzer violations now resolve to their correct rule ID instead of empty string.

---

## 3. Spec 11 & Spec 20 Code Accounting

### 3.1 Spec 11 (Ledger)

- **`src/ledger.ts`** (381 lines): Complete standalone library with AuditLedger, AuditRun, AnalyzerRun, TrendPoint, LedgerOptions, LedgerSummary.
- **Test**: `src/__tests__/ledger.test.ts` (391 lines, 26 tests).
- **Status**: Fully implemented and tested. **NEVER called from any execution path** — no CLI command, no MCP tool, no auditRunner integration.
- **Integration seam**: `AuditResult.metadata.baseline` block (Spec-18 R5.5) provides the fields the ledger needs (`newCount`, `fixedCount`, `knownCount`, `hash`).

**Close-out item 4**: `sql-injection` severity demoted from `warning` to `suggestion` (Spec-11 R4 blanket demotion). R1 diagnosis sentence added to CHANGELOG explaining the ~15,000 regex-based false positives.

### 3.2 Spec 20 (Profile Resolver — DELETED v3.1.1)

- **CHANGELOG entry**: "Spec-20: profile inheritance (speculative over-engineered; deleted in v3.1.1)."
- **Stale artifacts REMOVED** (close-out item 6):
  - ~~`app/tsconfig.json` line 38: `"src/config/profileResolver.ts"`~~ — removed from exclude
  - ~~`app/dist/config/profileResolver.d.ts.map`~~ — deleted
- **No runtime impact**: All stale artifacts are gone.

---

## 4. Verified Facts (from prior session)

### 4.1 Test Suite

- **475/475 tests pass** (0 failures)
- Bench: F1=1.0 across all 7 analyzers
- Fix: `extractDocumentation()` parent-level backward walk restricted to `/**` comments only (spec-17 R1.4 regression)

### 4.2 Analyzer Field Mapping (cross-verified against source)

Every `createViolation()` call stores:
- 5th positional arg → `v.rule` (UniversalAnalyzer.ts:157)
- 7th positional arg → `v.functionName` (UniversalAnalyzer.ts:167-169)

`extractSymbol()` in `symbols.ts` extracts from:
```
symbol ?? functionName ?? className ?? componentName ?? methodName
?? hookName ?? interfaceName ?? name ?? enclosingSymbol ?? ''
```

---

## 5. Action Items — Status

### Done (close-out batch)

1. ~~**Fix `projectTasks.ts` `from_audit` rule extraction**~~ → #106 (now delegates to `buildFingerprintInput()`)
2. ~~**Fix `baseline.ts` rule extraction**~~ → #107 (now delegates to `buildFingerprintInput()`)
3. ~~**Add cross-surface fingerprint identity test**~~ → #108
4. ~~**Add `contractType` to `buildFingerprintInput`**~~ → close-out item 1
5. ~~**Add `sql-injection` and `n-plus-one` to RULE_REGISTRY**~~ → close-out item 2
6. ~~**Demote `sql-injection` severity to `suggestion`**~~ → close-out item 4
7. ~~**Remove stale Spec-20 artifacts**~~ → close-out item 6

### Done (prior)

8. ~~**Rename SchemaValidator's `type-mismatch`**~~ → renamed to `schema-field-mismatch` (Rider 2, Spec 19)

### Pending

9. **Remove dead code**: `APIContractAnalyzer` (unused, has duplicate rule IDs with SchemaValidator).
10. **Wire ledger**: `src/ledger.ts` needs CLI/MCP integration. Deferred until Spec-11 implementation.

---

*End of ground-truth document. This is the reference for all subsequent Spec-18 fingerprint work.*

---

## 6. Spec 21 — Provenance-Based Detection

*Added 2026-07-23.*

### 6.1 Detection Mechanism

Database-handle detection is now **provenance-primary with conjunctive name-fallback**. The system asks "where did this variable's value come from?" — not "is it named `db`?"

**Provenance chain**: A variable is DB-provenanced if its value traces to:
1. A known DB package import (`better-sqlite3`, `drizzle-orm`, `@prisma/client`, `pg`, `mysql2`, etc.)
2. A member expression on a provenanced receiver (`.prepare()`, `.exec()` → the return value is provenanced)
3. A `D1Database`-annotated type (Cloudflare Workers/D1)
4. An `env.DB` binding pattern
5. Propagation through assignment, destructuring, class field init, default params

**Conjunctive guard**: Name alone is NEVER sufficient for detection. A variable named `database` pointing to `new Map()` produces zero violations — the provenance chain is broken at the source.

### 6.2 Detection Modes

| Mode | Config | Behavior |
|------|--------|----------|
| `hybrid` | `detection.mode = "hybrid"` | Provenance resolves first; unresolved identifiers matching name lists get `reason: "fallback"`. **Default.** |
| `provenance` | `detection.mode = "provenance"` | Strict provenance only. Never consults name lists. |
| `names` | `detection.mode = "names"` | Legacy English-only name matching. Opt-in escape hatch. |

The mode is a single shared key in `.codeauditor.json` — no per-analyzer config duplication.

### 6.3 Module: `src/analyzers/provenance.ts`

**Exports**:

| Export | Purpose |
|--------|---------|
| `DB_PACKAGES` | ReadonlySet of known DB package names |
| `VALIDATOR_PACKAGES` | ReadonlySet of known validator package names |
| `DB_TYPES` | ReadonlySet of known DB type names (`D1Database`, `Database`, `Pool`, `PrismaClient`, `Kysely`) |
| `DB_CALL_METHODS` | Fixed API surface methods (`exec`, `prepare`, `batch`, `run`, `all`, `first`, `query`, `get`, `each`) |
| `DB_BINDING_NAMES` | Environment binding patterns (`DB`, `env.DB`, `DATABASE`) |
| `buildProvenanceContext()` | Builds a `ProvenanceContext` for a file from its AST |
| `isDBProvenanced()` | Checks if a node's receiver is DB-provenanced |
| `isValidatorProvenanced()` | Checks if a node's receiver traces to a validator import |
| `extractDBProvenancedImports()` | Seeds the provenance map from import statements |
| `propagateProvenance()` | Walks assignments/destructuring to propagate provenance |
| `inferReceivers()` | Finds call expressions on provenanced receivers for inference |

**Data flow per file**:

```
parseFile → AST
    ↓
extractDBProvenancedImports(ast) → seedMap { localName → ProvenanceEvidence }
    ↓
propagateProvenance(ast, seedMap) → full provenanceMap
    ↓
build ProvenanceContext from provenanceMap
    ↓
analyzer checks gate on ProvenanceContext, not names
```

### 6.4 Tree-Sitter Grammar Detail

TypeScript's tree-sitter grammar does NOT include `=` as a named child of `variable_declarator`. The `splitVariableDeclarator()` function in `provenance.ts` handles this with a grammar-agnostic fallback: when `nameNode` is already set, past the `=` phase, and `valueNode` hasn't been assigned, the next non-type child is treated as the value expression.

### 6.5 Unicode Correctness

| Fix | File | Change |
|-----|------|--------|
| CamelCase splitting | `QueryParser.ts:554` | `/(?=[A-Z])/` → `/(?=\p{Lu})/u` |
| Token matching | `QueryParser.ts:286` | `\w+` → `[\p{L}\p{N}_]+` |
| CamelCase breakdown | `codeIndexDB-enhanced.ts:583` | `/([A-Z])/g` → `/(\p{Lu})/gu` |
| Symbol extraction | `ruleEngine.ts:489-514` | `\w` → `[\p{L}\p{N}_]` with `u` flag |
| Unclassifiable guard | `ruleEngine.ts:374` | Non-Latin identifiers → skip naming checks |

### 6.6 Regression Gate

The delta ledger governs before/after diffs on the committed Spec 11 English corpora baselines. Every disappeared finding must be proven a false positive with a fixture; every appeared finding must be attributed to provenance. Unexplained rows fail the gate. Additive means no true detection lost, not byte-identical output.

### 6.7 Non-English Corpus — R6.2 Language Gap (RESOLVED)

The non-English bench corpus (`bench/corpus/non-english/`) seeds 16 ground-truth violations across mixed Portuguese, German, and Japanese identifiers.

**Recovered (2) — R5 Unicode regex fix**: `unfiltered-query` for Japanese table names 注文 and 商品 — R5 `\p{L}` fix enabled table name extraction from SQL strings. TP citations:
- `kuesutori.ts:21` — "Unfiltered query on 注文 may cause performance issues"
- `kuesutori.ts:30` — "Unfiltered query on 商品 may cause performance issues"

**Recovered (2) — Spec 21 R6.2 three-tier requiresOrgFilter() fix**: `missing-org-filter` for Japanese table names 注文 and 商品. The old `requiresOrgFilter()` used an English-only table list (`['users', 'projects', 'orders', 'customers', 'accounts', 'teams']`). The fix implements the Spec 21 three-tier doctrine:
- **Tier 1 (config-primary)**: `orgFilterTables` in data-access config — user's explicit declaration
- **Tier 2 (usage-inference)**: Schema definitions with org-column matching (`orgFilterColumns` default: `org_id`, `tenant_id`, `organization_id`, `workspace_id`). Tables 注文 and 商品 are detected via schema inference with `org_id` column.
- **Tier 3 (fallback)**: English table list demoted to fallback tier

**Result**: trueRecall **16/16 = 1.0**. All 4 recovered known-misses flipped to Recovered with TP citations. Annotations deleted. Effective metrics unchanged (precision/recall/F1=1.0 across all 8 corpora).

---
## 7. Ground-Truth Law

*Added 2026-07-23 per Spec 21 R6.2 send-back.*

**Ground-truth entries may be added freely and deleted only for label errors with the error shown; detector limitations are annotated, never deleted.**

This law closes the hole where the `knownMisses` annotation mechanism guarded annotations but nothing guarded the corpus itself. The only legitimate ground-truth deletion is a **label error** — the violation isn't real or isn't in the rule's defined scope — and that claim requires showing the label was wrong, not that the detector is weak.

The `trueRecall` metric exists precisely to make the distance from done visible: it divides true positives by the full ground truth including acknowledged known-misses. Shrinking the corpus to raise `trueRecall` is laundering — it re-hides the distance the metric was built to expose.

---

## 8. Sibling Grep — Hardcoded English Word Lists

*Added 2026-07-23. Rider from Spec 21 R6.2 send-back: "grep for siblings — any other rule condition gating on hardcoded English word lists."*

### 8.1 Disposition

*Updated 2026-07-23. Spec 21 and its entire debt chain are now genuinely closed.*

| Priority | File:Line | List | What It Gates | Disposition |
|----------|-----------|------|---------------|-------------|
| **P1** | `config/defaults.ts:133-137` | `authPatterns`: `['withAuth', 'requireAuth', 'isAuthenticated']`; `adminPatterns`: `['withAdmin', 'requireAdmin', 'isAdmin']`; `rateLimitPatterns`: `['rateLimit', 'withRateLimit']`; `publicPatterns`: `['public', 'noAuth', 'skipAuth']` | Security behavior classification by function name. | **Corpus-annotated known-miss.** Seeded in `bench/corpus/non-english/src/autoriser.ts` (French `autoriser()` auth guard). Fix: three-tier detection (config-primary → middleware/decorator inference → English fallback), deferred to Spec 15's validator-provenance neighborhood where usage-inference infrastructure lives. The `knownMisses` entry on the non-English corpus ensures trueRecall visibly carries the debt. |
| **P1** | `config/defaults.ts:160-163` | `sanitized`: `['sanitize', 'escape', 'clean']` | Input-sanitization detection by function name. | **Corpus-annotated known-miss.** Seeded in `bench/corpus/non-english/src/nettoyer.ts` (French `nettoyer()` sanitizer). Fix: three-tier (config → library-call inference → fallback), same Spec 15 deferral as auth patterns above. |
| **P2** | `CrossLanguageSOLIDAnalyzer.ts:427` | `['handle', 'process', 'convert', 'transform', 'dispatch', 'route']` | "Switch-like" classification for open-closed principle. | ✅ **Resolved.** `switchLikeNames` made configurable in `CrossLanguageSOLIDConfig` (Spec 21 send-back). Corpus fixture at `bench/corpus/non-english/src/verarbeiten.ts` demonstrates the remaining structural-detection gap (German `verarbeiten()` doesn't match English names even with config — needs actual switch/if-else chain detection, deferred to Spec 15 neighborhood). |
| **P3** | `SchemaValidator.ts:441-444` | `['request', 'response', 'dto', 'model']` | Schema-name normalization. | **Deferred.** Lower priority; config-primary tier sufficient. Not blocking Spec 11. |
| **P4** | `UniversalSchemaAnalyzer.ts:577` | `['user', 'order', 'group', 'table', 'column', 'index']` | SQL reserved-word naming check. | **Deferred.** Lowest priority — SQL standard words are definitional, not English conventions. Config-primary (add DB-specific reserved words) sufficient. |

### 8.2 Already Addressed by Spec 21

| File:Line | List | Mechanism |
|-----------|------|-----------|
| `UniversalDataAccessAnalyzer.ts:812` | `['users', 'projects', 'orders', 'customers', 'accounts', 'teams']` | ✅ Tier 3 fallback in three-tier `requiresOrgFilter()` (#147) |
| `UniversalSchemaAnalyzer.ts:86-88` | `dbReceiverNames`, `dbBindingNames` | ✅ Fallback-only after provenance (Spec 21 R1). `detection.mode` controls. |
| `UniversalSchemaAnalyzer.ts:85` | `sqlTagNames = ['sql', 'db']` | ✅ Configurable; `sql` is language-invariant. |

### 8.3 Language-Invariant (Not English Gaps)

| File:Line | List | Reason |
|-----------|------|--------|
| `UniversalDataAccessAnalyzer.ts:576` | `['select', 'insert', 'update', 'delete', ...]` | SQL standard keywords + ORM API surface |
| `UniversalDataAccessAnalyzer.ts:963` | Same dbPatterns for legacy path | Same rationale |
| `UniversalDataAccessAnalyzer.ts:90-98` | `organizationPatterns` | Configurable English defaults — user-facing config |
| `UniversalDataAccessAnalyzer.ts:122` | `securityPatterns` | Configurable English defaults — user-facing config |
| `UniversalSchemaAnalyzer.ts:87` | `dbCallMethods` | Fixed API surface — `exec`, `prepare`, `batch`, etc. are library method names |
| `reactAnalyzer.ts:383` | `['div', 'span', 'section']` | HTML spec element names — W3C-defined |
| `UniversalSOLIDAnalyzer.ts` | `['Date', 'Array', 'Object', ...]` | JS built-in constructor names |
| `UniversalDataAccessAnalyzer.ts:1043` | `['forEach', 'map', 'filter', ...]` | JS Array.prototype method names |
| `APIContractAnalyzer.ts` (all) | Auth patterns, HTTP methods, API detection | **Dead code** — never imported or registered (GROUND-TRUTH.md §5 item 9) |

### 8.4 Action Items

All items are now dispositioned (2026-07-23):

1. ✅ **P2 resolved** (Spec 21 send-back): `switchLikeNames` is configurable in `CrossLanguageSOLIDConfig`. English defaults ship; non-English codebases override. The structural tier (detecting actual switch/if-else chains rather than naming) is deferred to Spec 15's neighborhood. Corpus fixture at `bench/corpus/non-english/src/verarbeiten.ts` carries the OCP known-miss.
2. 📏 **P1 corpus-annotated**: `authPatterns`/`adminPatterns`/`rateLimitPatterns`/`publicPatterns` and `sanitized` patterns are now seeded as `knownMisses` in the non-English bench corpus (`autoriser.ts`, `nettoyer.ts`). The three-tier fix (config-primary → usage-inference/middleware-provenance → English fallback) is design-level work deferred to Spec 15's validator-provenance neighborhood — same infrastructure, measured foundations. The non-English corpus `trueRecall` (currently 0.88) carries the debt visibly; no gap is invisible.
3. 📏 **P3-P4 deferred**: Schema-name normalization and SQL naming. Lower priority, config-primary tier sufficient. Not blocking Spec 11.

**Closure statement**: Spec 21 and its entire debt chain are now genuinely closed. The corpus is guarding the remaining known gaps — the measuring exists, the debt is on the ruler, and the fix arrives where its infrastructure lives (Spec 15). Nothing stands in front of Spec 11 anymore.
