/**
 * Spec 34 — JSON Schema validation (schema-json Stage 2 visitor + reducer
 * input). Extracted to module-level free functions; the only public entry
 * point is `analyzeJsonSchemas`, consumed by pipelineAdapters.ts via the
 * module surface.
 *
 * Dependency direction is leaf -> parent:
 *   jsonSchema.ts --(types, config, violations, pipeline)
 */

import type { AnalyzerResult, Violation as BaseViolation } from '../../../types.js';
import type { SchemaAnalyzerConfig } from './types.js';
import { DEFAULT_SCHEMA_CONFIG } from './config.js';
import { emitViolation } from './violations.js';
import { makeVisitorStatus } from '../../../pipeline.js';

// ---------------------------------------------------------------------------
// JSON Schema validation (extracted to module-level free functions)
// ---------------------------------------------------------------------------

/**
 * Validation context threaded through the JSON-schema helpers to keep their
 * parameter lists small.
 */
interface ValidationCtx {
  filePath: string;
  config: SchemaAnalyzerConfig;
  violations: BaseViolation[];
}

/**
 * Analyze JSON schemas and validate data files against them.
 *
 * Pipeline-refactored: accepts a list of JSON file paths plus an on-demand
 * parser so parsed objects are transient (one file at a time) rather than
 * retained in memory for the whole Stage 3 reducer run.
 *
* @param files JSON file paths to validate
* @param readJson on-demand parser: returns the parsed object, or null when
 *   the file failed to parse (invalid JSON) or was absent.
* @param config Schema analyzer configuration
* @param analyzerName name reported in the returned AnalyzerResult
* @returns the aggregate JSON-schema validation result
 */
export function analyzeJsonSchemas(
  files: string[],
  readJson: (filePath: string) => object | null,
  config: SchemaAnalyzerConfig,
  analyzerName = 'schema'
): AnalyzerResult {
  const startTime = Date.now();
  const finalConfig = { ...DEFAULT_SCHEMA_CONFIG, ...config };

  if (!finalConfig.validateJsonSchemas) {
    return jsonResult({ violations: [], errors: [], filesProcessed: 0 }, 0, analyzerName);
  }

  const schemaFiles = identifySchemaFiles(files, finalConfig);
  const dataFiles = identifyDataFiles(files, finalConfig);
  const unknownJsonFiles = files.filter(
    f => !schemaFiles.includes(f) && !dataFiles.includes(f)
  );

  const state: JsonRunState = { violations: [], errors: [], filesProcessed: 0 };
  const scan: JsonScanCtx = { files, readJson, config: finalConfig, state };
  const schemas = loadSchemas(schemaFiles, scan);

  if (finalConfig.schemaDataPairs) {
    validatePairedData(schemas, scan);
  } else {
    validateDiscoveredData([...dataFiles, ...unknownJsonFiles], unknownJsonFiles, schemas, scan);
  }

  return jsonResult(state, Date.now() - startTime, analyzerName);
}

interface JsonRunState {
  violations: BaseViolation[];
  errors: Array<{ file: string; error: string }>;
  filesProcessed: number;
}

interface JsonScanCtx {
  files: string[];
  readJson: (filePath: string) => object | null;
  config: SchemaAnalyzerConfig;
  state: JsonRunState;
}

function jsonResult(
  state: JsonRunState,
  executionTime: number,
  analyzerName: string
): AnalyzerResult {
  return {
    violations: state.violations,
    errors: state.errors,
    status: makeVisitorStatus(state.filesProcessed),
    executionTime,
    analyzerName,
  };
}

