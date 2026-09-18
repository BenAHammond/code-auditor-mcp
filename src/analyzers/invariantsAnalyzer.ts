/**
 * Invariants Analyzer — enforces user-defined invariant rules from .codeauditor.json.
 *
 * This is a first-class analyzer like SOLID or DRY. It reads the `rules` array
 * from the project config and checks every (scoped) file against them.
 *
 * Enabled by default when a `rules` array exists in .codeauditor.json.
 * Selectable via `-a invariants`.
 */

import type { AnalyzerFunction, AnalyzerResult, Violation, AuditOptions, IndexHandle, CoverageDiagnostic } from '../types.js';
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

/**
 * Build config-validation-error diagnostics (anchored to .codeauditor.json).
 *
 * A bad `.codeauditor.json` is a tool-side failure — the rules could not be
 * loaded — not a defect in the audited code. These live on the diagnostic
 * channel (outside the severity ladder, never counted in finding totals,
 * always surfaced regardless of `--fail-on`).
 */
function configErrorDiagnostics(errors: string[]): CoverageDiagnostic[] {
  return errors.map(err => ({
    analyzerName: 'invariants',
    kind: 'config-error',
    message: err,
    file: '.codeauditor.json',
    line: 1,
    details: { source: 'config-validation' },
  }));
}

/** Build rule-engine-error diagnostics (anchored to .codeauditor.json). */
function engineErrorDiagnostics(errors: string[]): CoverageDiagnostic[] {
  return errors.map(err => ({
    analyzerName: 'invariants',
    kind: 'engine-error',
    message: err,
    file: '.codeauditor.json',
    line: 1,
    details: { source: 'check-error' },
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

/** Run the rule engine and split its output into violations + diagnostics. */
function runRuleEngine(args: InvariantCheckArgs): { violations: Violation[]; diagnostics: CoverageDiagnostic[] } {
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

  return {
    violations: result.violations.map(toViolation),
    diagnostics: engineErrorDiagnostics(result.errors),
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
  const projectDir = (options as any)?.projectRoot || process.cwd();
  const ruleData = loadRules(config, projectDir);

  if (!ruleData) {
    return emptyResult(startTime);
  }

  const { rules, errors } = ruleData;
  const configDiagnostics = configErrorDiagnostics(errors);

  // If there are validation errors but no runnable rules, surface only them.
  if (rules.length === 0) {
    return {
      violations: [],
      diagnostics: configDiagnostics,
      status: makeVisitorStatus(0),
      executionTime: Date.now() - startTime,
      analyzerName: 'invariants',
    };
  }

  const { violations, diagnostics: engineDiagnostics } = runRuleEngine({ rules, files, options, projectDir, config });

  return {
    violations,
    diagnostics: [...configDiagnostics, ...engineDiagnostics],
    status: makeVisitorStatus(files.length),
    executionTime: Date.now() - startTime,
    analyzerName: 'invariants',
  };
};

