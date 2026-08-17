import { describe, it, expect } from 'vitest';
import { buildCoverageReport, makeVisitorStatus, makeReducerStatus } from '../pipeline.js';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';
import type { AnalyzerResult, PipelineConfig, RuleCoverage, Violation, AnalyzerNotRunStatus } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNotRunStatus(reason: string): AnalyzerNotRunStatus {
  return { status: 'notRun', reason };
}

function makeConfigWith(names: string[]): PipelineConfig {
  const config: Record<string, Record<string, unknown>> = {};
  for (const name of names) config[name] = {};
  return { projectRoot: '/test', config };
}

function makeViolation(rule: string, overrides: Partial<Violation> = {}): Violation {
  return {
    rule,
    message: `Violation: ${rule}`,
    severity: 'warning',
    file: '/test/file.ts',
    line: 1,
    analyzer: 'solid',
    ...overrides,
  } as Violation;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildCoverageReport', () => {
  it('skips rules whose analyzer is not in config', () => {
    const coverage = buildCoverageReport(
      {},
      makeConfigWith([]), // no analyzers configured
    );
    expect(coverage).toHaveLength(0);
  });

  it('reports notApplicable when analyzer not in results', () => {
    const coverage = buildCoverageReport(
      {},
      makeConfigWith(['solid']),
    );
    expect(coverage.length).toBeGreaterThan(0);
    for (const c of coverage) {
      expect(c.state).toBe('notApplicable');
      expect(c.reason).toContain('not in results');
    }
  });

  it('reports notApplicable for all rules when analyzer is notRun', () => {
    const results: Record<string, AnalyzerResult> = {
      solid: {
        violations: [],
        executionTime: 0,
        analyzerName: 'solid',
        status: makeNotRunStatus('invariants disabled — no rules configured'),
      },
    };

    const coverage = buildCoverageReport(
      results,
      makeConfigWith(['solid']),
    );

    const solidRules = coverage.filter(c => c.analyzer === 'solid');
    expect(solidRules.length).toBeGreaterThan(0);
    for (const c of solidRules) {
      expect(c.state).toBe('notApplicable');
      expect(c.count).toBe(0);
      expect(c.reason).toContain('invariants disabled');
    }
  });

  it('reports notApplicable when visitor processed zero files', () => {
    const results: Record<string, AnalyzerResult> = {
      solid: {
        violations: [],
        executionTime: 0,
        analyzerName: 'solid',
        status: makeVisitorStatus(0),
      },
    };

    const coverage = buildCoverageReport(
      results,
      makeConfigWith(['solid']),
    );

    const solidRules = coverage.filter(c => c.analyzer === 'solid');
    expect(solidRules.length).toBeGreaterThan(0);
    for (const c of solidRules) {
      expect(c.state).toBe('notApplicable');
      expect(c.reason).toBe('no matching source files');
    }
  });

  it('reports notApplicable when reducer consumed zero facts', () => {
    const results: Record<string, AnalyzerResult> = {
      conventions: {
        violations: [],
        executionTime: 0,
        analyzerName: 'conventions',
        status: makeReducerStatus(0),
      },
    };

    const coverage = buildCoverageReport(
      results,
      makeConfigWith(['conventions']),
    );

    const conventionRules = coverage.filter(c => c.analyzer === 'conventions');
    expect(conventionRules.length).toBeGreaterThan(0);
    for (const c of conventionRules) {
      expect(c.state).toBe('notApplicable');
      expect(c.reason).toBe('no facts consumed from upstream visitors');
    }
  });

  it('reports fired when violations match a rule', () => {
    const results: Record<string, AnalyzerResult> = {
      solid: {
        violations: [
          makeViolation('solid/class-size'),
          makeViolation('solid/class-size'),
          makeViolation('solid/method-complexity'),
        ],
        executionTime: 0,
        analyzerName: 'solid',
        status: makeVisitorStatus(10),
      },
    };

    const coverage = buildCoverageReport(
      results,
      makeConfigWith(['solid']),
    );

    const classSize = coverage.find(c => c.ruleId === 'solid/class-size');
    expect(classSize).toBeDefined();
    expect(classSize!.state).toBe('fired');
    expect(classSize!.count).toBe(2);

    const methodComplexity = coverage.find(c => c.ruleId === 'solid/method-complexity');
    expect(methodComplexity).toBeDefined();
    expect(methodComplexity!.state).toBe('fired');
    expect(methodComplexity!.count).toBe(1);

    // Rules with no violations but `files` input present should be clean
    const ocp = coverage.find(c => c.ruleId === 'solid/open-closed');
    expect(ocp).toBeDefined();
    expect(ocp!.state).toBe('clean');
  });

  it('reports clean when analyzer ran with files input but zero violations', () => {
    const results: Record<string, AnalyzerResult> = {
      solid: {
        violations: [],
        executionTime: 0,
        analyzerName: 'solid',
        status: makeVisitorStatus(10),
      },
    };

    const coverage = buildCoverageReport(
      results,
      makeConfigWith(['solid']),
    );

    const solidRules = coverage.filter(c => c.analyzer === 'solid');
    expect(solidRules.length).toBeGreaterThan(0);
    for (const c of solidRules) {
      expect(c.state).toBe('clean');
      expect(c.count).toBe(0);
    }
  });

  it('produces mixed states across multiple enabled analyzers', () => {
    const results: Record<string, AnalyzerResult> = {
      solid: {
        violations: [makeViolation('solid/class-size')],
        executionTime: 0,
        analyzerName: 'solid',
        status: makeVisitorStatus(10),
      },
      dry: {
        violations: [],
        executionTime: 0,
        analyzerName: 'dry',
        status: makeVisitorStatus(5),
      },
      react: {
        violations: [],
        executionTime: 0,
        analyzerName: 'react',
        status: makeNotRunStatus('no React files found'),
      },
    };

    const coverage = buildCoverageReport(
      results,
      makeConfigWith(['solid', 'dry', 'react']),
    );

    // fired
    const classSize = coverage.find(c => c.ruleId === 'solid/class-size');
    expect(classSize!.state).toBe('fired');
    expect(classSize!.count).toBe(1);

    // clean (dry ran with files but no violations)
    const duplicates = coverage.filter(c => c.analyzer === 'dry' && c.state === 'clean');
    expect(duplicates.length).toBeGreaterThan(0);

    // notApplicable (react notRun)
    const reactRules = coverage.filter(c => c.analyzer === 'react');
    expect(reactRules.length).toBeGreaterThan(0);
    for (const c of reactRules) {
      expect(c.state).toBe('notApplicable');
    }
  });

  it('classifies dependency-graph rules using type field', () => {
    const results: Record<string, AnalyzerResult> = {
      'dependency-graph': {
        violations: [
          {
            rule: '',
            message: 'Circular dependency found',
            severity: 'warning',
            file: '/test/file.ts',
            line: 1,
            analyzer: 'dependency-graph',
            type: 'circular-dependency',
          } as unknown as Violation,
          {
            rule: '',
            message: 'Orphaned node',
            severity: 'warning',
            file: '/test/file.ts',
            line: 2,
            analyzer: 'dependency-graph',
            type: 'orphaned-nodes',
          } as unknown as Violation,
        ],
        executionTime: 0,
        analyzerName: 'dependency-graph',
        status: makeReducerStatus(20),
      },
    };

    const coverage = buildCoverageReport(
      results,
      makeConfigWith(['dependency-graph']),
    );

    const circular = coverage.find(c => c.ruleId === 'circular-dependency');
    expect(circular!.state).toBe('fired');
    expect(circular!.count).toBe(1);

    const orphaned = coverage.find(c => c.ruleId === 'orphaned-nodes');
    expect(orphaned!.state).toBe('fired');
    expect(orphaned!.count).toBe(1);

    // Other dep-graph rules should be unassessed
    const tightCoupling = coverage.find(c => c.ruleId === 'tight-coupling');
    expect(tightCoupling!.state).toBe('unassessed');
  });

  it('covers every rule in RULE_REGISTRY when all analyzers are configured and run', () => {
    // Build results for every analyzer in the registry
    const analyzerNames = [...new Set(Object.values(RULE_REGISTRY).map(e => e.analyzer))];
    const config = makeConfigWith(analyzerNames);

    const results: Record<string, AnalyzerResult> = {};
    for (const name of analyzerNames) {
      results[name] = {
        violations: [],
        executionTime: 0,
        analyzerName: name,
        // Use visitor status for all — some analyzers (conventions, cross-domain, etc.)
        // are actually reducers, but for coverage logic the path after filesProcessed>0
        // is the same: they'll be unassessed.
        status: makeVisitorStatus(1),
      };
    }

    const coverage = buildCoverageReport(results, config);

    // Every rule in the registry should appear in coverage
    const registeredRuleIds = Object.keys(RULE_REGISTRY);
    const coveredRuleIds = new Set(coverage.map(c => c.ruleId));

    for (const ruleId of registeredRuleIds) {
      expect(coveredRuleIds.has(ruleId)).toBe(true);
    }

    expect(coverage.length).toBe(registeredRuleIds.length);
  });

  it('reports config-disabled rules as notApplicable via configGate', () => {
    const config: PipelineConfig = {
      projectRoot: '/test',
      config: {
        dry: {
          checkStructuralSimilarity: false,
          checkStrings: true,
          checkImports: false,
        },
        react: {
          requirePropTypes: true,
        },
      },
    };

    // dry ran with input (files processed > 0)
    const results: Record<string, AnalyzerResult> = {
      dry: {
        violations: [],
        executionTime: 0,
        analyzerName: 'dry',
        status: makeVisitorStatus(5),
      },
      react: {
        violations: [],
        executionTime: 0,
        analyzerName: 'react',
        status: makeVisitorStatus(10),
      },
    };

    const coverage = buildCoverageReport(results, config);

    // checkStructuralSimilarity: false → notApplicable
    const structSim = coverage.find(c => c.ruleId === 'dry/structural-similarity');
    expect(structSim!.state).toBe('notApplicable');
    expect(structSim!.reason).toContain('checkStructuralSimilarity');

    // checkImports: false → notApplicable
    const dupImport = coverage.find(c => c.ruleId === 'duplicate-import');
    expect(dupImport!.state).toBe('notApplicable');
    expect(dupImport!.reason).toContain('checkImports');

    // checkStrings: true → not config-gated → clean (files input present, no violations)
    const dupString = coverage.find(c => c.ruleId === 'duplicate-string-literal');
    expect(dupString!.state).toBe('clean');

    // dry/duplicate has no configGate → clean
    const dryDup = coverage.find(c => c.ruleId === 'dry/duplicate');
    expect(dryDup!.state).toBe('clean');

    // requirePropTypes: true → not config-gated → clean
    const missingProps = coverage.find(c => c.ruleId === 'missing-props');
    expect(missingProps!.state).toBe('clean');
  });

  it('emits clean when a rule mapped to files input has zero violations', () => {
    const results: Record<string, AnalyzerResult> = {
      solid: {
        violations: [],
        executionTime: 0,
        analyzerName: 'solid',
        status: makeVisitorStatus(10),
      },
    };

    const coverage = buildCoverageReport(
      results,
      makeConfigWith(['solid']),
    );

    const cleanEntries = coverage.filter(c => c.state === 'clean');
    expect(cleanEntries.length).toBeGreaterThan(0);
    for (const c of coverage) {
      expect(c.state).toBe('clean');
    }
  });

  it('promotes a fact-key rule to clean when its input is present', () => {
    const results: Record<string, AnalyzerResult> = {
      schema: {
        violations: [],
        executionTime: 0,
        analyzerName: 'schema',
        status: makeReducerStatus(3),
      },
    };

    // schema-code fact key present → sql-injection rule should be clean
    const coverage = buildCoverageReport(
      results,
      makeConfigWith(['schema']),
      { factKeys: ['schema-code'], indexTables: [] },
    );

    const sqlInjection = coverage.find(c => c.ruleId === 'sql-injection');
    expect(sqlInjection!.state).toBe('clean');

    // JSON rules have schema-json input, which is absent → notApplicable
    const invalidJson = coverage.find(c => c.ruleId === 'invalid-json');
    expect(invalidJson!.state).toBe('notApplicable');
    expect(invalidJson!.reason).toContain('schema-json');
  });

  it('promotes an index-table rule to clean only when its table has rows', () => {
    const results: Record<string, AnalyzerResult> = {
      'cross-domain': {
        violations: [],
        executionTime: 0,
        analyzerName: 'cross-domain',
        status: makeReducerStatus(10),
      },
    };

    const absent = buildCoverageReport(
      results,
      makeConfigWith(['cross-domain']),
      { factKeys: [], indexTables: [] },
    );
    const uncoveredAbsent = absent.find(c => c.ruleId === 'cross-domain/uncovered-risk');
    expect(uncoveredAbsent!.state).toBe('notApplicable');

    const present = buildCoverageReport(
      results,
      makeConfigWith(['cross-domain']),
      { factKeys: [], indexTables: ['schema_usage'] },
    );
    const uncoveredPresent = present.find(c => c.ruleId === 'cross-domain/uncovered-risk');
    expect(uncoveredPresent!.state).toBe('clean');
  });

  it('keeps rules with no input mapping as unassessed', () => {
    const results: Record<string, AnalyzerResult> = {
      'schema-validator': {
        violations: [],
        executionTime: 0,
        analyzerName: 'schema-validator',
        status: makeReducerStatus(1),
      },
    };

    const coverage = buildCoverageReport(
      results,
      makeConfigWith(['schema-validator']),
      { factKeys: [], indexTables: [] },
    );

    for (const c of coverage) {
      expect(c.state).toBe('unassessed');
    }
  });
});
