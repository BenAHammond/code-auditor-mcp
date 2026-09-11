/**
 * Cross-Language Schema Validator
 * Validates schema consistency across language boundaries
 */

import { CrossLanguageEntity } from '../../types/crossLanguage.js';
import { Violation } from '../../types.js';

export interface SchemaDefinition {
  id: string;
  name: string;
  type: 'protobuf' | 'graphql' | 'json-schema' | 'openapi' | 'typescript-interface' | 'go-struct';
  language: string;
  file: string;
  line: number;
  fields: SchemaField[];
  version?: string;
  deprecated?: boolean;
}

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  constraints?: FieldConstraints;
  deprecated?: boolean;
}

export interface FieldConstraints {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
}

export interface SchemaViolation extends Violation {
  rule: 'field-mismatch' | 'schema-field-mismatch' | 'missing-field' | 'extra-field' | 'constraint-mismatch' | 'version-mismatch';
  violationType: 'field-mismatch' | 'schema-field-mismatch' | 'missing-field' | 'extra-field' | 'constraint-mismatch' | 'version-mismatch';
  schemas: SchemaDefinition[];
  fieldName?: string;
  expectedType?: string;
  actualType?: string;
  suggestion: string;
}

export interface SchemaValidationOptions {
  strictTypeChecking?: boolean;
  allowAdditionalFields?: boolean;
  checkDeprecated?: boolean;
  versionTolerance?: 'strict' | 'minor' | 'major';
  ignoreOptionalFields?: boolean;
}

/**
 * A single field compared across two language implementations of a schema.
 * Bundles the field name, the reference/current field definitions, and the
 * two schema definitions so the comparison helpers take one context object
 * rather than five positional arguments.
 */
interface FieldComparison {
  fieldName: string;
  refField: SchemaField;
  curField: SchemaField;
  reference: SchemaDefinition;
  current: SchemaDefinition;
}

/**
 * Schema validator.
 */
export class SchemaValidator {
  private options: SchemaValidationOptions;

  /**
   * Constructor.
   * @param options
   */
  constructor(options: SchemaValidationOptions = {}) {
    this.options = {
      strictTypeChecking: true,
      allowAdditionalFields: false,
      checkDeprecated: true,
      versionTolerance: 'minor',
      ignoreOptionalFields: false,
      ...options
    };
  }

  /**
   * Validate schema consistency across multiple languages
   * @param schemas
   * @returns
   */
  async validateSchemas(schemas: SchemaDefinition[]): Promise<SchemaViolation[]> {
    const violations: SchemaViolation[] = [];

    // Cross-language comparison only. Group schemas by normalized name, then
    // compare one representative per language against the reference language.
    // Same-language duplicates (e.g. two TypeScript interfaces sharing a name
    // in different modules) are not a cross-language contract and are out of
    // scope; per-schema naming/deprecation hygiene is owned by the conventions
    // analyzer, not this validator.
    const schemaGroups = groupSchemasByName(schemas);
    for (const groupSchemas of schemaGroups.values()) {
      const byLanguage = new Map<string, SchemaDefinition>();
      for (const schema of groupSchemas) {
        if (!byLanguage.has(schema.language)) byLanguage.set(schema.language, schema);
      }
      if (byLanguage.size < 2) continue;

      const [reference, ...others] = [...byLanguage.values()];
      for (const current of others) {
        violations.push(...await this.compareSchemas(reference, current));
      }
    }

    return violations;
  }

  /**
   * Compare two schemas for compatibility
   */
  private async compareSchemas(
    reference: SchemaDefinition,
    current: SchemaDefinition
  ): Promise<SchemaViolation[]> {
    const violations: SchemaViolation[] = [];

    // Check version compatibility
    if (reference.version && current.version) {
      const versionViolation = this.checkVersionCompatibility(reference, current);
      if (versionViolation) violations.push(versionViolation);
    }

    // Create field maps for easier comparison
    const refFields = new Map(reference.fields.map(f => [f.name, f]));
    const curFields = new Map(current.fields.map(f => [f.name, f]));

    violations.push(...this.checkMissingFields(refFields, curFields, reference, current));
    violations.push(...this.checkExtraFields(refFields, curFields, reference, current));
    violations.push(...this.checkFieldTypes(refFields, curFields, reference, current));

    return violations;
  }

