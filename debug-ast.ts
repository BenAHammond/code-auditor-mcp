import { initializeLanguages, initParsers, LanguageRegistry } from './src/languages/index.js';
import { parseFile } from './src/languages/adapterBridge.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function main() {
  const dir = join(tmpdir(), 'debug-ast-' + Date.now());
  await mkdir(dir, { recursive: true });
  
  initializeLanguages();
  await initParsers();
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;

  const code = `export async function findInLoop(ids: number[]): Promise<any[]> {
  const results = [];
  for (const id of ids) {
    const row = await db.users.find({ id });
    results.push(row);
  }
  return results;
}`;

  const path = join(dir, 'test.ts');
  await writeFile(path, code, 'utf-8');
  const ast = parseFile(path, code)!;

  function walk(node: any, depth = 0) {
    if (depth > 15) return;
    const indent = '  '.repeat(depth);
    if (node.type === 'call_expression') {
      const children = adapter.getChildren(node);
      console.log(`${indent}CALL_EXPRESSION (line ${node.location.start.line}):`);
      for (const c of children) {
        console.log(`${indent}  ${c.type} = ${adapter.getNodeText(c, code).slice(0, 80)}`);
      }
      const memExpr = children.find((c: any) => c.type === 'member_expression');
      if (memExpr) {
        console.log(`${indent}  -> member_expression children:`);
        const memChildren = adapter.getChildren(memExpr);
        for (const mc of memChildren) {
          console.log(`${indent}     ${mc.type} = ${JSON.stringify({
            text: (mc as any).text,
            name: (mc as any).name,
            nodeText: adapter.getNodeText(mc, code),
            nodeType: adapter.getNodeType(mc),
          })}`);
        }
      }
    }
    if (node.children) {
      for (const c of node.children) {
        walk(c, depth + 1);
      }
    }
  }

  walk(ast.root);
}
main().catch(console.error);
