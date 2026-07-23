/**
 * Spec-19 item 15 — solid/method-complexity TRUE positive (oracle: MUST fire).
 * Query builder with chained conditionals, complexity > 50.
 * Deep conditional query construction — genuine complexity.
 */

interface QueryFilter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'between' | 'isNull' | 'isNotNull';
  value?: unknown;
  value2?: unknown;  // for 'between'
}

interface QueryOptions {
  table: string;
  select?: string[];
  filters?: QueryFilter[];
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  groupBy?: string[];
  having?: QueryFilter[];
  limit?: number;
  offset?: number;
  join?: Array<{
    table: string;
    alias: string;
    on: { left: string; right: string };
    type?: 'inner' | 'left' | 'right';
  }>;
  distinct?: boolean;
  forUpdate?: boolean;
  noWait?: boolean;
  skipLocked?: boolean;
  comment?: string;
}

export function buildQuery(options: QueryOptions): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts: string[] = [];
  let paramIndex = 0;

  // SELECT clause
  parts.push('SELECT');

  if (options.distinct) {
    parts.push('DISTINCT');
  }

  if (options.select && options.select.length > 0) {
    parts.push(options.select.map(s => `"${s}"`).join(', '));
  } else {
    parts.push('*');
  }

  // FROM clause
  parts.push(`FROM "${options.table}"`);

  // JOIN clauses
  if (options.join && options.join.length > 0) {
    for (const j of options.join) {
      const joinType = j.type ? j.type.toUpperCase() : 'INNER';
      parts.push(`${joinType} JOIN "${j.table}" AS "${j.alias}" ON "${j.left}" = "${j.right}"`);
    }
  }

  // WHERE clause
  if (options.filters && options.filters.length > 0) {
    const conditions: string[] = [];
    for (const filter of options.filters) {
      paramIndex++;
      switch (filter.operator) {
        case 'eq':
          conditions.push(`"${filter.field}" = $${paramIndex}`);
          params.push(filter.value);
          break;
        case 'neq':
          conditions.push(`"${filter.field}" != $${paramIndex}`);
          params.push(filter.value);
          break;
        case 'gt':
          conditions.push(`"${filter.field}" > $${paramIndex}`);
          params.push(filter.value);
          break;
        case 'gte':
          conditions.push(`"${filter.field}" >= $${paramIndex}`);
          params.push(filter.value);
          break;
        case 'lt':
          conditions.push(`"${filter.field}" < $${paramIndex}`);
          params.push(filter.value);
          break;
        case 'lte':
          conditions.push(`"${filter.field}" <= $${paramIndex}`);
          params.push(filter.value);
          break;
        case 'like':
          conditions.push(`"${filter.field}" LIKE $${paramIndex}`);
          params.push(`%${filter.value}%`);
          break;
        case 'in': {
          const values = Array.isArray(filter.value) ? filter.value : [filter.value];
          const placeholders = values.map(() => {
            paramIndex++;
            params.push(values[paramIndex - params.length - 1 + values.indexOf(values[values.length - 1])]);
            return `$${paramIndex}`;
          });
          // Fix placeholder indexing — rebuild properly
          params.length -= values.length;
          const idxs: number[] = [];
          for (const v of values) {
            params.push(v);
            idxs.push(params.length);
          }
          conditions.push(`"${filter.field}" IN (${idxs.map(i => `$${i}`).join(', ')})`);
          break;
        }
        case 'between':
          paramIndex++;
          const pLow = paramIndex;
          params.push(filter.value);
          paramIndex++;
          const pHigh = paramIndex;
          params.push(filter.value2);
          conditions.push(`"${filter.field}" BETWEEN $${pLow} AND $${pHigh}`);
          break;
        case 'isNull':
          conditions.push(`"${filter.field}" IS NULL`);
          break;
        case 'isNotNull':
          conditions.push(`"${filter.field}" IS NOT NULL`);
          break;
        default:
          conditions.push(`"${filter.field}" = $${paramIndex}`);
          params.push(filter.value);
      }
    }
    parts.push(`WHERE ${conditions.join(' AND ')}`);
  }

  // GROUP BY
  if (options.groupBy && options.groupBy.length > 0) {
    parts.push(`GROUP BY ${options.groupBy.map(g => `"${g}"`).join(', ')}`);
  }

  // HAVING
  if (options.having) {
    paramIndex++;
    parts.push(`HAVING "${options.having.field}" ${operatorToSQL(options.having.operator)} $${paramIndex}`);
    params.push(options.having.value);
  }

  // ORDER BY
  if (options.orderBy && options.orderBy.length > 0) {
    const orders = options.orderBy.map(o => `"${o.field}" ${o.direction.toUpperCase()}`);
    parts.push(`ORDER BY ${orders.join(', ')}`);
  }

  // LIMIT
  if (options.limit != null) {
    paramIndex++;
    parts.push(`LIMIT $${paramIndex}`);
    params.push(options.limit);
  }

  // OFFSET
  if (options.offset != null) {
    paramIndex++;
    parts.push(`OFFSET $${paramIndex}`);
    params.push(options.offset);
  }

  // Locking
  if (options.forUpdate) {
    parts.push('FOR UPDATE');
    if (options.noWait) {
      parts.push('NOWAIT');
    } else if (options.skipLocked) {
      parts.push('SKIP LOCKED');
    }
  }

  // Comment
  if (options.comment) {
    parts.push(`/* ${options.comment} */`);
  }

  return { sql: parts.join(' '), params };
}

function operatorToSQL(op: QueryFilter['operator']): string {
  switch (op) {
    case 'eq': return '=';
    case 'neq': return '!=';
    case 'gt': return '>';
    case 'gte': return '>=';
    case 'lt': return '<';
    case 'lte': return '<=';
    case 'like': return 'LIKE';
    default: return '=';
  }
}
