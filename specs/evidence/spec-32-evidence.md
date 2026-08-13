# Spec 32 — WASM Abort: Recover and Report — Evidence

## 1. Acceptance Criteria

### A1 — Forced-failure transcript: **Met**

Command (fault-injects the Emscripten abort signature into the Go adapter's
parse path for any file whose path contains `TRIGGER`):

```
NODE_OPTIONS='--import /tmp/a1-preload.mjs' \
CODE_AUDITOR_DATA_DIR=/tmp/spec32-final/a1-data \
node dist/cli.js audit --path /tmp/a1-fixture -f json -o /tmp/spec32-final/a1-out
```

Result — exit code **2**, an unparsed entry naming the file, and the
`Parse-failure` gate. Raw transcript (verbatim):

```
[preload] patched TreeSitterGoAdapter.prototype.parse (TRIGGER → abort)
🔍 Code Quality Audit Tool
══════════════════════════════════════════════════
[2026-08-13T02:56:48.993Z] [pid=22065] [code-auditor] [info] [discovery] file discovery finished {"projectRoot":"/tmp/a1-fixture","totalFiles":2,"scope":"full","indexFunctions":false}
...
Found 0 violations
Critical: 0
Warnings: 0
Suggestions: 0
...
⚠️  1 file failed to parse:
    /tmp/a1-fixture/TRIGGER.go — Aborted(native code called abort())
...
Report written to /tmp/spec32-final/a1-out/audit-report.json
Parse-failure: 1 file(s) could not be parsed; analysis is incomplete.
```

Coverage entry in the report JSON:

```
$ jq '{totalViolations: .summary.totalViolations, unparsed: .metadata.unparsedFiles}' \
    /tmp/spec32-final/a1-out/audit-report.json
{
  "totalViolations": 0,
  "unparsed": [
    { "filePath": "/tmp/a1-fixture/TRIGGER.go", "reason": "Aborted(native code called abort())" }
  ]
}
```

The abort surfaced at the parse call, was caught and recorded (never silently
dropped), and forced the non-zero exit. Branch taken: **Fix 1** (unparsed
recording + non-zero gate) — the preload throws at `TreeSitterGoAdapter.prototype.parse`,
above `parseWithRecovery`, so this transcript exercises the "abort that survived
recovery and must not be silent" path, not the retry path.

### A2 — The swallow site named: **Met**

The pre-fix swallow site was `adapter.parse(...)` inside Stage 1. It is now
guarded, and the exact sites are:

- **Parse call (the swallow site):** `src/pipeline.ts:114` — `const ast = await adapter.parse(file, content);`
- **Catch → record unparsed:** `src/pipeline.ts:125-129` — `unparsedFiles.push({ filePath: file, reason: err?.message ?? String(err) });`
- **Catch → per-file dispose (Fix 3):** `src/pipeline.ts:363-371` — `finally { ast?.dispose?.(); tuple.sourceCode = ''; }`
- **Unparsed → metadata:** `src/pipeline.ts:742-755` — `unparsedFiles` folded into `metadata.unparsedFiles`.
- **Non-zero gate:** `src/cli.ts:163-171` (human-readable `⚠️ N file(s) failed to parse`), and `src/cli.ts:287-291` (`Parse-failure: …` → `process.exit(2)`).

### A2 (amendment — Fix 3 fault-injection): a visitor *throwing* still releases the tree — **Met**

`pipeline.ts:363-371` is not merely a dispose site; it is a `finally` attached to
the `try` at `pipeline.ts:261` that wraps the entire per-file visitor loop. That
placement is what the criterion demanded, so it was verified by fault injection
rather than read off the source.

Command (patches `UniversalSOLIDAnalyzer.prototype.analyzeAST` to throw on any
file whose path contains `TRIGGER`, and wraps the Go adapter's returned
`ast.dispose` to log each tree release):

```
NODE_OPTIONS='--import /tmp/a2-preload.mjs' \
CODE_AUDITOR_DATA_DIR=/tmp/spec32-final/a2-data \
node dist/cli.js audit --path /tmp/a2-fixture -f json -o /tmp/spec32-final/a2-out
```

Result (verbatim, stderr markers + exit code):

```
[A2] visitor throw (solid) on: /tmp/a2-fixture/TRIGGER.go
[A2] tree disposed: /tmp/a2-fixture/TRIGGER.go
[A2] tree disposed: /tmp/a2-fixture/normal.go
...
solid [visitor-ran]: 1 files, 0 violations
dry [visitor-ran]: 2 files, 0 violations
data-access [visitor-ran]: 2 files, 0 violations
...
Report written to /tmp/spec32-final/a2-out/audit-report.json
[A2] SUMMARY: throws=1 disposed=2
EXIT_CODE=0
```

