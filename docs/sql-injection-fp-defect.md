# Remaining SQL Injection False Positives — Known Mechanisms

**Status**: Acknowledged — not planned for fix in v3.4.12
**Category**: correctness boundary
**Rule**: `sql-injection-risk`
**Current FP count**: 15 (down from 16 after `resolveLocalConstant` for-of fix)

These are the patterns the AST-based static analyzer cannot resolve as safe.
Each represents a gap between what tree-sitter can statically determine and what
a human reviewer knows is safe in context.

## FP Mechanisms

### 1. String concatenation (2 FPs)
`generate-article.ts:891`, `rederive-subjects.ts:105`

SQL built via `+` concatenation (not template literals). The analyzer traces
through template `${...}` substitutions but cannot resolve string concatenation
chains. These are safe — the concatenated values are compile-time string
literals, but the AST path through `+` operators isn't modeled.

**What would fix it**: A dataflow analysis that resolves binary expression
chains to their leaf values. Large scope — needs a symbolic evaluator.

### 2. CLI/config input via `.replace()` escaping (2 FPs)
`hero-data-agent.ts:232`, `hero-data-agent.ts:241`

`exec(\`...${gameModeFilter}\`)` where `gameModeFilter` is built from
`opts.gameMode.replace(/'/g, "''")`. The value originates from CLI options
(config input, not untrusted user data) and has SQL escaping applied. The
analyzer sees a non-static template substitution and flags it — it cannot
determine the provenance or safety of the interpolated value.

**What would fix it**: Recognizing `.replace(/'/g, "''")` as a sanitizer, or
taint tracking that distinguishes "trusted config input" from "untrusted
user input."

### 3. Conditional string literal (1 FP)
`admin-asset-rehost-map.ts:132`

`db.prepare(\`...${where}...\`)` where `where` is assigned from a ternary of
two known string literals. The analyzer resolves variable declarations but
cannot trace through conditional assignment — `where = cond ? "lit1" : "lit2"`
is seen as a non-static value because the ternary itself isn't evaluated.

**What would fix it**: Path-insensitive resolution of ternary expressions
where both branches are static.

### 4. Function call as SQL argument (5 FPs)
`admin-asset-rehost.ts:215, 227, 239, 251, 263`

`db.prepare(buildQuery(...))` where the SQL string is the return value of a
function call. The analyzer cannot resolve across function boundaries — it
has no inter-procedural dataflow. These are safe in context (the query
builder functions return parameterized queries with `.bind()`) but the
analyzer sees a non-string-literal argument to `.prepare()` and flags it.

**What would fix it**: Inter-procedural constant propagation, or a
module-level function summary mechanism.

### 5. Function parameter in template (2 FPs)
`guild-data/store.ts:422`, `pipeline/index.ts:343`

`${table}` where `table` is a function parameter — no local declaration to
resolve. The table name comes from the caller, which supplies known-safe
values, but the analyzer cannot trace callers.

**What would fix it**: Call-site analysis / inter-procedural propagation.
Alternatively, a "trusted parameter" annotation on the function.

### 6. Method call expression (1 FP)
`stadium-data.ts:489`

`db.prepare(\`...${EFFECT_FLAGS.map(c => \`a.${c}\`).join(", ")}\`)` where
`EFFECT_FLAGS` is a static array. The `.map().join()` chain evaluates to a
compile-time constant (a list of column names), but the analyzer cannot
evaluate method call chains — it only recognizes string/number/boolean
literals and substitution-free template strings.

**What would fix it**: Evaluation of well-known Array methods (`.map()`,
`.join()`) on static arrays. This is a precise but narrow enhancement.

### 7. Ternary conditional (1 FP)
`stadium-heroes.ts:69`

`db.prepare(\`...${selectCounts}\`)` where `selectCounts` is a ternary:
`includeCounts ? longStaticString : ""`. Both branches are static, but the
analyzer cannot evaluate ternary conditionals.

**What would fix it**: Same as mechanism #3 — path-insensitive ternary
evaluation where both branches are static.

### 8. Function parameter + for-of loop (1 FP)
`test-wired-pipeline.ts:61`

`d1Query(\`...${count}...\`)` where `count` is a function parameter within a
for-of loop. The for-of variable `table` was resolved as static by the recent
`resolveLocalConstant` fix, but `${count}` remains dynamic.

**What would fix it**: Same as mechanism #5 — inter-procedural analysis.

## Verification

```bash
# Cold run against recall-protocol
rm -rf .code-index
node dist/cli.js audit --path /Users/ben/playground/recall-protocol -f json

# Expected: sql-injection-risk = 15
# Expected: all other baselines unchanged (solid=1066, conventions=116,
#            documentation=2518, styles=119, cross-domain=38, dry=6,
#            react=339, schema=8, schema-code=95)
```