function loadSchemas(schemaFiles: string[], scan: JsonScanCtx): Map<string, any> {
  const schemas = new Map<string, any>();
  for (const file of schemaFiles) {
    try {
      const schema = scan.readJson(file);
      if (schema === null) throw new SyntaxError('JSON parse failed');
      schemas.set(file, schema);
      scan.state.violations.push(...validateJsonSchema(schema, file, scan.config));
      scan.state.filesProcessed++;
    } catch (error) {
      if (error instanceof SyntaxError) {
        scan.state.violations.push(
          emitViolation(file, 'warning', `Invalid JSON: ${error.message}`, 'invalid-json')
        );
      } else {
        scan.state.errors.push({
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      scan.state.filesProcessed++;
    }
  }
  return schemas;
}

function validatePairedData(schemas: Map<string, any>, scan: JsonScanCtx): void {
  for (const pair of scan.config.schemaDataPairs!) {
    const schema = schemas.get(pair.schema) ?? scan.readJson(pair.schema);
    if (schema) {
      const dataFiles = Array.isArray(pair.data) ? pair.data : [pair.data];
      for (const dataFile of dataFiles) {
        if (scan.files.includes(dataFile)) {
          const parsed = scan.readJson(dataFile);
          if (parsed !== null) {
            const dataViolations: BaseViolation[] = [];
            validateAgainstSchema(parsed, schema, {
              filePath: dataFile,
              config: scan.config,
              violations: dataViolations,
            });
            scan.state.violations.push(...dataViolations);
          } else {
            scan.state.violations.push(
              emitViolation(dataFile, 'warning', 'Invalid JSON in data file', 'invalid-json')
            );
          }
          scan.state.filesProcessed++;
        }
      }
    }
  }
}

function validateDiscoveredData(
  dataFiles: string[],
  unknownJsonFiles: string[],
  schemas: Map<string, any>,
  scan: JsonScanCtx
): void {
  for (const dataFile of dataFiles) {
    const matchedSchema = findMatchingSchema(dataFile, schemas);
    if (matchedSchema) {
      const parsed = scan.readJson(dataFile);
      if (parsed !== null) {
        const dataViolations: BaseViolation[] = [];
        validateAgainstSchema(parsed, matchedSchema, {
          filePath: dataFile,
          config: scan.config,
          violations: dataViolations,
        });
        scan.state.violations.push(...dataViolations);
      }
    } else if (unknownJsonFiles.includes(dataFile)) {
      const parsed = scan.readJson(dataFile);
      if (parsed === null) {
        scan.state.violations.push(
          emitViolation(dataFile, 'warning', 'Invalid JSON: Parse error', 'invalid-json')
        );
      }
    }
    scan.state.filesProcessed++;
  }
}

function validateJsonSchema(
  schema: any,
  filePath: string,
  config: SchemaAnalyzerConfig
): BaseViolation[] {
  const ctx: ValidationCtx = { filePath, config, violations: [] };

  if (!schema.$schema && config.jsonSchemaVersion) {
    emit(ctx, 'suggestion', 'missing-schema-declaration', 'JSON Schema missing $schema declaration');
  }

  validateSchemaTypes(schema, ctx);

  if (schema.type === 'object' && schema.properties) {
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!schema.properties[field]) {
          emit(ctx, 'warning', 'undefined-required-field', `Required field "${field}" not defined in properties`);
        }
      }
    }
  }

  return ctx.violations;
}

function validateSchemaTypes(schema: any, ctx: ValidationCtx, path = ''): void {
  if (!schema || typeof schema !== 'object') return;

  checkSchemaTypeField(schema, ctx, path);
  checkNumericRangeField(schema, ctx, path);

  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) {
      validateSchemaTypes(value, ctx, `${path}.${key}`);
    }
  }
  if (schema.items) {
    validateSchemaTypes(schema.items, ctx, `${path}[items]`);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    validateSchemaTypes(schema.additionalProperties, ctx, `${path}[additionalProperties]`);
  }
}

function checkSchemaTypeField(schema: any, ctx: ValidationCtx, path: string): void {
  if (schema.type && ctx.config.allowedJsonTypes) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const type of types) {
      if (!ctx.config.allowedJsonTypes.includes(type)) {
        emit(ctx, 'warning', 'invalid-type',
          `Invalid type "${type}" at ${path || 'root'}. Allowed types: ${ctx.config.allowedJsonTypes.join(', ')}`);
      }
    }
  }
}

