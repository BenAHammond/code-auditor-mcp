/**
 * Invariants Analyzer — enforces user-defined invariant rules from .codeauditor.json.
 *
 * This is a first-class analyzer like SOLID or DRY. It reads the `rules` array
 * from the project config and checks every (scoped) file against them.
 *
 * Enabled by default when a `rules` array exists in .codeauditor.json.
 * Selectable via `-a invariants`.
 */

import type { AnalyzerFunction, AnalyzerResult, AnalyzerDefinition, Violation, AuditOptions } from '../types.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CodeIndexDB } from '../codeIndexDB.js';
import { checkRules, hasRules, type InvariantRule, type RuleViolation } from '../invariants/ruleEngine.js';
import { validateRulesConfig } from '../invariants/ruleValidator.js';

/**
 * Load invariant rules from the project config or the .codeauditor.json on disk.
 * Returns null if no rules are configured.
 */
function loadRules(config: any, projectDir?: string): { rules: InvariantRule[]; errors: string[] } | null {
  // Check for rules in config (could be under `rules` or `invariantRules`)
  let rulesConfig = config?.rules ?? config?.invariantRules;

  // When config doesn't carry rules, try .codeauditor.json on disk (Spec 05 R3.1)
  if (!rulesConfig && projectDir) {
    try {
      const configPath = join(projectDir, '.codeauditor.json');
      const raw = readFileSync(configPath, 'utf-8');
      const fileConfig = JSON.parse(raw);
      rulesConfig = fileConfig?.rules ?? fileConfig?.invariantRules;
    } catch {
      // No config file on disk — that's fine
    }
  }

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
      filesProcessed: 0,
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
      filesProcessed: 0,
      executionTime: Date.now() - startTime,
      analyzerName: 'invariants',
    };
  }

  // Get the DB for call-constraint checks
  let db: CodeIndexDB | undefined;
  try {
    db = CodeIndexDB.getInstance();
    await db.initialize();
  } catch {
    // DB not available — call-constraint checking will be skipped
  }

  // Run the rule engine
  const result = checkRules({
    rules,
    files,
    db,
    projectDir,
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
    filesProcessed: files.length,
    executionTime: Date.now() - startTime,
    analyzerName: 'invariants',
  };
};

/**
 * The invariants analyzer definition for registration in the audit runner.
 */
export const invariantsAnalyzer: AnalyzerDefinition = {
  name: 'invariants',
  description: 'Enforces custom invariant rules from .codeauditor.json (import bans, call constraints, module boundaries, naming conventions)',
  category: 'invariants',
  analyze: analyzeInvariants,
  defaultConfig: {},
};

export default invariantsAnalyzer;
