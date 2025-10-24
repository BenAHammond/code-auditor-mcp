// Complex ORM Pattern Edge Cases for Schema Analyzer Testing
import { pgTable, serial, varchar, text, timestamp, boolean, integer, json, uuid } from 'drizzle-orm/pg-core';
import { mysqlTable, int, datetime } from 'drizzle-orm/mysql-core';
import { sqliteTable, primaryKey } from 'drizzle-orm/sqlite-core';
import { relations, eq, and, or, like, inArray } from 'drizzle-orm';
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, OneToMany, ManyToMany, JoinTable, Index } from 'typeorm';
import { Schema, model, Types } from 'mongoose';

// === DRIZZLE EDGE CASES ===

// Complex table with all column types and constraints
export const complexUsersTable = pgTable('complex_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  profile: json('profile').$type<{
    firstName: string;
    lastName: string;
    preferences: {
      theme: 'light' | 'dark';
      notifications: boolean;
    };
  }>(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  isActive: boolean('is_active').default(true),
  metadata: json('metadata'),
}, (table) => ({
  emailIdx: uniqueIndex('email_idx').on(table.email),
  createdAtIdx: index('created_at_idx').on(table.createdAt),
  compoundIdx: index('compound_idx').on(table.email, table.isActive),
}));

// Multi-database support (PostgreSQL + MySQL + SQLite)
export const postgresTable = pgTable('postgres_specific', {
  id: serial('id').primaryKey(),
  data: json('data'),
});

export const mysqlSpecificTable = mysqlTable('mysql_specific', {
  id: int('id').primaryKey().autoincrement(),
  timestamp: datetime('timestamp'),
});

export const sqliteSpecificTable = sqliteTable('sqlite_specific', {
  id: integer('id').primaryKey(),
  data: text('data'),
});

// Complex relations with circular dependencies
export const organizationsTable = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 255 }),
  parentId: uuid('parent_id').references(() => organizationsTable.id),
});

export const projectsTable = pgTable('projects', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').references(() => organizationsTable.id),
  leadUserId: uuid('lead_user_id').references(() => complexUsersTable.id),
});

// Self-referencing table with complex relations
export const organizationsRelations = relations(organizationsTable, ({ one, many }) => ({
  parent: one(organizationsTable, {
    fields: [organizationsTable.parentId],
    references: [organizationsTable.id],
    relationName: 'parentOrganization',
  }),
  children: many(organizationsTable, { relationName: 'parentOrganization' }),
  projects: many(projectsTable),
}));

// Many-to-many junction table
export const userProjectsTable = pgTable('user_projects', {
  userId: uuid('user_id').references(() => complexUsersTable.id),
  projectId: uuid('project_id').references(() => projectsTable.id),
  role: varchar('role', { length: 50 }),
  joinedAt: timestamp('joined_at').defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.projectId] }),
}));

// === TYPEORM EDGE CASES ===

// Complex entity with all decorator types
@Entity({ name: 'complex_products' })
@Index(['category', 'status'])
export class ComplexProduct {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  sku: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ type: 'jsonb', nullable: true })
  specifications: Record<string, any>;

  @Column({ type: 'enum', enum: ['active', 'inactive', 'discontinued'] })
  status: string;

  @Column({ type: 'varchar', array: true, default: [] })
  tags: string[];

  @ManyToOne(() => ProductCategory, category => category.products, {
    eager: true,
    onDelete: 'CASCADE'
  })
  category: ProductCategory;

  @ManyToMany(() => ProductAttribute, attribute => attribute.products)
  @JoinTable({
    name: 'product_attributes',
    joinColumn: { name: 'product_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'attribute_id', referencedColumnName: 'id' }
  })
  attributes: ProductAttribute[];

  @OneToMany(() => ProductVariant, variant => variant.product)
  variants: ProductVariant[];
}

// Self-referencing entity with complex inheritance
@Entity()
export class ProductCategory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ nullable: true })
  parentId?: number;

  @ManyToOne(() => ProductCategory, category => category.children)
  parent?: ProductCategory;

  @OneToMany(() => ProductCategory, category => category.parent)
  children: ProductCategory[];

  @OneToMany(() => ComplexProduct, product => product.category)
  products: ComplexProduct[];
}

// === MONGOOSE EDGE CASES ===

