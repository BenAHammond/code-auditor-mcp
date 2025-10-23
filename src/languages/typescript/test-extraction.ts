import { TypeScriptAdapter } from './TypeScriptAdapter.js';
import { readFile } from 'fs/promises';

async function testExtraction() {
  const adapter = new TypeScriptAdapter();
  const filePath = '/Users/ben/playground/code-auditor/app/test-cases/solid-test.ts';
  const content = await readFile(filePath, 'utf-8');
  
  console.log('Parsing file...');
  const ast = await adapter.parse(filePath, content);
  
  console.log('\nExtracting classes...');
  const classes = adapter.extractClasses(ast);
  
  console.log(`Found ${classes.length} classes\n`);
  
  for (const classInfo of classes) {
    console.log(`Class: ${classInfo.name}`);
    console.log(`  Methods found: ${classInfo.methods.length}`);
    classInfo.methods.forEach(method => {
      console.log(`    - ${method.name}`);
    });
  }
  
  // Let's also debug what forEachChild sees
  console.log('\n--- Debugging AST traversal ---');
  const userServiceNode = adapter.findNodes(ast, { 
    type: 'ClassDeclaration', 
    name: 'UserService' 
  })[0];
  
  if (userServiceNode) {
    console.log('UserService node found');
    console.log('Children count:', userServiceNode.children?.length || 0);
    if (userServiceNode.children) {
      userServiceNode.children.forEach(child => {
        console.log(`  Child type: ${child.type}`);
      });
    }
  }
}

testExtraction().catch(console.error);