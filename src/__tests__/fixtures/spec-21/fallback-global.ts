/**
 * Spec-21 R6: Name-list fallback — "db" as an injected global
 * with no visible import.
 *
 * In "hybrid" mode (default): "db" matches dbReceiverNames → gets
 *   `reason: 'fallback'` provenance. Detection fires, and the entry
 *   is visible in `config detection` output.
 *
 * In strict "provenance" mode: no import chain → zero detections
 *   because name lists are never consulted.
 *
 * In "names" mode (legacy): fires purely on name-match.
 */

// No import — db is an injected global (e.g., from a framework runtime).
declare const db: any;

// "hybrid" → fires via fallback name-match
// "provenance" → silent (no import chain)
// "names" → fires via name-match
db.prepare('SELECT * FROM users');
db.all();
