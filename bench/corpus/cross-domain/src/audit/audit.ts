/**
 * Audit log module — reads from audit_log but never writes to it.
 * The audit_log table is managed externally.
 */
export function readAuditLog(userId: number): Record<string, unknown>[] {
  // SELECT * FROM audit_log WHERE user_id = ? ...
  return [];
}
