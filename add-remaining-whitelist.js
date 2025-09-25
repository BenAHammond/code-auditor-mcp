#!/usr/bin/env node

import { WhitelistService } from './dist/services/whitelistService.js';
import { WhitelistType } from './dist/types/whitelist.js';

async function addRemainingWhitelists() {
  console.log('Adding remaining whitelists...\n');
  
  const service = WhitelistService.getInstance();
  
  // Node.js built-ins that were missed
  const nodeBuiltins = [
    { name: 'url', patterns: ['url', 'node:url'] },
    { name: 'util', patterns: ['util', 'node:util'] },
    { name: 'events', patterns: ['events', 'node:events'] },
    { name: 'querystring', patterns: ['querystring', 'node:querystring'] },
    { name: 'child_process', patterns: ['child_process', 'node:child_process'] },
  ];
  
  let added = 0;
  
  for (const builtin of nodeBuiltins) {
    try {
      await service.addEntry(
        builtin.name, 
        WhitelistType.NodeBuiltin, 
        `Node.js ${builtin.name} module`,
        builtin.patterns
      );
      console.log(`✓ Added: ${builtin.name}`);
      added++;
    } catch (error) {
      console.log(`⏩ Skipped: ${builtin.name} (${error.message})`);
    }
  }
  
  console.log(`\n✅ Added ${added} entries`);
}

addRemainingWhitelists().catch(console.error);