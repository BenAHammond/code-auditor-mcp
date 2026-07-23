/**
 * Portuguese identifiers — DB access via provenance only.
 *
 * "banco" (bank/database), "consultar" (to query), "buscar" (to fetch) —
 * none of these appear in dbReceiverNames.
 * Detection MUST fire via import provenance from drizzle-orm.
 *
 * Spec 21 R6.2 — non-English bench corpus fixture
 */

import { drizzle } from 'drizzle-orm';

const env = { DB: { exec: (_sql: string) => [] } };
const banco = drizzle(env.DB as any);

// Direct query — triggers missing-org-filter (table "users"), unfiltered-query
async function buscarUsuarios() {
  const resultado = await banco.query(
    'SELECT * FROM users WHERE id = 1'
  );
  return resultado;
}

// Another query — triggers missing-org-filter (table "orders"), unfiltered-query
async function consultarPedidos() {
  const pedidos = await banco.query(
    'SELECT * FROM orders WHERE status = $1',
    ['ativo']
  );
  return pedidos;
}