  /**
   * Check for required fields missing from the current schema.
   */
  private checkMissingFields(
    refFields: Map<string, SchemaField>,
    curFields: Map<string, SchemaField>,
    reference: SchemaDefinition,
    current: SchemaDefinition
  ): SchemaViolation[] {
    const violations: SchemaViolation[] = [];

    for (const [fieldName, refField] of refFields) {
      if (!refField.required || curFields.has(fieldName)) continue;
      violations.push({
        file: current.file,
        line: current.line,
        severity: 'warning',
        message: `Missing required field '${fieldName}' in ${current.type} ${current.name}`,
        rule: "missing-field",
        violationType: 'missing-field',
        schemas: [reference, current],
        fieldName,
        suggestion: `Add field '${fieldName}: ${refField.type}' to ${current.name}`,
        analyzer: 'schema-validator',
        category: 'cross-language-schema'
      });
    }

    return violations;
  }

  /**
   * Check for fields present in the current schema but missing from the reference.
   */
  private checkExtraFields(
    refFields: Map<string, SchemaField>,
    curFields: Map<string, SchemaField>,
    reference: SchemaDefinition,
    current: SchemaDefinition
  ): SchemaViolation[] {
    const violations: SchemaViolation[] = [];

    if (this.options.allowAdditionalFields) return violations;

    for (const [fieldName] of curFields) {
      if (refFields.has(fieldName)) continue;
      violations.push({
        file: current.file,
        line: current.line,
        severity: 'warning',
        message: `Extra field '${fieldName}' in ${current.type} ${current.name}`,
        rule: 'extra-field',
        violationType: 'extra-field',
        schemas: [reference, current],
        fieldName,
        suggestion: `Remove field '${fieldName}' or add it to the reference schema`,
        analyzer: 'schema-validator',
        category: 'cross-language-schema'
      });
    }

    return violations;
  }

  /**
   * Check type/constraint compatibility for fields present in both schemas.
   */
  private checkFieldTypes(
    refFields: Map<string, SchemaField>,
    curFields: Map<string, SchemaField>,
    reference: SchemaDefinition,
    current: SchemaDefinition
  ): SchemaViolation[] {
    const violations: SchemaViolation[] = [];

    for (const [fieldName, refField] of refFields) {
      const curField = curFields.get(fieldName);
      if (!curField) continue;

      const cmp: FieldComparison = { fieldName, refField, curField, reference, current };
      const typeViolation = this.compareFieldTypes(cmp);
      if (typeViolation) violations.push(typeViolation);

      violations.push(...this.compareFieldConstraints(cmp));
    }

    return violations;
  }

  /**
   * Check version compatibility between schemas
   */
  private checkVersionCompatibility(
    reference: SchemaDefinition,
    current: SchemaDefinition
  ): SchemaViolation | null {
    if (!reference.version || !current.version) return null;

    const refVersion = parseVersion(reference.version);
    const curVersion = parseVersion(current.version);

    const compatible = this.areVersionsCompatible(refVersion, curVersion);

    if (!compatible) {
      return {
        file: current.file,
        line: current.line,
        severity: 'warning',
        message: `Version mismatch: ${reference.name} v${reference.version} vs v${current.version}`,
        rule: "version-mismatch",
        violationType: 'version-mismatch',
        schemas: [reference, current],
        suggestion: 'Ensure schemas are using compatible versions',
        analyzer: 'schema-validator',
        category: 'cross-language-schema'
      };
    }

    return null;
  }

