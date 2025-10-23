/**
 * Parity tests to ensure the universal schema analyzer produces identical results
 */

import { describe, it, expect } from 'vitest';
import { schemaAnalyzer as legacyAnalyzer } from '../../schemaAnalyzer.js';
import { schemaAnalyzer as universalAnalyzer } from '../../schemaAnalyzerCompat.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Test helper to create temporary test files
 */
async function createTestFile(content: string, filename: string): Promise<string> {
  const testDir = path.join(__dirname, 'temp');
  await fs.mkdir(testDir, { recursive: true });
  const filePath = path.join(testDir, filename);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

/**
 * Clean up test files
 */
async function cleanupTestFiles(): Promise<void> {
  const testDir = path.join(__dirname, 'temp');
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore if directory doesn't exist
  }
}

describe('Schema Analyzer Parity Tests', () => {
  afterEach(async () => {
    await cleanupTestFiles();
  });
  
  describe('JSON Schema Validation', () => {
    it('should produce identical results for valid JSON schema', async () => {
      const code = `
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1
    },
    "age": {
      "type": "integer",
      "minimum": 0
    }
  },
  "required": ["name"]
}
      `;
      
      const file = await createTestFile(code, 'valid-schema.json');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      // Should have no violations
      expect(universalResult.violations).toHaveLength(0);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
    
    it('should produce identical results for invalid JSON schema', async () => {
      const code = `
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "name": {
      "type": "invalid-type"
    },
    "age": {
      "type": "integer",
      "minimum": "not-a-number"
    }
  }
}
      `;
      
      const file = await createTestFile(code, 'invalid-schema.json');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations.length).toBeGreaterThan(0);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('OpenAPI Schema Validation', () => {
    it('should produce identical results for valid OpenAPI spec', async () => {
      const code = `
openapi: 3.0.0
info:
  title: Sample API
  version: 1.0.0
paths:
  /users:
    get:
      summary: Get all users
      responses:
        '200':
          description: Success
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: string
                    name:
                      type: string
      `;
      
      const file = await createTestFile(code, 'openapi.yaml');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
    
    it('should produce identical results for OpenAPI with missing required fields', async () => {
      const code = `
openapi: 3.0.0
paths:
  /users:
    get:
      responses:
        '200':
          description: Success
      `;
      
      const file = await createTestFile(code, 'incomplete-openapi.yaml');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Database Schema Analysis', () => {
    it('should produce identical results for SQL schema files', async () => {
      const code = `
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  total DECIMAL(10, 2) NOT NULL,
  -- Missing foreign key constraint
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
      `;
      
      const file = await createTestFile(code, 'schema.sql');
      const files = [file];
      
      const config = { checkDatabaseSchemas: true };
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
    
    it('should produce identical results for migration files', async () => {
      const code = `
export async function up(knex) {
  return knex.schema.createTable('products', table => {
    table.uuid('id').primary();
    table.string('name').notNullable();
    table.decimal('price', 10, 2);
    // Missing index on frequently queried column
    table.timestamps(true, true);
  });
}

export async function down(knex) {
  return knex.schema.dropTable('products');
}
      `;
      
      const file = await createTestFile(code, '001_create_products.js');
      const files = [file];
      
      const config = { checkMigrations: true };
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Schema Inconsistencies', () => {
    it('should produce identical results for type mismatches', async () => {
      const code = `
// API response type
interface UserResponse {
  id: string;
  email: string;
  age: number;
}

// Database model with inconsistent types
class User {
  id: number; // Mismatch: string vs number
  email: string;
  age: string; // Mismatch: number vs string
}

// Validation schema with another mismatch
const userSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' }, // Different from interface
    email: { type: 'string' },
    age: { type: 'string' } // Different from interface
  }
};
      `;
      
      const file = await createTestFile(code, 'inconsistent-types.ts');
      const files = [file];
      
      const config = { checkTypeConsistency: true };
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('GraphQL Schema', () => {
    it('should produce identical results for GraphQL schema files', async () => {
      const code = `
type User {
  id: ID!
  name: String!
  email: String!
  posts: [Post!]!
}

type Post {
  id: ID!
  title: String!
  content: String
  author: User!
  # Circular reference without proper handling
}

type Query {
  user(id: ID!): User
  posts: [Post!]!
}

# Missing Mutation type
      `;
      
      const file = await createTestFile(code, 'schema.graphql');
      const files = [file];
      
      const config = { checkGraphQLSchemas: true };
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Prisma Schema', () => {
    it('should produce identical results for Prisma schema', async () => {
      const code = `
model User {
  id    String  @id @default(uuid())
  email String  @unique
  name  String?
  posts Post[]
}

model Post {
  id        String   @id @default(uuid())
  title     String
  content   String?
  authorId  String
  // Missing: @relation directive
  createdAt DateTime @default(now())
}
      `;
      
      const file = await createTestFile(code, 'schema.prisma');
      const files = [file];
      
      const config = { checkPrismaSchemas: true };
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Configuration Options', () => {
    it('should respect schema file patterns identically', async () => {
      const schemaCode = `
{
  "type": "object",
  "properties": {
    "name": { "type": "string" }
  }
}
      `;
      
      const nonSchemaCode = `
export function processData(data: any) {
  return { ...data, processed: true };
}
      `;
      
      const schemaFile = await createTestFile(schemaCode, 'user.schema.json');
      const codeFile = await createTestFile(nonSchemaCode, 'processor.ts');
      const files = [schemaFile, codeFile];
      
      const config = { 
        schemaFilePatterns: ['*.schema.json']
      };
      
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      // Should only analyze schema files
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
    
    it('should handle custom validation rules identically', async () => {
      const code = `
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "password": {
      "type": "string",
      "minLength": 6
    }
  }
}
      `;
      
      const file = await createTestFile(code, 'weak-validation.json');
      const files = [file];
      
      const config = { 
        customRules: {
          passwordMinLength: 12
        }
      };
      
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Edge Cases', () => {
    it('should handle malformed JSON identically', async () => {
      const code = `
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    // Invalid JSON comment
    "age": { type: "number" } // Missing quotes
  }
}
      `;
      
      const file = await createTestFile(code, 'malformed.json');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
    
    it('should handle deeply nested schemas identically', async () => {
      const code = `
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "level1": {
      "type": "object",
      "properties": {
        "level2": {
          "type": "object",
          "properties": {
            "level3": {
              "type": "object",
              "properties": {
                "level4": {
                  "type": "object",
                  "properties": {
                    "deepValue": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
      `;
      
      const file = await createTestFile(code, 'deeply-nested.json');
      const files = [file];
      
      const config = { maxNestingDepth: 3 };
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
});