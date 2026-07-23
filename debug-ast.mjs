import { initParsers, initializeLanguages, LanguageRegistry } from './dist/languages/index.js';

await initializeLanguages();
await initParsers();

const registry = LanguageRegistry.getInstance();

const code = `import { drizzle } from 'drizzle-orm';

const db = {
  DB: { exec: (_sql: string) => [] },
};

const banco = drizzle(db.DB as any);

banco.prepare('SELECT * FROM users');
banco.all();
banco.first();`;

const adapter = registry.getAdapterForFile('test.ts');
const result = await adapter.parse('test.ts', code);
const ast = result;  // parse returns { root, language, filePath, errors }

console.log('AST root type:', ast.root?.type);
console.log('AST root children count:', ast.root?.children?.length);
console.log('Root child types:', ast.root?.children?.map(c => c.type));

// Walk the AST and find variable_declarator nodes
function walk(node, depth = 0) {
  if (!node) return;
  if (node.type === 'variable_declarator' || node.type === 'variable_declaration' || node.type === 'lexical_declaration') {
    const indent = '  '.repeat(depth);
    console.log(indent + 'TYPE:', node.type, 'id:', node.id?.substring(0, 8));
    if (node.children) {
      for (const child of node.children) {
        console.log(indent + '  child:', child.type, child.type === 'identifier' ? `"${adapter.getNodeText(child, code)}"` : '');
      }
    }
  }
  if (node.children) {
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }
}

walk(ast.root);

// Now specifically find the "banco" variable_declarator
console.log('\n--- Manual search for banco declarator ---');
function findVarDecl(node) {
  if (!node) return;
  if (node.type === 'variable_declarator') {
    for (const child of node.children || []) {
      if (child.type === 'identifier' && adapter.getNodeText(child, code) === 'banco') {
        console.log('FOUND banco in variable_declarator');
        console.log('Children of variable_declarator:');
        for (const c of node.children || []) {
          console.log('  type:', c.type, 'text:', adapter.getNodeText(c, code)?.substring(0, 80));
        }
        // Also check parent
        console.log('Parent type:', node.parent?.type);
        if (node.parent?.children) {
          console.log('Parent children types:', node.parent.children.map(c => c.type));
        }
        return true;
      }
    }
  }
  if (node.children) {
    for (const child of node.children) {
      if (findVarDecl(child)) return true;
    }
  }
  return false;
}
findVarDecl(ast.root);
