# code-auditor-mcp@3.4.1 — Audit Triage

2026-07-24 against recall-protocol (8,160 findings across 6 analyzers).

## Summary

| Analyzer | Findings | Real | False Positive | Verdict |
|----------|----------|------|----------------|---------|
| styles | 4,394 | ~400 (9%) | ~3,994 (91%) | mostly false |
| data-access | 2,478 | ~1,200 (48%) | ~1,278 (52%) | mixed |
| solid | 1,066 | ~1,066 (100%) | 0 | real |
| conventions | 216 | ~50 (23%) | ~166 (77%) | mostly false |
| cross-domain | 34 | ~30 (88%) | ~4 (12%) | real (acknowledged external) |
| dry | 6 | ~6 (100%) | 0 | real |
| **Total** | **8,160** | **~1,750 (21%)** | **~6,410 (79%)** | |

---

## Real issues (~1,750)

### SOLID (1,066) — warning, 100% real

Honest code metrics. Three sub-rules:

1. **Function too long (>50 lines)** — ~1,050 findings. 170 scripts with oversized `main()` functions, plus `POST`/`GET`/`PATCH` handlers, `processHero`, `scrapeHeroWikiStats`, etc. Accurate counts — the functions do exceed 50 lines. Whether that matters is a judgment call.

2. **Too many parameters (>4)** — ~13 findings. `markRun(5)`, `postCandidate(5)`, etc. Consider options objects.

3. **Cyclomatic complexity >50** — ~3 findings. `main()` at 51.

### Data-access (mixed) — ~1,200 real

- **N+1 query-in-loop** — ~250 findings. `hero-data-agent.ts` has 8 hits. Batch queries or joins where practical.
- **Unfiltered queries on real tables** — `stadium_builds` (116), `heroes` (207), `hero_strategies` (34). Full-table scans without WHERE — real performance concern, though many are in scripts that intentionally iterate.
- **Missing tenant filter on `users`** — 32 findings. Read operations on users table without org/tenant scope.

### DRY (6) — suggestion, likely all real

15-27 line duplicate blocks in: `AddBlockPopover.tsx`, `chip-catalog.ts`, `hero-reference-data.ts`, `publish-moderation.ts`, `wiki/parser.ts`, `regenerate-build-prose.ts`. Worth extracting.

### Cross-domain (~30 of 34) — suggestion, real but acknowledged

Tables read but never written (or written but never read) within the TypeScript source. These are tables populated/consumed by cron workers, migration scripts, SSG queries, or external systems. The tool's message says "This may be an external/managed table" — correctly scoped.

---

## False positives → code-auditor bugs (~6,410)

### Bug 1: Tailwind classes flagged as undefined-class (2,837 findings)

Standard Tailwind utilities (`rounded-xl`, `font-semibold`, `mb-2`, `px-4`, `py-2`, `text-xs`, `space-y-2`, `whitespace-pre-wrap`, `bg-accent-orange`, `text-text-secondary`, `bg-bg-secondary`, `border-border-default`, `font-heading`) all flagged as "no matching definition in any stylesheet or Tailwind utility set."

The style index either doesn't scan `tailwind.config` for safelist/content globs, or its bundled Tailwind utility class dictionary is missing classes. `rounded-xl` is a core Tailwind class — it should never be flagged.

**Fix:** Parse the project's Tailwind config (`tailwind.config.{js,ts,mjs}`) to discover content paths and safelist patterns. At minimum, seed the utility class dictionary with the full Tailwind default set (~3,000 classes).

### Bug 2: Token definitions flagged as token-bypass (217 findings in frosted-prism.css alone)

`frosted-prism.css` is the design token DEFINITION file. Every flagged line is a `--custom-property: <hex-value>;` declaration that DEFINES what the token resolves to. Examples:

- Line 58: `--accent: #22d3ee;` → flagged as bypass because `#22d3ee` "matches `--brand-action`"
- Line 67: `--brand-deep: #2fd0ee;` → flagged because `#2fd0ee` "matches `--footer-accent`"

These are deliberately aliased to the same iridescent cyan (the file comment says: "Back-compat: collapse the old four-role accent system into the single iridescent identity"). The token-bypass analyzer needs to recognize `--x: <value>` as a definition site and skip it, or at minimum skip files that are dominated by `--var:` declarations.

### Bug 3: Semantic `var(--token)` flagged as bypassing `var(--other-token)` (~1,000 findings)

