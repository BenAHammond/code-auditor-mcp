/**
 * Japanese identifiers — DB access via provenance only.
 *
 * "データベース" (dētabēsu = database), "クエリ" (kueri = query),
 * "接続" (setsuzoku = connection) — none of these appear in
 * dbReceiverNames or any English name lists.
 *
 * Detection MUST fire via import provenance from drizzle-orm.
 *
 * Spec 21 R6.2 — non-English bench corpus fixture
 */

import { drizzle } from 'drizzle-orm';

const env = { DB: { exec: (_sql: string) => [] } };

// データベース is DB-provenanced via drizzle import propagation
const データベース = drizzle(env.DB as any);

// Direct query — triggers missing-org-filter, unfiltered-query
async function 注文を取得(ユーザーID: number) {
  const 注文 = await データベース.query(
    'SELECT * FROM 注文 WHERE ユーザーID = $1',
    [ユーザーID]
  );
  return 注文;
}

// Another query — triggers additional violations
async function 全商品を取得() {
  const 商品 = await データベース.query(
    'SELECT * FROM 商品'
  );
  return 商品;
}
