import * as ts from 'typescript';
import * as fs from 'fs';

// Create a test source file
const sourceCode = `
import { BaseFilters } from '@/components/shared/filters/CommonFilterControls';

export interface ReportFilters extends BaseFilters {
  customField: string;
}
`;

// Create source file
const sourceFile = ts.createSourceFile(
  'test.ts',
  sourceCode,
  ts.ScriptTarget.Latest,
  true
);

// Function to print AST structure
function printAST(node: ts.Node, indent = 0): void {
  const kindName = ts.SyntaxKind[node.kind];
  const prefix = ' '.repeat(indent);
  
  let info = `${prefix}${kindName}`;
  
  if (ts.isIdentifier(node)) {
    info += ` [${node.text}]`;
  }
  
  console.log(info);
  
  // Special handling for interface declaration
  if (ts.isInterfaceDeclaration(node)) {
    console.log(`${prefix}  name: ${node.name?.text}`);
    if (node.heritageClauses) {
      console.log(`${prefix}  heritageClauses:`);
      for (const clause of node.heritageClauses) {
        console.log(`${prefix}    clause.token: ${ts.SyntaxKind[clause.token]}`);
        console.log(`${prefix}    clause.types:`);
        for (const type of clause.types) {
          console.log(`${prefix}      ExpressionWithTypeArguments:`);
          console.log(`${prefix}        expression kind: ${ts.SyntaxKind[type.expression.kind]}`);
          if (ts.isIdentifier(type.expression)) {
            console.log(`${prefix}        expression text: ${type.expression.text}`);
          }
        }
      }
    }
  }
  
  // Recurse through children
  ts.forEachChild(node, (child) => {
    printAST(child, indent + 2);
  });
}

console.log('=== AST Structure for Interface Extension ===\n');
printAST(sourceFile);

// Now let's trace through what happens when we find the identifier
console.log('\n\n=== Finding BaseFilters identifier ===\n');

function findIdentifierUsage(node: ts.Node): void {
  if (ts.isIdentifier(node) && node.text === 'BaseFilters') {
    console.log(`Found identifier: ${node.text}`);
    console.log(`  Parent kind: ${ts.SyntaxKind[node.parent.kind]}`);
    console.log(`  Parent is ExpressionWithTypeArguments: ${ts.isExpressionWithTypeArguments(node.parent)}`);
    
    if (ts.isExpressionWithTypeArguments(node.parent)) {
      console.log(`  Parent.expression === node: ${node.parent.expression === node}`);
      
      const heritageClause = node.parent.parent;
      if (heritageClause && ts.isHeritageClause(heritageClause)) {
        console.log(`  Heritage clause token: ${ts.SyntaxKind[heritageClause.token]}`);
        
        const interfaceDecl = heritageClause.parent;
        if (interfaceDecl && ts.isInterfaceDeclaration(interfaceDecl)) {
          console.log(`  Interface declaration name: ${interfaceDecl.name?.text}`);
          console.log(`  Would isTypeOnlyUsage detect this?`);
          
          // Let's see the parent chain
          console.log(`\n  Parent chain:`);
          let current: ts.Node | undefined = node;
          let level = 0;
          while (current && level < 5) {
            console.log(`    ${level}: ${ts.SyntaxKind[current.kind]} ${ts.isIdentifier(current) ? `[${current.text}]` : ''}`);
            current = current.parent;
            level++;
          }
        }
      }
    }
  }
  
  ts.forEachChild(node, findIdentifierUsage);
}

findIdentifierUsage(sourceFile);