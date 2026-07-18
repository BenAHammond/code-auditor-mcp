/**
 * Invariant Rules Engine — barrel export
 * Spec 05: Custom Invariant Rules Engine
 */
export type {
  RuleSeverity,
  RuleKind,
  RuleBase,
  ImportBanRule,
  CallConstraintRule,
  ModuleBoundaryRule,
  NamingRule,
  InvariantRule,
  RulesConfig,
  RuleViolation,
  RuleCheckResult,
} from './types.js';
export { validateRulesConfig, hasRules, type RuleValidationError } from './ruleValidator.js';
export { checkRules, clearMatcherCache, type RuleEngineOptions } from './ruleEngine.js';
export { invariantsAnalyzer, analyzeInvariants } from '../analyzers/invariantsAnalyzer.js';
