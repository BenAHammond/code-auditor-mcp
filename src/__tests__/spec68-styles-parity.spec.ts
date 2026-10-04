/**
 * Spec 68 §3.2 — parity: the migrated styles rules reproduce the old
 * `UniversalStylesAnalyzer`'s findings exactly.
 *
 * The styles analyzer is the one migrated analyzer that was *index-backed* in the
 * legacy pipeline: it queried `style_declarations` + `style_tokens` from SQLite
 * rather than walking an AST per file. So the parity test seeds those two tables
 * in an in-memory `CodeIndexDB`, runs the legacy `analyze(files, { indexHandle })`,
 * then re-reads the *same* rows (in the legacy query's `ORDER BY property,
 * file_path, line` order) and converts them to the camelCase
 * `StyleDeclarationsFile` fact the new rules read. The rule half is what is
 * pinned — same file, line, column, rule, severity — on the full multiset.
 *
 * `undefined-class` (severity 'severe') is deliberately absent from the migrated
 * slice: it reads `classUsage` + a defined-class catalog + a Tailwind probe, none
 * of which is a pure function of the `style-declarations` fact. It is DEFERRED
 * and stays on the legacy path; the eight rules here are the pure-data ones.
 *
 * The seed exercises all eight rules at once and asserts the per-rule identity
 * multisets are equal and non-empty, so a rule that silently stops firing (or a
 * detector that starts double-firing) turns the pin red.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { UniversalStylesAnalyzer } from '../analyzers/universal/UniversalStylesAnalyzer.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { resetTailwindExpander } from '../styles/tailwindUtilityExpander.js';
import { normalizeValue } from '../styles/normalizer.js';
import { analyzeStyles } from '../phase/runner.js';
import { stylesRules } from '../phase/rules/styles.js';
import type { StyleDeclarationsFile, StylesDeclaration, StylesToken } from '../phase/types.js';
import type { Violation } from '../types.js';

let db: CodeIndexDB;
let _declId = 0;
let _tokenId = 0;

/** A declaration seed — the camelCase fact and the snake_case DB row derive from it. */
interface Seed {
  property: string;
  rawValue: string;
  mechanism: string;
  filePath: string;
  line: number;
  context?: string | null;
  tokenRef?: string | null;
}

beforeAll(async () => {
  db = CodeIndexDB.getInstance(':memory:');
  await db.initialize();
}, 30_000);

beforeEach(() => {
  db.rawSql.exec('DELETE FROM style_declarations');
  db.rawSql.exec('DELETE FROM style_tokens');
  db.rawSql.exec('DELETE FROM style_class_usage');
  db.rawSql.exec('DELETE FROM style_defined_classes');
  _declId = 0;
  _tokenId = 0;
});

afterAll(async () => {
  await CodeIndexDB.getInstance().close();
  resetTailwindExpander();
});

