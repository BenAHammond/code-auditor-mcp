# recall-protocol — SQL Injection Defects (Ticket)

**Status**: Open — real defects in `recall-protocol` (READ-ONLY corpus; fix belongs to that repo's owner)
**Rule**: `sql-injection-risk`
**Detector**: `UniversalDataAccessAnalyzer` → `TsSafetyAnalysis.isSafeInterpolation`
**Severity after Spec 33/34 part (a)**: `warning` (full severity; the Spec 19 R3.3 blanket demotion to `suggestion` was reverted)

## Summary

Spec 33/34 cleared 11 real false positives via cross-function taint tracking, and
part (a) of that work **tightened `isSafeInterpolation` so manual quote-escaping
is no longer treated as sanitization**. After those changes the analyzer reports
**4 `sql-injection-risk` findings** against `recall-protocol`, and **none of them
are false positives** — all four are genuine defects.

Three of the four were previously *misclassified as safe false positives* (see
`sql-injection-fp-defect.md`, now superseded). The re-adjudication unmasked them.
They are the ticket items below. The fourth (`rederive-subjects.ts:105`) was
always flagged and is recorded here for completeness because it is the most
severe of the group.

## Why `.replace(/'/g, "''")` is not sanitization

Single-quote doubling protects **only** the string-literal context against the
**single** ASCII apostrophe. It leaves every other injection vector open:

- **Backslash escapes** — the SQL string still parses `\'`, `\\`, etc., so a
  value containing a backslash can break out of the literal.
- **Unicode quote variants** — `’` (U+2019), `“`/`”` (U+201C/D), and other
  quote-shaped codepoints are not touched.
- **Numeric contexts** — where no quoting applies, doubling quotes is a no-op.
- **Identifier positions** — where quotes are not the injection vector at all.

Treating it as safe makes the tool *actively certify* a vulnerability: a user
reads silence as clearance. A masked injection is worse than a false positive.

---

## Ticket items

### 1. `scripts/generate-article.ts:891` — read-back by untrusted `args.name`

```ts
const readBack = await d1Query(
  `SELECT id FROM strategy_articles WHERE name = '${args.name.replace(/'/g, "''")}' ORDER BY generated_at DESC LIMIT 1`,
);
```

`args.name` is a CLI-supplied article name (user input). It reaches the SQL text
with only single-quote doubling. **Analyzer severity: `suggestion`** (the
"scripts-and-tests" profile caps scripts to `suggestion`; the underlying finding
is `warning`).

### 2. `src/agents/hero-data-agent.ts:228→232` — `game_mode` filter from user config

```ts
const gameModeFilter = opts?.gameMode !== undefined
  ? opts.gameMode === null
    ? "WHERE game_mode IS NULL"
    : `WHERE game_mode = '${opts.gameMode.replace(/'/g, "''")}'`
  : "";
```

`opts.gameMode` is typed `string | null` and traces to `cfg.gameMode` (user
strategist config). It is interpolated into `.exec()` with only single-quote
doubling. **Analyzer severity: `warning`** — the one genuine injection on the
corpus that was previously masked.

### 3. `src/agents/hero-data-agent.ts:238→241` — `mode` filter from user config

```ts
const strategyModeFilter = opts?.gameMode !== undefined
  ? opts.gameMode === null
    ? "WHERE mode = 'stadium'"
    : `WHERE mode = '${opts.gameMode.replace(/'/g, "''")}'`
  : "";
```

Same value, same insufficient escaping, second query site. **Analyzer severity:
`warning`.**

### 4. `scripts/rederive-subjects.ts:105` — raw `process.argv` with no escaping (pre-existing)

```ts
const modeArg = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1];
// ...
const where = modeArg ? `AND mode='${modeArg}'` : "";
```

`modeArg` is a raw CLI argument interpolated into SQL with **no escaping at
all** — not even quote doubling. Most severe of the four. Always flagged (the
standing pre-Spec-33 "1" finding); recorded here so the four travel together.
**Analyzer severity: `suggestion`** (scripts profile cap).

---

## Remediation (for recall-protocol's owner)

Replace all four with **parameterized queries** so user/CLI-controlled values are
bound, never interpolated into SQL text:

- D1 REST API (`d1Query`) supports bound parameters; pass `args.name` / `modeArg`
  as `params` instead of string interpolation.
- `storage.sql.exec(...)` accepts `...args` binding; pass `opts.gameMode` as a
  bound argument and drop the `WHERE`/`AND` string assembly.

If a value *must* be inlined (e.g. a dynamic identifier), whitelist it against a
closed set (`mode ∈ { competitive, quickplay }`, table/column names from an
allow-list) rather than escaping.

## Verification

```bash
# Cold run against recall-protocol — expect exactly 4 sql-injection-risk findings
rm -rf .code-index
node dist/cli.js audit --path /Users/ben/playground/recall-protocol -f json
```

Confirmed at Spec 33/34 part (a): `sql-injection-risk` went **1 → 4** (net −91
from baseline 6008 → 5917), `schema-code` 95 and `schema` 10 unchanged.