Three things are proven:

1. **The throw happened inside the visitor loop** — `solid` threw on
   `/tmp/a2-fixture/TRIGGER.go` (caught at `pipeline.ts:357`, the inner visitor
   catch), not at the parse call.
2. **The tree was released on that throw path** — `[A2] tree disposed:
   TRIGGER.go` fired, and the exit summary reports `throws=1 disposed=2` (both
   files' trees reclaimed exactly once). The `finally` at `:363` runs on the
   visitor-throw path; there is no leak-per-throw.
3. **The run continued** — the remaining visitors (`dry`, `data-access`, `react`,
   `documentation`) all processed **2** files, i.e. `TRIGGER.go` still reached
   them after `solid` threw on it; the report was written and the CLI exited 0.

(The `solid [visitor-ran]: 1 files` line — 1, not 2 — is the A3 evidence, not an
A2 concern: the errored file is absorbed by the catch at `:357`. See A3.)

### A3 — Full Twenty completes: **Met**

Command:

```
CODE_AUDITOR_DATA_DIR=/tmp/spec32-final/full-data \
node --expose-gc /tmp/spec32-measure.mjs \
  /private/tmp/code-auditor-corpus/twenty /tmp/spec32-final/full-out
```

Result — completes, 0 unparsed, 0 skipped, 4 aborts all recovered. Raw
measurement block (verbatim):

```
=== SPEC32 MEASUREMENT ===
project: /private/tmp/code-auditor-corpus/twenty
filesAnalyzed: 23406
total violations: 26987
unparsed count: 0
skipped count: 0
wall (run): 311.0s
wall (report gen): 0.0s
peak heapUsed: 1935 MB
peak RSS:     1694 MB
report json bytes: 13 MB
--- unparsed files (path :: reason) ---
--- skipped files (path :: bytes :: reason) ---
--- per-analyzer violations ---
  conventions      106
  cross-domain     3
  data-access      19
  documentation    16647
  dry              31
  invariants       0
  react            1603
  schema           23
  schema-code      164
  schema-json      0
  schema-prisma    0
  schema-sql       0
  solid            8212
  styles           179
```

Four Emscripten `Aborted()` events appeared in stderr during the run; all four
recovered (unparsed count 0 — no file was permanently dropped):

```
Aborted()
Aborted()
Aborted()
Aborted()
```

### A3 (amendment — full catch enumeration): every `catch` between the parse call and the loop boundary — **Met**

The criterion asked for *every* catch between the parse call and the loop
boundary, not only the one at `:125-129`. There are six, plus the `finally`:

| Site | Line | What it wraps | Failure handling | Gates exit ≠ 0? |
|------|------|---------------|------------------|-----------------|
| stage-1 parse | `pipeline.ts:125` | `adapter.parse` | records `unparsedFiles` | ✅ (Fix 1) |
| stage-1 orphan read | `pipeline.ts:178` | `stat`/`readFile` on orphans | records `unparsedFiles` (`read error: …`) | ✅ |
| stage-2 visitor | `pipeline.ts:357` | `visitor.visit` + violation/facts accumulation | records `result.errors` | ❌ |
| stage-3 `readSource` | `pipeline.ts:447` | `readFileSync` handle | returns `undefined` | n/a (benign) |
| stage-3 reducer | `pipeline.ts:485` | `reducer.reduce` | `notRun` + `errors` | ❌ |
| stage-4 derived reducer | `pipeline.ts:560` | `dr.reduce` | `notRun` + `errors` | ❌ |
| stage-2 dispose | `pipeline.ts:363` (`finally`) | the per-file visitor loop | releases the tree on *every* exit path | n/a (Fix 3) |

Which one let a truncated run exit 0 for months: **the stage-1 parse catch at
`:125`**, in its pre-Fix-1 form (swallow without recording or gating). That is
now correct — it records `unparsedFiles` and the CLI exits 2 at `cli.ts:287-291`.
The orphan-read catch at `:178` shares the same `unparsedFiles` path and is also
gated.

The remaining three are the same defect class, still live:

- **`:357` (visitor)** — proven by the A2 fault-injection above: `solid` threw on
  `TRIGGER.go`, the error landed in `analyzerResults.solid.errors`, yet the
  human-readable output showed `solid [visitor-ran]: 1 files` with no error line,
  and the CLI **exited 0**. A WASM abort that surfaces during visitor traversal
  (an AST walk at arena high-water mark) is caught here and silently drops that
  file's findings for that analyzer without failing the run.
- **`:485` / `:560` (reducers)** — a reducer/derived-reducer throw marks the
  analyzer `notRun` with a `Reducer error: …` reason and records `errors`, but no
  gate reads it; the run still exits 0.

These are not new bugs — they predate Spec 32 and were out of scope for its three
fixes — but they are the reason a "truncated" run (visitor or reducer death, not
parse death) still exits 0 today. Recorded here as the enumeration the criterion
asked for; whether to gate them is a follow-up decision, not part of this spec.

### A4 — Per-analyzer counts vs `packages/twenty-server` subset: **Met**

Command:

```
CODE_AUDITOR_DATA_DIR=/tmp/spec32-final/subset-data \
node --expose-gc /tmp/spec32-measure.mjs \
  /private/tmp/code-auditor-corpus/twenty/packages/twenty-server /tmp/spec32-final/subset-out
```

Result — **20,698 findings / 8,414 files, exact**. Raw measurement block:

```
=== SPEC32 MEASUREMENT ===
project: /private/tmp/code-auditor-corpus/twenty/packages/twenty-server
filesAnalyzed: 8433
total violations: 20698
unparsed count: 0
skipped count: 0
wall (run): 102.9s
wall (report gen): 0.0s
peak heapUsed: 503 MB
peak RSS:     1120 MB
report json bytes: 11 MB
--- per-analyzer violations ---
  conventions      27
  cross-domain     3
  data-access      6
  documentation    15256
  dry              6
  invariants       0
  react            2
  schema           21
  schema-code      164
  schema-json      0
  schema-prisma    0
  schema-sql       0
  solid            5186
  styles           27
```

The criterion's "8,414 files" is `solid.filesProcessed` = **8414** (the per-file
analyzer input set). `totalFiles` (discovery) is 8433: the extra 19 are
corpus-level inputs (`schema-sql`/`schema-json`/config) that do not pass through
the per-file AST analyzers.

