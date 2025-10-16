// Comprehensive Schema Validation Test - All Edge Cases Combined
import { pgTable, serial, varchar, text, timestamp, boolean } from 'drizzle-orm/pg-core';
import { eq, and, or, sql } from 'drizzle-orm';
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne } from 'typeorm';
import { Schema, model, Types } from 'mongoose';

// === VALID SCHEMA PATTERNS ===

// 1. Properly defined tables
export const validUsersTable = pgTable('valid_users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).unique(),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

export const validPostsTable = pgTable('valid_posts', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }),
  content: text('content'),
  authorId: serial('author_id').references(() => validUsersTable.id),
  createdAt: timestamp('created_at').defaultNow(),
});

// 2. Valid TypeORM entities
@Entity('valid_products')
export class ValidProduct {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column('decimal', { precision: 10, scale: 2 })
  price: number;

  @ManyToOne(() => ValidCategory, category => category.products)
  category: ValidCategory;
}

@Entity('valid_categories')
export class ValidCategory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  products: ValidProduct[];
}

// 3. Valid Mongoose schemas
interface ValidUser {
  _id: Types.ObjectId;
  email: string;
  profile: { name: string; age: number };
}

const validUserSchema = new Schema<ValidUser>({
  email: { type: String, required: true, unique: true },
  profile: {
    name: { type: String, required: true },
    age: { type: Number, min: 0, max: 150 }
  }
});

export const ValidUserModel = model<ValidUser>('ValidUser', validUserSchema);

// === VIOLATION TEST CASES ===

export class SchemaViolationTests {
  // Test 1: Missing table references (should trigger violations)
  async testMissingTableReferences() {
    // These tables don't exist in our schema definitions
    const query1 = sql`SELECT * FROM non_existent_table WHERE id = 1`;
    const query2 = sql`INSERT INTO missing_table (name) VALUES ('test')`;
    const query3 = sql`UPDATE phantom_table SET status = 'active'`;
    const query4 = sql`DELETE FROM void_table WHERE id = 999`;
    
    return [query1, query2, query3, query4];
  }

  // Test 2: Cross-reference violations
  async testCrossReferenceViolations() {
    // Reference tables that exist but with wrong foreign keys
    const invalidRef1 = sql`
      SELECT u.*, p.title 
      FROM valid_users u 
      JOIN invalid_posts p ON u.id = p.user_id  -- invalid_posts doesn't exist
    `;

    const invalidRef2 = sql`
      INSERT INTO valid_posts (title, author_id) 
      SELECT title, user_id FROM phantom_articles  -- phantom_articles doesn't exist
    `;

    return [invalidRef1, invalidRef2];
  }

  // Test 3: Mixed ORM patterns in single function (complexity test)
  async testMixedOrmComplexity(userId: number, categoryName: string) {
    // Drizzle query
    const drizzleUsers = await db.select()
      .from(validUsersTable)
      .where(eq(validUsersTable.isActive, true));

    // TypeORM-style query (pseudo-code)
    const typeormProducts = await productRepository.find({
      where: { 'category.name': categoryName },
      relations: ['category']
    });

    // Mongoose query
    const mongoUsers = await ValidUserModel.find({
      'profile.age': { $gte: 18 }
    }).limit(10);

    // Raw SQL with missing table reference
    const rawQuery = sql`
      SELECT u.email, missing_table.data 
      FROM valid_users u 
      JOIN missing_table mt ON u.id = mt.user_id  -- Should trigger violation
      WHERE u.id = ${userId}
    `;

    // Complex subquery with invalid references
    const complexQuery = sql`
      WITH user_stats AS (
        SELECT 
          u.id,
          COUNT(p.id) as post_count,
          COUNT(invalid_comments.id) as comment_count  -- invalid table
        FROM valid_users u
        LEFT JOIN valid_posts p ON u.id = p.author_id
        LEFT JOIN invalid_comments c ON u.id = c.user_id  -- Should trigger violation
        GROUP BY u.id
      )
      SELECT * FROM user_stats WHERE post_count > 5
    `;

    return {
      drizzleUsers,
      typeormProducts,
      mongoUsers,
      rawQuery,
      complexQuery
    };
  }

  // Test 4: SQL injection patterns (should be detected)
  async testSqlInjectionPatterns(userInput: string, tableName: string) {
    // Direct string interpolation - UNSAFE
    const unsafeQuery1 = `SELECT * FROM valid_users WHERE name = '${userInput}'`;
    
    // Dynamic table name - UNSAFE
    const unsafeQuery2 = `SELECT * FROM ${tableName} WHERE id = 1`;
    
    // Template literal with raw insertion - UNSAFE  
    const unsafeQuery3 = sql`
      SELECT * FROM valid_users 
      WHERE created_at > ${sql.raw(userInput)}  -- Could be malicious
    `;

    // Should trigger multiple violations
    return [
      sql.raw(unsafeQuery1),
      sql.raw(unsafeQuery2), 
      unsafeQuery3
    ];
  }

