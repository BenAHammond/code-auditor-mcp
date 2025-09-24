/**
 * Test file for Bug 2: Query parser with nested quotes and escape sequences
 * Contains complex string patterns to test the improved parser
 */

import React from 'react';

// Component with nested quotes in strings
export const DataTableFilter: React.FC = () => {
  // This tests parsing of: "column: 'country'"
  const filterConfig = {
    filters: [
      { column: 'country', operator: 'equals', value: 'USA' },
      { column: 'status', operator: 'in', values: ['active', 'pending'] }
    ]
  };
  
  // Test escape sequences: "status = 'active\\'s'"
  const complexQuery = "SELECT * FROM users WHERE status = 'active\\'s orders'";
  
  // Nested quotes scenario
  const jsonConfig = `{"filter": "column: 'user_name'", "value": "John's \"Special\" Account"}`;
  
  return (
    <div>
      <h3>Filter Configuration</h3>
      <pre>{JSON.stringify(filterConfig, null, 2)}</pre>
      
      <h3>Complex Query</h3>
      <code>{complexQuery}</code>
      
      <h3>JSON Config with nested quotes</h3>
      <code>{jsonConfig}</code>
    </div>
  );
};

// Function with various quote patterns
export function buildDynamicQuery(params: any) {
  // Pattern: prop:"onClick"
  const eventHandlers = ['onClick', 'onSubmit', 'onChange'];
  
  // Pattern: file:"test-components/edge-case-1"
  const importPath = 'test-components/edge-case-1-massive-form.tsx';
  
  // Complex nested pattern
  const template = `
    query GetUser($id: ID!) {
      user(id: $id) {
        name
        profile {
          bio: "User's \"favorite\" quote"
        }
      }
    }
  `;
  
  return {
    handlers: eventHandlers,
    path: importPath,
    graphqlTemplate: template
  };
}

// Test unclosed quotes handling
export function handleUnterminatedStrings() {
  try {
    // This has an unclosed quote: "this is unclosed
    const badString = "this is unclosed and continues...";
    
    // Multiple quote types
    const mixed = `He said "it's working" and I agreed`;
    
    return { badString, mixed };
  } catch (e) {
    console.error('Error in string handling');
  }
}