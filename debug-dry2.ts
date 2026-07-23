import { initializeLanguages, initParsers } from './src/languages/index.js';
import { LanguageRegistry } from './src/languages/languageRegistry.js';
import { resolve } from 'path';

async function main() {
  initializeLanguages();
  await initParsers();

  const registry = LanguageRegistry.getInstance();
  const filePath = resolve('./bench/corpus/dry/src/duplicates.ts');
  const adapter = registry.getAdapter(filePath);
  
  if (!adapter) {
    console.log('No adapter found for', filePath);
    // check registered extensions
    console.log('Registered:', registry.getRegisteredExtensions?.() || 'N/A');
    return;
  }

  const fs = await import('fs');
  const sourceCode = fs.readFileSync(filePath, 'utf-8');
  const ast = adapter.parse(sourceCode, filePath);
  
  const functions = adapter.extractFunctions(ast);
  console.log('Functions extracted:', functions.length);
  for (const fn of functions) {
    console.log(`  name=${fn.name} location=line=${fn.location.start.line},col=${fn.location.start.column}`);
    const node = findNode(ast.root, fn.location.start);
    if (node) {
      const text = adapter.getNodeText(node, sourceCode);
      const lineCount = text?.split('\n').filter((l: string) => l.trim().length > 0).length ?? 0;
      console.log(`  nodeType=${node.type} textLen=${text?.length} lineCount=${lineCount}`);
      console.log(`  firstLine: ${text?.split('\n')[0]}`);
    } else {
      console.log('  NODE NOT FOUND at', JSON.stringify(fn.location.start));
    }
  }
}

function findNode(root: any, location: { line: number; column: number }): any | null {
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.location?.start?.line === location.line &&
        node.location?.start?.column === location.column) {
      return node;
    }
    if (node.children) {
      queue.push(...node.children);
    }
  }
  return null;
}

main().catch(e => { console.error(e); process.exit(1); });