  // Test 5: Database introspection with invalid schema references
  async testIntrospectionWithInvalidRefs() {
    // Query system tables with references to non-existent user tables
    const schemaQuery = sql`
      SELECT 
        c.table_name,
        c.column_name,
        c.data_type
      FROM information_schema.columns c
      WHERE c.table_name IN ('valid_users', 'invalid_table', 'missing_schema')
      ORDER BY c.table_name, c.ordinal_position
    `;

    // Foreign key query with mix of valid/invalid tables
    const fkQuery = sql`
      SELECT 
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name  
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name IN ('valid_posts', 'phantom_relations')  -- Mix of valid/invalid
    `;

    return { schemaQuery, fkQuery };
  }

  // Test 6: Advanced aggregation with missing tables
  async testAdvancedAggregationViolations() {
    const complexAggregation = sql`
      SELECT 
        u.email,
        COUNT(DISTINCT p.id) as post_count,
        COUNT(DISTINCT c.id) as comment_count,
        COUNT(DISTINCT l.id) as like_count,
        AVG(r.rating) as avg_rating
      FROM valid_users u
      LEFT JOIN valid_posts p ON u.id = p.author_id
      LEFT JOIN missing_comments c ON p.id = c.post_id      -- Should trigger violation  
      LEFT JOIN phantom_likes l ON p.id = l.post_id         -- Should trigger violation
      LEFT JOIN void_ratings r ON p.id = r.post_id          -- Should trigger violation
      WHERE u.is_active = true
      GROUP BY u.id, u.email
      HAVING COUNT(p.id) > 0
      ORDER BY post_count DESC, avg_rating DESC
    `;

    return complexAggregation;
  }

  // Test 7: Recursive CTE with invalid table references
  async testRecursiveCteViolations() {
    const recursiveCte = sql`
      WITH RECURSIVE org_hierarchy AS (
        -- Base case: root organizations from valid table
        SELECT id, name, parent_id, 0 as level
        FROM valid_organizations  -- Doesn't exist - should trigger violation
        WHERE parent_id IS NULL
        
        UNION ALL
        
        -- Recursive case: child organizations
        SELECT o.id, o.name, o.parent_id, oh.level + 1
        FROM invalid_orgs o                    -- Should trigger violation
        INNER JOIN org_hierarchy oh ON o.parent_id = oh.id
        WHERE oh.level < 10
      ),
      department_stats AS (
        SELECT 
          oh.id,
          oh.name,
          oh.level,
          COUNT(e.id) as employee_count
        FROM org_hierarchy oh
        LEFT JOIN phantom_employees e ON oh.id = e.org_id  -- Should trigger violation
        GROUP BY oh.id, oh.name, oh.level
      )
      SELECT * FROM department_stats 
      ORDER BY level, employee_count DESC
    `;

    return recursiveCte;
  }

  // Test 8: Window functions with missing table references
  async testWindowFunctionViolations() {
    const windowQuery = sql`
      SELECT 
        u.email,
        p.title,
        p.created_at,
        ROW_NUMBER() OVER (PARTITION BY u.id ORDER BY p.created_at DESC) as post_rank,
        LAG(p.title) OVER (PARTITION BY u.id ORDER BY p.created_at) as prev_post,
        COUNT(*) OVER (PARTITION BY DATE(p.created_at)) as daily_posts,
        AVG(metrics.views) OVER (
          PARTITION BY u.id 
          ORDER BY p.created_at 
          ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) as avg_recent_views
      FROM valid_users u
      JOIN valid_posts p ON u.id = p.author_id
      LEFT JOIN missing_metrics metrics ON p.id = metrics.post_id  -- Should trigger violation
      WHERE u.is_active = true
        AND p.created_at >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY u.email, p.created_at DESC
    `;

    return windowQuery;
  }
}

// === EDGE CASE TABLE DEFINITIONS ===

// Case sensitivity tests
export const CamelCaseTable = pgTable('CamelCaseTable', {
  UserId: serial('UserId').primaryKey(),
  UserName: varchar('UserName', { length: 255 }),
});

export const snake_case_table = pgTable('snake_case_table', {
  user_id: serial('user_id').primaryKey(), 
  user_name: varchar('user_name', { length: 255 }),
});

export const UPPER_CASE_TABLE = pgTable('UPPER_CASE_TABLE', {
  USER_ID: serial('USER_ID').primaryKey(),
  USER_NAME: varchar('USER_NAME', { length: 255 }),
});