The tool does color-value-matching between CSS custom properties. When `var(--surface-raised)` resolves to the same hex as `--bg-secondary`, it says "use the canonical token instead." But these are semantically different custom properties:

- `--surface-raised` = "raised surface" (a role/elevation)
- `--bg-secondary` = "secondary background" (a color value)

Using semantic tokens IS the token system. The purpose of CSS custom properties is abstraction — different semantic roles can resolve to the same color. Only raw hex values (not `var()` references) should be flagged as token bypasses.

**Fix:** Ignore `var(--*)` references entirely during token-bypass checks. Only flag literal color values (`#rrggbb`, `rgb()`, `hsl()`) that match a token definition.

### Bug 4: value-drift on categorical CSS properties (~130 of 147)

`display: inline` flagged as "rare (1 of 937 usages, 0.1%), dominant is flex (617 uses)" — but `inline` and `flex` are semantically different layout modes. `align-items: stretch` vs `center` serve different purposes. Statistical rarity isn't drift for categorical properties.

The detector should exclude categorical properties entirely: `display`, `position`, `flex-direction`, `align-items`, `justify-content`, `text-align`, `overflow`, `white-space`, `cursor`, `pointer-events`, `visibility`, `box-sizing`, `text-transform`, `font-style`, `font-weight` (variable font ranges break this too), `object-fit`, `mix-blend-mode`.

### Bug 5: JavaScript identifiers parsed as SQL keywords (~120 of data-access)

"Potential SQL injection risk in `map`" — that's `Array.map()`. "in `lower`" — `String.toLowerCase()`. "in `is`" — JavaScript expression. "in `escape`" — regex escaping. "Unfiltered query on `the`" — variable name, not a table. "Unfiltered query on `SET`" — SQL keyword, not a table name. "Unfiltered query on `prior`" — variable name.

The SQL parser is scanning TypeScript source code and treating generic JavaScript function calls as SQL identifiers/hazards.

**Fix:** Restrict SQL analysis to `.sql` files and `db.prepare()`/`db.exec()`/template-literal call sites. Don't scan arbitrary JavaScript lines as SQL.

### Bug 6: SQL alias `t` parsed as table name (1 finding)

`Table 't' is read (SELECT) but never written` — `FROM some_table AS t` alias parsed as a standalone table reference.

### Bug 7: Convention mining treats all exports as one population (~200 findings)

**usage-pair** (141): "91% of `arg.slice` callers also call `trim`" — whether you trim depends on what you're slicing. "94% of `args.find` callers also call `a.startsWith`" — depends on search pattern. "92% of `readFile` callers also call `JSON.parse`" — not all files are JSON. Statistical co-occurrence ≠ convention. The signal-to-noise ratio makes this analyzer unsafe to act on.

**naming** (26): Treats all exports in a directory as one population. `submit()` (a function) flagged as non-PascalCase in a component directory where 96% are PascalCase components. `StrategistProvider` (a React context component) flagged as non-camelCase in a hooks directory. Needs to distinguish: component exports → PascalCase, function exports → camelCase, constant exports → UPPER_SNAKE, hook exports → camelCase with `use` prefix. These are universal React/TypeScript conventions — not per-directory statistics.

**error-handling** (49): Actually our best convention analyzer — accurately detects `promise-catch`, `go-style`, and `if-err` deviations from the dominant `try-catch`. These are real deviations, but suggestion severity is correct (they may be intentional).

---

## Validation against v3.4.0 bugs

| v3.4.0 Bug | v3.4.1 Status |
|------------|---------------|
| style-index sync crash (`Cannot read properties of undefined (reading 'prepare')`) | **FIXED** — syncs 1,335 files cleanly |
| Hotspots producing no data | **FIXED** — 1,401 hotspots with scores |
| `generate-config --tool claude` in SKILL.md | **FIXED** in shipped package (CLEAN); rooted in stale installed copy (dual-copy architecture gap) |
| Fingerprint migration 3.4.0→3.4.1 | **WORKED** — one re-baseline resolved 4,610 "new" → 0 |

### Post-release gap identified

The skills dual-copy architecture means `npm install -g` upgrades the tarball but doesn't refresh `~/.claude/skills/code-auditor/SKILL.md`. The fix (`code-audit install --agent claude`) works but is not automatic. Consider: auto-detect version bump on next `code-audit` run and print a one-line reminder to re-run `install --agent <name>`.
