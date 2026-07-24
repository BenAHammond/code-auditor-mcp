/**
 * Validates invariant rules using AJV JSON Schema + custom business logic.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import picomatch from 'picomatch';
import type { InvariantRule, RulesConfig, RuleKind } from './types.js';
import schema from './invariant-rules.schema.json' with { type: 'json' };

export interface RuleValidationError {
  ruleId?: string;
  message: string;
}

let _ajv: Ajv | null = null;
let _validate: ValidateFunction | null = null;

function getAjv(): Ajv {
  if (!_ajv) {
    _ajv = new Ajv({ allErrors: true, strict: false });
  }
  return _ajv;
}

function getValidate(): ValidateFunction {
  if (!_validate) {
    _validate = getAjv().compile(schema);
  }
  return _validate;
}

/**
 * Validate rules config against the JSON Schema and custom business rules.
 * Returns a list of validation errors (empty = valid).
 */
export function validateRulesConfig(config: unknown): RuleValidationError[] {
  const errors: RuleValidationError[] = [];

  // 1. Structural validation via AJV
  const validate = getValidate();
  const valid = validate(config);
  if (!valid && validate.errors) {
    for (const err of validate.errors) {
      errors.push({
        message: `${err.instancePath || '(root)'} ${err.message}`,
        ruleId: extractRuleId(err.instancePath),
      });
    }
  }

  // If structural validation failed, skip business validation that depends on structure
  if (!isRulesConfig(config)) {
    if (errors.length === 0) {
      errors.push({ message: 'Config must have a "rules" array' });
    }
    return errors;
  }

  const rules = config.rules as InvariantRule[];

  // 2. Check for duplicate ids
  const seenIds = new Set<string>();
  for (const rule of rules) {
    if (seenIds.has(rule.id)) {
      errors.push({
        ruleId: rule.id,
        message: `Duplicate rule id: "${rule.id}"`,
      });
    } else {
      seenIds.add(rule.id);
    }
  }

  // 3. Per-rule validation
  for (const rule of rules) {
    const ruleErrors = validateRule(rule);
    errors.push(...ruleErrors);
  }

  return errors;
}

/**
 * Validate a single rule for business-rule correctness.
 */
