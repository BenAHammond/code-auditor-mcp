# Spec 35 — Finish

The ten items still open from Spec 33/34. Ordered so earlier work makes later work smaller.

---

## 1. Item 15 to zero — 143 `single-responsibility` findings

The threshold revert restored 143 scoped findings that the goalpost move had suppressed. `verify:self` fails, or its assertion is disabled. Item 15's terms hold: fix the code, fix the rule, or calibrate with a recorded rationale. No fourth.

Items 2, 3 and 4 below are that work, decomposed. Report the count after each so the remainder is always visible.

## 2. The `isSafe*` parameter cluster — one design signal, not thirteen findings

Ten functions at exactly six parameters — `isSafeExpression`, `isSafeIdentifier`, `isSafeTemplateString`, `isSafeArray`, `isSafeCallExpression`, `isSafeMapJoin`, `isLocalFunctionCallSafe`, `isBodySafeUnderParams`, `isParamSafeAtAllCallSites`, `isDeclarationValueSafe` — plus `isDBProvenanced`, `isMemberExpressionDBProvenanced`, `isDBMethodCall`.

Ten functions threading the same six values is a context object that was never extracted. Bundle them into one — likely the provenance context, source, adapter and config the taint walk already carries — and pass that.

Thirteen findings clear at once and the call sites get shorter. This is the rule finding a real design problem, which is the outcome that justifies the rule.

**Expected:** the `isSafe*` family drops to two or three parameters. Recall's `sql-injection-risk` holds at 4 — this is a signature change, not a logic change, so any movement is a bug in the refactor.

## 3. `analyze` and `analyzeAST` in the schema analyzer

72 and 77 lines, both over 50 after the revert. Ordinary extraction — the helpers already live in `schema/` modules, so this is moving blocks out and calling them.

`analyzeAST` was already reduced from 103 to 77 by extracting `checkMissingReferences`. The same treatment applies to whatever the next-largest block is.

**Expected:** both under 50. Recall schema-code 95, schema 10, exact.

## 4. The adapter line-length cluster

`extractName` 84 lines, `getDynamicParts` 84, `isSafeExpression` 94, `buildAssignmentGraph` 71, plus the rest of the 141 across 24 files.

These are the tedious remainder — no shared design signal, just long functions. Extract sub-blocks with names that say what they do.

`isSafeExpression` at 94 lines is worth doing after item 2, since bundling the parameters may already split it naturally.

**Expected:** `verify:self` reaches 0. The zero-violations assertion goes live in `verify:close`, with a forced-failure transcript: reintroduce a violation, confirm `verify:close` exits non-zero, remove it, confirm green.

## 5. A2 — prove `dispose` runs on the throw path

`pipeline.ts:363-371` is a dispose site. Whether a visitor *throwing* still releases the tree is unproven, and disposing only on the normal path leaks one tree per throw — a live candidate for what pushed the WASM arena toward the aborts.

Fault-inject: make a visitor throw on a known file. Confirm the tree is released, the run continues, and the failure is recorded per Spec 32 item 1.

If `dispose` is not in a `finally`, move it there. A tree releases on every exit path from the per-file loop.

## 6. A3 — enumerate every `catch` between parse and the loop boundary

Only the one at `pipeline.ts:125-129` has been examined and corrected. Report every other `catch` in that span: path, line, what it catches, and what it does with the error.

One of those handlers is why a truncated run exited 0 for months. The others have never been looked at.

**Expected:** a list. Any handler that swallows an error without recording it is a finding.

## 7. Post-`gc()` RSS — re-run Twenty

Spec 33 item 3 landed changes to `parser.ts` (the `tsx` grammar map, removal of a one-off `new Parser()`) and `styleIndexer.ts` (`ast.dispose?.()` in a `finally`). Nobody re-ran Twenty to confirm the number moved.

The measurement was 2,423 MB post-`gc()` at 23,406 files, against 632 MB on recall's 4,107 — four times the figure the arena hypothesis predicted, with `heapUsed` at 52 MB ruling out a JS leak.

Re-run full Twenty with `--expose-gc`. Report peak heap, peak RSS, post-`gc()` heap and RSS, facts size, findings total, unparsed count, abort count, wall time.

If post-`gc()` RSS is still ~2.4 GB, item 3 did not fix it and the cause is still open. State that plainly rather than accepting the landed changes as the fix.

## 8. `verify:dist` on the final commit

Still has never run on this tree. The CLAUDE.md wording was corrected — `npm pack` produces a throwaway fixture, not a deliverable — so there is no reason left to skip it.

It checks that native binaries and the WASM grammars survive packaging. This release changed WASM tree lifetime, the grammar map, and added SCSS. Post every check.

## 9. Hook robustness

Two separate failures, both in the mechanism meant to bind agents at the edit boundary:

- `CLAUDE_PLUGIN_ROOT` unset resolves to `/scripts/hook-audit.sh`, not found, hook silently does not run. The guard exists in the source tree and has not reached the installed marketplace plugin.
- The hook emits a blocking error on edits outside the repo. It should no-op cleanly on a non-repo path.

Fix both. Confirm the guard fires on an unset variable, and that an out-of-repo edit passes without error.

This is Spec 36's enforcement point. It cannot be the flakiest thing in the stack.

## 10. Tickets to recall-protocol

Three manual-escaping findings, now correctly flagged after tightening `isSafeInterpolation`:

- `generate-article.ts:891`
- `hero-data-agent.ts:232`
- `hero-data-agent.ts:241`

All three build SQL by interpolating user-controllable input with `.replace(/'/g, "''")` as the only defence. `opts.gameMode` at `:232` and `:241` traces to user input.

Plus `generation_queue`, dropped in migration 0198 and still referenced at 8 call sites in `scripts/lib/queue.ts:35-121`.

File them. Confirm filed.

---

## Acceptance

- `verify:self` total 0, assertion live in `verify:close`, forced-failure transcript posted.
- Recall exact after every item: total 5,917, solid 1,028, data-access 1,688 with `sql-injection-risk` 4, documentation 2,477, schema 10, schema-code 95, styles 119, conventions 116, cross-domain 39.
- knex 458, primer/css 18, blitz 975 exact.
- A2 fault-injection transcript. A3 catch list.
- Full Twenty numbers, all eight.
- `verify:dist` all checks, on the final commit.
- Hook guard transcript, and an out-of-repo edit passing cleanly.
- `npx tsc --noEmit` exit 0. Suite and integration suite green.

## Reporting

Standing reporting contract. Every item met, failed, or not run — never omitted.
