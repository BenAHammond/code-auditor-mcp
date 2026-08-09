/**
 * Safe pattern — d1Query wrapper with bind params
 * Guard: isWrapperFunctionWithBindParams (Guard 4)
 *
 * `d1Query(sql, param1, param2)` with 2+ args provides the same guarantee
 * as `.prepare().bind()`. Must produce 0 sql-injection-risk violations.
 */
import { d1Query } from './fake-db';

export function getUsersByStatus(status: string): void {
  d1Query(`SELECT * FROM users WHERE status = ?`, status).all();
}
