#!/usr/bin/env node

import { WhitelistService } from './dist/services/whitelistService.js';
import { WhitelistType } from './dist/types/whitelist.js';

async function addFrameworkWhitelists() {
  console.log('Adding framework class whitelists...\n');
  
  const service = WhitelistService.getInstance();
  
  // Common framework classes that should be whitelisted
  const frameworkClasses = [
    // Commander.js
    { name: 'Command', description: 'Commander.js Command class' },
    
    // Express
    { name: 'Router', description: 'Express Router class' },
    { name: 'Application', description: 'Express Application class' },
    
    // MCP SDK
    { name: 'Server', description: 'MCP SDK Server class' },
    { name: 'StdioServerTransport', description: 'MCP SDK transport class' },
    
    // Common error classes
    { name: 'Error', description: 'JavaScript built-in Error class' },
    { name: 'TypeError', description: 'JavaScript built-in TypeError' },
    { name: 'RangeError', description: 'JavaScript built-in RangeError' },
    { name: 'SyntaxError', description: 'JavaScript built-in SyntaxError' },
    
    // Common utility classes  
    { name: 'Document', description: 'FlexSearch Document class' },
    { name: 'Loki', description: 'LokiJS database class' },
    { name: 'QueryParser', description: 'Internal query parser class' },
    { name: 'FunctionScanner', description: 'Internal function scanner class' },
    
    // Factory pattern classes
    { name: 'ConfigGeneratorFactory', description: 'Factory for config generators' },
    { name: 'CursorConfigGenerator', description: 'Cursor config generator' },
    { name: 'ContinueConfigGenerator', description: 'Continue config generator' },
    { name: 'CopilotConfigGenerator', description: 'Copilot config generator' },
    { name: 'ClaudeConfigGenerator', description: 'Claude config generator' },
    { name: 'AWSQConfigGenerator', description: 'AWS Q config generator' },
    { name: 'CodeiumConfigGenerator', description: 'Codeium config generator' },
    { name: 'VSCodeConfigGenerator', description: 'VS Code config generator' },
    { name: 'JetBrainsConfigGenerator', description: 'JetBrains config generator' },
    { name: 'ClineConfigGenerator', description: 'Cline config generator' },
    { name: 'AiderConfigGenerator', description: 'Aider config generator' },
    
    // Custom error classes
    { name: 'DatabaseError', description: 'Custom database error class' },
    { name: 'SearchError', description: 'Custom search error class' },
    { name: 'ValidationError', description: 'Custom validation error class' },
    
    // UI Classes
    { name: 'InteractivePrompts', description: 'Interactive prompts UI class' },
    
    // Singleton classes
    { name: 'CodeIndexDB', description: 'Database singleton class' },
    { name: 'WhitelistService', description: 'Whitelist service singleton' },
    
    // Debug classes
    { name: 'DebugLogger', description: 'Debug logging class' }
  ];
  
  let added = 0;
  let skipped = 0;
  
  for (const cls of frameworkClasses) {
    try {
      await service.addEntry(cls.name, WhitelistType.FrameworkClass, cls.description);
      console.log(`✓ Added: ${cls.name}`);
      added++;
    } catch (error) {
      if (error.message.includes('already exists')) {
        skipped++;
      } else {
        console.error(`✗ Failed to add ${cls.name}:`, error.message);
      }
    }
  }
  
  console.log(`\n✅ Added ${added} framework class entries`);
  console.log(`⏩ Skipped ${skipped} existing entries`);
}

addFrameworkWhitelists().catch(console.error);