  /**
   * Compare field types between schemas
   */
  private compareFieldTypes(cmp: FieldComparison): SchemaViolation | null {
    const { fieldName, refField, curField, reference: refSchema, current: curSchema } = cmp;
    const normalizedRefType = normalizeType(refField.type, refSchema.language);
    const normalizedCurType = normalizeType(curField.type, curSchema.language);

    if (this.options.strictTypeChecking) {
      if (normalizedRefType !== normalizedCurType) {
        return {
          file: curSchema.file,
          line: curSchema.line,
          severity: 'warning',
          message: `Type-name strings differ for field '${fieldName}': expected ${normalizedRefType}, got ${normalizedCurType}`,
          rule: "schema-field-mismatch",
          violationType: 'schema-field-mismatch',
          schemas: [refSchema, curSchema],
          fieldName,
          expectedType: normalizedRefType,
          actualType: normalizedCurType,
          suggestion: `Change field type to ${normalizedRefType} or update the reference schema`,
          analyzer: 'schema-validator',
          category: 'cross-language-schema'
        };
      }
    } else {
      // Loose type checking - check for compatibility
      if (!areTypesCompatible(normalizedRefType, normalizedCurType)) {
        return {
          file: curSchema.file,
          line: curSchema.line,
          severity: 'warning',
          message: `Potentially incompatible types for field '${fieldName}': ${normalizedRefType} vs ${normalizedCurType}`,
          rule: "schema-field-mismatch",
          violationType: 'schema-field-mismatch',
          schemas: [refSchema, curSchema],
          fieldName,
          expectedType: normalizedRefType,
          actualType: normalizedCurType,
          suggestion: 'Verify type compatibility across language boundaries',
          analyzer: 'schema-validator',
          category: 'cross-language-schema'
        };
      }
    }

    return null;
  }

  /**
   * Compare field constraints
   */
  private compareFieldConstraints(cmp: FieldComparison): SchemaViolation[] {
    const { fieldName, refField, curField, reference: refSchema, current: curSchema } = cmp;
    const violations: SchemaViolation[] = [];

    if (!refField.constraints || !curField.constraints) return violations;

    const refConstraints = refField.constraints;
    const curConstraints = curField.constraints;

    // Check length constraints
    if (refConstraints.minLength !== curConstraints.minLength ||
        refConstraints.maxLength !== curConstraints.maxLength) {
      violations.push({
        file: curSchema.file,
        line: curSchema.line,
        severity: 'warning',
        message: `Length constraint mismatch for field '${fieldName}'`,
        rule: "constraint-mismatch",
        violationType: 'constraint-mismatch',
        schemas: [refSchema, curSchema],
        fieldName,
        suggestion: 'Align length constraints across schema implementations',
        analyzer: 'schema-validator',
        category: 'cross-language-schema'
      });
    }

    // Check numeric constraints
    if (refConstraints.minimum !== curConstraints.minimum ||
        refConstraints.maximum !== curConstraints.maximum) {
      violations.push({
        file: curSchema.file,
        line: curSchema.line,
        severity: 'warning',
        message: `Numeric constraint mismatch for field '${fieldName}'`,
        rule: "constraint-mismatch",
        violationType: 'constraint-mismatch',
        schemas: [refSchema, curSchema],
        fieldName,
        suggestion: 'Align numeric constraints across schema implementations',
        analyzer: 'schema-validator',
        category: 'cross-language-schema'
      });
    }

    return violations;
  }

  /**
   * Check if versions are compatible
   */
  private areVersionsCompatible(v1: any, v2: any): boolean {
    switch (this.options.versionTolerance) {
      case 'strict':
        return v1.major === v2.major && v1.minor === v2.minor && v1.patch === v2.patch;
      case 'minor':
        return v1.major === v2.major && v1.minor === v2.minor;
      case 'major':
        return v1.major === v2.major;
      default:
        return true;
    }
  }
}

// ---------------------------------------------------------------------------
// Stateless utilities (pure functions — no validator state)
// ---------------------------------------------------------------------------

/**
 * Group schemas by name
 */
