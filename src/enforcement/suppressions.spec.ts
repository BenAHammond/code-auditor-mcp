/**
 * Spec 36 R7 — suppressions decay. A directive carries a required reason; an
 * unnecessary directive (finding no longer fires) and a reasonless directive
 * are both errors. A matched directive suppresses the finding without hiding
 * it from the report.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSuppressionDirectives,
  applySuppressions,
} from './suppressions.js';
import type { Violation } from '../types.js';

function v(partial: Partial<Violation> & { rule: string }): Violation {
  return { file: 'src/a.ts', severity: 'critical', message: 'm', ...partial } as Violation;
}

describe('parseSuppressionDirectives — Spec 36 R7', () => {
  it('parses a disable-next-line directive with a reason', () => {
    const src = [
      'const x = 1;',
      '// code-audit-disable-next-line sql-injection-risk -- input is bind-parameterized',
      'db.query("SELECT " + user);',
    ].join('\n');
    const dirs = parseSuppressionDirectives('src/a.ts', src);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatchObject({
      rule: 'sql-injection-risk',
      kind: 'disable-next-line',
      targetLine: 3,
      reason: 'input is bind-parameterized',
    });
  });

  it('parses a disable-line directive targeting its own line', () => {
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      'db.query(x); // code-audit-disable-line sql-injection-risk -- false positive\n',
    );
    expect(dirs).toHaveLength(1);
    expect(dirs[0].targetLine).toBe(1);
    expect(dirs[0].kind).toBe('disable-line');
  });

  it('ignores the directive when it is inside a string literal, not a comment', () => {
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      'const s = "code-audit-disable-next-line sql-injection-risk -- not a comment";\n',
    );
    expect(dirs).toHaveLength(0);
  });

  it('ignores a // marker inside a single-quoted string literal (near-miss)', () => {
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      "const s = '// code-audit-disable-next-line sql-injection-risk -- not a comment';\n",
    );
    expect(dirs).toHaveLength(0);
  });

  it('ignores a // marker inside a backtick string literal (near-miss)', () => {
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      'const s = `// code-audit-disable-next-line sql-injection-risk -- not a comment`;\n',
    );
    expect(dirs).toHaveLength(0);
  });

  it('still finds a real comment after a string literal on the same line', () => {
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      'const s = "// not a comment"; // code-audit-disable-next-line sql-injection-risk -- real\n',
    );
    expect(dirs).toHaveLength(1);
    expect(dirs[0].rule).toBe('sql-injection-risk');
  });

  it('captures a missing reason as an empty string', () => {
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      '// code-audit-disable-next-line sql-injection-risk\n',
    );
    expect(dirs).toHaveLength(1);
    expect(dirs[0].reason).toBe('');
  });
});

describe('applySuppressions — Spec 36 R7', () => {
  const finding = v({ rule: 'sql-injection-risk', line: 3 });

  it('suppresses a matched finding and leaves the reason on it', () => {
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      [
        'const x = 1;',
        '// code-audit-disable-next-line sql-injection-risk -- x',
        'db.query(user);',
      ].join('\n'),
    );
    const result = applySuppressions([finding], dirs);
    expect(result.suppressed).toHaveLength(1);
    expect(result.remaining).toHaveLength(0);
    expect((result.suppressed[0] as any).suppressed).toBe(true);
    expect((result.suppressed[0] as any).suppressionReason).toBe('x');
  });

  it('flags a directive whose finding no longer fires as unnecessary', () => {
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      '// code-audit-disable-next-line sql-injection-risk -- x\n',
    );
    // The finding is at line 3; the directive targets line 2 → no match.
    const result = applySuppressions([v({ rule: 'sql-injection-risk', line: 3 })], dirs);
    expect(result.unnecessary).toHaveLength(1);
    expect(result.remaining).toHaveLength(1);
  });

  it('flags a directive with no reason as reasonless', () => {
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      '// code-audit-disable-next-line sql-injection-risk\n',
    );
    const result = applySuppressions([finding], dirs);
    expect(result.reasonless).toHaveLength(1);
  });

  it('does not suppress a different rule at the same line', () => {
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      [
        'const x = 1;',
        '// code-audit-disable-next-line unknown-table -- x',
        'db.query(user);',
      ].join('\n'),
    );
    const result = applySuppressions([finding], dirs);
    expect(result.suppressed).toHaveLength(0);
    expect(result.unnecessary).toHaveLength(1);
  });

  it('matches through a rule rename via the alias map', () => {
    // naming-convention → table-naming-convention. A directive written against
    // the old ID still suppresses the renamed rule's finding.
    const dirs = parseSuppressionDirectives(
      'src/a.ts',
      '// code-audit-disable-next-line naming-convention -- legacy\n',
    );
    const result = applySuppressions(
      [v({ rule: 'table-naming-convention', line: 2 })],
      dirs,
    );
    expect(result.suppressed).toHaveLength(1);
  });
});
