/**
 * Spec-19 item 17 — method-complexity false positive.
 * Data-payload assembly: object spread, property assignment, zero branches.
 * Pure data shaping — no if/for/while/ternary.
 * The violation should NOT fire: complexity is 1, threshold is 50.
 */

interface RawRecord {
  id: string;
  fields: Record<string, string>;
  meta: { created: string; updated: string; version: number };
  tags: string[];
}

interface AssembledPayload {
  id: string;
  displayName: string;
  attributes: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  version: number;
  labels: string[];
  normalized: boolean;
}

function assemblePayload(record: RawRecord): AssembledPayload {
  const { id, fields, meta, tags } = record;

  const attributes = {
    ...fields,
    source: 'sync-engine',
    recordId: id,
  };

  const labels = tags.map(t => t.toLowerCase().trim());

  const payload: AssembledPayload = {
    id,
    displayName: fields.display_name || fields.name || id,
    attributes,
    createdAt: meta.created,
    updatedAt: meta.updated,
    version: meta.version,
    labels,
    normalized: true,
  };

  return payload;
}

export { assemblePayload };