function checkNumericRangeField(schema: any, ctx: ValidationCtx, path: string): void {
  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.minimum !== undefined && schema.maximum !== undefined) {
      if (schema.minimum > schema.maximum) {
        emit(ctx, 'warning', 'invalid-range',
          `Invalid range at ${path}: minimum (${schema.minimum}) > maximum (${schema.maximum})`);
      }
    }
  }
}

function identifySchemaFiles(files: string[], config: SchemaAnalyzerConfig): string[] {
  if (!config.schemaFilePatterns) return [];
  return files.filter(file => {
    const fileName = file.split('/').pop() || '';
    return config.schemaFilePatterns!.some(pattern => {
      const regex = new RegExp(pattern.replace('*', '.*'));
      return regex.test(fileName);
    });
  });
}

function identifyDataFiles(files: string[], config: SchemaAnalyzerConfig): string[] {
  if (!config.dataFilePatterns) return [];
  return files.filter(file => {
    const fileName = file.split('/').pop() || '';
    return config.dataFilePatterns!.some(pattern => {
      const regex = new RegExp(pattern.replace('*', '.*'));
      return regex.test(fileName);
    });
  });
}

function findMatchingSchema(dataFile: string, schemas: Map<string, any>): any | null {
  const dataFileName = dataFile.split('/').pop() || '';
  const dataBaseName = dataFileName.replace(/\.(data|example|test)\.json$/, '');

  for (const [schemaFile, schema] of schemas) {
    const schemaFileName = schemaFile.split('/').pop() || '';
    const schemaBaseName = schemaFileName.replace(/[.-]?schema\.json$/, '');

    if (dataBaseName === schemaBaseName) {
      return schema;
    }
  }

  if (schemas.size === 1) {
    return schemas.values().next().value;
  }

  return null;
}

function validateAgainstSchema(data: any, schema: any, ctx: ValidationCtx, path = ''): void {
  if (schema.type) {
    const actualType = actualTypeOf(data);
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];

    if (!matchesSchemaType(data, actualType, allowedTypes)) {
      emit(ctx, 'warning', 'type-mismatch',
        `Type mismatch at ${path || 'root'}: expected ${allowedTypes.join(' | ')}, got ${actualType}`);
      return;
    }
  }

  checkStringConstraints(data, schema, ctx, path);
  checkNumberConstraints(data, schema, ctx, path);
  checkArrayConstraints(data, schema, ctx, path);
  checkObjectConstraints(data, schema, ctx, path);
  checkEnumConstraint(data, schema, ctx, path);
}

function actualTypeOf(data: any): string {
  if (Array.isArray(data)) return 'array';
  if (data === null) return 'null';
  return typeof data;
}

function matchesSchemaType(data: any, actualType: string, allowedTypes: string[]): boolean {
  return allowedTypes.some((type: string) => {
    if (type === 'integer') {
      return typeof data === 'number' && Number.isInteger(data);
    }
    return type === actualType;
  });
}

function checkStringConstraints(data: any, schema: any, ctx: ValidationCtx, path: string): void {
  if (schema.type !== 'string' || typeof data !== 'string') return;

  if (schema.minLength !== undefined && data.length < schema.minLength) {
    emit(ctx, 'warning', 'string-too-short', `String at ${path} too short: ${data.length} < ${schema.minLength}`);
  }
  if (schema.maxLength !== undefined && data.length > schema.maxLength) {
    emit(ctx, 'warning', 'string-too-long', `String at ${path} too long: ${data.length} > ${schema.maxLength}`);
  }
  if (schema.pattern) {
    const regex = new RegExp(schema.pattern);
    if (!regex.test(data)) {
      emit(ctx, 'warning', 'pattern-mismatch', `String at ${path} doesn't match pattern: ${schema.pattern}`);
    }
  }
  if (schema.format) {
    checkFormatConstraint(data, schema.format, ctx, path);
  }
}

