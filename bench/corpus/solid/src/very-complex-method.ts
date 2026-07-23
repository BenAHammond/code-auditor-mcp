/**
 * API request handler with 60+ decision points — cyclomatic complexity ~65.
 * With maxMethodComplexity set to 50 (shipped default), this should trigger.
 */
export class ApiRequestHandler {
  async handleRequest(
    req: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: unknown;
      query?: Record<string, string>;
      ip: string;
    },
    context: {
      auth: { userId: string; roles: string[]; tenant: string };
      rateLimiter: { check: (k: string) => boolean };
      cache: { get: (k: string) => unknown; set: (k: string, v: unknown) => void };
      db: { query: (sql: string) => Promise<unknown[]> };
      logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
    }
  ): Promise<{ status: number; body: unknown }> {
    const { method, path, headers, body, query, ip } = req;
    const { auth, rateLimiter, cache, db, logger } = context;

    // 1: auth check
    if (!auth?.userId) {
      logger.warn('Missing auth');
      return { status: 401, body: { error: 'unauthorized' } };
    }

    // 2: rate limit
    if (!rateLimiter.check(ip)) {
      return { status: 429, body: { error: 'rate_limited' } };
    }

    // 3: method routing
    if (method === 'GET') {
      // 4-7: GET path routing
      if (path.startsWith('/api/users')) {
        if (path === '/api/users') {
          // 8: admin check
          if (!auth.roles.includes('admin')) {
            return { status: 403, body: { error: 'forbidden' } };
          }
          const cached = cache.get('users:list');
          if (cached) {
            return { status: 200, body: cached };
          }
          const users = await db.query('SELECT id, name FROM users WHERE tenant = ?');
          cache.set('users:list', users);
          return { status: 200, body: users };
        }
        // 9-10: single user
        const userId = path.split('/')[3];
        if (!userId) {
          return { status: 400, body: { error: 'missing_user_id' } };
        }
        if (auth.userId !== userId && !auth.roles.includes('admin')) {
          return { status: 403, body: { error: 'forbidden' } };
        }
        const user = await db.query('SELECT * FROM users WHERE id = ?');
        return { status: 200, body: user };
      }
      // 11-14: GET /api/orders
      if (path.startsWith('/api/orders')) {
        if (auth.roles.includes('viewer') && !auth.roles.includes('editor')) {
          return { status: 403, body: { error: 'readonly_for_viewers' } };
        }
        if (query?.status === 'pending') {
          const pending = await db.query('SELECT * FROM orders WHERE status = ?');
          return { status: 200, body: pending };
        }
        if (query?.status === 'completed') {
          const completed = await db.query('SELECT * FROM orders WHERE status = ?');
          return { status: 200, body: completed };
        }
        if (query?.status === 'cancelled') {
          const cancelled = await db.query('SELECT * FROM orders WHERE status = ?');
          return { status: 200, body: cancelled };
        }
        const orders = await db.query('SELECT * FROM orders');
        return { status: 200, body: orders };
      }
      // 15: default GET
      return { status: 404, body: { error: 'not_found' } };
    }
    // 16
    if (method === 'POST') {
      if (path === '/api/users') {
        if (!auth.roles.includes('admin')) {
          return { status: 403, body: { error: 'forbidden' } };
        }
        // 17
        if (!body || typeof body !== 'object') {
          return { status: 400, body: { error: 'invalid_body' } };
        }
        const b = body as Record<string, unknown>;
        // 18-21: validation chain
        if (!b.name) {
          return { status: 400, body: { error: 'missing_name' } };
        }
        if (!b.email) {
          return { status: 400, body: { error: 'missing_email' } };
        }
        if (typeof b.name !== 'string') {
          return { status: 400, body: { error: 'invalid_name' } };
        }
        if (typeof b.email !== 'string') {
          return { status: 400, body: { error: 'invalid_email' } };
        }
        // 22
        if (headers['content-type'] !== 'application/json') {
          return { status: 415, body: { error: 'unsupported_media_type' } };
        }
        // 23
        if ((b as any).role && !['admin', 'editor', 'viewer'].includes((b as any).role as string)) {
          return { status: 400, body: { error: 'invalid_role' } };
        }
        // 24-26: create logic
        try {
          await db.query('INSERT INTO users (name, email, tenant) VALUES (?, ?, ?)');
          logger.info(`User created by ${auth.userId}`);
          return { status: 201, body: { created: true } };
        } catch (e) {
          logger.error('DB insert failed');
          return { status: 500, body: { error: 'internal_error' } };
        }
      }
      // 27
      if (path === '/api/orders') {
        if (!auth.roles.includes('editor') && !auth.roles.includes('admin')) {
          return { status: 403, body: { error: 'forbidden' } };
        }
        // 28
        if (!body || typeof body !== 'object') {
          return { status: 400, body: { error: 'invalid_body' } };
        }
        const ob = body as Record<string, unknown>;
        // 29-33: order validation
        if (!ob.items || !Array.isArray(ob.items)) {
          return { status: 400, body: { error: 'missing_items' } };
        }
        if (ob.items.length === 0) {
          return { status: 400, body: { error: 'empty_order' } };
        }
        if ((ob as any).total && typeof (ob as any).total !== 'number') {
          return { status: 400, body: { error: 'invalid_total' } };
        }
        if ((ob as any).priority && !['low', 'normal', 'high', 'urgent'].includes((ob as any).priority as string)) {
          return { status: 400, body: { error: 'invalid_priority' } };
        }
        if ((ob as any).shippingMethod === 'express' && (ob as any).total < 50) {
          return { status: 400, body: { error: 'express_minimum_not_met' } };
        }
        // 34-35
        try {
          await db.query('INSERT INTO orders (user_id, items, tenant) VALUES (?, ?, ?)');
          cache.set(`orders:${auth.userId}`, null);
          return { status: 201, body: { created: true } };
        } catch (e) {
          return { status: 500, body: { error: 'internal_error' } };
        }
      }
      return { status: 404, body: { error: 'not_found' } };
    }
    // 36
    if (method === 'PUT') {
      if (path.startsWith('/api/users/')) {
        const userId = path.split('/')[3];
        // 37
        if (!body) {
          return { status: 400, body: { error: 'missing_body' } };
        }
        const b = body as Record<string, unknown>;
        // 38-40
        if (b.role && !['admin', 'editor', 'viewer'].includes(b.role as string)) {
          return { status: 400, body: { error: 'invalid_role' } };
        }
        if (b.status && !['active', 'inactive', 'suspended'].includes(b.status as string)) {
          return { status: 400, body: { error: 'invalid_status' } };
        }
        if ((b as any).plan && !['free', 'pro', 'enterprise'].includes((b as any).plan as string)) {
          return { status: 400, body: { error: 'invalid_plan' } };
        }
        // 41
        try {
          await db.query('UPDATE users SET ... WHERE id = ? AND tenant = ?');
          logger.info(`User ${userId} updated`);
          return { status: 200, body: { updated: true } };
        } catch (e) {
          return { status: 500, body: { error: 'internal_error' } };
        }
      }
      return { status: 404, body: { error: 'not_found' } };
    }
    // 42
    if (method === 'DELETE') {
      // 43
      if (!auth.roles.includes('admin')) {
        return { status: 403, body: { error: 'admin_only' } };
      }
      // 44-46
      if (path.startsWith('/api/users/')) {
        try {
          await db.query('DELETE FROM users WHERE id = ? AND tenant = ?');
          cache.set('users:list', null);
          return { status: 200, body: { deleted: true } };
        } catch (e) {
          return { status: 500, body: { error: 'internal_error' } };
        }
      }
      // 47
      if (path.startsWith('/api/orders/')) {
        const [orderId, action] = path.split('/').slice(3);
        // 48
        if (!orderId) {
          return { status: 400, body: { error: 'missing_order_id' } };
        }
        // 49
        if (action === 'cancel') {
          try {
            await db.query("UPDATE orders SET status = 'cancelled' WHERE id = ? AND tenant = ?");
            return { status: 200, body: { cancelled: true } };
          } catch (e) {
            return { status: 500, body: { error: 'internal_error' } };
          }
        }
        // 50
        if (action === 'refund') {
          if (!auth.roles.includes('admin')) {
            return { status: 403, body: { error: 'admin_only' } };
          }
          try {
            await db.query("UPDATE orders SET status = 'refunded' WHERE id = ? AND tenant = ?");
            return { status: 200, body: { refunded: true } };
          } catch (e) {
            return { status: 500, body: { error: 'internal_error' } };
          }
        }
        return { status: 400, body: { error: 'unknown_action' } };
      }
      return { status: 404, body: { error: 'not_found' } };
    }
    // 51
    if (method === 'PATCH') {
      // 52
      if (path === '/api/settings') {
        // 53
        if (!body) {
          return { status: 400, body: { error: 'missing_body' } };
        }
        const b = body as Record<string, unknown>;
        // 54-57
        if (b.theme && !['light', 'dark', 'auto'].includes(b.theme as string)) {
          return { status: 400, body: { error: 'invalid_theme' } };
        }
        if (b.lang && !['en', 'es', 'fr', 'de', 'ja'].includes(b.lang as string)) {
          return { status: 400, body: { error: 'invalid_lang' } };
        }
        if (b.notifications && typeof b.notifications !== 'object') {
          return { status: 400, body: { error: 'invalid_notifications' } };
        }
        if ((b as any).timezone && !Intl.DateTimeFormat().resolvedOptions().timeZone) {
          logger.warn('Suspicious timezone');
        }
        return { status: 200, body: { updated: true } };
      }
      return { status: 404, body: { error: 'not_found' } };
    }

    // 58: fallback
    logger.warn(`Unknown method: ${method}`);
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
}
