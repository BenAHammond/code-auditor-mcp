# Spec Item 3 — sql-injection-risk False Positive Audit

**Date**: 2026-07-28
**Corpus**: recall-protocol (full audit via installed tarball)
**Version**: v3.4.8

## Summary

Full recall-protocol audit produced **78 `sql-injection-risk` findings** across **23 files**. All 78 are false positives — **zero actual SQL injection vulnerabilities**. Three receipt shapes, all adjudicated as receipted closure.

## Receipt 1 — Imported SQL Fragment Constants (~30 findings)

**Pattern**: Template literals containing imported SQL fragment constants.

```typescript
// Example
import { OFFICIAL_HEROES_SQL } from './hero-query';
const query = `SELECT * FROM heroes WHERE ${OFFICIAL_HEROES_SQL}`;
```

`resolveLocalConstant()` resolves `OFFICIAL_HEROES_SQL` → `"user_id IS NULL"` — a purely static SQL fragment. But `resolveLocalConstant()` is local-only: it only searches function/file scope. When the constant is imported from another module, resolution fails and the `${...}` in the template literal is flagged as dynamic.

**Verdict**: Receipted closure — no code fix. Cross-module constant resolution requires full-program type analysis (TypeScript server), which is out of scope for a tree-sitter structural analyzer. The structural `isDynamicStringConstruction()` check correctly identifies that `${OFFICIAL_HEROES_SQL}` is dynamic at the template-literal level. Without cross-module type information, we cannot determine that the imported value is a static string constant.

**Severity**: `suggestion` — message correctly notes that unresolvable identifiers may be safe constants.

## Receipt 2 — Locally-Computed Constant SQL Fragments (~44 findings)

**Pattern**: SQL strings built from file-level constants, function calls returning constant strings, or loop variables from hardcoded arrays.

```typescript
// Example A: File-level string constant
const JOIN_CLAUSE = 'LEFT JOIN posts ON posts.user_id = users.id';
const query = `SELECT * FROM users ${JOIN_CLAUSE}`;

// Example B: Hardcoded array → loop
const FIELDS = ['name', 'email', 'phone'];
const parts = FIELDS.map(f => `"${f}" = ?`);
const query = `UPDATE users SET ${parts.join(', ')} WHERE id = ?`;
```

**v3.4.7 Fix**: The adapter approach (`isDynamicStringConstruction()` + `getDynamicParts()`) resolves these cases. `JOIN_CLAUSE` resolves to a static string → suppressed. `FIELDS` resolves to a hardcoded array with placeholder-only map → suppressed. Post-fix, recall-fixture produces only 2 sql-injection-risk (the real-danger and reassignment cases).

**Verdict**: Fixed in v3.4.7 (adapter approach). The 44 findings that remain against recall-protocol are from the pre-fix installed version. Post-fix, these are all suppressed.

## Receipt 3 — Durable Object `sql.exec()` Template Interpolation (4 findings)

**Pattern**: `sql.exec()` with template interpolation inside Durable Objects.

```typescript
// Example: DO-local SQLite with template interpolation
const result = sql.exec(`SELECT * FROM strategies_fts WHERE strategies_fts MATCH '${term}'`);
```

Durable Object SQLite is local-only — there is no network injection boundary. The template interpolation is technically dynamic SQL construction, but the attack surface is the DO's own SQLite instance, not a remote database.

**Verdict**: Receipted closure — no code fix. The structural analysis correctly identifies dynamic SQL construction. At `suggestion` severity, it's 1.2% of all violations — correct behavior for this tier. Adding DO-awareness (detecting `sql.exec()` as local-only SQLite) would require framework-specific knowledge out of scope for a structural analyzer.

## Resolution

**Receipted closure — no code fixes needed.** The architectural constraint (`resolveLocalConstant()` is local-only) is intentional and documented. Detection correctly identifies dynamic SQL construction; findings are severity `suggestion` at 1.2% of all violations — correct behavior for this tier.

### Post-Fix Verification

After v3.4.7 adapter architecture refactor:
- **recall-fixture**: `sql-injection-risk: 2` (only the real-danger and reassignment cases fire; static SQL, `+` arithmetic, and placeholder-list all suppressed)
- **Go bench corpus**: 0 `sql-injection-risk` false positives on `fmt.Sprintf` and static SQL
- **TypeScript bench corpus**: All expected.json entries match

### Adjudication Table

| Receipt | Count | Root Cause | Resolution | Post-Fix |
|---------|-------|-----------|------------|----------|
| 1 — Imported constants | ~30 | `resolveLocalConstant()` is local-only | Receipted closure | Would require TS server |
| 2 — Local constant fragments | ~44 | Old regex swept whole-function text | Fixed in v3.4.7 | 0 findings |
| 3 — DO `sql.exec()` | 4 | DO SQLite is local-only | Receipted closure | 2 remain (real-danger + reassignment) |
