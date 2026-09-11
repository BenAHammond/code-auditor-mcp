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
    line: rv.line ?? 1,
    column: rv.column ?? 1,
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

interface InvariantCheckArgs {
  rules: InvariantRule[];
  files: string[];
  options: AuditOptions | undefined;
  projectDir: string;
  config: any;
}

/** Build config-validation-error violations (anchored to .codeauditor.json). */
function configErrorViolations(errors: string[]): Violation[] {
  return errors.map(err => ({
    file: '.codeauditor.json',
    line: 1,
    column: 1,
    severity: 'critical' as const,
    message: err,
    rule: 'config-error',
    analyzer: 'invariants',
    details: 'config-validation',
  }));
}

/** Build rule-engine-error violations (anchored to .codeauditor.json). */
function engineErrorViolations(errors: string[]): Violation[] {
  return errors.map(err => ({
    file: '.codeauditor.json',
    line: 1,
    column: 1,
    severity: 'severe' as const,
    message: err,
    rule: 'engine-error',
    analyzer: 'invariants',
    details: 'check-error',
  }));
}

/** Build the empty-result object returned when no rules are configured. */
function emptyResult(startTime: number): AnalyzerResult {
  return {
    violations: [],
    status: makeVisitorStatus(0),
    executionTime: Date.now() - startTime,
    analyzerName: 'invariants',
  };
}

/** Run the rule engine and convert its output into standard violations. */
function runRuleEngine(args: InvariantCheckArgs): Violation[] {
  const indexHandle = (args.options as any)?.indexHandle as IndexHandle | undefined;
  const result = checkRules({
    rules: args.rules,
    files: args.files,
    indexHandle,
    projectDir: args.projectDir,
    readSource: args.config.readSource,
    knownFiles: args.config.knownFiles,
    fileData: args.config.fileData,
    isScoped: args.config.isScoped,
  });

  return [
    ...result.violations.map(toViolation),
    ...engineErrorViolations(result.errors),
  ];
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
  const projectDir = (options as any)?.projectRoot || process.cwd();
  const ruleData = loadRules(config, projectDir);

  if (!ruleData) {
    return emptyResult(startTime);
  }

  const { rules, errors } = ruleData;
  const errorViolations = configErrorViolations(errors);

  // If there are validation errors but no runnable rules, surface only them.
  if (rules.length === 0) {
    return {
      violations: errorViolations,
      status: makeVisitorStatus(0),
      executionTime: Date.now() - startTime,
      analyzerName: 'invariants',
    };
  }

  const engineViolations = runRuleEngine({ rules, files, options, projectDir, config });

  return {
    violations: [...errorViolations, ...engineViolations],
    status: makeVisitorStatus(files.length),
    executionTime: Date.now() - startTime,
    analyzerName: 'invariants',
  };
};

