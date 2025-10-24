// SQL Injection Patterns and Dynamic Query Edge Cases
import { sql } from 'drizzle-orm';
import { db } from '../src/db';

// === DANGEROUS PATTERNS (should be flagged) ===

export class UnsafeQueryPatterns {
  // Direct string interpolation (SQL injection risk)
  async unsafeUserSearch(searchTerm: string) {
    const query = `SELECT * FROM users WHERE name LIKE '%${searchTerm}%'`; // UNSAFE
    return await db.execute(sql.raw(query));
  }

  // Dynamic table names (potential injection)
  async unsafeDynamicTable(tableName: string, id: number) {
    const query = `SELECT * FROM ${tableName} WHERE id = ${id}`; // UNSAFE
    return await db.execute(sql.raw(query));
  }

  // Template literals with user input
  async unsafeTemplateQuery(userId: string, orderBy: string) {
    return await db.execute(sql`
      SELECT u.*, p.title 
      FROM users u 
      LEFT JOIN posts p ON u.id = p.user_id 
      WHERE u.id = ${userId}
      ORDER BY ${sql.raw(orderBy)} -- UNSAFE: orderBy could contain malicious SQL
    `);
  }

  // Dynamic WHERE conditions
  async unsafeDynamicWhere(conditions: Record<string, any>) {
    let whereClause = "WHERE 1=1";
    for (const [key, value] of Object.entries(conditions)) {
      whereClause += ` AND ${key} = '${value}'`; // UNSAFE
    }
    
    const query = `SELECT * FROM products ${whereClause}`;
    return await db.execute(sql.raw(query));
  }

  // Union injection potential
  async unsafeUnionQuery(category: string) {
    const query = `
      SELECT id, name FROM products WHERE category = '${category}'
      UNION ALL
      SELECT id, title as name FROM articles WHERE category = '${category}'
    `; // UNSAFE
    return await db.execute(sql.raw(query));
  }
}

// === COMPLEX DYNAMIC QUERIES ===