function insertDecl(s: Seed): void {
  const normalized = normalizeValue(s.rawValue, s.property);
  db.rawSql.run(
    `INSERT INTO style_declarations
      (id, property, raw_value, normalized_value, mechanism, file_path, line, context, variant_context, token_ref, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ++_declId,
      s.property,
      s.rawValue,
      normalized ? JSON.stringify(normalized) : null,
      s.mechanism,
      s.filePath,
      s.line,
      s.context ?? null,
      null,
      s.tokenRef ?? null,
      `hash-${_declId}`,
    ],
  );
}

function insertToken(name: string, value: string, filePath: string, mechanism: 'css-custom-property' | 'tailwind-theme'): void {
  db.rawSql.run(
    `INSERT INTO style_tokens (id, name, value, file_path, mechanism) VALUES (?, ?, ?, ?, ?)`,
    [++_tokenId, name, value, filePath, mechanism],
  );
}

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** Run the legacy analyzer and the new `analyzeStyles`, return per-rule multisets. */
async function parity(seeds: Seed[]): Promise<Record<string, string[]>> {
  // Seed the DB (the legacy path's only input).
  for (const s of seeds) insertDecl(s);

  // Legacy: query the index and run the full detector set.
  const analyzer = new UniversalStylesAnalyzer();
  const legacy = await analyzer.analyze(['a.css', 'b.css', 'c.css', 'd.css', 'e.css', 'f.css'], { indexHandle: db.indexHandle });

  // Phase: re-read the SAME rows in the legacy query's order and convert to the
  // camelCase fact (so the flattened order — which first-occurrence anchors in
  // color-drift / fragmentation / block-building depend on — is identical).
  const declRows = db.rawSql.query(
    'SELECT property, raw_value, normalized_value, mechanism, file_path, line, context, token_ref ' +
    'FROM style_declarations ORDER BY property, file_path, line',
  ) as Array<{
    property: string;
    raw_value: string;
    normalized_value: string | null;
    mechanism: string;
    file_path: string;
    line: number;
    context: string | null;
    token_ref: string | null;
  }>;
  const tokenRows = db.rawSql.query('SELECT name, value, file_path, mechanism FROM style_tokens') as Array<{
    name: string;
    value: string;
    file_path: string;
    mechanism: 'css-custom-property' | 'tailwind-theme';
  }>;

  const declarations: StylesDeclaration[] = declRows.map((r) => ({
    property: r.property,
    rawValue: r.raw_value,
    normalizedValue: r.normalized_value ? JSON.parse(r.normalized_value) : null,
    mechanism: r.mechanism,
    filePath: r.file_path,
    line: r.line,
    context: r.context,
    variantContext: null,
    tokenRef: r.token_ref,
  }));
  const tokens: StylesToken[] = tokenRows.map((r) => ({
    name: r.name,
    value: r.value,
    filePath: r.file_path,
    mechanism: r.mechanism,
  }));

  const facts: StyleDeclarationsFile[] = [{ declarations, tokens, classUsage: [] }];
  const fresh = await analyzeStyles(facts, {});

  const perRule: Record<string, string[]> = {};
  for (const ruleId of stylesRules.map((r) => r.id)) {
    const old = legacy.violations
      .filter((v: Violation) => v.rule === ruleId)
      .map((v: Violation) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
      .sort();
    const nu = fresh
      .filter((f) => f.ruleId === ruleId)
      .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
      .sort();
    perRule[ruleId] = nu;
    expect(nu, `rule ${ruleId}`).toEqual(old);
  }
  return perRule;
}

/** The eight migrated styles rules, in registry order — the slice under test. */
const RULE_IDS = stylesRules.map((r) => r.id);

describe('Spec 68 styles parity (new analyze(ctx) === old UniversalStylesAnalyzer)', () => {
  it('covers exactly the eight migrated styles rules (undefined-class deferred)', () => {
    expect(RULE_IDS).toEqual([
      'styles/value-drift',
      'styles/off-scale',
      'styles/token-bypass',
      'styles/mechanism-fragmentation',
      'styles/mechanism-mixing',
      'styles/declaration-set-similarity',
      'styles/z-index-sprawl',
      'styles/z-index-singleton',
    ]);
  });

  it('all eight rules fire and match the legacy multiset on a full seed', async () => {
    const seeds: Seed[] = [];

    // value-drift: two near-identical colors (ΔE ≈ 1.59 < 2.5) on `color`.
    seeds.push(
      { property: 'color', rawValue: '#5f7488', mechanism: 'css', filePath: 'a.css', line: 1 },
      { property: 'color', rawValue: '#637688', mechanism: 'css', filePath: 'a.css', line: 2 },
    );

    // token-bypass: a raw color that matches the `colors.brand` token below, no token_ref.
    seeds.push({ property: 'color', rawValue: '#3b82f6', mechanism: 'css', filePath: 'b.css', line: 1 });

    // off-scale: 20 `margin` declarations, 18 on the declared spacing scale and 2 off.
    const onScale = ['4px', '8px', '12px', '16px', '20px'];
    for (let i = 0; i < 18; i++) {
      seeds.push({ property: 'margin', rawValue: onScale[i % onScale.length], mechanism: 'css', filePath: 'c.css', line: i + 1 });
    }
    seeds.push(
      { property: 'margin', rawValue: '13px', mechanism: 'css', filePath: 'c.css', line: 19 },
      { property: 'margin', rawValue: '7px', mechanism: 'css', filePath: 'c.css', line: 20 },
    );

    // mechanism-fragmentation: `padding: 8px` via three mechanisms (and mixing in d.css).
    seeds.push(
      { property: 'padding', rawValue: '8px', mechanism: 'css', filePath: 'd.css', line: 1 },
      { property: 'padding', rawValue: '8px', mechanism: 'inline', filePath: 'd.css', line: 2 },
      { property: 'padding', rawValue: '8px', mechanism: 'scss', filePath: 'd.css', line: 3 },
    );

    // declaration-set-similarity: two contexts, five identical keyword declarations each.
    const blockProps = ['display', 'position', 'overflow', 'float', 'text-align'];
    const blockVals = ['block', 'relative', 'hidden', 'none', 'center'];
    for (let i = 0; i < blockProps.length; i++) {
      seeds.push({ property: blockProps[i], rawValue: blockVals[i], mechanism: 'css', filePath: 'e.css', line: i + 1, context: '.card-a' });
      seeds.push({ property: blockProps[i], rawValue: blockVals[i], mechanism: 'css', filePath: 'e.css', line: i + 10, context: '.card-b' });
    }

    // z-index: 7 distinct values (sprawl), value 1 used twice, 2..7 once (six singletons).
    seeds.push(
      { property: 'z-index', rawValue: '1', mechanism: 'css', filePath: 'f.css', line: 1 },
      { property: 'z-index', rawValue: '1', mechanism: 'css', filePath: 'f.css', line: 2 },
    );
    for (let v = 2; v <= 7; v++) {
      seeds.push({ property: 'z-index', rawValue: String(v), mechanism: 'css', filePath: 'f.css', line: v + 1 });
    }

    // Design tokens: a declared spacing scale (off-scale) + a brand color (token-bypass).
    insertToken('spacing.1', '4px', 'tailwind.config.js', 'tailwind-theme');
    insertToken('spacing.2', '8px', 'tailwind.config.js', 'tailwind-theme');
    insertToken('spacing.3', '12px', 'tailwind.config.js', 'tailwind-theme');
    insertToken('spacing.4', '16px', 'tailwind.config.js', 'tailwind-theme');
    insertToken('spacing.5', '20px', 'tailwind.config.js', 'tailwind-theme');
    insertToken('colors.brand', '#3b82f6', 'tailwind.config.js', 'tailwind-theme');

    const perRule = await parity(seeds);

    for (const ruleId of RULE_IDS) {
      expect(perRule[ruleId].length, `rule ${ruleId} must fire`).toBeGreaterThan(0);
    }
  });

  it('value-drift does NOT fire on a single color (no cluster)', async () => {
    const perRule = await parity([
      { property: 'color', rawValue: '#0f172a', mechanism: 'css', filePath: 'a.css', line: 1 },
    ]);
    expect(perRule['styles/value-drift']).toEqual([]);
  });

  it('off-scale does NOT fire below the usage floor (no declared-scale population)', async () => {
    // One margin declaration, but off the (absent) scale and far below 20 uses.
    const perRule = await parity([
      { property: 'margin', rawValue: '13px', mechanism: 'css', filePath: 'c.css', line: 1 },
    ]);
    expect(perRule['styles/off-scale']).toEqual([]);
  });

  it('token-bypass does NOT fire when the token carries the built-in-defaults path', async () => {
    // A token with `file_path === 'built-in defaults'` is the bundled fallback
    // palette, not a project token — the raw value must not be flagged.
    insertToken('colors.white', '#ffffff', 'built-in defaults', 'tailwind-theme');
    const perRule = await parity([
      { property: 'color', rawValue: '#ffffff', mechanism: 'css', filePath: 'b.css', line: 1 },
    ]);
    expect(perRule['styles/token-bypass']).toEqual([]);
  });
});
