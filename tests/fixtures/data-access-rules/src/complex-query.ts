/**
 * complex-query rule — true positive + near-miss negative
 *
 * True positive: query with multiple JOINs and nested subqueries (high complexity).
 * Near-miss negative: simple single-table SELECT — should NOT trigger.
 */
import { getDB } from './fake-db';

// TRUE POSITIVE — query with 3+ JOINs and nested subqueries
export function runComplexReport(): void {
  const db = getDB();
  db.exec(`
    SELECT u.name, p.title, t.amount, c.name as company,
           (SELECT COUNT(*) FROM invoices i WHERE i.user_id = u.id) as invoice_count,
           (SELECT SUM(o.total) FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            WHERE o.user_id = u.id) as total_spent
    FROM users u
    JOIN projects p ON u.id = p.owner_id
    JOIN transactions t ON p.id = t.project_id
    JOIN companies c ON u.company_id = c.id
    LEFT JOIN memberships m ON u.id = m.user_id
    LEFT JOIN teams tm ON m.team_id = tm.id
    WHERE u.active = 1
    ORDER BY u.name
  `);
}

// NEAR-MISS NEGATIVE — simple single-table SELECT, should NOT trigger complex-query
export function getSimpleCount(): void {
  const db = getDB();
  db.prepare(`SELECT COUNT(*) FROM users WHERE active = ?`).bind(1).all();
}
