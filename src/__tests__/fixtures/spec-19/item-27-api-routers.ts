/**
 * Spec-19 item 27 — dry/structural-similarity useless positive.
 * Two API version routers with similar shape (strategist-manager pattern).
 * Verdict: USELESS — API version routers are structured similarly by convention.
 * dry/structural-similarity is default-off → 0 violations with defaults.
 * When checkStructuralSimilarity is enabled → fires.
 *
 * Two exported router classes with near-identical handler method signatures,
 * parameter validation, error handling, and JSON response patterns.
 */

declare const req: { params: Record<string, string>; query: Record<string, string> };
declare const res: { json: (data: unknown) => void; status: (c: number) => { json: (d: unknown) => void } };

export class V1UserRouter {
  async getById(params: Record<string, string>): Promise<unknown> {
    const { id } = params;
    if (!id || id.length === 0) {
      return res.status(400).json({ error: 'id is required' });
    }
    const user = { id, name: 'v1-user', version: 1 };
    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }
    return res.json({ data: user, meta: { version: 'v1' } });
  }

  async list(query: Record<string, string>): Promise<unknown> {
    const { limit, offset } = query;
    if (!limit || parseInt(limit) <= 0) {
      return res.status(400).json({ error: 'invalid limit' });
    }
    const users = [{ id: '1', name: 'v1-user', version: 1 }];
    return res.json({ data: users, meta: { total: users.length, version: 'v1' } });
  }
}

export class V2UserRouter {
  async getById(params: Record<string, string>): Promise<unknown> {
    const { id } = params;
    if (!id || id.length === 0) {
      return res.status(400).json({ error: 'id is required' });
    }
    const user = { id, name: 'v2-user', version: 2 };
    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }
    return res.json({ data: user, meta: { version: 'v2' } });
  }

  async list(query: Record<string, string>): Promise<unknown> {
    const { limit, offset } = query;
    if (!limit || parseInt(limit) <= 0) {
      return res.status(400).json({ error: 'invalid limit' });
    }
    const users = [{ id: '1', name: 'v2-user', version: 2 }];
    return res.json({ data: users, meta: { total: users.length, version: 'v2' } });
  }
}