function validateRule(rule: InvariantRule): RuleValidationError[] {
  const errors: RuleValidationError[] = [];

  // Validate kind
  const validKinds: RuleKind[] = ['import-ban', 'call-constraint', 'module-boundary', 'naming', 'ast-pattern', 'style-mechanism', 'no-raw-values'];
  if (!validKinds.includes(rule.kind as RuleKind)) {
    errors.push({
      ruleId: rule.id,
      message: `Invalid kind "${(rule as any).kind}". Must be one of: ${validKinds.join(', ')}`,
    });
    return errors; // can't validate kind-specific fields
  }

  // Validate severity
  const validSeverities = ['critical', 'warning', 'suggestion'];
  if (!validSeverities.includes(rule.severity)) {
    errors.push({
      ruleId: rule.id,
      message: `Invalid severity "${rule.severity}". Must be one of: ${validSeverities.join(', ')}`,
    });
  }

  // Kind-specific validation
  switch (rule.kind) {
    case 'import-ban': {
      if (!rule.module || typeof rule.module !== 'string') {
        errors.push({ ruleId: rule.id, message: 'import-ban requires a "module" string' });
      }
      if (rule.except !== undefined && !Array.isArray(rule.except)) {
        errors.push({ ruleId: rule.id, message: '"except" must be an array of path glob strings' });
      }
      // Validate glob patterns in except
      if (Array.isArray(rule.except)) {
        for (const g of rule.except) {
          if (!isValidGlob(g)) {
            errors.push({ ruleId: rule.id, message: `Invalid glob pattern in "except": "${g}"` });
          }
        }
      }
      break;
    }

    case 'call-constraint': {
      const hasAllow = Array.isArray(rule.allowFrom) && rule.allowFrom.length > 0;
      const hasDeny = Array.isArray(rule.denyFrom) && rule.denyFrom.length > 0;

      if (!hasAllow && !hasDeny) {
        errors.push({
          ruleId: rule.id,
          message: 'call-constraint requires exactly one of "allowFrom" or "denyFrom" (got neither)',
        });
      } else if (hasAllow && hasDeny) {
        errors.push({
          ruleId: rule.id,
          message: 'call-constraint requires exactly one of "allowFrom" or "denyFrom" (got both)',
        });
      }

      if (!rule.callee || typeof rule.callee !== 'string') {
        errors.push({ ruleId: rule.id, message: 'call-constraint requires a "callee" string' });
      }

      // Validate glob patterns
      for (const arr of [rule.allowFrom, rule.denyFrom]) {
        if (Array.isArray(arr)) {
          for (const g of arr) {
            if (!isValidGlob(g)) {
              errors.push({ ruleId: rule.id, message: `Invalid glob pattern: "${g}"` });
            }
          }
        }
      }
      break;
    }

    case 'module-boundary': {
      if (!rule.from || typeof rule.from !== 'string') {
        errors.push({ ruleId: rule.id, message: 'module-boundary requires a "from" glob string' });
      } else if (!isValidGlob(rule.from)) {
        errors.push({ ruleId: rule.id, message: `Invalid glob pattern in "from": "${rule.from}"` });
      }

      if (!rule.to || typeof rule.to !== 'string') {
        errors.push({ ruleId: rule.id, message: 'module-boundary requires a "to" glob string' });
      } else if (!isValidGlob(rule.to)) {
        errors.push({ ruleId: rule.id, message: `Invalid glob pattern in "to": "${rule.to}"` });
      }
      break;
    }

    case 'naming': {
      if (!rule.path || typeof rule.path !== 'string') {
        errors.push({ ruleId: rule.id, message: 'naming requires a "path" glob string' });
      } else if (!isValidGlob(rule.path)) {
        errors.push({ ruleId: rule.id, message: `Invalid glob pattern in "path": "${rule.path}"` });
      }

      if (!rule.exports || typeof rule.exports !== 'string') {
        errors.push({ ruleId: rule.id, message: 'naming requires an "exports" regex string' });
      } else {
        try {
          new RegExp(rule.exports);
        } catch {
          errors.push({
            ruleId: rule.id,
            message: `Invalid regex in "exports": "${rule.exports}"`,
          });
        }
      }
      break;
    }

    case 'ast-pattern': {
      if (!rule.pattern || typeof rule.pattern !== 'string' || rule.pattern.trim().length === 0) {
        errors.push({ ruleId: rule.id, message: 'ast-pattern requires a non-empty "pattern" string' });
      }

      if (rule.language !== undefined) {
        const validLanguages = ['typescript', 'javascript', 'go'];
        if (!validLanguages.includes(rule.language)) {
          errors.push({
            ruleId: rule.id,
            message: `ast-pattern language "${rule.language}" must be one of: ${validLanguages.join(', ')}`,
          });
        }
      }

      if (rule.path !== undefined) {
        if (typeof rule.path !== 'string' || !isValidGlob(rule.path)) {
          errors.push({
            ruleId: rule.id,
            message: `Invalid glob pattern in "path": "${rule.path}"`,
          });
        }
      }
      break;
    }

    case 'style-mechanism': {
      if (!rule.allow || !Array.isArray(rule.allow) || rule.allow.length === 0) {
        errors.push({ ruleId: rule.id, message: 'style-mechanism requires a non-empty "allow" array' });
      } else {
        for (const item of rule.allow) {
          if (typeof item !== 'string') {
            errors.push({ ruleId: rule.id, message: 'style-mechanism "allow" entries must be strings' });
            break;
          }
        }
      }

      if (rule.path !== undefined) {
        if (typeof rule.path !== 'string' || !isValidGlob(rule.path)) {
          errors.push({
            ruleId: rule.id,
            message: `Invalid glob pattern in "path": "${rule.path}"`,
          });
        }
      }
      break;
    }

    case 'no-raw-values': {
      if (!rule.properties || !Array.isArray(rule.properties) || rule.properties.length === 0) {
        errors.push({ ruleId: rule.id, message: 'no-raw-values requires a non-empty "properties" array' });
      } else {
        for (const item of rule.properties) {
          if (typeof item !== 'string') {
            errors.push({ ruleId: rule.id, message: 'no-raw-values "properties" entries must be strings' });
            break;
          }
        }
      }

      if (rule.allowValues !== undefined) {
        if (!Array.isArray(rule.allowValues)) {
          errors.push({ ruleId: rule.id, message: '"allowValues" must be an array of strings' });
        } else {
          for (const item of rule.allowValues) {
            if (typeof item !== 'string') {
              errors.push({ ruleId: rule.id, message: '"allowValues" entries must be strings' });
              break;
            }
          }
        }
      }

      if (rule.path !== undefined) {
        if (typeof rule.path !== 'string' || !isValidGlob(rule.path)) {
          errors.push({
            ruleId: rule.id,
            message: `Invalid glob pattern in "path": "${rule.path}"`,
          });
        }
      }
      break;
    }
  }

  // Check for unknown fields
  const knownFields = new Set([
    'id', 'kind', 'severity', 'message',
    'module', 'except',           // import-ban
    'callee', 'allowFrom', 'denyFrom', // call-constraint
    'from', 'to',                 // module-boundary
    'path', 'exports',            // naming
    'pattern', 'language',         // ast-pattern
    'allow',                       // style-mechanism
    'properties', 'allowValues',   // no-raw-values
  ]);
  const kindFields: Record<RuleKind, Set<string>> = {
    'import-ban': new Set(['id', 'kind', 'severity', 'message', 'module', 'except']),
    'call-constraint': new Set(['id', 'kind', 'severity', 'message', 'callee', 'allowFrom', 'denyFrom']),
    'module-boundary': new Set(['id', 'kind', 'severity', 'message', 'from', 'to']),
    'naming': new Set(['id', 'kind', 'severity', 'message', 'path', 'exports']),
    'ast-pattern': new Set(['id', 'kind', 'severity', 'message', 'pattern', 'language', 'path']),
    'style-mechanism': new Set(['id', 'kind', 'severity', 'message', 'allow', 'path']),
    'no-raw-values': new Set(['id', 'kind', 'severity', 'message', 'properties', 'allowValues', 'path']),
  };

  const allowed = kindFields[rule.kind] || new Set(['id', 'kind', 'severity', 'message']);
  const unknownFields = Object.keys(rule).filter(k => !allowed.has(k));
  if (unknownFields.length > 0) {
    errors.push({
      ruleId: rule.id,
      message: `Unknown field(s) for kind "${rule.kind}": ${unknownFields.join(', ')}`,
    });
  }

  return errors;
}

/**
 * Check if a string is a valid picomatch glob pattern.
 * picomatch accepts most strings, but we reject obviously broken patterns
 * (unmatched brackets, etc).
 */
function isValidGlob(pattern: string): boolean {
  try {
    // picomatch silently returns a no-match for bad patterns.
    // Test that the pattern compiles without throwing.
    picomatch(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract rule ID from an AJV instancePath,
 * e.g. "/rules/2/id" or "/rules/0/module"
 */
function extractRuleId(instancePath: string): string | undefined {
  const match = instancePath.match(/\/rules\/(\d+)/);
  if (match) {
    return `rules[${match[1]}]`;
  }
  return undefined;
}

function isRulesConfig(value: unknown): value is RulesConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rules' in value &&
    Array.isArray((value as Record<string, unknown>).rules)
  );
}

/**
 * Check whether a config has any rules defined.
 */
export function hasRules(config: unknown): boolean {
  return isRulesConfig(config) && config.rules.length > 0;
}
