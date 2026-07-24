/**
 * Invariant rule type definitions for Spec 05
 */

export type RuleSeverity = 'critical' | 'warning' | 'suggestion';
export type RuleKind = 'import-ban' | 'call-constraint' | 'module-boundary' | 'naming' | 'ast-pattern' | 'style-mechanism' | 'no-raw-values';

/** Base fields shared by all rule kinds */
export interface RuleBase {
  id: string;
  kind: RuleKind;
  severity: RuleSeverity;
  message?: string;
}

/** import-ban: prevent importing a given module (glob) from any file,
 *  unless the importing file matches an `except` path glob. */
export interface ImportBanRule extends RuleBase {
  kind: 'import-ban';
  module: string;
  except?: string[];
}

/** call-constraint: allow or deny callers of a function.
 *  Exactly one of allowFrom / denyFrom must be specified. */
export interface CallConstraintRule extends RuleBase {
  kind: 'call-constraint';
  callee: string;          // function name, optionally 'path/glob#name'
  allowFrom?: string[];    // only callers matching these path globs are allowed
  denyFrom?: string[];     // callers matching these path globs are denied
}

/** module-boundary: files matching `from` may not import from files matching `to`. */
export interface ModuleBoundaryRule extends RuleBase {
  kind: 'module-boundary';
  from: string;
  to: string;
}

/** naming: exported symbols in files matching `path` must match the `exports` regex. */
export interface NamingRule extends RuleBase {
  kind: 'naming';
  path: string;
  exports: string;  // regex pattern
}

/** ast-pattern: match AST nodes using @ast-grep/napi pattern syntax.
 *  Optionally restrict to files matching `path` and/or a specific `language`. */
export interface AstPatternRule extends RuleBase {
  kind: 'ast-pattern';
  pattern: string;
  language?: 'typescript' | 'javascript' | 'go';
  path?: string;
}

/** style-mechanism: enforce that style declarations in matching files
 *  only use allowed mechanisms (e.g. tailwind, css-modules). */
export interface StyleMechanismRule extends RuleBase {
  kind: 'style-mechanism';
  /** Allowed style mechanisms (e.g. ['tailwind', 'css']). */
  allow: string[];
  /** Optional path glob to restrict which files this applies to. */
  path?: string;
}

/** no-raw-values: enforce that designated properties reference a design token.
 *  A declaration whose normalized_value is not in allowValues AND has no token_ref
 *  is a violation. */
export interface NoRawValuesRule extends RuleBase {
  kind: 'no-raw-values';
  /** CSS properties to check (e.g. ['color', 'background-color']). */
  properties: string[];
  /** Values that are always allowed even without a token ref (e.g. ['inherit', 'transparent']). */
  allowValues?: string[];
  /** Optional path glob to restrict which files this applies to. */
  path?: string;
}

/** Discriminated union of all rule kinds */
export type InvariantRule = ImportBanRule | CallConstraintRule | ModuleBoundaryRule | NamingRule | AstPatternRule | StyleMechanismRule | NoRawValuesRule;

/** The rules array from .codeauditor.json */
export interface RulesConfig {
  $schema?: string;
  rules: InvariantRule[];
}

/** A violation produced by the invariant rules engine */
export interface RuleViolation {
  ruleId: string;
  kind: RuleKind;
  severity: RuleSeverity;
  message: string;
  file: string;
  line?: number;
  column?: number;
  symbol?: string;
  /** The import specifier that triggered the violation (for import-ban / module-boundary) */
  importSpecifier?: string;
  /** The callee that triggered the violation (for call-constraint) */
  callee?: string;
  /** The caller that triggered the violation (for call-constraint) */
  caller?: string;
}

/** Result of checking rules */
export interface RuleCheckResult {
  rules: InvariantRule[];
  violations: RuleViolation[];
  errors: string[];
}
