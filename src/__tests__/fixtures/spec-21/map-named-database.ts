/**
 * Spec-21 R6: Conjunctive guard — variable named "database" but
 * assigned from `new Map()` is NOT DB-provenanced.
 *
 * Key acceptance criterion from the spec:
 *   const database = new Map(); database.first()
 *   → zero violations.
 *
 * The variable is named "database" but its value comes from a Map
 * constructor, not a DB package import — no provenance, no detection.
 */

// No DB package imports — Map is a standard library class.
const database = new Map<string, any>();

// These MUST NOT fire: database is not DB-provenanced.
database.set('key', 'value');
database.get('key');
database.has('key');

// Even though .first() is in DB_CALL_METHODS, the receiver has no
// provenance — conjunctive guard blocks detection.
const result = database.get('missing') || 'default';
