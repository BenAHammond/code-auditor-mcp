// Multi-Database System Patterns and Cross-Platform Edge Cases
import { pgTable, mysqlTable, sqliteTable } from 'drizzle-orm';
import { serial, varchar, text, timestamp, boolean, integer, json, uuid, decimal } from 'drizzle-orm/pg-core';
import { int, datetime, longtext, tinyint, mediumtext } from 'drizzle-orm/mysql-core';
import { text as sqliteText, integer as sqliteInt, real } from 'drizzle-orm/sqlite-core';
import { ObjectId, MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { Entity, Column } from 'typeorm';
import { Schema } from 'mongoose';

// === MULTI-DATABASE ORM PATTERNS ===

// PostgreSQL specific tables
export const postgresUsers = pgTable('postgres_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 320 }).unique(),
  profile: json('profile').$type<{
    name: string;
    age: number;
    metadata: Record<string, unknown>;
  }>(),
  searchVector: text('search_vector'), // PostgreSQL full-text search
  createdAt: timestamp('created_at').defaultNow(),
  geolocation: text('geolocation'), // PostGIS point
});

// MySQL specific tables  
export const mysqlProducts = mysqlTable('mysql_products', {
  id: int('id').primaryKey().autoincrement(),
  title: varchar('title', { length: 255 }),
  description: longtext('description'),
  price: decimal('price', { precision: 10, scale: 2 }),
  inStock: tinyint('in_stock').default(1),
  createdAt: datetime('created_at'),
  updatedAt: datetime('updated_at'),
});

// SQLite specific tables
export const sqliteCache = sqliteTable('sqlite_cache', {
  id: sqliteInt('id').primaryKey(),
  key: sqliteText('key').unique(),
  value: sqliteText('value'),
  expiresAt: sqliteInt('expires_at'),
  score: real('score'),
});

// === CROSS-DATABASE ENTITY MAPPING ===

// Same entity across different databases
@Entity({ database: 'postgres_db' })
export class PostgresUser {
  @Column('uuid', { primary: true, generated: 'uuid' })
  id: string;

  @Column('varchar', { length: 320, unique: true })
  email: string;

  @Column('jsonb', { nullable: true })
  profile: Record<string, any>;

  @Column('tsvector', { nullable: true })
  searchVector: string;
}

@Entity({ database: 'mysql_db' })
export class MySQLUser {
  @Column('int', { primary: true, generated: true })
  id: number;

  @Column('varchar', { length: 255, unique: true })
  email: string;

  @Column('json', { nullable: true })
  profile: Record<string, any>;

  @Column('fulltext', { nullable: true })
  searchText: string;
}

// === MONGODB PATTERNS ===

interface MongoUser {
  _id: ObjectId;
  email: string;
  profile: {
    name: string;
    preferences: {
      theme: 'light' | 'dark';
      language: string;
    };
    social: {
      [platform: string]: {
        username: string;
        verified: boolean;
      };
    };
  };
  metadata: {
    createdAt: Date;
    lastLoginAt?: Date;
    loginCount: number;
    ipAddresses: string[];
  };
  tags: string[];
  scores: {
    reputation: number;
    activity: number;
    helpfulness: number;
  };
}

const mongoUserSchema = new Schema<MongoUser>({
  email: { type: String, required: true, unique: true, index: true },
  profile: {
    name: { type: String, required: true },
    preferences: {
      theme: { type: String, enum: ['light', 'dark'], default: 'light' },
      language: { type: String, default: 'en' }
    },
    social: {
      type: Map,
      of: {
        username: String,
        verified: { type: Boolean, default: false }
      }
    }
  },
  metadata: {
    createdAt: { type: Date, default: Date.now },
    lastLoginAt: Date,
    loginCount: { type: Number, default: 0 },
    ipAddresses: [String]
  },
  tags: [{ type: String, index: true }],
  scores: {
    reputation: { type: Number, default: 0, min: 0 },
    activity: { type: Number, default: 0, min: 0 },
    helpfulness: { type: Number, default: 0, min: 0 }
  }
}, {
  collection: 'users',
  timestamps: false, // Using custom metadata.createdAt
  shardKey: { email: 1 } // For MongoDB sharding
});