// Complex schema with subdocuments, arrays, and validation
interface IComplexUser {
  _id: Types.ObjectId;
  email: string;
  profile: {
    personal: {
      firstName: string;
      lastName: string;
      dateOfBirth?: Date;
    };
    professional: {
      title: string;
      company?: Types.ObjectId;
      skills: string[];
    };
  };
  addresses: Array<{
    type: 'home' | 'work' | 'other';
    street: string;
    city: string;
    zipCode: string;
    country: string;
    isDefault: boolean;
  }>;
  socialConnections: Map<string, {
    platform: string;
    username: string;
    verified: boolean;
  }>;
  preferences: {
    notifications: {
      email: boolean;
      push: boolean;
      sms: boolean;
    };
    privacy: {
      profileVisible: boolean;
      showEmail: boolean;
    };
  };
  auditLog: Array<{
    action: string;
    timestamp: Date;
    ip: string;
    userAgent?: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const complexUserSchema = new Schema<IComplexUser>({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    validate: {
      validator: function(v: string) {
        return /\S+@\S+\.\S+/.test(v);
      },
      message: 'Invalid email format'
    }
  },
  profile: {
    personal: {
      firstName: { type: String, required: true, minlength: 2, maxlength: 50 },
      lastName: { type: String, required: true, minlength: 2, maxlength: 50 },
      dateOfBirth: { type: Date, validate: {
        validator: function(v: Date) {
          return v < new Date();
        },
        message: 'Date of birth must be in the past'
      }}
    },
    professional: {
      title: { type: String, required: true },
      company: { type: Schema.Types.ObjectId, ref: 'Company' },
      skills: [{ type: String, enum: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'Python'] }]
    }
  },
  addresses: [{
    type: { type: String, enum: ['home', 'work', 'other'], required: true },
    street: { type: String, required: true },
    city: { type: String, required: true },
    zipCode: { type: String, required: true, match: /^\d{5}(-\d{4})?$/ },
    country: { type: String, required: true, default: 'US' },
    isDefault: { type: Boolean, default: false }
  }],
  socialConnections: {
    type: Map,
    of: {
      platform: { type: String, required: true },
      username: { type: String, required: true },
      verified: { type: Boolean, default: false }
    }
  },
  preferences: {
    notifications: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
      sms: { type: Boolean, default: false }
    },
    privacy: {
      profileVisible: { type: Boolean, default: true },
      showEmail: { type: Boolean, default: false }
    }
  },
  auditLog: [{
    action: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    ip: { type: String, required: true },
    userAgent: String
  }]
}, {
  timestamps: true,
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual fields and middleware
complexUserSchema.virtual('profile.fullName').get(function() {
  return `${this.profile.personal.firstName} ${this.profile.personal.lastName}`;
});

complexUserSchema.virtual('defaultAddress').get(function() {
  return this.addresses.find(addr => addr.isDefault) || this.addresses[0];
});

// Pre-save middleware
complexUserSchema.pre('save', function(next) {
  // Ensure only one default address
  const defaultAddresses = this.addresses.filter(addr => addr.isDefault);
  if (defaultAddresses.length > 1) {
    this.addresses.forEach((addr, index) => {
      if (index > 0) addr.isDefault = false;
    });
  }
  next();
});

// Static methods
complexUserSchema.statics.findByEmail = function(email: string) {
  return this.findOne({ email: email.toLowerCase() });
};

complexUserSchema.statics.findWithCompany = function() {
  return this.find().populate('profile.professional.company');
};

export const ComplexUser = model<IComplexUser>('ComplexUser', complexUserSchema);

// === COMPLEX QUERY PATTERNS ===

// Dynamic query building with conditional joins
export async function getComplexUserData(filters: {
  email?: string;
  skills?: string[];
  companyId?: string;
  hasAddress?: boolean;
  createdAfter?: Date;
}) {
  let query = ComplexUser.find();

  if (filters.email) {
    query = query.where({ email: new RegExp(filters.email, 'i') });
  }

  if (filters.skills && filters.skills.length > 0) {
    query = query.where({ 'profile.professional.skills': { $in: filters.skills } });
  }

  if (filters.companyId) {
    query = query.where({ 'profile.professional.company': filters.companyId });
  }

  if (filters.hasAddress) {
    query = query.where({ 'addresses.0': { $exists: true } });
  }

  if (filters.createdAfter) {
    query = query.where({ createdAt: { $gte: filters.createdAfter } });
  }

  return query
    .populate('profile.professional.company')
    .select('-auditLog -socialConnections')
    .sort({ createdAt: -1 })
    .limit(100);
}

// Raw SQL with complex joins and subqueries
export const complexRawQueries = {
  // PostgreSQL specific with CTEs and window functions
  userAnalytics: `
    WITH user_stats AS (
      SELECT 
        u.id,
        u.email,
        COUNT(DISTINCT p.id) as project_count,
        COUNT(DISTINCT up.project_id) as participation_count,
        ROW_NUMBER() OVER (PARTITION BY o.id ORDER BY u.created_at) as org_join_order
      FROM complex_users u
      LEFT JOIN user_projects up ON u.id = up.user_id
      LEFT JOIN projects p ON up.project_id = p.id
      LEFT JOIN organizations o ON p.organization_id = o.id
      WHERE u.is_active = true
      GROUP BY u.id, u.email, o.id, u.created_at
    ),
    active_projects AS (
      SELECT 
        project_id,
        COUNT(*) as member_count
      FROM user_projects 
      WHERE joined_at >= NOW() - INTERVAL '30 days'
      GROUP BY project_id
      HAVING COUNT(*) >= 3
    )
    SELECT 
      us.*,
      ap.member_count,
      CASE 
        WHEN us.project_count > 5 THEN 'power_user'
        WHEN us.project_count > 2 THEN 'regular_user'
        ELSE 'new_user'
      END as user_tier
    FROM user_stats us
    LEFT JOIN active_projects ap ON us.id IN (
      SELECT up2.user_id 
      FROM user_projects up2 
      WHERE up2.project_id = ap.project_id
    )
    ORDER BY us.project_count DESC, us.participation_count DESC;
  `,

  // Recursive query for organization hierarchy
  organizationHierarchy: `
    WITH RECURSIVE org_tree AS (
      -- Base case: root organizations
      SELECT 
        id, 
        name, 
        parent_id, 
        0 as level,
        ARRAY[id] as path,
        name as full_path
      FROM organizations 
      WHERE parent_id IS NULL
      
      UNION ALL
      
      -- Recursive case: child organizations
      SELECT 
        o.id, 
        o.name, 
        o.parent_id, 
        ot.level + 1,
        ot.path || o.id,
        ot.full_path || ' > ' || o.name
      FROM organizations o
      INNER JOIN org_tree ot ON o.parent_id = ot.id
      WHERE NOT o.id = ANY(ot.path) -- Prevent infinite loops
    )
    SELECT 
      ot.*,
      (SELECT COUNT(*) FROM projects p WHERE p.organization_id = ot.id) as project_count,
      (SELECT COUNT(*) FROM organizations child WHERE child.parent_id = ot.id) as child_count
    FROM org_tree ot
    ORDER BY ot.level, ot.full_path;
  `,

  // Complex aggregation with multiple CTEs
  projectMetrics: `
    WITH project_activity AS (
      SELECT 
        p.id as project_id,
        p.organization_id,
        COUNT(DISTINCT up.user_id) as member_count,
        AVG(EXTRACT(EPOCH FROM (up.joined_at - p.created_at))/86400) as avg_join_delay_days,
        MIN(up.joined_at) as first_member_joined,
        MAX(up.joined_at) as last_member_joined
      FROM projects p
      LEFT JOIN user_projects up ON p.id = up.project_id
      GROUP BY p.id, p.organization_id
    ),
    org_metrics AS (
      SELECT 
        organization_id,
        COUNT(*) as total_projects,
        AVG(member_count) as avg_team_size,
        SUM(member_count) as total_members
      FROM project_activity
      GROUP BY organization_id
    )
    SELECT 
      o.name as organization_name,
      om.total_projects,
      om.avg_team_size,
      om.total_members,
      pa.project_id,
      pa.member_count,
      pa.avg_join_delay_days,
      RANK() OVER (PARTITION BY pa.organization_id ORDER BY pa.member_count DESC) as project_rank_in_org
    FROM project_activity pa
    JOIN organizations o ON pa.organization_id = o.id
    JOIN org_metrics om ON pa.organization_id = om.organization_id
    WHERE pa.member_count > 0
    ORDER BY om.total_members DESC, pa.member_count DESC;
  `
};

// === EDGE CASE SCENARIOS ===

// Mixed ORM usage in single file (should detect all patterns)
export class MixedOrmService {
  // Drizzle usage
  async getDrizzleUsers() {
    return await db.select().from(complexUsersTable).where(eq(complexUsersTable.isActive, true));
  }

  // TypeORM usage
  async getTypeOrmProducts() {
    return await productRepository.find({
      relations: ['category', 'attributes', 'variants'],
      where: { status: 'active' }
    });
  }

  // Mongoose usage
  async getMongooseUsers() {
    return await ComplexUser.findWithCompany()
      .where('profile.professional.skills').in(['JavaScript', 'TypeScript'])
      .limit(50);
  }

  // Raw SQL usage
  async getAnalytics() {
    return await db.execute(sql`${complexRawQueries.userAnalytics}`);
  }
}

// Table name conflicts and case sensitivity
export const usersLowercase = pgTable('users', { id: serial('id') });
export const UsersUppercase = pgTable('Users', { id: serial('id') }); 
export const USERS_CAPS = pgTable('USERS', { id: serial('id') });

// Foreign key references to non-existent tables (should trigger violations)
export const invalidReferences = pgTable('invalid_refs', {
  id: serial('id').primaryKey(),
  nonExistentRef: integer('non_existent_id').references(() => nonExistentTable.id), // Should error
  anotherBadRef: uuid('bad_ref').references(() => missingTable.id), // Should error
});

// Complex enum and custom types
export const complexEnums = pgTable('complex_enums', {
  id: serial('id').primaryKey(),
  status: varchar('status').$type<'draft' | 'published' | 'archived'>(),
  priority: integer('priority').$type<1 | 2 | 3 | 4 | 5>(),
  metadata: json('metadata').$type<{
    tags: string[];
    settings: Record<string, unknown>;
    timestamps: {
      created: string;
      modified: string;
    };
  }>(),
});