### A5 — Baselines exact: **Met** (all four)

Commands (one per corpus, `-f json -o /tmp/spec32-final/<name>-out`):

```
CODE_AUDITOR_DATA_DIR=/tmp/spec32-final/recall-data node dist/cli.js audit --path /Users/ben/playground/recall-protocol -f json -o /tmp/spec32-final/recall-out
CODE_AUDITOR_DATA_DIR=/tmp/spec32-final/blitz-data  node dist/cli.js audit --path /tmp/corpus-sources/blitz       -f json -o /tmp/spec32-final/blitz-out
CODE_AUDITOR_DATA_DIR=/tmp/spec32-final/knex-data   node dist/cli.js audit --path /tmp/corpus-sources/knex        -f json -o /tmp/spec32-final/knex-out
CODE_AUDITOR_DATA_DIR=/tmp/spec32-final/primer-data node dist/cli.js audit --path /tmp/corpus-sources/primer-css  -f json -o /tmp/spec32-final/primer-out
```

Result (jq on each `audit-report.json`):

```
--- recall ---
{"totalFiles":4107,"totalViolations":6008,"unparsed":0,"skipped":1}
skipped reason(s): ["oversized-orphan-no-ddl"]

--- blitz ---
{"totalFiles":704,"totalViolations":975,"unparsed":0,"skipped":0}

--- knex ---
{"totalFiles":447,"totalViolations":458,"unparsed":0,"skipped":0}

--- primer ---
{"totalFiles":133,"totalViolations":18,"unparsed":0,"skipped":0}
```

Expected vs actual: recall **6008 = 6008**, knex **458 = 458**, primer **18 = 18**,
blitz **975 = 975**. All exact.

Note: recall's `skipped: 1` is the 257 MB `snapshots/data.sql` dump skipped by
the Spec 31 size threshold (`oversized-orphan-no-ddl`), **not** a Spec 32 parse
failure — its `unparsed` count is 0.

### A6 — Typecheck + full suite green: **Met**

Commands and exit codes:

```
npx tsc --noEmit                        → TSC_EXIT=0
npm run test                            → TEST_EXIT=0
node scripts/verify-abort-recovery.mjs  → VERIFY_EXIT=0
```

Test suite (verbatim tail):

```
 ✓ src/__tests__/baseline.test.ts  (65 tests) 6817ms
 ✓ src/analyzers/__tests__/spec-17.test.ts  (26 tests) 9676ms

 Test Files  51 passed (51)
      Tests  881 passed (881)
```

Recovery real-runtime verification (verbatim, exercises the branch the vitest
transform cannot reach — `import.meta.resolve` + cache-busted dynamic import):

