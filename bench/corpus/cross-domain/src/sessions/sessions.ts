/**
 * Sessions module — writes to sessions but never reads.
 * Sessions table is read by middleware outside this module.
 */
export function createSession(userId: number): string {
  // INSERT INTO sessions ...
  return 'session-token';
}