// Compound indexes for MongoDB
mongoUserSchema.index({ 'profile.name': 'text', 'tags': 'text' }); // Text search
mongoUserSchema.index({ 'metadata.createdAt': -1, 'scores.reputation': -1 }); // Compound
mongoUserSchema.index({ 'profile.social': 1 }, { sparse: true }); // Sparse index

// === REDIS PATTERNS ===

export class RedisSchemaPatterns {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  // Key-value patterns
  async setUserSession(userId: string, sessionData: Record<string, any>) {
    const key = `session:${userId}`;
    await this.redis.setex(key, 3600, JSON.stringify(sessionData));
  }

  // Hash patterns
  async setUserProfile(userId: string, profile: Record<string, string>) {
    const key = `user:${userId}:profile`;
    await this.redis.hset(key, profile);
  }

  // List patterns for activity feeds
  async addUserActivity(userId: string, activity: string) {
    const key = `user:${userId}:activities`;
    await this.redis.lpush(key, JSON.stringify({
      activity,
      timestamp: Date.now()
    }));
    await this.redis.ltrim(key, 0, 99); // Keep only last 100 activities
  }

  // Set patterns for tags/categories
  async addUserTags(userId: string, tags: string[]) {
    const key = `user:${userId}:tags`;
    await this.redis.sadd(key, ...tags);
  }

  // Sorted set patterns for leaderboards
  async updateUserScore(userId: string, score: number) {
    await this.redis.zadd('leaderboard:global', score, userId);
    
    // Daily leaderboard
    const today = new Date().toISOString().split('T')[0];
    await this.redis.zadd(`leaderboard:daily:${today}`, score, userId);
  }

  // Pub/Sub patterns
  async publishUserEvent(userId: string, event: string, data: any) {
    const channel = `user:${userId}:events`;
    await this.redis.publish(channel, JSON.stringify({ event, data, timestamp: Date.now() }));
  }

  // Stream patterns (Redis 5.0+)
  async addToEventStream(streamKey: string, event: Record<string, string>) {
    await this.redis.xadd(streamKey, '*', ...Object.entries(event).flat());
  }
}

// === ELASTICSEARCH PATTERNS ===

export const elasticsearchMappings = {
  users: {
    mappings: {
      properties: {
        email: { type: 'keyword' },
        profile: {
          type: 'object',
          properties: {
            name: { 
              type: 'text',
              fields: {
                keyword: { type: 'keyword' },
                suggest: { type: 'completion' }
              }
            },
            bio: { type: 'text', analyzer: 'english' },
            location: { type: 'geo_point' },
            skills: { type: 'keyword' }
          }
        },
        posts: {
          type: 'nested',
          properties: {
            title: { type: 'text' },
            content: { type: 'text', analyzer: 'english' },
            tags: { type: 'keyword' },
            publishedAt: { type: 'date' },
            stats: {
              type: 'object',
              properties: {
                views: { type: 'integer' },
                likes: { type: 'integer' },
                comments: { type: 'integer' }
              }
            }
          }
        },
        createdAt: { type: 'date' },
        lastActive: { type: 'date' },
        isActive: { type: 'boolean' }
      }
    }
  },

  products: {
    mappings: {
      properties: {
        title: {
          type: 'text',
          fields: {
            keyword: { type: 'keyword' },
            autocomplete: {
              type: 'search_as_you_type'
            }
          }
        },
        description: { type: 'text', analyzer: 'english' },
        category: { type: 'keyword' },
        price: { type: 'scaled_float', scaling_factor: 100 },
        attributes: {
          type: 'object',
          dynamic: true
        },
        reviews: {
          type: 'nested',
          properties: {
            rating: { type: 'integer' },
            comment: { type: 'text' },
            reviewer: { type: 'keyword' },
            createdAt: { type: 'date' }
          }
        },
        availability: {
          type: 'object',
          properties: {
            inStock: { type: 'boolean' },
            quantity: { type: 'integer' },
            restockDate: { type: 'date' }
          }
        }
      }
    }
  }
};

