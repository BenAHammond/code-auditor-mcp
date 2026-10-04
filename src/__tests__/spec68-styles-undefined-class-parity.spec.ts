/**
 * Spec 68 §3.2 — parity: the migrated `styles/undefined-class` rule reproduces
 * the old `UniversalStylesAnalyzer.detectUndefinedClasses` finding exactly.
 *
 * `undefined-class` is the one styles rule that was *index-backed* on two tables
 * (`style_class_usage` + `style_defined_classes`) plus a Tailwind compile-probe.
 * The migrated rule reads the `style-declarations` fact's `classUsage` and the
 * corpus `defined-classes` fact, then resolves candidates through the shared
 * `getTailwindExpander()` singleton with `projectRoot: undefined` — the same
 * config the legacy reducer passed (the probe never initializes), so `resolve()`
 * degrades to the user's `tailwindClasses` custom-set + bare utilities +
 * structural patterns on both paths.
 *
 * The parity test seeds the two tables (plus one `style_declarations` row so the
 * legacy `analyze()` does not early-return), runs the legacy `analyze`, re-reads
 * the same rows into the camelCase facts, and runs `undefinedClassRule.analyze`.
 * It pins the `(file, line, column, rule, severity)` identity multiset — the
 * `severe` near-miss finding only. The off-ladder `undefined-class-not-found`
 * diagnostic has no `Finding` shape on the phase path, so a genuinely-undefined
 * class with no near-miss is a zero-finding case on BOTH paths (the legacy
 * diagnostic is asserted elsewhere).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { UniversalStylesAnalyzer } from '../analyzers/universal/UniversalStylesAnalyzer.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { resetTailwindExpander } from '../styles/tailwindUtilityExpander.js';
import { CORPUS_PRODUCERS } from '../phase/producers.js';
import { undefinedClassRule } from '../phase/rules/styles.js';
import type { Finding, StylesClassUsage } from '../phase/types.js';
import type { Violation } from '../types.js';

let db: CodeIndexDB;
let _usageId = 0;
let _definedId = 0;

/** One class-usage seed — the camelCase fact and the snake_case DB row derive from it. */
interface UsageSeed {
  className: string;
  filePath: string;
  line: number;
  mechanism: 'className' | 'class';
  unresolvable?: boolean;
}

beforeAll(async () => {
  db = CodeIndexDB.getInstance(':memory:');
  await db.initialize();
}, 30_000);

beforeEach(() => {
  db.rawSql.exec('DELETE FROM style_class_usage');
  db.rawSql.exec('DELETE FROM style_defined_classes');
  db.rawSql.exec('DELETE FROM style_declarations');
  _usageId = 0;
  _definedId = 0;
  resetTailwindExpander();
});

afterAll(async () => {
  await CodeIndexDB.getInstance().close();
  resetTailwindExpander();
});

