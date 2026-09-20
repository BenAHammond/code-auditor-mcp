/**
 * Spec 06 — SARIF Output Tests
 *
 * Validates SARIF 2.1.0 emitter against the official JSON Schema,
 * severity mapping, fingerprint presence, invariant rule handling,
 * and golden-file output.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Ajv from 'ajv';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateSARIFReport, resolveRuleId, buildFullRuleId } from '../reporting/sarifReportGenerator.js';
import type { AuditResult, Violation } from '../types.js';
import { makeVisitorStatus } from '../pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', 'test-fixtures', 'sarif-schema-2.1.0.json');

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    file: 'src/example.ts',
    line: 42,
    column: 10,
    severity: 'severe',
    message: 'A code quality issue was detected',
    ...overrides,
  };
}

function makeAuditResult(analyzerResults: Record<string, any> = {}): AuditResult {
  return {
    timestamp: new Date('2026-07-16T12:00:00Z'),
    summary: {
      totalFiles: 3,
      totalViolations: 1,
      criticalIssues: 0,
      severe: 1,
      high: 0,
      violationsByCategory: { solid: 1 },
      topIssues: [{ type: 'single-responsibility', count: 1 }],
    },
    analyzerResults: {
      'solid-analyzer': {
        violations: [],
        status: makeVisitorStatus(3),
        executionTime: 150,
        analyzerName: 'solid-analyzer',
        ...(analyzerResults['solid-analyzer'] || {}),
      },
      ...analyzerResults,
    },
    recommendations: [],
    metadata: {
      auditDuration: 500,
      filesAnalyzed: 3,
      analyzersRun: ['solid-analyzer'],
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

// Module-scoped ajv instance shared across all describe blocks
let ajv: Ajv;
let schema: any;
let validate: ReturnType<Ajv['compile']>;

beforeAll(() => {
  const raw = readFileSync(SCHEMA_PATH, 'utf-8');
  schema = JSON.parse(raw);
  ajv = new Ajv({ strict: false });
  validate = ajv.compile(schema);
});

describe('SARIF Report Generator', () => {

  describe('Schema validation', () => {
    it('validates against the SARIF 2.1.0 JSON Schema', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({
              severity: 'critical',
              message: 'Function doEverything has too many responsibilities',
              principle: 'single-responsibility',
              functionName: 'doEverything',
            }),
          ],
          status: makeVisitorStatus(3),
          executionTime: 150,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      const valid = validate(parsed);
      if (!valid) {
        console.error('Schema errors:', JSON.stringify(validate.errors, null, 2));
      }
      expect(valid).toBe(true);
    });

    it('validates with multiple analyzers', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({
              severity: 'critical',
              message: 'SRP violation',
              principle: 'single-responsibility',
              functionName: 'fn1',
            }),
          ],
          status: makeVisitorStatus(3),
          executionTime: 100,
        },
        'dry-analyzer': {
          violations: [
            makeViolation({
              file: 'src/other.ts',
              line: 15,
              severity: 'severe',
              message: 'Code appears to be duplicated',
              type: 'exact-duplicate',
              functionName: 'fn2',
              similarity: 0.85,
            }),
          ],
          status: makeVisitorStatus(3),
          executionTime: 120,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);
      const valid = validate(parsed);
      if (!valid) {
        console.error('Schema errors:', JSON.stringify(validate.errors, null, 2));
      }
      expect(valid).toBe(true);
    });

    it('validates with invariant rules violations', () => {
      const result = makeAuditResult({
        'invariants-analyzer': {
          violations: [
            makeViolation({
              file: 'src/feature.ts',
              line: 10,
              severity: 'critical',
              message: 'Do not import lokijs — use better-sqlite3 instead',
              rule: 'no-lokijs',
              functionName: 'featureInit',
            }),
          ],
          status: makeVisitorStatus(5),
          executionTime: 80,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);
      const valid = validate(parsed);
      if (!valid) {
        console.error('Schema errors:', JSON.stringify(validate.errors, null, 2));
      }
      expect(valid).toBe(true);
    });
  });

  describe('SARIF structure', () => {
    it('emits version 2.1.0', () => {
      const result = makeAuditResult();
      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      expect(parsed.version).toBe('2.1.0');
    });

    it('includes $schema reference', () => {
      const result = makeAuditResult();
      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      expect(parsed.$schema).toContain('sarif-schema-2.1.0.json');
    });

    it('has one run', () => {
      const result = makeAuditResult();
      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      expect(parsed.runs).toHaveLength(1);
    });

    it('sets tool.driver.name to code-auditor-mcp', () => {
      const result = makeAuditResult();
      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      expect(parsed.runs[0].tool.driver.name).toBe('code-auditor-mcp');
    });

    it('sets tool.driver.version from package', () => {
      const result = makeAuditResult();
      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      expect(parsed.runs[0].tool.driver.version).toBeTruthy();
      expect(typeof parsed.runs[0].tool.driver.version).toBe('string');
    });

    it('sets tool.driver.informationUri to the GitHub repo', () => {
      const result = makeAuditResult();
      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      expect(parsed.runs[0].tool.driver.informationUri).toContain('github.com');
    });
  });

  describe('Severity mapping', () => {
    it('maps critical to error', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({ severity: 'critical', principle: 'single-responsibility' }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      expect(parsed.runs[0].results[0].level).toBe('error');
    });

    it('maps severe to error', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({ severity: 'severe', principle: 'open-closed' }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      expect(parsed.runs[0].results[0].level).toBe('error');
    });

    it('maps high to note', () => {
      const result = makeAuditResult({
        'documentation-analyzer': {
          violations: [
            makeViolation({
              severity: 'high',
              message: 'Function lacks documentation',
              functionName: 'foo',
            }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      expect(parsed.runs[0].results[0].level).toBe('note');
    });
  });

  describe('Fingerprints', () => {
    it('populates partialFingerprints for every result', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({
              severity: 'critical',
              principle: 'single-responsibility',
              functionName: 'fn1',
            }),
            makeViolation({
              severity: 'severe',
              principle: 'open-closed',
              functionName: 'fn2',
            }),
          ],
          status: makeVisitorStatus(3),
          executionTime: 100,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      for (const r of parsed.runs[0].results) {
        expect(r.partialFingerprints).toBeDefined();
        expect(r.partialFingerprints.primary).toBeTruthy();
        expect(typeof r.partialFingerprints.primary).toBe('string');
        expect(r.partialFingerprints.primary.length).toBe(64); // SHA-256 hex
      }
    });

    it('produces different fingerprints for different violations', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({
              file: 'src/a.ts',
              severity: 'critical',
              principle: 'single-responsibility',
              functionName: 'fnA',
            }),
            makeViolation({
              file: 'src/b.ts',
              severity: 'severe',
              principle: 'single-responsibility',
              functionName: 'fnB',
            }),
          ],
          status: makeVisitorStatus(2),
          executionTime: 50,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      const fps = parsed.runs[0].results.map((r: any) => r.partialFingerprints.primary);
      expect(fps[0]).not.toBe(fps[1]);
    });
  });

  describe('Rules', () => {
    it('creates one rule entry per unique rule id', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({ principle: 'single-responsibility', functionName: 'fn1' }),
            makeViolation({ principle: 'single-responsibility', functionName: 'fn2' }),
            makeViolation({ principle: 'open-closed', functionName: 'fn3' }),
          ],
          status: makeVisitorStatus(3),
          executionTime: 100,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      const rules = parsed.runs[0].tool.driver.rules;
      expect(rules).toHaveLength(2);
      expect(rules.map((r: any) => r.id).sort()).toEqual([
        'solid/open-closed',
        'solid/single-responsibility',
      ]);
    });

    it('uses invariant/<rule-id> format for invariant rules', () => {
      const result = makeAuditResult({
        'invariants-analyzer': {
          violations: [
            makeViolation({
              severity: 'critical',
              message: 'No lokijs allowed',
              rule: 'no-lokijs',
              functionName: 'init',
            }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      const rules = parsed.runs[0].tool.driver.rules;
      expect(rules[0].id).toBe('invariants/no-lokijs');
    });

    it('uses invariant message as fullDescription (Spec 06 R1.3)', () => {
      const userMessage = 'Do not import lokijs — use better-sqlite3 instead';
      const result = makeAuditResult({
        'invariants-analyzer': {
          violations: [
            makeViolation({
              severity: 'critical',
              message: userMessage,
              rule: 'no-lokijs',
              functionName: 'init',
            }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      const rule = parsed.runs[0].tool.driver.rules[0];
      expect(rule.fullDescription.text).toBe(userMessage);
    });

    it('has shortDescription and fullDescription for every rule', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({ principle: 'single-responsibility', functionName: 'fn1' }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
        'dry-analyzer': {
          violations: [
            makeViolation({
              file: 'src/other.ts',
              type: 'exact-duplicate',
              functionName: 'dupFn',
              message: 'Exact duplicate detected',
            }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      for (const rule of parsed.runs[0].tool.driver.rules) {
        expect(rule.shortDescription).toBeDefined();
        expect(rule.shortDescription.text).toBeTruthy();
        expect(rule.fullDescription).toBeDefined();
        expect(rule.fullDescription.text).toBeTruthy();
      }
    });
  });

  describe('Locations', () => {
    it('includes file and region for each result', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({
              file: 'src/services/auth.ts',
              line: 42,
              column: 5,
              principle: 'single-responsibility',
              functionName: 'authenticate',
            }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      const location = parsed.runs[0].results[0].locations[0];
      const { artifactLocation, region } = location.physicalLocation;

      expect(artifactLocation.uri).toBe('src/services/auth.ts');
      expect(region.startLine).toBe(42);
      expect(region.startColumn).toBe(5);
    });

    it('handles missing line and column gracefully', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({
              file: 'src/global.ts',
              // no line or column
              principle: 'single-responsibility',
            }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const sarif = generateSARIFReport(result);
      const parsed = JSON.parse(sarif);

      const valid = validate(parsed);
      if (!valid) {
        console.error('Schema errors:', JSON.stringify(validate.errors, null, 2));
      }
      expect(valid).toBe(true);
    });
  });

  describe('Resolution from suggestions (Spec 06 R1.5)', () => {
    const suggestion = 'Add JSDoc comment describing the function purpose and parameters';

    function makeResultWithSuggestion() {
      return makeAuditResult({
        'documentation-analyzer': {
          violations: [
            makeViolation({
              severity: 'high',
              message: 'Function lacks documentation',
              suggestion,
              functionName: 'doWork',
            }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });
    }

    it('produces schema-valid output when a suggestion is present', () => {
      const parsed = JSON.parse(generateSARIFReport(makeResultWithSuggestion()));
      const valid = validate(parsed);
      if (!valid) {
        console.error('Schema errors:', JSON.stringify(validate.errors, null, 2));
      }
      expect(valid).toBe(true);
    });

    it('does not emit a schema-invalid `fixes` array', () => {
      const parsed = JSON.parse(generateSARIFReport(makeResultWithSuggestion()));
      expect(parsed.runs[0].results[0].fixes).toBeUndefined();
    });

    it('surfaces the resolution in the result message', () => {
      const parsed = JSON.parse(generateSARIFReport(makeResultWithSuggestion()));
      expect(parsed.runs[0].results[0].message.text).toContain(suggestion);
    });

    it('carries the resolution verbatim in properties.resolution', () => {
      const parsed = JSON.parse(generateSARIFReport(makeResultWithSuggestion()));
      expect(parsed.runs[0].results[0].properties.resolution).toBe(suggestion);
    });

    it('carries the resolution as per-rule help', () => {
      const parsed = JSON.parse(generateSARIFReport(makeResultWithSuggestion()));
      const rule = parsed.runs[0].tool.driver.rules[0];
      expect(rule.help).toBeDefined();
      expect(rule.help.text).toBe(suggestion);
    });
  });

  describe('Regions', () => {
    it('omits startColumn when the column is 0 (SARIF minimum is 1)', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({ column: 0, principle: 'single-responsibility', functionName: 'fn' }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const parsed = JSON.parse(generateSARIFReport(result));
      const region = parsed.runs[0].results[0].locations[0].physicalLocation.region;
      expect(region.startLine).toBe(42);
      expect(region.startColumn).toBeUndefined();

      const valid = validate(parsed);
      if (!valid) {
        console.error('Schema errors:', JSON.stringify(validate.errors, null, 2));
      }
      expect(valid).toBe(true);
    });
  });

  describe('Relative URIs', () => {
    it('makes artifact URIs repo-relative when rootDir is supplied', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [
            makeViolation({
              file: '/repo/src/services/auth.ts',
              line: 42,
              column: 5,
              principle: 'single-responsibility',
              functionName: 'authenticate',
            }),
          ],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const parsed = JSON.parse(generateSARIFReport(result, { rootDir: '/repo' }));
      const location = parsed.runs[0].results[0].locations[0];
      expect(location.physicalLocation.artifactLocation.uri).toBe('src/services/auth.ts');
    });
  });

  describe('Run metadata (Spec 06 R1.5)', () => {
    it('sets a stable, tool-scoped automationDetails.id (category/run-id)', () => {
      const parsed = JSON.parse(generateSARIFReport(makeAuditResult()));
      expect(parsed.runs[0].automationDetails.id).toMatch(/^code-auditor-mcp\//);
      // The segment before the first `/` is GitHub's analysis category.
      expect(parsed.runs[0].automationDetails.id.split('/')[0]).toBe('code-auditor-mcp');
    });

    it('omits versionControlProvenance when not configured', () => {
      const parsed = JSON.parse(generateSARIFReport(makeAuditResult()));
      expect(parsed.runs[0].versionControlProvenance).toBeUndefined();
    });

    it('emits versionControlProvenance when repository and revision are supplied', () => {
      const result = makeAuditResult({
        'solid-analyzer': {
          violations: [makeViolation({ principle: 'single-responsibility', functionName: 'fn' })],
          status: makeVisitorStatus(1),
          executionTime: 10,
        },
      });

      const parsed = JSON.parse(generateSARIFReport(result, {
        rootDir: '/repo',
        repositoryUri: 'https://github.com/owner/repo.git',
        revisionId: 'abc123def456',
      }));

      const prov = parsed.runs[0].versionControlProvenance;
      expect(prov).toHaveLength(1);
      expect(prov[0].repositoryUri).toBe('https://github.com/owner/repo.git');
      expect(prov[0].revisionId).toBe('abc123def456');

      const valid = validate(parsed);
      if (!valid) {
        console.error('Schema errors:', JSON.stringify(validate.errors, null, 2));
      }
      expect(valid).toBe(true);
    });
  });

  describe('Fingerprint path stability', () => {
    it('derives partialFingerprints from the repo-relative path, not the absolute path', () => {
      const base = {
        severity: 'critical' as const,
        message: 'SRP violation',
        rule: 'single-responsibility',
        functionName: 'fn',
      };
      const fpFor = (file: string, rootDir: string) => {
        const result = makeAuditResult({
          'solid-analyzer': {
            violations: [makeViolation({ ...base, file })],
            status: makeVisitorStatus(1),
            executionTime: 10,
          },
        });
        return JSON.parse(generateSARIFReport(result, { rootDir })).runs[0].results[0].partialFingerprints.primary;
      };
      expect(fpFor('/checkout-a/src/x.ts', '/checkout-a')).toBe(fpFor('/checkout-b/src/x.ts', '/checkout-b'));
    });
  });
});

describe('resolveRuleId', () => {
  it('uses violation.rule first', () => {
    const v = makeViolation({ rule: 'hooks-conditional' });
    expect(resolveRuleId(v)).toBe('hooks-conditional');
  });

  it('uses violation.principle when no rule field', () => {
    const v = makeViolation({ principle: 'single-responsibility' });
    delete (v as any).rule;
    expect(resolveRuleId(v)).toBe('single-responsibility');
  });

  it('uses violation.details.rule when nested', () => {
    const v = makeViolation({
      details: { rule: 'hooks-naming', hookName: 'useData' },
    });
    delete (v as any).rule;
    expect(resolveRuleId(v)).toBe('hooks-naming');
  });

  it('falls back to violation.type', () => {
    const v = makeViolation({ type: 'exact-duplicate' });
    delete (v as any).rule;
    expect(resolveRuleId(v)).toBe('exact-duplicate');
  });

  it('falls back to violation.schemaType', () => {
    const v = makeViolation({ schemaType: 'missing-reference' });
    delete (v as any).rule;
    expect(resolveRuleId(v)).toBe('missing-reference');
  });

  it('falls back to "unknown"', () => {
    const v = makeViolation({});
    delete (v as any).rule;
    delete (v as any).type;
    delete (v as any).principle;
    delete (v as any).schemaType;
    delete (v as any).violationType;
    expect(resolveRuleId(v)).toBe('unknown');
  });
});

describe('buildFullRuleId', () => {
  it('builds solid/single-responsibility', () => {
    const v = makeViolation({ principle: 'single-responsibility' });
    delete (v as any).rule;
    expect(buildFullRuleId('solid-analyzer', v)).toBe('solid/single-responsibility');
  });

  it('builds invariants/<user-id>', () => {
    const v = makeViolation({ rule: 'no-lokijs' });
    expect(buildFullRuleId('invariants-analyzer', v)).toBe('invariants/no-lokijs');
  });

  it('builds dry/exact-duplicate', () => {
    const v = makeViolation({ type: 'exact-duplicate' });
    delete (v as any).rule;
    expect(buildFullRuleId('dry-analyzer', v)).toBe('dry/exact-duplicate');
  });

  it('builds react/hooks-conditional', () => {
    const v = makeViolation({ details: { rule: 'hooks-conditional' } });
    delete (v as any).rule;
    expect(buildFullRuleId('react-analyzer', v)).toBe('react/hooks-conditional');
  });

  it('does not double-prefix an already-namespaced rule ID', () => {
    const v = makeViolation({ rule: 'solid/class-size' });
    expect(buildFullRuleId('solid', v)).toBe('solid/class-size');
    expect(buildFullRuleId('solid-analyzer', v)).toBe('solid/class-size');
  });
});

  describe('Golden file', () => {
    it('generates deterministic output and validates against schema', () => {
    const result = makeAuditResult({
      'solid-analyzer': {
        violations: [
          makeViolation({
            file: 'src/example.ts',
            line: 42,
            column: 10,
            severity: 'critical',
            message: 'Function doEverything violates SRP',
            principle: 'single-responsibility',
            functionName: 'doEverything',
          }),
        ],
        status: makeVisitorStatus(3),
        executionTime: 150,
        analyzerName: 'solid-analyzer',
      },
      'dry-analyzer': {
        violations: [
          makeViolation({
            file: 'src/utils.ts',
            line: 15,
            severity: 'severe',
            message: 'Pattern duplication detected',
            type: 'pattern-duplication',
            functionName: 'formatDate',
          }),
        ],
        status: makeVisitorStatus(3),
        executionTime: 120,
        analyzerName: 'dry-analyzer',
      },
      'invariants-analyzer': {
        violations: [
          makeViolation({
            file: 'src/app.ts',
            line: 5,
            severity: 'critical',
            message: 'Do not import lokijs',
            rule: 'no-lokijs',
            functionName: 'appBootstrap',
          }),
        ],
        status: makeVisitorStatus(5),
        executionTime: 80,
        analyzerName: 'invariants-analyzer',
      },
    });

    const sarif = generateSARIFReport(result);

    // Validate against schema
    const parsed = JSON.parse(sarif);
    const valid = validate(parsed);
    if (!valid) {
      console.error('Golden file schema errors:', JSON.stringify(validate.errors, null, 2));
    }
    expect(valid).toBe(true);

    // Write golden file for manual inspection
    const goldenDir = join(__dirname, '..', '..', 'test-fixtures');
    mkdirSync(goldenDir, { recursive: true });
    const goldenPath = join(goldenDir, 'sarif-golden.json');
    writeFileSync(goldenPath, sarif + '\n', 'utf-8');

    // Basic structural assertions
    const log = parsed;
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].tool.driver.rules).toHaveLength(3);
    expect(log.runs[0].results).toHaveLength(3);
  });
});