function groupSchemasByName(schemas: SchemaDefinition[]): Map<string, SchemaDefinition[]> {
  const groups = new Map<string, SchemaDefinition[]>();

  for (const schema of schemas) {
    const normalizedName = normalizeSchemaName(schema.name);
    if (!groups.has(normalizedName)) {
      groups.set(normalizedName, []);
    }
    groups.get(normalizedName)!.push(schema);
  }

  return groups;
}

/**
 * Normalize schema name for comparison
 */
function normalizeSchemaName(name: string): string {
  // Lowercase and strip separators only, so snake_case (TS) and PascalCase (Go)
  // spellings of the same logical schema group together. Do NOT strip
  // request/response/dto/model suffixes — those are distinct schemas, and
  // stripping them collapsed e.g. User, UserDto, and UserRequest into one
  // group, producing false missing/extra-field pairs.
  return name.toLowerCase().replace(/[-_]/g, '');
}

/**
 * Count cross-language schema pairs — groups of the same logical schema name
 * implemented in ≥2 languages. Returns the number of comparisons
 * {@link SchemaValidator.validateSchemas} would perform (one reference plus
 * every additional language per group). A single-language corpus (or one with
 * no schemas at all) yields zero, which the caller uses to report "no
 * cross-language pairs found" instead of a misleadingly clean zero.
 * @param schemas
 * @returns
 */
export function countCrossLanguagePairs(schemas: SchemaDefinition[]): number {
  let pairs = 0;
  for (const groupSchemas of groupSchemasByName(schemas).values()) {
    const languages = new Set(groupSchemas.map(s => s.language));
    if (languages.size >= 2) pairs += languages.size - 1;
  }
  return pairs;
}

/**
 * Canonical primitive aliases per language.
 *
 * Maps each language's primitive spellings to a canonical category name
 * (`string` / `number` / `boolean` / `datetime` / `any`). Numeric aliases stay
 * one category — for a cross-language API contract a TS `number` legitimately
 * represents both Go `int64` and `float64`, so splitting integer vs float would
 * manufacture false mismatches. Non-primitive (named/structural) types are not
 * in this table; they are normalized structurally by {@link normalizeType}.
 */
const PRIMITIVE_ALIASES: Record<string, Record<string, string>> = {
  'typescript': {
    'string': 'string',
    'number': 'number',
    'bigint': 'number',
    'integer': 'number',
    'long': 'number',
    'double': 'number',
    'float': 'number',
    'boolean': 'boolean',
    'bool': 'boolean',
    'Date': 'datetime',
    'any': 'any',
    'unknown': 'any',
    'object': 'any',
  },
  'go': {
    'string': 'string',
    'int': 'number', 'int8': 'number', 'int16': 'number', 'int32': 'number', 'int64': 'number',
    'uint': 'number', 'uint8': 'number', 'uint16': 'number', 'uint32': 'number', 'uint64': 'number', 'uintptr': 'number',
    'byte': 'number', 'rune': 'number',
    'float32': 'number', 'float64': 'number',
    'bool': 'boolean',
    'time.Time': 'datetime',
    'any': 'any', 'interface{}': 'any', 'interface': 'any',
  },
  'python': {
    'str': 'string',
    'int': 'number',
    'float': 'number',
    'bool': 'boolean',
    'datetime': 'datetime',
    'date': 'datetime',
  },
};

/** Union members that contribute nullability and nothing else to a type. */
const NULL_MARKERS = new Set(['null', 'undefined', 'void', 'nil']);

/**
 * Strip nullability from a type: Go `*T` / TS `?T` leading markers, and
 * `null`/`undefined`/`void`/`nil` union members. A type whose union is entirely
 * null markers reduces to `null`; a multi-member union that survives is left
 * joined (a genuine union is a distinct shape).
 */
function stripNullability(type: string): string {
  let t = type.trim();
  while (t.startsWith('*') || t.startsWith('?')) t = t.slice(1).trim();
  if (t.includes('|')) {
    const members = t.split('|').map(m => m.trim()).filter(m => !NULL_MARKERS.has(m));
    if (members.length === 0) return 'null';
    if (members.length === 1) return members[0];
    return members.join('|');
  }
  return t;
}