function checkFormatConstraint(data: string, format: string, ctx: ValidationCtx, path: string): void {
  switch (format) {
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data)) {
        emit(ctx, 'warning', 'invalid-format', `Invalid email format at ${path}`);
      }
      break;
    case 'uuid':
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data)) {
        emit(ctx, 'warning', 'invalid-format', `Invalid UUID format at ${path}`);
      }
      break;
  }
}

function checkNumberConstraints(data: any, schema: any, ctx: ValidationCtx, path: string): void {
  if ((schema.type !== 'number' && schema.type !== 'integer') || typeof data !== 'number') return;

  if (schema.minimum !== undefined && data < schema.minimum) {
    emit(ctx, 'warning', 'below-minimum', `Value at ${path} below minimum: ${data} < ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && data > schema.maximum) {
    emit(ctx, 'warning', 'above-maximum', `Value at ${path} above maximum: ${data} > ${schema.maximum}`);
  }
}

function checkArrayConstraints(data: any, schema: any, ctx: ValidationCtx, path: string): void {
  if (schema.type !== 'array' || !Array.isArray(data)) return;

  if (schema.minItems !== undefined && data.length < schema.minItems) {
    emit(ctx, 'warning', 'too-few-items', `Array at ${path} has too few items: ${data.length} < ${schema.minItems}`);
  }
  if (schema.maxItems !== undefined && data.length > schema.maxItems) {
    emit(ctx, 'warning', 'too-many-items', `Array at ${path} has too many items: ${data.length} > ${schema.maxItems}`);
  }
  if (schema.items) {
    data.forEach((item: any, index: number) => {
      validateAgainstSchema(item, schema.items, ctx, `${path}[${index}]`);
    });
  }
}

function checkObjectConstraints(data: any, schema: any, ctx: ValidationCtx, path: string): void {
  if (schema.type !== 'object' || typeof data !== 'object' || data === null) return;

  if (schema.required && Array.isArray(schema.required)) {
    for (const requiredField of schema.required) {
      if (!(requiredField in data)) {
        emit(ctx, 'warning', 'missing-required-field', `Missing required field "${requiredField}" at ${path}`);
      }
    }
  }

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in data) {
        validateAgainstSchema(data[key], propSchema, ctx, path ? `${path}.${key}` : key);
      }
    }
  }

  if (schema.additionalProperties === false || (ctx.config.strictMode && !schema.additionalProperties)) {
    checkUnexpectedProperties(data, schema, ctx, path);
  } else if (typeof schema.additionalProperties === 'object') {
    checkAdditionalProperties(data, schema, ctx, path);
  }
}

function checkUnexpectedProperties(data: any, schema: any, ctx: ValidationCtx, path: string): void {
  const definedKeys = new Set(Object.keys(schema.properties || {}));
  for (const key of Object.keys(data)) {
    if (!definedKeys.has(key)) {
      emit(ctx, 'warning', 'unexpected-property', `Unexpected property "${key}" at ${path}`);
    }
  }
}

function checkAdditionalProperties(data: any, schema: any, ctx: ValidationCtx, path: string): void {
  const definedKeys = new Set(Object.keys(schema.properties || {}));
  for (const [key, value] of Object.entries(data)) {
    if (!definedKeys.has(key)) {
      validateAgainstSchema(value, schema.additionalProperties, ctx, path ? `${path}.${key}` : key);
    }
  }
}

function checkEnumConstraint(data: any, schema: any, ctx: ValidationCtx, path: string): void {
  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      emit(ctx, 'warning', 'enum-mismatch',
        `Value at ${path} not in enum: ${JSON.stringify(data)}. Allowed: ${schema.enum.join(', ')}`);
    }
  }
}

function emit(ctx: ValidationCtx, severity: BaseViolation['severity'], rule: string, message: string): void {
  ctx.violations.push({
    file: ctx.filePath,
    line: 1,
    column: 1,
    severity,
    message,
    rule,
    analyzer: 'schema',
  });
}