// Reserved keyword tables (should be quoted)
export const orderTable = pgTable('order', {  // 'order' is SQL keyword
  id: serial('id').primaryKey(),
  user: varchar('user', { length: 255 }),    // 'user' is SQL keyword
  select: text('select'),                     // 'select' is SQL keyword
});

// Special character table names
export const specialCharTable = pgTable('user-preferences', {
  id: serial('id').primaryKey(),
  'user-id': serial('user-id'),               // Hyphenated column
  'settings.theme': varchar('settings.theme', { length: 50 }), // Dotted column
});

// Unicode table names
export const unicodeTable = pgTable('用户表', {  // Chinese characters
  id: serial('id').primaryKey(),
  '姓名': varchar('姓名', { length: 100 }),      // Chinese column name
  'البريد_الإلكتروني': varchar('البريد_الإلكتروني', { length: 255 }), // Arabic
});

// === PERFORMANCE AND SCALE TESTS ===

export class ScaleTestQueries {
  // Generate large number of table references to test indexing performance
  async generateManyTableReferences(count: number) {
    const queries = [];
    
    for (let i = 0; i < count; i++) {
      // Mix of valid and invalid table references
      const isValid = i % 3 === 0;
      const tableName = isValid ? `valid_table_${i}` : `missing_table_${i}`;
      
      queries.push(sql.raw(`
        SELECT id, name, created_at 
        FROM ${tableName} 
        WHERE id = ${i}
        ORDER BY created_at DESC 
        LIMIT 10
      `));
    }
    
    return queries;
  }

  // Test complex joins across many tables
  async testComplexMultiTableJoin() {
    return sql`
      SELECT 
        u.email,
        p.title,
        c.name as category_name,
        t.name as tag_name,
        cm.content as comment_content,
        l.created_at as like_date,
        m.view_count,
        r.rating
      FROM valid_users u
      JOIN valid_posts p ON u.id = p.author_id
      LEFT JOIN valid_categories c ON p.category_id = c.id 
      LEFT JOIN post_tags pt ON p.id = pt.post_id              -- Missing table
      LEFT JOIN invalid_tags t ON pt.tag_id = t.id             -- Missing table
      LEFT JOIN phantom_comments cm ON p.id = cm.post_id       -- Missing table
      LEFT JOIN void_likes l ON p.id = l.post_id               -- Missing table
      LEFT JOIN missing_metrics m ON p.id = m.post_id          -- Missing table
      LEFT JOIN ghost_ratings r ON p.id = r.post_id            -- Missing table
      WHERE u.is_active = true
        AND p.created_at >= CURRENT_DATE - INTERVAL '1 year'
        AND (c.name IS NOT NULL OR t.name IS NOT NULL)
      ORDER BY p.created_at DESC, r.rating DESC NULLS LAST
      LIMIT 1000
    `;
  }
}

// Export a comprehensive test runner
export async function runComprehensiveSchemaValidation() {
  const tests = new SchemaViolationTests();
  const scaleTests = new ScaleTestQueries();
  
  const results = {
    missingTableRefs: await tests.testMissingTableReferences(),
    crossReferenceViolations: await tests.testCrossReferenceViolations(), 
    mixedOrmComplexity: await tests.testMixedOrmComplexity(123, 'electronics'),
    sqlInjectionPatterns: await tests.testSqlInjectionPatterns("'; DROP TABLE users; --", 'dynamic_table'),
    introspectionViolations: await tests.testIntrospectionWithInvalidRefs(),
    aggregationViolations: await tests.testAdvancedAggregationViolations(),
    recursiveCteViolations: await tests.testRecursiveCteViolations(),
    windowFunctionViolations: await tests.testWindowFunctionViolations(),
    scaleTestQueries: await scaleTests.generateManyTableReferences(100),
    complexJoinViolations: await scaleTests.testComplexMultiTableJoin()
  };
  
  return results;
}

// Export for schema analyzer to detect
export const COMPREHENSIVE_TEST_METADATA = {
  totalExpectedViolations: 45,
  expectedMissingTables: [
    'non_existent_table', 'missing_table', 'phantom_table', 'void_table',
    'invalid_posts', 'phantom_articles', 'missing_comments', 'invalid_comments',
    'phantom_likes', 'void_ratings', 'valid_organizations', 'invalid_orgs',
    'phantom_employees', 'missing_metrics', 'post_tags', 'invalid_tags',
    'phantom_comments', 'void_likes', 'ghost_ratings'
  ],
  expectedValidTables: [
    'valid_users', 'valid_posts', 'valid_products', 'valid_categories'
  ],
  testCategories: [
    'missing-references', 'cross-references', 'mixed-orm', 'sql-injection',
    'introspection', 'aggregation', 'recursive-cte', 'window-functions',
    'scale-test', 'complex-joins', 'case-sensitivity', 'unicode', 'keywords'
  ]
};