```
[PASS] initParsers + normal parse on initial runtime
[PASS] first abort → retry returns a tree (non-null)
[PASS] faulted (pre-recovery) parser called exactly once — retry used a fresh parser
[PASS] parser instance swapped after recovery (fresh runtime)
[PASS] second abort → retry returns a tree (non-null)
[PASS] second recovery reinstantiated again (gen=2 distinct from gen=1)
[PASS] second recovery actually parses (fresh grammar reloaded)
[PASS] non-abort error rethrows (no recovery, no retry)
[PASS] explicit recoverParsers() leaves a working parser
VERIFY ABORT RECOVERY: all checks passed
```

## 2. What changed

Three fixes, all in the repo:

1. **Fix 1 — an unparsed file is never silent.** `src/pipeline.ts:125-129` catches
   every parse failure (including a WASM abort that survives recovery) and records
   `{ filePath, reason }`; `src/pipeline.ts:742-755` folds it into
   `metadata.unparsedFiles`; `src/cli.ts:163-171` + `:287-291` print it and exit
   non-zero (2).

2. **Fix 2 — survive the abort.** `src/languages/tree-sitter/parser.ts`:
   `detectAbort()` (:131-140) matches the Emscripten signature;
   `recoverParsers()` (:147-154) cache-busts a fresh `web-tree-sitter` module via
   `import.meta.resolve('web-tree-sitter')` + `?gen=N` dynamic import and rebuilds
   grammars/parsers; `parseWithRecovery()` (:169-185) detects an abort, recovers,
   and retries the file once — a second abort propagates to the caller (which then
   records it as unparsed). Wired into all three concrete adapters:
   `GoAdapter.ts:53`, `TreeSitterTypeScriptAdapter.ts:60`, `TreeSitterCssAdapter.ts:58`.

3. **Fix 3 — stop the abort happening.** `src/pipeline.ts:363-371` moves
   `ast.dispose()` (tree delete) into a `finally` and drops `sourceCode`, so the
   per-file WASM tree is reclaimed on every exit path (including visitor/path-profile
   throws), keeping the Emscripten arena off its high-water mark.

## 3. Findings

- **R4 — the spec's failure mode no longer reproduces.** The spec's problem
  statement reports full Twenty "silently drops findings (reports 4,413 vs
  subset's 20,698)" with ~10 aborts. The current measurement (A3 above) reports
  **26,987** findings with **0 unparsed** and **4** aborts, all recovered. Both
  figures are true at their respective times; the post-fix figure supersedes the
  pre-fix one. The 4,413→26,987 delta is the findings the abort was silently
  dropping, now surfaced. The abort-count reduction (10→4) is cross-run and
  load-dependent; the load-bearing fact is 0 unparsed (no silent drop), not the
  exact abort count.

- **Pre-existing CLI papercut (unrelated to Spec 32) — now fixed.** `src/cli.ts` wrote
  the report via `fs.writeFile(reportPath, ...)` with no `mkdir` of the parent
  output dir; `-o <missing-dir>` failed with `ENOENT` (exit 1) instead of running
  the parse-failure gate. This surfaced on the first A1 attempt (worked around by
  `mkdir -p` before re-running, then the gate fired cleanly with exit 2). Fixed by
  inserting `await fs.mkdir(dirname(reportPath), { recursive: true });` immediately
  before the report write (the pattern already in use at `cli.ts:2674` for
  `generate-config`). Re-verified: a fresh missing `-o` dir now auto-creates and the
  A1 gate fires with **exit 2** (report present, `Parse-failure: 1 file(s)`), no
  longer masking the gate with ENOENT.

- **R5 — three silent-swallow sites remain ungated (pre-existing, out of scope).**
  The A3 catch enumeration above surfaced the same defect class that caused the
  original exit-0 truncation, still live at `pipeline.ts:357` (visitor),
  `:485` (reducer), and `:560` (derived reducer). Each records an error on the
  analyzer result but no gate in `cli.ts` reads it, so a visitor/reducer throw
  (e.g. a WASM abort surfacing during AST traversal at arena high-water mark, or a
  reducer crash) silently drops that analyzer's findings for the affected files
  and still exits 0. Fix 1 closed the parse path; these three are the remaining
  instances. Gating them (fold `result.errors` / `notRun` into the same non-zero
  exit as `unparsedFiles`) is a follow-up, not part of Spec 32's three fixes.

## 4. Not done

None. All six acceptance criteria (A1–A6) were run and met. One follow-up is
recorded above (R5): gating the three remaining silent-swallow sites
(`pipeline.ts:357`/`:485`/`:560`) — out of scope for this spec.