// === GRAPH DATABASE PATTERNS (Neo4j) ===

export const cypherQueries = {
  // Create user nodes and relationships
  createUserNetwork: `
    CREATE (u:User {
      id: $userId,
      email: $email,
      profile: $profile,
      createdAt: datetime()
    })
    WITH u
    UNWIND $friendIds AS friendId
    MATCH (friend:User {id: friendId})
    CREATE (u)-[:FRIENDS_WITH {since: datetime()}]->(friend)
  `,

  // Complex traversal query
  findInfluencers: `
    MATCH (u:User)-[r:FOLLOWS]->(influencer:User)
    WHERE u.profile.interests CONTAINS $interest
    WITH influencer, count(r) AS followerCount
    WHERE followerCount > $minFollowers
    MATCH (influencer)-[:POSTED]->(p:Post)-[:TAGGED_WITH]->(t:Tag)
    WHERE t.name = $tagName
    RETURN influencer, followerCount, collect(p) AS posts
    ORDER BY followerCount DESC
    LIMIT $limit
  `,

  // Recommendation algorithm
  recommendUsers: `
    MATCH (u:User {id: $userId})-[:FOLLOWS]->(followed:User)
    MATCH (followed)-[:FOLLOWS]->(recommended:User)
    WHERE NOT (u)-[:FOLLOWS]->(recommended) AND recommended <> u
    WITH recommended, count(*) AS mutualConnections
    WHERE mutualConnections >= $minMutual
    MATCH (recommended)-[:POSTED]->(p:Post)
    WHERE p.createdAt > datetime() - duration('P7D')
    WITH recommended, mutualConnections, count(p) AS recentPosts
    RETURN recommended, mutualConnections, recentPosts
    ORDER BY mutualConnections DESC, recentPosts DESC
    LIMIT $limit
  `,

  // Path finding
  findShortestPath: `
    MATCH p = shortestPath(
      (u1:User {id: $user1Id})-[*..6]-(u2:User {id: $user2Id})
    )
    WHERE ALL(r IN relationships(p) WHERE type(r) IN ['FRIENDS_WITH', 'FOLLOWS', 'COLLABORATES_WITH'])
    RETURN p, length(p) AS pathLength
  `
};

// === TIME-SERIES DATABASE PATTERNS (InfluxDB) ===

export const influxQueries = {
  // Write time-series data
  writeMetrics: `
    user_activity,user_id=${userId},action=${action} 
    value=1 ${timestamp}
  `,

  // Query with aggregation
  getUserActivityTrend: `
    SELECT mean("value") 
    FROM "user_activity" 
    WHERE time >= now() - 30d 
      AND "user_id" = '${userId}' 
    GROUP BY time(1d), "action" 
    FILL(0)
  `,

  // Complex aggregation across multiple measurements
  getDashboardMetrics: `
    SELECT 
      mean("response_time") AS avg_response_time,
      count("user_id") AS active_users,
      sum("page_views") AS total_views
    FROM "app_metrics" 
    WHERE time >= now() - 1h 
    GROUP BY time(5m)
  `
};

// === CROSS-DATABASE SERVICE LAYER ===

export class MultiDatabaseService {
  constructor(
    private postgres: any,
    private mysql: any,
    private mongodb: any,
    private redis: Redis,
    private elasticsearch: any
  ) {}

