#!/usr/bin/env node

// Simple test to verify Go adapter functionality
import { GoAdapter } from './dist/languages/go/GoAdapter.js';
import { readFileSync } from 'fs';

async function testGoAdapter() {
  console.log('Testing Go Adapter...');
  
  const adapter = new GoAdapter();
  console.log('Adapter name:', adapter.name);
  console.log('File extensions:', adapter.fileExtensions);
  
  // Test file support
  console.log('Supports .go files:', adapter.supportsFile('example.go'));
  console.log('Supports .ts files:', adapter.supportsFile('example.ts'));
  
  // Test parsing
  try {
    const goCode = readFileSync('./test-go/example.go', 'utf8');
    console.log('Go code length:', goCode.length);
    
    const ast = await adapter.parse('./test-go/example.go', goCode);
    console.log('AST language:', ast.language);
    console.log('AST root type:', ast.root.type);
    console.log('AST children count:', ast.root.children?.length || 0);
    
    // Test function extraction
    const functions = adapter.extractFunctions(ast);
    console.log('Functions extracted:', functions.length);
    functions.forEach(func => {
      console.log(`  - ${func.name} (exported: ${func.isExported})`);
    });
    
    // Test struct extraction (classes)
    const structs = adapter.extractClasses(ast);
    console.log('Structs extracted:', structs.length);
    structs.forEach(struct => {
      console.log(`  - ${struct.name} (exported: ${struct.isExported})`);
    });
    
    // Test interface extraction
    const interfaces = adapter.extractInterfaces(ast);
    console.log('Interfaces extracted:', interfaces.length);
    interfaces.forEach(iface => {
      console.log(`  - ${iface.name} (exported: ${iface.isExported})`);
    });
    
  } catch (error) {
    console.error('Test error:', error);
  }
}

testGoAdapter().catch(console.error);