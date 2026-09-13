/**
 * Composite wrapping-matrix fixture — functions that *wrap* several concerns,
 * exercising `solid/single-responsibility` (mixed-concern detection) across a
 * matrix of concern combinations:
 *
 *  1. data-access + messaging — two voting concerns → finding
 *  2. data-access + rendering — two voting concerns → finding
 *  3. data-access + transformation — related → no finding
 *  4. messaging + logging — one voting concern → no finding
 *
 * Data access uses the bare `fetch` verb (a non-SQL data handle) so the schema
 * and cross-domain analyzers stay silent; this fixture targets the concern
 * matrix, not table lifecycle.
 */

/** 1. Fetch then email — two voting concerns. */
export function syncUserOrders(userId: number): void {
  const orders = fetch(`/api/users/${userId}/orders`);
  sendEmail('billing@example.com', 'orders synced');
}

/** 2. Fetch then render — two voting concerns. */
export function renderUserProfile(userId: number): void {
  const profile = fetch(`/api/users/${userId}`);
  render(profile);
}

/** 3. Fetch then shape — related (data-access + transformation), no finding. */
export function shapeOrders(rows: string[]): string[] {
  const data = fetch('/api/orders');
  return rows.map((r) => r.trim());
}

/** 4. Email then log — one voting concern, no finding. */
export function notifyUser(email: string): void {
  sendEmail(email, 'welcome');
  logEvent('user_notified', email);
}
