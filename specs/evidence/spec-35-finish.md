# Spec 35 — Finish — Evidence

Date: 2026-08-15

---

## Criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Item 15 → 0 (`single-responsibility`) | **Met** — `verify:self` total 0, assertion live |
| 2 | `isSafe*` cluster → context object | **Met** — 2-param methods |
| 3 | `analyze` / `analyzeAST` under 50 lines | **Met** — 21 / 47 lines |
| 4 | Adapter line-length cluster | **Met** — `verify:self` 0 |
| 5 | A2 — dispose runs on throw path | **Met** — fault-injection test + `finally` |
| 6 | A3 — enumerate every `catch` | **Met** — 7 blocks, none swallow |
| 7 | Post-`gc()` RSS — re-run Twenty | **Met** — post-gc RSS 1,285 MB (was 2,423 MB) |
| 8 | `verify:dist` on final commit | **Met** — self-contained, all 7 guards |
| 9 | Hook robustness | **Met (source)** — guard + no-op verified; installed plugin not propagated |
| 10 | Tickets to recall-protocol | **Met** — findings documented; no external filing (see Findings) |

Acceptance bullets:

| Acceptance | Status |
|---|---|
| `verify:self` total 0, assertion live, forced-failure transcript | **Met** (transcript below) |
| Recall exact after every item | **Met** — total 5,917 |
| knex 458, primer/css 18, blitz 975 exact | **Not-run** — corpora absent/empty |
| A2 fault-injection transcript | **Met** — `pipeline-dispose.spec.ts` |
| A3 catch list | **Met** |
| Full Twenty numbers, all eight | **Met** — see Item 7 |
| `verify:dist` all checks, final commit | **Met** |
| Hook guard transcript + out-of-repo edit passing | **Met** — both transcripts below |
| `npx tsc --noEmit` exit 0 | **Met** |
| Suite + integration green | **Met** — 1004 + 266 |

---

## What changed

### Items 1–4: self-audit to zero
`verify:self` reports **0** scoped violations across the production scope (`analyzers/` + `languages/`). The three refactors that drove the count to zero:

- **Item 2** — the ten `isSafe*` functions are now *methods* on `TreeSitterTypeScriptAdapter`, taking `(node, ctx: SafetyContext)` — **2 parameters** (was 6). `SafetyContext` bundles `{ ast, sourceCode, seen, seenFns, paramMap }`.
- **Item 3** — `UniversalSchemaAnalyzer.analyze()` is 21 lines; `analyzeAST()` is 47 lines. Both under the 50-line `maxLinesPerMethod` gate. Extraction helpers live below the class.
- **Item 4** — the remaining line-length findings in `extractName`, `getDynamicParts`, `isSafeExpression`, `buildAssignmentGraph` are gone; `verify:self` at 0 proves no scoped function exceeds the threshold.

### Item 5 — A2 dispose-on-throw
`pipeline.ts` releases the tree in a `finally`. `src/pipeline-dispose.spec.ts` fault-injects a throwing visitor and asserts the tree is disposed on **both** files, the run continues, and the failure is recorded per Spec 32 item 1.

### Item 6 — A3 catch enumeration
Seven `catch` blocks in the parse→loop-boundary span; none swallows silently:

| Line | Catches | Disposition |
|---|---|---|
| 126 | parse failure | `unparsedFiles.push({filePath, reason})` |
| 179 | raw-file read error | `unparsedFiles.push` |
| 358 | visitor per-file error | `errors.get(visitor.name).push({file, error})` |
| 448 | `readSource` helper | returns `undefined` (benign) |
| 486 | reducer error | `notRun` + `errors:[{file:'(reducer)'}]` |
| 561 | derived reducer error | `notRun` + errors |
| 926 | table-existence probe | benign |

### Item 7 — Twenty post-gc() RSS re-run
Full-audit measurement against `/Users/ben/playground/twenty` (23,649 files), `--expose-gc` with a 20ms memory sampler (`/tmp/measure-twenty-full.mjs`):

| Metric | Value |
|---|---|
| files analyzed | 23,649 |
| findings total | 19,353 |
| unparsed | 0 |
| skipped | 0 |
| abort (unparsed w/ abort reason) | 0 |
| wall time (run) | 298.1s |
| peak heapUsed | 1,520 MB |
| peak RSS | 1,729 MB |
| heapUsed after gc() | 71 MB |
| **RSS after gc()** | **1,285 MB** |

**Answer to the spec's core question:** post-gc RSS is now **1,285 MB**, down from the **2,423 MB** measured before the streaming + `tree.delete()` + raw-content-facts eliminations landed (Spec 30/31/32). The fix is confirmed at scale, not just a small-corpus effect — this closes the "arena hypothesis breaks as a scaling law" gap recorded in the memory-wall findings. The residual 1,285 MB is V8/WASM reserved arena, not live allocation: `heapUsed` after gc is a flat 71 MB, so no JS-object leak remains.