function insertUsage(u: UsageSeed): void {
  db.rawSql.run(
    `INSERT INTO style_class_usage (id, class_name, file_path, line, mechanism, unresolvable)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [++_usageId, u.className, u.filePath, u.line, u.mechanism, u.unresolvable ? 1 : 0],
  );
}

function insertDefined(className: string, filePath: string): void {
  db.rawSql.run(
    `INSERT INTO style_defined_classes (id, class_name, file_path) VALUES (?, ?, ?)`,
    [++_definedId, className, filePath],
  );
}

/** One declaration so the legacy `analyze()` does not early-return on an empty index. */
function insertMinimalDeclaration(): void {
  db.rawSql.run(
    `INSERT INTO style_declarations
      (id, property, raw_value, normalized_value, mechanism, file_path, line, context, variant_context, token_ref, content_hash)
     VALUES (1, 'color', 'red', NULL, 'css', 'seed.css', 1, NULL, NULL, NULL, 'hash-seed')`,
  );
}

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** Run the legacy detector and the new rule, return the `styles/undefined-class` multisets. */
async function parity(usages: UsageSeed[], defined: Array<{ className: string; filePath: string }>, tailwindClasses?: string[]): Promise<{ old: string[]; nu: string[]; fresh: Finding[] }> {
  for (const u of usages) insertUsage(u);
  for (const d of defined) insertDefined(d.className, d.filePath);
  insertMinimalDeclaration();

  // Legacy: query the index and run the full detector set, then keep only the
  // undefined-class finding (other detectors may fire on the seed declaration, but
  // they are not the rule under test).
  const analyzer = new UniversalStylesAnalyzer();
  const legacy = await analyzer.analyze(['page.tsx', 'a.css'], { indexHandle: db.indexHandle, tailwindClasses });
  const old = legacy.violations
    .filter((v: Violation) => v.rule === 'styles/undefined-class')
    .map((v: Violation) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();

  // Phase: re-read the SAME rows into the camelCase facts and run the rule.
  const usageRows = db.rawSql.query('SELECT class_name, file_path, line, mechanism, unresolvable FROM style_class_usage') as Array<{
    class_name: string;
    file_path: string;
    line: number;
    mechanism: string;
    unresolvable: number;
  }>;
  const classUsage: StylesClassUsage[] = usageRows.map((r) => ({
    className: r.class_name,
    filePath: r.file_path,
    line: r.line,
    mechanism: r.mechanism as 'className' | 'class',
    unresolvable: !!r.unresolvable,
  }));
  // Item 4 2b — `defined-classes` is now derived from the `style-declarations`
  // phase fact (declaration selector `context` → class name, the same regex the
  // legacy `style_defined_classes` writers used). Seed the fact's declarations
  // with the class names in their `context`, mirroring what the real producer
  // emits for a stylesheet, and pass that as the producer's upstream fact.
  const declarations = defined.map((d) => ({
    property: 'color',
    rawValue: 'red',
    normalizedValue: null,
    mechanism: 'css',
    filePath: d.filePath,
    line: 1,
    context: `.${d.className}`,
    variantContext: null,
    tokenRef: null,
  }));
  const definedClasses = CORPUS_PRODUCERS['defined-classes'].process(
    { 'style-declarations': [{ declarations, tokens: [], classUsage: [] }] },
    { indexHandle: db.indexHandle },
  );

  const fresh = (await undefinedClassRule.analyze({
    facts: {
      'style-declarations': [{ declarations: [], tokens: [], classUsage }],
      'defined-classes': definedClasses,
    },
    formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'],
    thresholds: tailwindClasses ? { tailwindClasses } : {},
  })) as readonly Finding[];

  const nu = fresh
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();

  return { old, nu, fresh: fresh as Finding[] };
}

describe('Spec 68 styles parity (new undefined-class analyze(ctx) === old detectUndefinedClasses)', () => {
  it('flags a near-miss typo as a severe finding, anchored at the usage site', async () => {
    const { old, nu, fresh } = await parity(
      [{ className: 'btn-primry', filePath: 'page.tsx', line: 5, mechanism: 'className' }],
      [{ className: 'btn-primary', filePath: 'a.css' }],
    );
    expect(nu).toEqual(old);
    expect(nu).toEqual(['page.tsx:5:1:styles/undefined-class:severe']);
    expect(fresh[0]).toMatchObject({
      ruleId: 'styles/undefined-class',
      severity: 'severe',
      symbol: 'btn-primry',
      resolution: {
        action: 'use-defined-class',
        symbols: ['btn-primary'],
        files: ['page.tsx', 'a.css'],
        lines: [5],
      },
    });
  });

  it('emits no finding for a genuinely-undefined class with no near-miss (coverage gap)', async () => {
    const { old, nu, fresh } = await parity(
      [{ className: 'totally-unrelated', filePath: 'page.tsx', line: 7, mechanism: 'className' }],
      [{ className: 'btn-primary', filePath: 'a.css' }],
    );
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
    expect(fresh).toEqual([]);
  });

  it('skips a defined class (no finding)', async () => {
    const { old, nu } = await parity(
      [{ className: 'btn-primary', filePath: 'page.tsx', line: 3, mechanism: 'className' }],
      [{ className: 'btn-primary', filePath: 'a.css' }],
    );
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('skips a CSS selector (mechanism "class" in a .css file) — a definition, not a usage', async () => {
    const { old, nu } = await parity(
      [{ className: 'some-new-selector', filePath: 'b.css', line: 2, mechanism: 'class' }],
      [{ className: 'btn-primary', filePath: 'a.css' }],
    );
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('resolves a class in the tailwindClasses custom set before near-miss (no finding)', async () => {
    // `btn-primry` is a distance-1 near-miss of the defined `btn-primary`, but it
    // is also in the user's `tailwindClasses` custom set — `resolve()` short-circuits
    // to valid before the suggester runs, on both paths.
    const { old, nu } = await parity(
      [{ className: 'btn-primry', filePath: 'page.tsx', line: 5, mechanism: 'className' }],
      [{ className: 'btn-primary', filePath: 'a.css' }],
      ['btn-primry'],
    );
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('skips an unresolvable usage', async () => {
    const { old, nu } = await parity(
      [{ className: 'btn-primry', filePath: 'page.tsx', line: 5, mechanism: 'className', unresolvable: true }],
      [{ className: 'btn-primary', filePath: 'a.css' }],
    );
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('de-duplicates repeated (class, file) usage pairs to one candidate', async () => {
    const { old, nu } = await parity(
      [
        { className: 'btn-primry', filePath: 'page.tsx', line: 5, mechanism: 'className' },
        { className: 'btn-primry', filePath: 'page.tsx', line: 6, mechanism: 'className' },
      ],
      [{ className: 'btn-primary', filePath: 'a.css' }],
    );
    expect(nu).toEqual(old);
    expect(nu).toEqual(['page.tsx:5:1:styles/undefined-class:severe']);
  });
});
