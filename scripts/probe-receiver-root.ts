import { initializeLanguages, initParsers } from '../src/languages/index.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { resolveReceiverRoot } from '../src/analyzers/receiverRoot.js';
import { getCallExpressionCallee, getMemberExpressionReceiver } from '../src/analyzers/provenance.js';
import type { AST, LanguageAdapter, ASTNode } from '../src/languages/types.js';

const exprs = [
  'this.env.DB.prepare("SELECT 1")',
  'this.ctx.storage.sql.exec("SELECT 1")',
  '$(table).find()',
  'a.b.c.d.query()',
  'db.query("SELECT 1")',
];

async function main() {
  initializeLanguages();
  await initParsers();
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('/fixture/p.ts')!;

  for (const e of exprs) {
    const src = `${e};`;
    const ast = parseFile('/fixture/p.ts', src)!;
    try {
      const calls = adapter.findNodes(ast, { custom: (n: ASTNode) => n.type === 'call_expression' });
      const call = calls[0];
      const callee = getCallExpressionCallee(call, adapter);
      const root = callee ? resolveReceiverRoot(callee, adapter, src) : null;
      const receiver = callee ? getMemberExpressionReceiver(callee, adapter, src) : null;
      console.log(`${e}\n  callee.type=${callee?.type ?? '(null)'}  receiver=${receiver}  ROOT=${root}\n`);
    } finally {
      ast.dispose?.();
    }
  }
}

main();
