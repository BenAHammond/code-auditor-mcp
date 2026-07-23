/**
 * Spec-19 item 16 — solid/method-complexity TRUE positive (oracle: MUST fire).
 * Field-mapping function with 20+ conditional branches.
 * Genuinely complex field mapping dispatch.
 */

interface SourceRecord {
  type: string;
  version: number;
  data: Record<string, unknown>;
  meta?: { source: string; ingested: string };
}

interface MappedRecord {
  id: string;
  entityType: string;
  fields: Record<string, unknown>;
  tags: string[];
  normalized: boolean;
  source: string;
}

const FIELD_MAP: Record<string, Record<string, string>> = {
  user: { name: 'fullName', email: 'emailAddress', dob: 'birthDate' },
  order: { total: 'amount', status: 'state', customer: 'buyer' },
  product: { name: 'title', price: 'cost', stock: 'inventory' },
  invoice: { total: 'amountDue', date: 'issuedAt', due: 'dueDate' },
};

function mapField(sourceType: string, field: string): string {
  const typeMap = FIELD_MAP[sourceType];
  if (!typeMap) {
    return field;
  }
  return typeMap[field] || field;
}

export function mapRecord(record: SourceRecord): MappedRecord {
  const { type, version, data, meta } = record;

  const fields: Record<string, unknown> = {};

  // 20+ conditional branches across field mapping and version handling
  for (const [key, value] of Object.entries(data)) {
    // Version-specific transformations
    if (version === 1) {
      if (key === 'name' && type === 'user') {
        const parts = String(value).split(' ');
        fields.firstName = parts[0] || '';
        fields.lastName = parts.slice(1).join(' ') || '';
        continue;
      } else if (key === 'date') {
        fields[key] = new Date(String(value)).toISOString();
        continue;
      } else if (key === 'amount' && typeof value === 'number') {
        fields[key] = value * 100; // Convert to cents
        continue;
      } else if (key === 'status' && type === 'order') {
        fields[key] = String(value).toLowerCase();
        continue;
      }
    } else if (version === 2) {
      if (key === 'fullName' && type === 'user') {
        fields.displayName = String(value);
        continue;
      } else if (key === 'emailAddress' && type === 'user') {
        fields.email = String(value).toLowerCase();
        continue;
      } else if (key === 'amount' && type === 'order') {
        fields.totalCents = Number(value);
        continue;
      } else if (key === 'state' && type === 'order') {
        fields.orderStatus = String(value).toUpperCase();
        continue;
      }
    } else if (version >= 3) {
      if (typeof value === 'string' && value.startsWith('enc:')) {
        fields[key] = '[ENCRYPTED]';
        continue;
      } else if (value === null) {
        fields[key] = undefined;
        continue;
      } else if (Array.isArray(value) && value.length === 0) {
        fields[key] = null;
        continue;
      }
    }

    // General field mapping
    const mapped = mapField(type, key);
    if (mapped !== key) {
      fields[mapped] = value;
    } else {
      fields[key] = value;
    }
  }

  // Tag generation with more branches
  const tags: string[] = [];
  if (type === 'user') {
    tags.push('person');
  } else if (type === 'order') {
    tags.push('transaction');
  } else if (type === 'product') {
    tags.push('catalog');
  } else if (type === 'invoice') {
    tags.push('billing');
  } else {
    tags.push('entity');
  }

  if (version > 1) {
    tags.push(`v${version}`);
  }
  if (meta?.source === 'api') {
    tags.push('api-ingested');
  } else if (meta?.source === 'manual') {
    tags.push('manual-entry');
  } else {
    tags.push('auto-ingested');
  }

  return {
    id: `${type}:${version}:${Date.now()}`,
    entityType: type,
    fields,
    tags,
    normalized: version >= 2,
    source: meta?.source || 'unknown',
  };
}