/**
 * Normalize a type name to a canonical structural form, cross-language.
 *
 * The old proxy returned a handful of mapped primitives and fell back to the
 * raw string for everything else, so equivalent cross-language spellings were
 * judged by exact string equality: Go `[]User` vs TS `User[]`, Go `*string` vs
 * TS `string`, Go `map[string]User` vs TS `Record<string, User>`, and any Go
 * numeric alias absent from the map all fired as false mismatches.
 *
 * The real computation folds those spellings to a common form:
 *   - nullability is stripped (`*T`, `?T`, `| null`),
 *   - containers are normalized (`[]T` / `T[]` / `[N]T` / `Array<T>` →
 *     `list<T>`; `map[K]V` / `Record<K,V>` → `map<K,V>`), recursively,
 *   - primitive leaves are mapped via {@link PRIMITIVE_ALIASES}.
 *
 * A named type with no alias maps through unchanged, so two identical named
 * types still compare equal and two different named types still differ.
 */
function normalizeType(type: string, language: string): string {
  const t = stripNullability(type);
  if (!t) return 'any';

  // Map: `map[K]V` (Go) / `Record<K,V>` / `Map<K,V>` (TS).
  let m = t.match(/^map\[(.+)\](.+)$/);
  if (m) return `map<${normalizeType(m[1], language)},${normalizeType(m[2], language)}>`;
  m = t.match(/^(?:Record|Map)<(.+),\s*(.+)>$/);
  if (m) return `map<${normalizeType(m[1], language)},${normalizeType(m[2], language)}>`;

  // Slice / array: `[]T` and `[N]T` (Go) / `T[]` (TS) / `Array<T>` / `List<T>`.
  m = t.match(/^\[\](.+)$/) || t.match(/^\[[0-9]*\](.+)$/);
  if (m) return `list<${normalizeType(m[1], language)}>`;
  m = t.match(/^(.+)\[\]$/);
  if (m) return `list<${normalizeType(m[1], language)}>`;
  m = t.match(/^(?:Array|List|ArrayList)<(.+)>$/);
  if (m) return `list<${normalizeType(m[1], language)}>`;

  return PRIMITIVE_ALIASES[language]?.[t] || t;
}

/**
 * Check if two normalized types are compatible (loose mode).
 *
 * After normalization, most cross-language equivalences are already equal, so
 * loose compatibility reduces to: equality, `any` as a wildcard, and recursive
 * comparison of container elements.
 */
function areTypesCompatible(type1: string, type2: string): boolean {
  if (type1 === type2) return true;
  if (type1 === 'any' || type2 === 'any') return true;

  const l1 = type1.match(/^list<(.+)>$/);
  const l2 = type2.match(/^list<(.+)>$/);
  if (l1 && l2) return areTypesCompatible(l1[1], l2[1]);

  const m1 = type1.match(/^map<(.+),(.+)>$/);
  const m2 = type2.match(/^map<(.+),(.+)>$/);
  if (m1 && m2) return areTypesCompatible(m1[1], m2[1]) && areTypesCompatible(m1[2], m2[2]);

  return false;
}

/**
 * Parse version string
 */
function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0
  };
}

// ---------------------------------------------------------------------------
// Schema extraction (pure functions — no validator state)
// ---------------------------------------------------------------------------

/**
 * Extract schema definitions from entities
 * @param entities
 * @returns
 */