export class ComplexDynamicQueries {
  // Pagination with dynamic sorting
  async getPaginatedResults(options: {
    table: string;
    page: number;
    limit: number;
    sortBy?: string;
    sortOrder?: 'ASC' | 'DESC';
    filters?: Array<{ column: string; operator: string; value: any }>;
  }) {
    const { table, page, limit, sortBy = 'id', sortOrder = 'ASC', filters = [] } = options;
    
    let query = `SELECT * FROM ${table}`;
    
    if (filters.length > 0) {
      const whereConditions = filters.map(f => `${f.column} ${f.operator} ?`).join(' AND ');
      query += ` WHERE ${whereConditions}`;
    }
    
    query += ` ORDER BY ${sortBy} ${sortOrder}`;
    query += ` LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
    
    const values = filters.map(f => f.value);
    return await db.execute(sql.raw(query, values));
  }

  // Dynamic aggregation queries
  async getDynamicAggregation(config: {
    table: string;
    groupBy: string[];
    aggregates: Array<{ function: string; column: string; alias: string }>;
    having?: Array<{ aggregate: string; operator: string; value: number }>;
  }) {
    const { table, groupBy, aggregates, having = [] } = config;
    
    const selectFields = [
      ...groupBy,
      ...aggregates.map(agg => `${agg.function}(${agg.column}) AS ${agg.alias}`)
    ].join(', ');
    
    let query = `SELECT ${selectFields} FROM ${table}`;
    
    if (groupBy.length > 0) {
      query += ` GROUP BY ${groupBy.join(', ')}`;
    }
    
    if (having.length > 0) {
      const havingConditions = having.map(h => `${h.aggregate} ${h.operator} ${h.value}`).join(' AND ');
      query += ` HAVING ${havingConditions}`;
    }
    
    return await db.execute(sql.raw(query));
  }

  // Multi-table joins with conditions
  async getComplexJoinQuery(joinConfig: {
    baseTable: string;
    joins: Array<{
      type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
      table: string;
      on: string;
    }>;
    select: string[];
    where?: string[];
    orderBy?: string[];
  }) {
    const { baseTable, joins, select, where = [], orderBy = [] } = joinConfig;
    
    let query = `SELECT ${select.join(', ')} FROM ${baseTable}`;
    
    joins.forEach(join => {
      query += ` ${join.type} JOIN ${join.table} ON ${join.on}`;
    });
    
    if (where.length > 0) {
      query += ` WHERE ${where.join(' AND ')}`;
    }
    
    if (orderBy.length > 0) {
      query += ` ORDER BY ${orderBy.join(', ')}`;
    }
    
    return await db.execute(sql.raw(query));
  }
}

// === STORED PROCEDURES AND FUNCTIONS ===

export const storedProcedures = {
  // PostgreSQL function calls
  getUserStatistics: async (userId: number) => {
    return await db.execute(sql`SELECT * FROM get_user_statistics(${userId})`);
  },

  // Complex stored procedure with multiple parameters
  generateReport: async (params: {
    startDate: Date;
    endDate: Date;
    reportType: string;
    filters: Record<string, any>;
  }) => {
    return await db.execute(sql`
      CALL generate_complex_report(
        ${params.startDate},
        ${params.endDate},
        ${params.reportType},
        ${JSON.stringify(params.filters)}::jsonb
      )
    `);
  },

  // Cursor-based pagination
  getCursorPagination: async (cursor?: string, limit = 20) => {
    if (cursor) {
      return await db.execute(sql`
        SELECT * FROM posts 
        WHERE id > ${cursor}
        ORDER BY id ASC 
        LIMIT ${limit}
      `);
    } else {
      return await db.execute(sql`
        SELECT * FROM posts 
        ORDER BY id ASC 
        LIMIT ${limit}
      `);
    }
  }
};

// === DATABASE SCHEMA INTROSPECTION ===

export class SchemaIntrospection {
  // PostgreSQL system tables
  async getTableSchema(tableName: string) {
    return await db.execute(sql`
      SELECT 
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        c.character_maximum_length,
        c.numeric_precision,
        c.numeric_scale,
        pgd.description
      FROM information_schema.columns c
      LEFT JOIN pg_catalog.pg_statio_all_tables psat ON c.table_name = psat.relname
      LEFT JOIN pg_catalog.pg_description pgd ON psat.relid = pgd.objoid 
        AND c.ordinal_position = pgd.objsubid
      WHERE c.table_name = ${tableName}
      ORDER BY c.ordinal_position;
    `);
  }

  // Get foreign key relationships
  async getForeignKeys(tableName?: string) {
    const whereClause = tableName ? sql`WHERE tc.table_name = ${tableName}` : sql``;
    
    return await db.execute(sql`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.delete_rule,
        rc.update_rule
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON tc.constraint_name = rc.constraint_name
        AND tc.table_schema = rc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
      ${whereClause}
      ORDER BY tc.table_name, kcu.column_name;
    `);
  }

  // Get table indexes
  async getIndexes(schemaName = 'public') {
    return await db.execute(sql`
      SELECT
        t.relname AS table_name,
        i.relname AS index_name,
        a.attname AS column_name,
        ix.indisunique AS is_unique,
        ix.indisprimary AS is_primary,
        am.amname AS index_type
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_am am ON i.relam = am.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE n.nspname = ${schemaName}
        AND t.relkind = 'r'
        AND i.relname NOT LIKE 'pg_%'
      ORDER BY t.relname, i.relname, a.attnum;
    `);
  }

  // Database statistics
  async getDatabaseStats() {
    return await db.execute(sql`
      SELECT
        schemaname,
        tablename,
        attname AS column_name,
        n_distinct,
        correlation,
        most_common_vals,
        most_common_freqs
      FROM pg_stats
      WHERE schemaname NOT IN ('information_schema', 'pg_catalog')
      ORDER BY schemaname, tablename, attname;
    `);
  }
}

// === TRANSACTION PATTERNS ===

export class TransactionPatterns {
  // Complex multi-table transaction
  async createUserWithProfile(userData: any, profileData: any) {
    return await db.transaction(async (tx) => {
      // Insert user
      const user = await tx.execute(sql`
        INSERT INTO users (email, password_hash, created_at)
        VALUES (${userData.email}, ${userData.passwordHash}, NOW())
        RETURNING id, email
      `);

      const userId = user.rows[0].id;

      // Insert profile
      await tx.execute(sql`
        INSERT INTO user_profiles (user_id, first_name, last_name, bio)
        VALUES (${userId}, ${profileData.firstName}, ${profileData.lastName}, ${profileData.bio})
      `);

      // Create default settings
      await tx.execute(sql`
        INSERT INTO user_settings (user_id, theme, notifications_enabled)
        VALUES (${userId}, 'light', true)
      `);

      // Audit log
      await tx.execute(sql`
        INSERT INTO audit_logs (user_id, action, details, created_at)
        VALUES (${userId}, 'user_created', ${JSON.stringify(userData)}, NOW())
      `);

      return user.rows[0];
    });
  }

  // Savepoint handling
  async complexUpdateWithSavepoints(updates: Array<{ table: string; id: number; data: Record<string, any> }>) {
    return await db.transaction(async (tx) => {
      for (let i = 0; i < updates.length; i++) {
        const update = updates[i];
        const savepointName = `savepoint_${i}`;
        
        await tx.execute(sql.raw(`SAVEPOINT ${savepointName}`));
        
        try {
          const setClause = Object.keys(update.data)
            .map(key => `${key} = ?`)
            .join(', ');
          
          await tx.execute(sql.raw(
            `UPDATE ${update.table} SET ${setClause} WHERE id = ?`,
            [...Object.values(update.data), update.id]
          ));
        } catch (error) {
          await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepointName}`));
          console.error(`Failed to update ${update.table}:${update.id}`, error);
        }
      }
    });
  }
}

