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

    // Group schemas by name (different language implementations of same schema)
    const schemaGroups = groupSchemasByName(schemas);

    for (const [schemaName, groupSchemas] of schemaGroups) {
      if (groupSchemas.length > 1) {
        violations.push(...await this.validateSchemaGroup(schemaName, groupSchemas));
      }
    }

    // Validate individual schema consistency
    for (const schema of schemas) {
      violations.push(...await this.validateIndividualSchema(schema));
    }
    return violations;
  }

  /**
   * Validate a group of schemas that should be equivalent
   */
  private async validateSchemaGroup(
    schemaName: string,
    schemas: SchemaDefinition[]
  ): Promise<SchemaViolation[]> {
    const violations: SchemaViolation[] = [];

    // Use the first schema as the reference
    const reference = schemas[0];

    for (let i = 1; i < schemas.length; i++) {
      const current = schemas[i];
      violations.push(...await this.compareSchemas(reference, current));
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
   * Validate individual schema for internal consistency
   */
  private async validateIndividualSchema(schema: SchemaDefinition): Promise<SchemaViolation[]> {
    const violations: SchemaViolation[] = [];

    // Check for deprecated field usage
    if (this.options.checkDeprecated) {
      const deprecatedFields = schema.fields.filter(f => f.deprecated);
      if (deprecatedFields.length > 0) {
        violations.push({
          file: schema.file,
          line: schema.line,
          severity: 'warning',
          message: `Schema ${schema.name} contains ${deprecatedFields.length} deprecated fields`,
          rule: "field-mismatch",
          violationType: 'field-mismatch',
          schemas: [schema],
          suggestion: 'Review and migrate away from deprecated fields',
          analyzer: 'schema-validator',
          category: 'cross-language-schema'
        });
      }
    }

    // Check for naming consistency
    const namingViolations = this.checkFieldNaming(schema);
    violations.push(...namingViolations);

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
          message: `Type mismatch for field '${fieldName}': expected ${normalizedRefType}, got ${normalizedCurType}`,
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
   * Check field naming consistency
   */
  private checkFieldNaming(schema: SchemaDefinition): SchemaViolation[] {
    const violations: SchemaViolation[] = [];

    for (const field of schema.fields) {
      // Check for consistent naming convention
      if (!isConsistentNaming(field.name, schema.language)) {
        violations.push({
          file: schema.file,
          line: schema.line,
          severity: 'suggestion',
          message: `Field '${field.name}' doesn't follow ${schema.language} naming conventions`,
          rule: "field-mismatch",
          violationType: 'field-mismatch',
          schemas: [schema],
          fieldName: field.name,
          suggestion: `Use ${getRecommendedNaming(field.name, schema.language)} naming convention`,
          analyzer: 'schema-validator',
          category: 'cross-language-schema'
        });
      }
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
  return name.toLowerCase()
    .replace(/[-_]/g, '')
    .replace(/request|response|dto|model/g, '');
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

/**
 * Check if field name follows language conventions
 */
function isConsistentNaming(fieldName: string, language: string): boolean {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return /^[a-z][a-zA-Z0-9]*$/.test(fieldName); // camelCase
    case 'go':
      return /^[A-Z][a-zA-Z0-9]*$/.test(fieldName); // PascalCase for exported
    case 'python':
      return /^[a-z][a-z0-9_]*$/.test(fieldName); // snake_case
    default:
      return true;
  }
}

/**
 * Get recommended naming convention
 */
function getRecommendedNaming(fieldName: string, language: string): string {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return 'camelCase';
    case 'go':
      return 'PascalCase';
    case 'python':
      return 'snake_case';
    default:
      return 'consistent';
  }
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

function extractGoStruct(entity: CrossLanguageEntity): SchemaDefinition | null {
  if (entity.type !== 'struct') return null;

  const fields = entity.metadata?.fields?.map((field: any) => ({
    name: field.name,
    type: field.type,
    required: field.isExported, // Simplified assumption
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
