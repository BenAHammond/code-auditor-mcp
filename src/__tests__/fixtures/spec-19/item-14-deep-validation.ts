/**
 * Spec-19 item 14 — solid/method-complexity TRUE positive (oracle: MUST fire).
 * Validation function with deep conditional nesting, complexity > 50.
 * Form/API validation with many branching paths — genuine complexity.
 */

interface ValidationRule {
  field: string;
  type: 'required' | 'minLength' | 'maxLength' | 'pattern' | 'range' | 'enum' | 'custom';
  value?: unknown;
  message?: string;
}

interface ValidationError {
  field: string;
  rule: string;
  message: string;
}

interface ValidatableRecord {
  [key: string]: unknown;
}

function required(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function minLength(value: unknown, min: number): boolean {
  if (typeof value === 'string') return value.length >= min;
  if (Array.isArray(value)) return value.length >= min;
  return false;
}

function maxLength(value: unknown, max: number): boolean {
  if (typeof value === 'string') return value.length <= max;
  if (Array.isArray(value)) return value.length <= max;
  return true;
}

function pattern(value: unknown, regex: RegExp): boolean {
  return typeof value === 'string' && regex.test(value);
}

function inRange(value: unknown, min: number, max: number): boolean {
  if (typeof value !== 'number') return false;
  return value >= min && value <= max;
}

function oneOf(value: unknown, allowed: unknown[]): boolean {
  return allowed.includes(value);
}

export function validate(
  record: ValidatableRecord,
  rules: ValidationRule[],
  context?: { mode: 'create' | 'update' | 'patch' }
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const rule of rules) {
    const value = record[rule.field];
    const msg = rule.message || `${rule.field} failed validation: ${rule.type}`;

    switch (rule.type) {
      case 'required': {
        // On patch mode, required fields can be absent
        if (context?.mode === 'patch' && !(rule.field in record)) {
          break;
        }
        if (!required(value)) {
          errors.push({ field: rule.field, rule: 'required', message: msg });
        }
        break;
      }
      case 'minLength': {
        if (value == null) break; // optional unless required
        const min = Number(rule.value);
        if (isNaN(min) || min < 0) {
          throw new Error(`Invalid minLength value for ${rule.field}: ${rule.value}`);
        }
        if (!minLength(value, min)) {
          errors.push({ field: rule.field, rule: 'minLength', message: msg });
        }
        break;
      }
      case 'maxLength': {
        if (value == null) break;
        const max = Number(rule.value);
        if (isNaN(max)) {
          throw new Error(`Invalid maxLength value for ${rule.field}`);
        }
        if (!maxLength(value, max)) {
          errors.push({ field: rule.field, rule: 'maxLength', message: msg });
        }
        break;
      }
      case 'pattern': {
        if (value == null) break;
        const regex = rule.value instanceof RegExp
          ? rule.value
          : new RegExp(String(rule.value));
        if (!pattern(value, regex)) {
          errors.push({ field: rule.field, rule: 'pattern', message: msg });
        }
        break;
      }
      case 'range': {
        if (value == null) break;
        const range = rule.value as { min: number; max: number };
        if (!range || typeof range.min !== 'number' || typeof range.max !== 'number') {
          throw new Error(`Invalid range value for ${rule.field}`);
        }
        if (!inRange(value, range.min, range.max)) {
          errors.push({ field: rule.field, rule: 'range', message: msg });
        }
        break;
      }
      case 'enum': {
        if (value == null) break;
        const allowed = rule.value as unknown[];
        if (!Array.isArray(allowed)) {
          throw new Error(`Invalid enum value for ${rule.field}`);
        }
        if (!oneOf(value, allowed)) {
          errors.push({ field: rule.field, rule: 'enum', message: msg });
        }
        break;
      }
      case 'custom': {
        const fn = rule.value as ((v: unknown) => boolean);
        if (typeof fn !== 'function') {
          throw new Error(`Invalid custom validator for ${rule.field}`);
        }
        try {
          if (!fn(value)) {
            errors.push({ field: rule.field, rule: 'custom', message: msg });
          }
        } catch (e) {
          errors.push({ field: rule.field, rule: 'custom', message: String(e) });
        }
        break;
      }
      default: {
        throw new Error(`Unknown validation rule type: ${rule.type}`);
      }
    }
  }

  // Cross-field validation — mutual exclusion
  const hasSourceField = record.source_url || record.source_file;
  const hasBodyField = record.body || record.content;
  if (hasSourceField && hasBodyField) {
    errors.push({
      field: 'source',
      rule: 'mutual-exclusion',
      message: 'Cannot provide both source_url/source_file and body/content — choose one',
    });
  }

  // Cross-field — conditional requirement
  if (record.notify && !record.notify_channel) {
    errors.push({
      field: 'notify_channel',
      rule: 'conditional-required',
      message: 'notify_channel is required when notify is true',
    });
  }

  // Date ordering check
  if (record.start_date && record.end_date) {
    const start = new Date(String(record.start_date));
    const end = new Date(String(record.end_date));
    if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && start > end) {
      errors.push({
        field: 'end_date',
        rule: 'date-order',
        message: 'end_date must be after start_date',
      });
    }
  }

  return errors;
}