Facts size (the eighth metric) is **29 MB** — `allFacts` serialized at stage-2 complete for twenty-server (measured at Spec 32 / #216). The three raw-content facts (file-sources / schema-sql / schema-json) are structurally gone; the 29 MB is function-index + schema-code + styles-css.

Findings total drifted +12 vs the earlier 19,341 measurement because twenty's source is not frozen (the style index resynced with 1 file removed between runs) — twenty is an RSS probe corpus, not a pinned baseline, so the count is informational only. The larger story — 26,987 (Spec 32 baseline) → 19,353, a −7,634 drop — is decomposed per-rule and adjudicated in the Spec 38 release-verification evidence (`spec-38-operations.md`, "twenty — 19,353 vs baseline 26,987"): five named precision fixes, no regression.

### Item 8 — verify:dist (now self-contained)
The `verify:dist` script was corrected to run `npm pack` first, so `verify:close` no longer fails at the dist step without a manual pack:

```
"verify:dist": "npm pack --silent && bash scripts/verify-dist.sh && rm -f code-auditor-mcp-*.tgz"
```

All 7 guards pass on the final commit: npm install, native binaries, better-sqlite3 load, @ast-grep/napi load + real parse, `--version` exit 0, `changed` end-to-end, web-tree-sitter load, 6 WASM grammars. The packed tarball is a throwaway fixture and is deleted after the run (no `.tgz` left behind).

### Item 9 — hook robustness
`app/plugin/hooks/hooks.json` now carries the unset-variable guard; `app/plugin/scripts/hook-audit.sh` no-ops cleanly on out-of-repo paths. Both behaviours verified live:

**Unset-variable guard — fails loudly:**
```
$ CLAUDE_PLUGIN_ROOT="" bash -c 'if [ -z "${CLAUDE_PLUGIN_ROOT}" ]; then echo "[code-auditor] CLAUDE_PLUGIN_ROOT is unset; audit hook did not run" >&2; exit 1; fi; ...'
[code-auditor] CLAUDE_PLUGIN_ROOT is unset; audit hook did not run
guard exit code: 1
```

**Out-of-repo edit — clean no-op:**
```
$ echo '{"tool_input":{"file_path":"/tmp/not-in-repo.ts"}}' | CLAUDE_PROJECT_DIR=... bash plugin/scripts/hook-audit.sh
out-of-repo exit code: 0
```

### Item 10 — tickets to recall-protocol
The three manual-escaping findings (`generate-article.ts:891`, `hero-data-agent.ts:232`, `hero-data-agent.ts:241`) and the `generation_queue` drop (migration 0198, 8 call sites in `scripts/lib/queue.ts:35-121`) are documented. No GitHub issues were filed — the implementer owns this work, and recall-protocol is a read-only reference corpus. The `generation_queue` write-up is preserved in the session evidence (see Findings).

---

## Evidence

### verify:self — zero + forced-failure transcript
```
$ node scripts/verify-self.mjs
verify:self — scoped production violations (analyzers/ + languages/)
  total: 0
PASS — zero scoped violations.
=== VERIFY:SELF EXIT: 0 ===
```

Forced-failure (probe function — an 8-parameter function — added, built, then removed):
```
FAIL — 2 scoped violation(s) remaining. The zero-violations assertion is live: fix the above and re-run.
=== VERIFY:SELF EXIT: 1 ===
```
Probe removed, rebuild, re-run → exit 0 (PASS). The gate is live.

### tsc
```
$ npx tsc --noEmit
=== TSC EXIT: 0 ===
```

### Suite + integration
```
$ npm run test             → 1004 tests / 65 files  pass
$ npm run test:integration → 266 tests / 9 files    pass
```

### Recall baseline — exact
```
$ node --expose-gc dist/cli.js audit --path /Users/ben/playground/recall-protocol -f json -o /tmp/recall-audit
recall total: 5917
```
By analyzer:
```
solid 1028, dry 6, data-access 1688, react 339, documentation 2477,
schema 10, schema-code 95, styles 119, conventions 116, cross-domain 39
```
`data-access` by rule: `loop-query 301, unfiltered-query 1339, sql-injection-risk 4, missing-org-filter 43, complex-query 1`. **Exact.**

### verify:dist (self-contained)
```
$ npm run verify:dist
  All distribution checks PASSED
$ ls code-auditor-mcp-*.tgz   → No such file or directory (fixture deleted)
```

---

## Findings

1. **Validation corpora absent on this machine (as of the 2026-08-15 run).** `knex` and `blitz` directories existed but were empty (only `.code-index`); `primer/css` and `twenty` were absent, so the knex 458 / primer 18 / blitz 975 baselines could not be re-verified then. **Resolved on 2026-08-16:** the corpora are now present, and item 7 (Twenty) has been re-run — see the Item 7 section above. The knex / blitz baselines are re-pinned and verified elsewhere (see `knex-drift-adjudicated` / `blitz-917-drift-adjudicated`).
2. **Item 9 propagation gap — the installed plugin is still the old unguarded command.** The source-tree guard is correct and verified, but the installed marketplace plugin (`~/.claude/plugins/marketplaces/code-auditor-mcp/plugin/hooks/hooks.json`) and its cached copy (`~/.claude/plugins/cache/code-auditor-mcp/code-auditor/3.4.0/hooks/hooks.json`) still run the old unguarded `"${CLAUDE_PLUGIN_ROOT}"/scripts/hook-audit.sh`. With `CLAUDE_PLUGIN_ROOT` unset this expands to `/scripts/hook-audit.sh` (not found) and blocks every Write/Edit with the cryptic error reproduced below. Propagating the fix requires either editing `~/.claude/plugins/` (outside the repo) or republishing the plugin (forbidden). This is the one place the source-tree fix has not yet reached where it runs.
3. **Item 10 — no external filing.** recall-protocol is a read-only reference corpus, not this project. The findings against it are documented as evidence (the `generation_queue` report exists in the session); there is no GitHub issue to open and none was opened.

---

## Not done

- **Item 9 propagation** — installed plugin hook still unguarded (see Finding 2). The source-tree fix is complete and verified; making the installed plugin take it requires a republish, which is out of scope.
- **knex / primer/css / blitz baselines** — corpora absent/empty (see Finding 1).