export function extractSchemas(entities: CrossLanguageEntity[]): SchemaDefinition[] {
  const schemas: SchemaDefinition[] = [];

  for (const entity of entities) {
    // TypeScript interfaces
    if (entity.language === 'typescript' && entity.type === 'interface') {
      const schema = extractTypeScriptInterface(entity);
      if (schema) schemas.push(schema);
    }

    // Go structs
    if (entity.language === 'go' && entity.type === 'struct') {
      const schema = extractGoStruct(entity);
      if (schema) schemas.push(schema);
    }

    // protobuf / GraphQL / JSON Schema files are detected but NOT extracted
    // here. Pushing an empty-field schema for them silently degrades a real
    // comparison into a spurious "missing/extra field" or a false "clean".
    // Callers surface them via getUnimplementedSchemaExtractions() as a
    // notApplicable reason ("protobuf extraction not implemented") instead.
  }

  return schemas;
}

function extractTypeScriptInterface(entity: CrossLanguageEntity): SchemaDefinition | null {
  if (entity.type !== 'interface') return null;

  return {
    id: entity.id,
    name: entity.name,
    type: 'typescript-interface',
    language: 'typescript',
    file: entity.file,
    line: entity.startLine || 0,
    fields: entity.parameters?.map(param => ({
      name: param.name,
      type: param.type || 'any',
      required: !param.optional,
      description: param.description
    })) || []
  };
}

/**
 * True when a Go field type is a non-nilable value type (hence always present),
 * i.e. "required". Nilable reference types — pointers, slices, maps, channels,
 * functions, and the built-in interface types — are optional.
 * @param type
 * @returns
 */
export function isGoValueType(type: string | undefined): boolean {
  if (!type) return false;
  const t = type.trim();
  if (t === 'interface' || t === 'interface{}' || t === 'any' || t === 'error') {
    return false;
  }
  // Nilable reference types. `[]` is a slice (nilable); `[N]` is a fixed-size
  // array (value type), so only the empty-bracket form is nilable.
  if (t.startsWith('*')) return false;       // pointer
  if (t.startsWith('[]')) return false;       // slice
  if (t.startsWith('map[')) return false;     // map
  if (t.startsWith('chan') || t.startsWith('<-chan')) return false; // channel
  if (t.startsWith('func')) return false;     // function
  return true;
}

function extractGoStruct(entity: CrossLanguageEntity): SchemaDefinition | null {
  if (entity.type !== 'struct') return null;

  const fields = entity.metadata?.fields?.map((field: any) => ({
    name: field.name,
    type: field.type,
    // A Go field is required iff it is a non-nilable value type. Pointers
    // (`*T`), slices, maps, channels, functions, and interfaces are nilable and
    // therefore optional. The old `isExported` proxy was inverted: an exported
    // pointer (`Email *string`) is optional, and an unexported value (`id int`)
    // is always present — exportedness is a visibility signal, not a
    // requiredness one.
    required: isGoValueType(field.type),
    description: field.tag
  })) || [];

  return {
    id: entity.id,
    name: entity.name,
    type: 'go-struct',
    language: 'go',
    file: entity.file,
    line: entity.startLine || 0,
    fields
  };
}

export interface UnimplementedSchemaExtraction {
  language: 'protobuf' | 'graphql' | 'json-schema';
  reason: string;
}

/**
 * Detect schema-bearing files whose extraction is not implemented yet, so a
 * caller can state the gap as a notApplicable reason ("protobuf extraction not
 * implemented") rather than silently comparing nothing. Returns one entry per
 * distinct unimplemented language present in the corpus.
 */
export function getUnimplementedSchemaExtractions(entities: CrossLanguageEntity[]): UnimplementedSchemaExtraction[] {
  const seen = new Set<string>();
  const result: UnimplementedSchemaExtraction[] = [];

  const note = (language: 'protobuf' | 'graphql' | 'json-schema') => {
    if (seen.has(language)) return;
    seen.add(language);
    result.push({ language, reason: `${language} extraction not implemented` });
  };

  for (const entity of entities) {
    if (entity.file.endsWith('.proto')) note('protobuf');
    else if (entity.file.endsWith('.graphql') || entity.file.endsWith('.gql')) note('graphql');
    else if (entity.file.endsWith('.json') && entity.name.toLowerCase().includes('schema')) note('json-schema');
  }

  return result;
}
