/**
 * Parity tests to ensure the universal data-access analyzer produces identical results
 */

import { describe, it, expect } from 'vitest';
import { dataAccessAnalyzer as legacyAnalyzer } from '../../dataAccessAnalyzer.js';
import { dataAccessAnalyzer as universalAnalyzer } from '../../dataAccessAnalyzerCompat.js';
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

describe('DataAccess Analyzer Parity Tests', () => {
  afterEach(async () => {
    await cleanupTestFiles();
  });
  
  describe('SQL Injection Detection', () => {
    it('should produce identical results for direct SQL concatenation', async () => {
      const code = `
async function getUser(userId: string) {
  const query = "SELECT * FROM users WHERE id = " + userId;
  return db.execute(query);
}
      `;
      
      const file = await createTestFile(code, 'sql-injection.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      // Should detect SQL injection
      expect(universalResult.violations.length).toBeGreaterThan(0);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
    
    it('should produce identical results for template literal SQL', async () => {
      const code = `
async function searchUsers(name: string) {
  const query = \`
    SELECT * FROM users 
    WHERE name LIKE '%\${name}%'
  \`;
  return db.query(query);
}
      `;
      
      const file = await createTestFile(code, 'template-sql.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
    
    it('should produce identical results for safe parameterized queries', async () => {
      const code = `
async function getUser(userId: string) {
  const query = "SELECT * FROM users WHERE id = ?";
  return db.execute(query, [userId]);
}

async function updateUser(id: string, name: string) {
  return db.query(\`
    UPDATE users 
    SET name = $1 
    WHERE id = $2
  \`, [name, id]);
}
      `;
      
      const file = await createTestFile(code, 'safe-queries.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      // Should not have violations
      expect(universalResult.violations).toHaveLength(0);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Organization Filter Detection', () => {
    it('should produce identical results for missing org filter', async () => {
      const code = `
async function getUserData(userId: string) {
  const user = await db.users.findOne({ id: userId });
  return user;
}

async function getOrders() {
  return db.orders.find({}).toArray();
}
      `;
      
      const file = await createTestFile(code, 'missing-org-filter.ts');
      const files = [file];
      
      const config = { checkOrgFilters: true };
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      // Should detect missing org filters
      expect(universalResult.violations.length).toBeGreaterThan(0);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
    
    it('should produce identical results with proper org filters', async () => {
      const code = `
async function getUserData(userId: string, orgId: string) {
  const user = await db.users.findOne({ 
    id: userId, 
    organizationId: orgId 
  });
  return user;
}

async function getOrders(orgId: string) {
  return db.orders.find({ organizationId: orgId }).toArray();
}
      `;
      
      const file = await createTestFile(code, 'with-org-filter.ts');
      const files = [file];
      
      const config = { checkOrgFilters: true };
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      // Should not have violations
      expect(universalResult.violations).toHaveLength(0);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Input Sanitization', () => {
    it('should produce identical results for unsanitized input', async () => {
      const code = `
async function createUser(data: any) {
  // Direct use of user input
  const user = {
    name: data.name,
    email: data.email,
    role: data.role // Dangerous - user can set their own role
  };
  
  return db.users.insert(user);
}
      `;
      
      const file = await createTestFile(code, 'unsanitized.ts');
      const files = [file];
      
      const config = { checkInputSanitization: true };
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Complex Scenarios', () => {
    it('should produce identical results for ORM usage', async () => {
      const code = `
import { User } from './models';

class UserService {
  async searchUsers(term: string) {
    // SQL injection in ORM
    return User.findAll({
      where: \`name LIKE '%\${term}%'\`
    });
  }
  
  async getUsersByRole(role: string) {
    // Missing org filter
    return User.findAll({
      where: { role }
    });
  }
  
  async updateUserEmail(userId: string, email: string) {
    // Direct SQL with concatenation
    const sql = "UPDATE users SET email = '" + email + "' WHERE id = " + userId;
    return sequelize.query(sql);
  }
}
      `;
      
      const file = await createTestFile(code, 'orm-issues.ts');
      const files = [file];
      
      const config = { 
        checkOrgFilters: true,
        checkSQLInjection: true 
      };
      
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      // Should have multiple violations
      expect(universalResult.violations.length).toBeGreaterThan(0);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
    
    it('should produce identical results for repository pattern', async () => {
      const code = `
class UserRepository {
  private db: Database;
  
  async findByEmail(email: string, orgId?: string) {
    const query = {
      email: email.toLowerCase()
    };
    
    // Missing org filter when orgId is provided
    if (orgId) {
      // Forgot to add orgId to query
    }
    
    return this.db.collection('users').findOne(query);
  }
  
  async executeRawQuery(params: any) {
    // Dangerous - executing raw SQL from params
    const sql = params.query;
    return this.db.raw(sql);
  }
}
      `;
      
      const file = await createTestFile(code, 'repository.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Edge Cases', () => {
    it('should handle async/await patterns identically', async () => {
      const code = `
const getUser = async (id: string) => {
  const result = await db.query(\`SELECT * FROM users WHERE id = \${id}\`);
  return result[0];
};

async function* getUserBatch(ids: string[]) {
  for (const id of ids) {
    const query = "SELECT * FROM users WHERE id = '" + id + "'";
    yield await db.query(query);
  }
}
      `;
      
      const file = await createTestFile(code, 'async-patterns.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
    
    it('should handle nested queries identically', async () => {
      const code = `
async function complexQuery(userId: string, filters: any) {
  const baseQuery = \`
    SELECT u.*, 
           (SELECT COUNT(*) FROM orders WHERE user_id = \${userId}) as order_count
    FROM users u
    WHERE u.id = \${userId}
  \`;
  
  if (filters.name) {
    // Nested SQL injection
    return db.query(baseQuery + " AND name = '" + filters.name + "'");
  }
  
  return db.query(baseQuery);
}
      `;
      
      const file = await createTestFile(code, 'nested-queries.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      // Should detect multiple SQL injections
      expect(universalResult.violations.length).toBeGreaterThan(0);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Deduplication', () => {
    it('should deduplicate violations identically', async () => {
      const code = `
// This code intentionally has patterns that might create duplicate violations
async function multipleIssues(userId: string, data: any) {
  // Issue 1: SQL injection in main query
  const userQuery = "SELECT * FROM users WHERE id = " + userId;
  
  // Issue 2: Same line, but might be detected by multiple patterns
  const sameQuery = "SELECT * FROM users WHERE id = " + userId;
  
  // Issue 3: Template literal with same issue
  const templateQuery = \`SELECT * FROM users WHERE id = \${userId}\`;
  
  // Issue 4: Another function call with the same pattern
  db.query("SELECT * FROM users WHERE id = " + userId);
  
  return {
    user1: await db.query(userQuery),
    user2: await db.query(sameQuery),
    user3: await db.query(templateQuery)
  };
}
      `;
      
      const file = await createTestFile(code, 'duplicates.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      // Both should have deduplicated the violations
      expect(universalResult.violations.length).toBe(legacyResult.violations.length);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
});