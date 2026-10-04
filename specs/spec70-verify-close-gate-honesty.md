# Spec 70 — verify:close gate honesty (the "PASS without running" question)

## The plain answer

**The current runner cannot print `verify:close PASSED` when any gate was
skipped.** Its PASS banner is reached only when every gate ran *and* exited 0 —
a skip, a failure, or a crash each forces a non-zero exit. So if a prior
"verify:close PASSED" was printed by `scripts/verify-close.mjs`, every gate ran
and passed at that moment (dist was fresh, `verify:self` ran its audit for real).

What made that answer *unsettled* rather than false was that the runner enforced
it **implicitly**. The PASS banner was gated by `failed.length || crashed.length`,
and a skip was assumed to always co-occur with a `verify:dist-fresh` failure
(the only thing that triggers a skip). That assumption was real but (a) never
asserted and (b) the one place it was spelled out carried the comment
"unreachable in practice". A regression that broke the skip⟹failure coupling —
e.g. a gate marked `dist: true` in `GATES` but skipped by some other branch, or a
`verify:dist-fresh` that silently exited 0 on a stale build — would have let a
skipped `verify:self` ride through to a green run, uncaught.

## What the liveness test asserted (and missed)

`src/__tests__/gate-liveness.test.ts` tested `planRun` — the **pure skip/run
decision** — asserting *which* gates skip on a stale dist. It never tested the
**verdict** half that turns a completed result list into pass/fail. The
skip-decides-correctly invariant is necessary but not sufficient: a runner could
skip `verify:self` correctly and still report PASS if its aggregation ignored
skips. That aggregation is exactly what the test did not cover.

## The fix

`scripts/verify-close.mjs` now extracts `summarizeResults(results)` (pure,
exported) that classifies a result list as `pass` / `fail` / `inconsistent`:

- `pass` — `failed.length === 0 && crashed.length === 0 && skipped.length === 0`
  (skips are named in the guard, not assumed away).
- `fail` — at least one gate failed or crashed.
- `inconsistent` — a skip with no failure/crash: a planning bug, still non-pass.

It also fixes a double-count: `failed` no longer matches `status === null`, so a
crash is reported once (in `crashed`), not also as `failed`.

Five new liveness tests pin the verdict directly, the key one being: **a skipped
gate with no co-occurring failure is `inconsistent`, never `pass`.**

## The remaining honest caveat

`verify:self` (and `verify:languages`) consume `dist/cli.js` and do **not** assert
dist freshness themselves — they validate whatever `dist/cli.js` exists. Their
protection against validating a stale build is entirely the runner's
`dist: true` → skip-on-stale-dist. Running `npm run verify:self` standalone
against a stale build would genuinely report PASS against the wrong code. That is
by design (the scripts document `npm run build && npm run verify:self`), and the
runner now makes the skip loud and non-pass — but it is the one place a standalone
invocation can still produce a misleading green.