// === VIEWS AND MATERIALIZED VIEWS ===

export const viewDefinitions = {
  // Create complex view
  createUserSummaryView: sql`
    CREATE OR REPLACE VIEW user_summary AS
    SELECT 
      u.id,
      u.email,
      up.first_name || ' ' || up.last_name AS full_name,
      COUNT(DISTINCT p.id) AS post_count,
      COUNT(DISTINCT c.id) AS comment_count,
      u.created_at,
      CASE 
        WHEN COUNT(DISTINCT p.id) > 10 THEN 'active'
        WHEN COUNT(DISTINCT p.id) > 5 THEN 'moderate'
        ELSE 'light'
      END AS activity_level
    FROM users u
    LEFT JOIN user_profiles up ON u.id = up.user_id
    LEFT JOIN posts p ON u.id = p.author_id
    LEFT JOIN comments c ON u.id = c.author_id
    GROUP BY u.id, u.email, up.first_name, up.last_name, u.created_at;
  `,

  // Materialized view with refresh
  createMaterializedStatsView: sql`
    CREATE MATERIALIZED VIEW IF NOT EXISTS daily_stats AS
    SELECT 
      DATE(created_at) AS date,
      COUNT(*) AS total_records,
      COUNT(DISTINCT user_id) AS unique_users,
      AVG(rating) AS avg_rating
    FROM activities
    GROUP BY DATE(created_at)
    ORDER BY date DESC;
  `,

  refreshMaterializedView: sql`REFRESH MATERIALIZED VIEW daily_stats;`
};

// === EDGE CASE TABLE REFERENCES ===

// Table names with special characters and keywords
export const edgeCaseTableQueries = {
  // Reserved keywords as table names
  selectFromOrder: sql`SELECT * FROM "order" WHERE status = 'pending'`,
  selectFromUser: sql`SELECT * FROM "user" WHERE active = true`,
  selectFromGroup: sql`SELECT * FROM "group" WHERE type = 'admin'`,

  // Special characters in table names
  selectFromHyphenated: sql`SELECT * FROM "user-preferences" WHERE id = 1`,
  selectFromDotted: sql`SELECT * FROM "app.logs" WHERE level = 'error'`,
  selectFromSpaced: sql`SELECT * FROM "Product Categories" WHERE active = true`,

  // Schema-qualified table names
  selectFromSchema: sql`SELECT * FROM analytics.user_events WHERE event_type = 'click'`,
  selectFromPublicSchema: sql`SELECT * FROM public.users WHERE role = 'admin'`,
  selectFromTempSchema: sql`SELECT * FROM temp.processing_queue WHERE status = 'pending'`,

  // Case sensitivity tests
  selectMixedCase: sql`SELECT * FROM UserProfiles WHERE UserId = 123`,
  selectUpperCase: sql`SELECT * FROM USER_SETTINGS WHERE USER_ID = 456`,
  selectLowerCase: sql`SELECT * FROM user_logs WHERE user_id = 789`,
};

// === TEMPORAL TABLES AND HISTORY ===

export const temporalQueries = {
  // PostgreSQL temporal queries
  timeTravel: sql`
    SELECT * FROM users FOR SYSTEM_TIME AS OF TIMESTAMP '2024-01-01 00:00:00'
    WHERE email = 'user@example.com'
  `,

  historyQuery: sql`
    SELECT 
      u.*,
      valid_from,
      valid_to
    FROM users_history u
    WHERE u.id = 123
    ORDER BY valid_from DESC
  `,

  // Audit trail queries
  auditTrail: sql`
    SELECT 
      operation,
      old_values,
      new_values,
      changed_by,
      changed_at
    FROM audit_trail
    WHERE table_name = 'users' AND record_id = 123
    ORDER BY changed_at DESC
  `
};