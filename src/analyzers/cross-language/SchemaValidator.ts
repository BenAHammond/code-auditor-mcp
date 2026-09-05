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
 * Normalize type names across languages
 */
function normalizeType(type: string, language: string): string {
  const typeMap: Record<string, Record<string, string>> = {
    'typescript': {
      'string': 'string',
      'number': 'number',
      'boolean': 'boolean',
      'Date': 'datetime',
      'any': 'any'
    },
    'go': {
      'string': 'string',
      'int': 'number',
      'int32': 'number',
      'int64': 'number',
      'float32': 'number',
      'float64': 'number',
      'bool': 'boolean',
      'time.Time': 'datetime'
    },
    'python': {
      'str': 'string',
      'int': 'number',
      'float': 'number',
      'bool': 'boolean',
      'datetime': 'datetime'
    }
  };

  return typeMap[language]?.[type] || type;
}

/**
 * Check if types are compatible across languages
 */
function areTypesCompatible(type1: string, type2: string): boolean {
  // Allow some common compatible types
  const compatibilityMatrix: Record<string, string[]> = {
    'string': ['string'],
    'number': ['number', 'integer', 'float'],
    'boolean': ['boolean', 'bool'],
    'datetime': ['datetime', 'timestamp', 'date'],
    'any': ['any', 'object', 'interface{}']
  };

  for (const [baseType, compatibleTypes] of Object.entries(compatibilityMatrix)) {
    if (compatibleTypes.includes(type1) && compatibleTypes.includes(type2)) {
      return true;
    }
  }

  return type1 === type2;
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

    // Protocol buffer definitions
    if (entity.file.endsWith('.proto')) {
      const schema = extractProtobufMessage(entity);
      if (schema) schemas.push(schema);
    }

    // GraphQL types
    if (entity.file.endsWith('.graphql') || entity.file.endsWith('.gql')) {
      const schema = extractGraphQLType(entity);
      if (schema) schemas.push(schema);
    }

    // JSON Schema
    if (entity.file.endsWith('.json') && entity.name.toLowerCase().includes('schema')) {
      const schema = extractJSONSchema(entity);
      if (schema) schemas.push(schema);
    }
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

function extractProtobufMessage(entity: CrossLanguageEntity): SchemaDefinition | null {
  // Simplified protobuf extraction
  return {
    id: entity.id,
    name: entity.name,
    type: 'protobuf',
    language: 'protobuf',
    file: entity.file,
    line: entity.startLine || 0,
    fields: [] // Would parse .proto file in real implementation
  };
}

function extractGraphQLType(entity: CrossLanguageEntity): SchemaDefinition | null {
  // Simplified GraphQL extraction
  return {
    id: entity.id,
    name: entity.name,
    type: 'graphql',
    language: 'graphql',
    file: entity.file,
    line: entity.startLine || 0,
    fields: [] // Would parse .graphql file in real implementation
  };
}

function extractJSONSchema(entity: CrossLanguageEntity): SchemaDefinition | null {
  // Simplified JSON Schema extraction
  return {
    id: entity.id,
    name: entity.name,
    type: 'json-schema',
    language: 'json',
    file: entity.file,
    line: entity.startLine || 0,
    fields: [] // Would parse JSON schema in real implementation
  };
}
