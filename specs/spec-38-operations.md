# Spec 38 — Operations

Five patterns the linter ecosystem paid for. Each addresses something that has already cost time here.

---

## R1 — `--print-config`

ESLint can report the effective config for a given file and where each value came from. Its config cascade — extends, overrides, nested files, plugin resolution — took ten years and a full rewrite to escape, and `--print-config` is what made the intervening decade survivable.

This project already has the same problem in miniature: `analyzerConfigs`, `pathProfiles`, `includePaths`, `severityOverrides`, `builtin` toggles, `tableSources`, and ten colliding keys in a flat blob. Rounds of this project's own debugging were config archaeology — which `minCorpus` applies, whether built-in profiles were active, whether `schemas` or `knownTables` was read, whether `dbWrapperNames` reached the guard as well as the detector.

`code-audit print-config <file>` outputs the effective config for that file: every key, its value, and its source — default, project config, path profile, or built-in preset.

Requirements:

- Resolves per file, since path profiles make config file-dependent.
- Names the source of every value, not just the value.
- Includes keys the user never set, showing the default in effect. The `minCorpus` collision was invisible precisely because nobody set it.
- Flags any key whose value differs from default, which Spec 36 R5's threshold reporting consumes.

## R2 — Per-rule timing

ESLint ships `TIMING=1` for per-rule cost. Per-stage timing already exists here; per-rule is what identifies the rule making a gate too slow to keep.

This matters more than for a linter because of R3.

Requirements:

- Per-rule wall time, opt-in by environment variable.
- Reported for the gating path specifically, since that is where the budget binds.
- Ordered slowest first.

## R3 — Gate speed budget

The tools displacing ESLint are not better analyzers, they are 50–100× faster ones. A slow gate gets disabled, and a disabled gate is worse than none because it looks like coverage.

An agent will not complain that the hook is slow. It will work in a way that avoids triggering it, and nothing in the output will say so.

**Budget: the blocking gate completes in under 300 ms on a single changed file.**

Requirements:

- Measure the current figure before optimizing. Report it.
- A rule exceeding its share of the budget is reported by R2 and optimized — never removed from the gating set (Spec 45 Amendment A, A1).
- The budget is asserted in CI against a representative file, so a regression fails rather than silently degrading.
- If the budget cannot be met, report the actual number and what dominates it. Do not quietly widen it.

## R4 — Shareable presets

`eslint:recommended` exists so nobody starts from a blank config.

A project adopting this today must discover `dbReceiverNames`, `dbCallMethods`, `dbBindingNames`, `dbWrapperNames`, `tableSources`, `schemas` versus `knownTables`, `minCorpus`, `exemptPatterns` and the rest. That discovery is what most of this project's own debugging consisted of, on a codebase whose author wrote the tool.

Presets: D1/Cloudflare, Drizzle, TypeORM, Prisma, plain-pg, Knex.

Requirements:

- A preset sets the config keys that stack needs and nothing else.
- Presets compose — a Drizzle-on-Postgres project extends both.
- `print-config` names the preset as the source of every value it contributes.
- Each preset is verified against a real corpus: D1 against recall, Drizzle against OpenStatus, TypeORM against Twenty, Knex against Directus, Prisma against blitz. A preset that does not populate a table catalog on its corpus is not finished.

## R5 — Rule-ID alias map

ESLint deprecates rules with a named replacement rather than removing them. Rule identity is in the baseline fingerprint here, so a rename silently reshuffles known versus new.

Already spent: `naming-convention` became `table-naming-convention`; `direct-sql` and `unknown-column` were deleted outright. Each invalidated existing baselines with no migration path.

Requirements:

- An alias map from retired rule IDs to their replacement, or to a tombstone for genuine removals.
- Fingerprint resolution consults it, so an existing baseline survives a rename.
- A removed rule with no replacement is a tombstone with a reason, so a stale baseline entry reports "this rule was removed because X" rather than appearing as a resolved finding.
- Adding an alias is part of renaming a rule, enforced by the registry test — a rule ID that exists in a prior release and neither in the registry nor the alias map fails.

---

## Acceptance

1. `print-config <file>` outputs every effective key with its source, including unset defaults. Run it on a recall file and a blitz file; post both.
2. Per-rule timing reported, slowest first, for the gating path.
3. Current gate latency measured and reported. Budget asserted in CI — forced-failure transcript showing the assertion fails when exceeded.
4. Five presets, each verified against its corpus with the table catalog or equivalent populated. Post the per-preset result.
5. Alias map covering `naming-convention`, `direct-sql` and `unknown-column`. A baseline written before the rename still matches after — transcript.
6. Registry test fails on a rule ID present in a prior release and absent from both registry and alias map — transcript.
7. Recall, knex, primer/css and blitz baselines exact.

## Reporting

Standing reporting contract. Every requirement met, failed, or not run.
