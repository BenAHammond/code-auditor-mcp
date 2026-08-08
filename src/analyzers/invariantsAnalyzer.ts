/**
 * Invariants Analyzer — enforces user-defined invariant rules from .codeauditor.json.
 *
 * This is a first-class analyzer like SOLID or DRY. It reads the `rules` array
 * from the project config and checks every (scoped) file against them.
 *
 * Enabled by default when a `rules` array exists in .codeauditor.json.
 * Selectable via `-a invariants`.
 */

import type { AnalyzerFunction, AnalyzerResult, Violation, AuditOptions, IndexHandle } from '../types.js';
import { checkRules, hasRules, type InvariantRule, type RuleViolation } from '../invariants/ruleEngine.js';
import { validateRulesConfig } from '../invariants/ruleValidator.js';
import { makeVisitorStatus } from '../pipeline.js';

/**
 * Load invariant rules from the project config or the .codeauditor.json on disk.
 * Returns null if no rules are configured.
 */
function loadRules(config: any, _projectDir?: string): { rules: InvariantRule[]; errors: string[] } | null {
  // Check for rules in config (could be under `rules` or `invariantRules`)
  // The pipeline guarantees rules are pre-loaded into the namespace config;
  // standalone callers must pass rules explicitly.
  const rulesConfig = config?.rules ?? config?.invariantRules;

  if (!rulesConfig || !Array.isArray(rulesConfig)) {
    return null;
  }

  // Validate
  const validationErrors = validateRulesConfig({ rules: rulesConfig });
  if (validationErrors.length > 0) {
    return {
      rules: [],
      errors: validationErrors.map(e => `Rule "${e.ruleId || '?'}": ${e.message}`),
    };
  }

  return { rules: rulesConfig as InvariantRule[], errors: [] };
}

/**
 * Convert a RuleViolation to the standard Violation format
 */
function toViolation(rv: RuleViolation): Violation {
  return {
    file: rv.file,
    line: rv.line,
    column: rv.column,
    severity: rv.severity,
    message: rv.message,
    rule: rv.ruleId,
    analyzer: 'invariants',
    details: rv.kind,
    suggestion: undefined,
    symbol: rv.symbol,
    importSpecifier: rv.importSpecifier,
    callee: rv.callee,
    caller: rv.caller,
  };
}

/**
 * The invariants analyzer function — conforms to AnalyzerFunction.
 */
export const analyzeInvariants: AnalyzerFunction = async (
  files: string[],
  config: any,
  options?: AuditOptions,
  _progressCallback?: any
): Promise<AnalyzerResult> => {
  const startTime = Date.now();

  // Determine project directory (needed before loadRules for auto-discovery)
  const projectDir = (options as any)?.projectRoot || process.cwd();

  // Load rules from config
  const ruleData = loadRules(config, projectDir);

  if (!ruleData) {
    return {
      violations: [],
      status: makeVisitorStatus(0),
      executionTime: Date.now() - startTime,
      analyzerName: 'invariants',
    };
  }

  const { rules, errors } = ruleData;

  // If there are validation errors, return them as violations
  const errorViolations: Violation[] = errors.map(err => ({
    file: '.codeauditor.json',
    severity: 'critical' as const,
    message: err,
    rule: 'config-error',
    analyzer: 'invariants',
    details: 'config-validation',
  }));

  if (rules.length === 0) {
    return {
      violations: errorViolations,
      status: makeVisitorStatus(0),
      executionTime: Date.now() - startTime,
      analyzerName: 'invariants',
    };
  }

  // IndexHandle for call-constraint and style checks, routed via pipeline.
  // When not running through the pipeline (standalone analyzer call), fall
  // back to accessing the DB through the options handle if provided.
  const indexHandle = (options as any)?.indexHandle as IndexHandle | undefined;

  // Run the rule engine
  const result = checkRules({
    rules,
    files,
    indexHandle,
    projectDir,
    sourceMap: config.sourceMap,
    knownFiles: config.knownFiles,
    fileData: config.fileData,
  });

  const violations: Violation[] = [
    ...errorViolations,
    ...result.violations.map(toViolation),
    ...result.errors.map(err => ({
      file: '.codeauditor.json',
      severity: 'warning' as const,
      message: err,
      rule: 'engine-error',
      analyzer: 'invariants',
      details: 'check-error',
    })),
  ];

  return {
    violations,
    status: makeVisitorStatus(files.length),
    executionTime: Date.now() - startTime,
    analyzerName: 'invariants',
  };
};