  // Sync data across multiple databases
  async createUserAcrossDBs(userData: {
    email: string;
    profile: Record<string, any>;
    preferences: Record<string, any>;
  }) {
    try {
      // PostgreSQL - main user record
      const pgUser = await this.postgres.execute(sql`
        INSERT INTO postgres_users (email, profile, created_at)
        VALUES (${userData.email}, ${JSON.stringify(userData.profile)}, NOW())
        RETURNING id, email
      `);

      const userId = pgUser.rows[0].id;

      // MySQL - denormalized data for reporting
      await this.mysql.execute(sql`
        INSERT INTO mysql_products (title, description, created_at)
        VALUES (${userData.profile.name}, ${userData.profile.bio}, NOW())
      `);

      // MongoDB - flexible document storage
      await this.mongodb.collection('users').insertOne({
        _id: new ObjectId(),
        email: userData.email,
        profile: userData.profile,
        preferences: userData.preferences,
        metadata: {
          createdAt: new Date(),
          postgresId: userId
        }
      });

      // Redis - session and cache
      await this.redis.hset(`user:${userId}`, {
        email: userData.email,
        lastLogin: Date.now().toString(),
        sessionCount: '1'
      });

      // Elasticsearch - searchable data
      await this.elasticsearch.index({
        index: 'users',
        id: userId,
        body: {
          email: userData.email,
          profile: userData.profile,
          createdAt: new Date().toISOString(),
          searchableText: `${userData.profile.name} ${userData.profile.bio}`
        }
      });

      return { userId, email: userData.email };
    } catch (error) {
      // Rollback logic would go here
      throw new Error(`Failed to create user across databases: ${error.message}`);
    }
  }

  // Complex cross-database query
  async getUserAnalytics(userId: string) {
    const [pgData, mongoData, redisData, esData] = await Promise.all([
      // PostgreSQL - structured data
      this.postgres.execute(sql`
        SELECT u.*, COUNT(p.id) AS post_count
        FROM postgres_users u
        LEFT JOIN posts p ON u.id = p.user_id
        WHERE u.id = ${userId}
        GROUP BY u.id
      `),

      // MongoDB - document data
      this.mongodb.collection('users').findOne(
        { 'metadata.postgresId': userId },
        { projection: { profile: 1, preferences: 1, metadata: 1 } }
      ),

      // Redis - session data
      this.redis.hgetall(`user:${userId}`),

      // Elasticsearch - search and analytics
      this.elasticsearch.search({
        index: 'user_activities',
        body: {
          query: { term: { userId } },
          aggs: {
            daily_activity: {
              date_histogram: {
                field: '@timestamp',
                interval: 'day'
              }
            }
          }
        }
      })
    ]);

    return {
      basicInfo: pgData.rows[0],
      profile: mongoData?.profile,
      preferences: mongoData?.preferences,
      session: redisData,
      activityTrend: esData.aggregations?.daily_activity?.buckets
    };
  }
}

// === DATABASE-SPECIFIC EDGE CASES ===

// Case sensitivity across databases
export const caseSensitivityTests = {
  postgres: {
    // PostgreSQL folds to lowercase unless quoted
    unquoted: sql`SELECT * FROM UserTable WHERE UserName = 'test'`, // becomes usertable, username
    quoted: sql`SELECT * FROM "UserTable" WHERE "UserName" = 'test'`, // preserves case
  },
  
  mysql: {
    // MySQL case sensitivity depends on OS and settings
    default: sql`SELECT * FROM UserTable WHERE UserName = 'test'`, // case insensitive on Windows
    binary: sql`SELECT * FROM UserTable WHERE BINARY UserName = 'test'`, // case sensitive
  },
  
  sqlite: {
    // SQLite is case insensitive for ASCII
    normal: sql`SELECT * FROM UserTable WHERE UserName = 'test'`, // case insensitive
    collate: sql`SELECT * FROM UserTable WHERE UserName COLLATE BINARY = 'test'`, // case sensitive
  }
};

// Unicode and internationalization
export const unicodeTests = {
  // Emoji and special characters in table/column names
  emojiTable: sql`SELECT * FROM "users_😀" WHERE "name_🌟" = 'test'`,
  
  // Unicode in data
  unicodeData: sql`
    INSERT INTO international_users (name, city, description)
    VALUES 
      ('北京用户', '北京', '这是一个中文描述'),
      ('مستخدم عربي', 'الرياض', 'هذا وصف باللغة العربية'),
      ('ユーザー日本', '東京', 'これは日本語の説明です')
  `,
  
  // Mixed scripts and RTL text
  mixedScript: sql`
    SELECT * FROM users 
    WHERE name LIKE '%العربية%' 
       OR name LIKE '%中文%' 
       OR name LIKE '%日本語%'
  `
};